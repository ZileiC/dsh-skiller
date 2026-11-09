/**
 * dsh-skill-manager host-half contract test.
 *
 * Mounts the plugin against a fake Cordis context whose `skills` service is a
 * miniature filesystem-backed registry (same discovery rules the real
 * `@deepseek-ai/dsh-skill-filesystem` provider enforces for the fields that
 * matter here) and whose `agentPresets` service hands out a fake scope lease.
 * Every filesystem assertion runs inside an OS temp directory; the real
 * `.agents/skills` tree is never touched.
 *
 * Run with: node test/host-test.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/* ----------------------------------------------------------------- fixtures */

const tempRoot = mkdtempSync(join(tmpdir(), 'dsm-host-'))
const homeRoot = join(tempRoot, 'home')
const agentsHome = join(tempRoot, 'agents-home')
const projectRoot = join(tempRoot, 'project')
const projectSkills = join(projectRoot, '.agents', 'skills')
const userSkills = join(homeRoot, 'skills')
mkdirSync(homeRoot, { recursive: true })
mkdirSync(agentsHome, { recursive: true })
mkdirSync(join(projectRoot, '.git'), { recursive: true })
mkdirSync(projectSkills, { recursive: true })

process.env.DSH_HOME = homeRoot
process.env.DSH_AGENTS_HOME = agentsHome

process.on('exit', () => {
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* a leftover temp dir must never fail the run */
  }
})

const { apply } = await import('../lib/index.js')
const { renameWithRetry, SkillError } = await import('../lib/skills.js')

/* ------------------------------------------------------- fake skill registry */

const VALID_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function scalar(raw) {
  if (raw === undefined) return undefined
  const value = String(raw).trim()
  if (!value) return ''
  if (value.startsWith('"')) {
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] === '\\') {
        index += 1
        continue
      }
      if (value[index] !== '"') continue
      try {
        return String(JSON.parse(value.slice(0, index + 1)))
      } catch {
        return value.slice(1, index)
      }
    }
    return value
  }
  if (value.startsWith("'")) return value.endsWith("'") ? value.slice(1, -1) : value.slice(1)
  const comment = /\s#/.exec(value)
  return comment ? value.slice(0, comment.index).trim() : value
}

function parseBoolean(raw) {
  if (raw === undefined) return undefined
  const value = String(raw).trim().toLowerCase()
  if (value === 'true' || value === 'yes' || value === 'on' || value === '1') return true
  if (value === 'false' || value === 'no' || value === 'off' || value === '0') return false
  throw new Error('invalid boolean')
}

/** Mirrors the provider's acceptance rules closely enough for the contract. */
function parseSkillFile(text, { rejectMarker } = {}) {
  const normalized = String(text ?? '').replace(/^\uFEFF/, '')
  const lines = normalized.split('\n')
  if ((lines[0] ?? '').replace(/\r$/, '') !== '---') return null
  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/\r$/, '') === '---') {
      close = index
      break
    }
  }
  if (close < 0) return null
  const data = new Map()
  for (const line of lines.slice(1, close)) {
    const match = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line)
    if (match) data.set(match[1], match[2])
  }
  if (data.has('disableModelInvocation') || data.has('modelInvocable') || data.has('userInvocable')) return null
  const name = scalar(data.get('name'))
  if (!name || name.length > 64 || !VALID_NAME.test(name) || RESERVED.test(name)) return null
  const description = scalar(data.get('description'))
  if (!description) return null
  if (rejectMarker && description.includes(rejectMarker)) return null
  let modelInvocable = true
  let userInvocable = true
  try {
    if (parseBoolean(data.get('disable-model-invocation')) === true) modelInvocable = false
    if (parseBoolean(data.get('user-invocable')) === false) userInvocable = false
  } catch {
    return null
  }
  const whenToUse = scalar(data.get('whenToUse'))
  return {
    name,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    invocation: { modelInvocable, userInvocable },
    body: lines.slice(close + 1).join('\n').trim(),
  }
}

function createRegistry(roots) {
  const registry = {
    roots,
    extras: [],
    frozen: null,
    isFrozen: false,
    ignoreNewerThanMs: null,
    rejectDescriptionMarker: null,
    async scan(cutoff) {
      const candidates = []
      for (const { root, source, rank } of registry.roots) {
        let entries
        try {
          entries = await readdir(root, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          const full = join(root, entry.name)
          let isDirectory = entry.isDirectory()
          let isFile = entry.isFile()
          if (entry.isSymbolicLink()) {
            // The real provider follows a symlink/junction entry to its target
            // type but reports the target's real path; mirror that here.
            let info
            try {
              info = await stat(full)
            } catch {
              continue
            }
            isDirectory = info.isDirectory()
            isFile = info.isFile()
          }
          let file
          if (isDirectory) file = join(full, 'SKILL.md')
          else if (isFile && entry.name.endsWith('.md')) file = full
          else continue
          let info
          try {
            info = await stat(file)
          } catch {
            continue
          }
          if (!info.isFile()) continue
          if (cutoff !== undefined && info.mtimeMs > cutoff) continue
          const parsed = parseSkillFile(await readFile(file, 'utf8'), {
            rejectMarker: registry.rejectDescriptionMarker,
          })
          if (!parsed) continue
          candidates.push({
            ...parsed,
            provider: 'filesystem',
            source,
            rank,
            path: await realpath(file),
          })
        }
      }
      for (const extra of registry.extras) candidates.push({ ...extra })
      candidates.sort((left, right) => (left.rank ?? 600) - (right.rank ?? 600) || left.name.localeCompare(right.name))
      const winners = new Map()
      for (const candidate of candidates) if (!winners.has(candidate.name)) winners.set(candidate.name, candidate)
      return [...winners.values()]
    },
    async snapshot() {
      if (registry.isFrozen) return { skills: registry.frozen.map((entry) => ({ ...entry })), complete: true }
      const cutoff = registry.ignoreNewerThanMs === null ? undefined : Date.now() - registry.ignoreNewerThanMs
      return { skills: await registry.scan(cutoff), complete: true }
    },
    async get(name) {
      // Definitions are never cached by the real registry: every load re-reads
      // the file, even while a frozen snapshot models a lagging watcher.
      const all = await registry.scan()
      const extra = registry.extras.find((entry) => entry.name === name)
      if (extra && typeof extra.content === 'string') {
        return { ...extra, content: extra.content }
      }
      const hit = all.find((entry) => entry.name === name)
      if (!hit || typeof hit.path !== 'string') return undefined
      return { ...hit, content: hit.body ?? '' }
    },
    async freeze() {
      registry.frozen = (await registry.scan()).map((entry) => ({ ...entry }))
      registry.isFrozen = true
    },
    thaw() {
      registry.isFrozen = false
      registry.frozen = null
    },
  }
  registry.service = {
    snapshot: (options) => registry.snapshot(options),
    get: (name) => registry.get(name),
  }
  return registry
}

const registry = createRegistry([
  { root: projectSkills, source: 'project-agents', rank: 200 },
  { root: userSkills, source: 'user-dsh', rank: 400 },
])

/* ------------------------------------------------------------------- harness */

function createHarness({ mounted = true } = {}) {
  const routes = new Map()
  const effects = []
  const sessions = new Map()
  const presets = {
    defaultId: 'standard',
    async resolve() {
      return { id: presets.defaultId }
    },
    presetForSession(session) {
      return session && session.presetId ? session.presetId : null
    },
    async acquireScope() {
      return {
        key: { scope: 'fake-scope' },
        async [Symbol.asyncDispose]() {},
      }
    },
    async compositionInventory() {
      const rows = mounted
        ? [{ entryId: 'skill-filesystem', moduleName: '@deepseek-ai/dsh-skill-filesystem', enabled: true }]
        : [{ entryId: 'tool-fs', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: true }]
      return [{ id: 'standard', isDefault: true, rows }]
    },
  }
  const ctx = {
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
    get(key) {
      if (key === 'skills') return registry.service
      if (key === 'agentPresets') return presets
      if (key === 'sessions') return { get: (id) => sessions.get(id) }
      return undefined
    },
    on() {
      return () => {}
    },
    logger: { info() {}, warn() {} },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  apply(ctx, {})
  return {
    ctx,
    routes,
    sessions,
    presets,
    dispose() {
      for (const effect of effects.splice(0)) {
        try {
          effect()
        } catch {
          /* a failing disposer must not mask the result */
        }
      }
    },
  }
}

function fakeResponse() {
  const chunks = []
  return {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers || {}
    },
    end(body) {
      if (body) chunks.push(String(body))
      this.body = chunks.join('')
    },
  }
}

async function call(harness, path, options = {}) {
  const route = harness.routes.get(path)
  if (!route) throw new Error(`route not registered: ${path}`)
  const method = options.method ?? 'GET'
  const headers = { host: '127.0.0.1:5816', ...(options.headers ?? {}) }
  if (method === 'POST' && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json'
  }
  let payload
  if (options.rawBody !== undefined) payload = Buffer.from(options.rawBody, 'utf8')
  else if (options.body !== undefined) payload = Buffer.from(JSON.stringify(options.body), 'utf8')
  const request = {
    method,
    url: path + (options.query ? `?${options.query}` : ''),
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload) yield payload
    },
  }
  const response = fakeResponse()
  await route.handler(request, response)
  let json = null
  try {
    json = response.body ? JSON.parse(response.body) : null
  } catch {
    json = null
  }
  return { status: response.statusCode, headers: response.headers, body: response.body ?? '', json }
}

const BASE = '/api/skill-manager'

/* ------------------------------------------------------------------ helpers */

let passed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
  }
}
function section(title) {
  console.log(`\n== ${title}`)
}
function code(result) {
  return result && result.json && result.json.error ? result.json.error.code : undefined
}

async function writeSkillFile(root, name, { frontmatter, body }) {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  const lines = ['---', ...frontmatter, '---', '']
  if (body) lines.push(body, '')
  await writeFile(join(directory, 'SKILL.md'), lines.join('\n'), 'utf8')
  return join(directory, 'SKILL.md')
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Create a directory junction/symlink. On Windows a junction needs no
 * administrator rights, which is why the security tests use it instead of a
 * file symlink. Returns the error when creation is unavailable.
 */
async function tryJunction(target, linkPath) {
  try {
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    return null
  } catch (error) {
    return error
  }
}

/* ------------------------------------------------------------- fixtures (fs) */

const alphaSkill = await writeSkillFile(projectSkills, 'alpha', {
  frontmatter: [
    'name: "alpha"',
    'description: "Alpha skill"',
    'whenToUse: "when testing"',
    'x-custom: keep',
    'metadata:',
    '  owner: bench',
    '# note line',
  ],
  body: 'alpha body line one',
})
mkdirSync(userSkills, { recursive: true })
await writeSkillFile(userSkills, 'user-skill', {
  frontmatter: ['name: "user-skill"', 'description: "User level skill"'],
  body: 'user body',
})

const harness = createHarness()

/* ---------------------------------------------------------------- 1. guards */

section('guards and routing')
check('six exact routes are registered', harness.routes.size === 6, [...harness.routes.keys()])
check(
  'state route is a GET',
  harness.routes.get(`${BASE}/state`).kind === 'exact',
  harness.routes.get(`${BASE}/state`).kind,
)

const hostileHost = await call(harness, `${BASE}/state`, { headers: { host: 'evil.example:5816' } })
check('untrusted Host → 403 HOST_FORBIDDEN', hostileHost.status === 403 && code(hostileHost) === 'HOST_FORBIDDEN', hostileHost.json)

const hostileOrigin = await call(harness, `${BASE}/state`, {
  headers: { origin: 'http://evil.example' },
})
check('cross-origin → 403 ORIGIN_FORBIDDEN', hostileOrigin.status === 403 && code(hostileOrigin) === 'ORIGIN_FORBIDDEN', hostileOrigin.json)

const wrongMethod = await call(harness, `${BASE}/state`, { method: 'PUT' })
check('PUT on a GET route → 405', wrongMethod.status === 405 && code(wrongMethod) === 'METHOD_NOT_ALLOWED', wrongMethod.json)

const wrongType = await call(harness, `${BASE}/create`, {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: { name: 'x' },
})
check('non-JSON content-type → 415', wrongType.status === 415 && code(wrongType) === 'BAD_REQUEST', wrongType.json)

const badJson = await call(harness, `${BASE}/create`, { method: 'POST', rawBody: '{not json' })
check('invalid JSON → 400 INVALID_JSON', badJson.status === 400 && code(badJson) === 'INVALID_JSON', badJson.json)

const oversized = await call(harness, `${BASE}/create`, {
  method: 'POST',
  rawBody: 'x'.repeat(1024 * 1024 + 10),
})
check('oversized body → 413', oversized.status === 413 && code(oversized) === 'PAYLOAD_TOO_LARGE', oversized.status)

/* ----------------------------------------------------------------- 2. state */

section('GET /state')
const state = await call(harness, `${BASE}/state`, { query: `cwd=${encodeURIComponent(projectRoot)}` })
check('state 200 ok', state.status === 200 && state.json && state.json.ok === true, state.json && state.json.error)
const stateBody = state.json
check('preset resolved from default', stateBody.view.preset.id === 'standard' && stateBody.view.preset.source === 'default', stateBody.view.preset)
check('mounted detects the filesystem provider', stateBody.mounted === true && stateBody.mountedKnown === true, stateBody.mounted)
check(
  'project and user roots are exposed',
  stateBody.roots.length === 2 && stateBody.roots.some((root) => root.key === 'project') && stateBody.roots.some((root) => root.key === 'user'),
  stateBody.roots,
)
const alphaRow = stateBody.skills.find((skill) => skill.name === 'alpha')
check('alpha listed as writable directory bundle', Boolean(alphaRow) && alphaRow.writable === true && alphaRow.layout === 'directory', alphaRow)
check('alpha carries rootKey project and an etag', alphaRow.rootKey === 'project' && /^\d+:\d+$/.test(String(alphaRow.etag)), alphaRow.etag)
check(
  'host-only root spellings are not sent to the browser',
  alphaRow.realPath === undefined && alphaRow.rootReal === undefined,
  Object.keys(alphaRow),
)
const userRow = stateBody.skills.find((skill) => skill.name === 'user-skill')
check('user skill listed as writable in the user root', Boolean(userRow) && userRow.writable === true && userRow.rootKey === 'user', userRow)
check('limits are published', stateBody.limits && stateBody.limits.importFiles === 200, stateBody.limits)

const noCwdState = await call(harness, `${BASE}/state`)
check(
  'without cwd only the user root is exposed',
  noCwdState.json.ok === true && noCwdState.json.roots.length === 1 && noCwdState.json.roots[0].key === 'user',
  noCwdState.json.roots,
)

/* ---------------------------------------------------------------- 3. detail */

section('GET /detail')
const detail = await call(harness, `${BASE}/detail`, {
  query: `cwd=${encodeURIComponent(projectRoot)}&name=alpha`,
})
check('detail 200', detail.status === 200 && detail.json.ok === true, detail.json && detail.json.error)
check('detail body comes from disk', detail.json.skill.body === 'alpha body line one', detail.json.skill.body)
check('detail frontmatter is resolved', detail.json.skill.frontmatter.description === 'Alpha skill', detail.json.skill.frontmatter)
check('detail deletePlan describes the bundle', detail.json.skill.deletePlan && detail.json.skill.deletePlan.kind === 'directory', detail.json.skill.deletePlan)

const missingDetail = await call(harness, `${BASE}/detail`, {
  query: `cwd=${encodeURIComponent(projectRoot)}&name=no-such-skill`,
})
check('unknown skill → 404 SKILL_NOT_FOUND', missingDetail.status === 404 && code(missingDetail) === 'SKILL_NOT_FOUND', missingDetail.json)

/* ---------------------------------------------------------------- 4. create */

section('POST /create')
const created = await call(harness, `${BASE}/create`, {
  method: 'POST',
  body: {
    cwd: projectRoot,
    root: 'project',
    name: 'created-skill',
    description: 'Created by the contract test',
    whenToUse: 'when creating',
    modelInvocable: true,
    userInvocable: false,
    body: 'created body',
    waitMs: 400,
  },
})
check('create 201', created.status === 201 && created.json.ok === true, created.json && created.json.error)
check('create reports discovery', created.json.discovery && created.json.discovery.state === 'discovered', created.json.discovery)
const createdFile = join(projectSkills, 'created-skill', 'SKILL.md')
check('created SKILL.md exists', await exists(createdFile))
const createdText = await readFile(createdFile, 'utf8')
check('frontmatter is generated with quoted scalars', createdText.includes('name: "created-skill"') && createdText.includes('description: "Created by the contract test"'), createdText)
check('disabled user invocation is written', createdText.includes('user-invocable: false'), createdText)
check('body lands after a blank line', createdText.endsWith('\n\ncreated body\n'), JSON.stringify(createdText.slice(-24)))

const duplicate = await call(harness, `${BASE}/create`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', name: 'created-skill', description: 'dup' },
})
check('duplicate create → 409 NAME_CONFLICT', duplicate.status === 409 && code(duplicate) === 'NAME_CONFLICT', duplicate.json)

const badName = await call(harness, `${BASE}/create`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', name: 'Bad_Name', description: 'x' },
})
check('invalid name → 400 INVALID_NAME', badName.status === 400 && code(badName) === 'INVALID_NAME', badName.json)

const reservedName = await call(harness, `${BASE}/create`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', name: 'con', description: 'x' },
})
check('reserved Windows name → 400 INVALID_NAME', reservedName.status === 400 && code(reservedName) === 'INVALID_NAME', reservedName.json)

const noCwdCreate = await call(harness, `${BASE}/create`, {
  method: 'POST',
  body: { root: 'project', name: 'needs-cwd', description: 'x' },
})
check('project create without cwd → 400 CWD_REQUIRED', noCwdCreate.status === 400 && code(noCwdCreate) === 'CWD_REQUIRED', noCwdCreate.json)

const userCreate = await call(harness, `${BASE}/create`, {
  method: 'POST',
  body: { root: 'user', name: 'user-created', description: 'No session needed', waitMs: 400 },
})
check('user create works without cwd', userCreate.status === 201 && userCreate.json.discovery.state === 'discovered', userCreate.json)
check('user create lands in $DSH_HOME/skills', await exists(join(userSkills, 'user-created', 'SKILL.md')))

await mkdir(join(projectSkills, 'taken'), { recursive: true })
const takenConflict = await call(harness, `${BASE}/create`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', name: 'taken', description: 'x' },
})
check('existing directory → 409', takenConflict.status === 409 && code(takenConflict) === 'NAME_CONFLICT', takenConflict.json)

const oversizedBody = 'z'.repeat(300 * 1024)
const hugeCreate = await call(harness, `${BASE}/create`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', name: 'huge-skill', description: 'too big', body: oversizedBody },
})
check('create body over 256 KiB → 413', hugeCreate.status === 413 && code(hugeCreate) === 'PAYLOAD_TOO_LARGE', hugeCreate.status)
check('rejected oversized create left nothing on disk', !(await exists(join(projectSkills, 'huge-skill'))))

const nonBooleanCreate = await call(harness, `${BASE}/create`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', name: 'bad-boolean', description: 'x', modelInvocable: 'yes' },
})
check('non-boolean modelInvocable on create → 400', nonBooleanCreate.status === 400 && code(nonBooleanCreate) === 'BAD_REQUEST', nonBooleanCreate.json)

await registry.freeze()
const pendingCreate = await call(harness, `${BASE}/create`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', name: 'pending-skill', description: 'pending', waitMs: 120 },
})
registry.thaw()
check('create reports pending without rolling back', pendingCreate.status === 201 && pendingCreate.json.discovery.state === 'pending' && (await exists(join(projectSkills, 'pending-skill', 'SKILL.md'))), pendingCreate.json.discovery)

const [raceA, raceB] = await Promise.all([
  call(harness, `${BASE}/create`, { method: 'POST', body: { cwd: projectRoot, root: 'project', name: 'race-skill', description: 'race' } }),
  call(harness, `${BASE}/create`, { method: 'POST', body: { cwd: projectRoot, root: 'project', name: 'race-skill', description: 'race' } }),
])
const raceCodes = [raceA.status, raceB.status].sort((left, right) => left - right)
check('concurrent create: one 201, one 409', raceCodes[0] === 201 && raceCodes[1] === 409, raceCodes)

/* ---------------------------------------------------------------- 5. update */

section('POST /update')
const alphaDetail = await call(harness, `${BASE}/detail`, {
  query: `cwd=${encodeURIComponent(projectRoot)}&name=alpha`,
})
const update = await call(harness, `${BASE}/update`, {
  method: 'POST',
  body: {
    cwd: projectRoot,
    name: 'alpha',
    description: 'Alpha updated',
    whenToUse: 'when testing',
    modelInvocable: true,
    userInvocable: true,
    body: 'updated body',
    baseMtimeMs: alphaDetail.json.skill.mtimeMs,
    waitMs: 400,
  },
})
check('update 200 discovered', update.status === 200 && update.json.ok === true && update.json.discovery.state === 'discovered', update.json)
const updatedText = await readFile(alphaSkill, 'utf8')
check('description rewritten', updatedText.includes('description: "Alpha updated"'), updatedText)
check('body replaced', updatedText.includes('updated body') && !updatedText.includes('alpha body line one'), updatedText)
check('unknown keys preserved', updatedText.includes('x-custom: keep') && updatedText.includes('metadata:') && updatedText.includes('  owner: bench'), updatedText)
check('comment line preserved', updatedText.includes('# note line'), updatedText)
check('frontmatter rewritten as a valid provider file', parseSkillFile(updatedText) !== null, 'parse failed')

await registry.freeze()
const bodyOnly = await call(harness, `${BASE}/update`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'alpha', description: 'Alpha updated', whenToUse: 'when testing', body: 'body only change', waitMs: 400 },
})
registry.thaw()
check('body-only update skips discovery polling', bodyOnly.status === 200 && bodyOnly.json.discovery.waitedMs === 0, bodyOnly.json)
check('body-only update wrote the new body', (await readFile(alphaSkill, 'utf8')).includes('body only change'))

await writeFile(alphaSkill, `${await readFile(alphaSkill, 'utf8')}\n`, 'utf8')
const staleUpdate = await call(harness, `${BASE}/update`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'alpha', description: 'stale', baseMtimeMs: alphaDetail.json.skill.mtimeMs },
})
check('stale baseMtimeMs → 409 FILE_CHANGED', staleUpdate.status === 409 && code(staleUpdate) === 'FILE_CHANGED', staleUpdate.json)

const beforeRejected = await readFile(alphaSkill, 'utf8')
registry.rejectDescriptionMarker = 'REJECT_ME'
const rejectedUpdate = await call(harness, `${BASE}/update`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'alpha', description: 'REJECT_ME value', body: 'should not stick', waitMs: 200 },
})
registry.rejectDescriptionMarker = null
const restored = await readFile(alphaSkill, 'utf8')
check('provider rejection → 409 VALIDATION_FAILED', rejectedUpdate.status === 409 && code(rejectedUpdate) === 'VALIDATION_FAILED', rejectedUpdate.json)
check('rejected update restores the original file', restored === beforeRejected, restored.slice(0, 120))

await registry.freeze()
const slowUpdate = await call(harness, `${BASE}/update`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'alpha', description: 'slow watcher', body: 'slow body', waitMs: 150 },
})
registry.thaw()
const afterSlow = await readFile(alphaSkill, 'utf8')
check('unobserved frontmatter change → 409 VALIDATION_FAILED', slowUpdate.status === 409 && code(slowUpdate) === 'VALIDATION_FAILED', slowUpdate.json)
check('slow-watcher rollback restores the original file', afterSlow === beforeRejected, afterSlow.slice(0, 120))

/* ------------------------------------------------- M1 / L1 / L2 (update) */

section('update limits, defaults, and current-value baseline')

const beforeHugeUpdate = await readFile(createdFile, 'utf8')
const hugeUpdate = await call(harness, `${BASE}/update`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'created-skill', description: 'too big', body: oversizedBody },
})
check('update body over 256 KiB → 413', hugeUpdate.status === 413 && code(hugeUpdate) === 'PAYLOAD_TOO_LARGE', hugeUpdate.status)
check('rejected oversized update left the file unchanged', (await readFile(createdFile, 'utf8')) === beforeHugeUpdate)

const hugeExistingDir = join(projectSkills, 'huge-existing')
await mkdir(hugeExistingDir, { recursive: true })
const hugeExistingFile = join(hugeExistingDir, 'SKILL.md')
await writeFile(
  hugeExistingFile,
  `---\nname: "huge-existing"\ndescription: "Existing oversized body"\n---\n\n${'q'.repeat(300 * 1024)}\n`,
  'utf8',
)
const beforeHugeOmitted = await readFile(hugeExistingFile, 'utf8')
const hugeOmittedUpdate = await call(harness, `${BASE}/update`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'huge-existing', description: 'changed without body' },
})
check('update with an omitted body still enforces the existing body size', hugeOmittedUpdate.status === 413 && code(hugeOmittedUpdate) === 'PAYLOAD_TOO_LARGE', hugeOmittedUpdate.json)
check('rejected omitted-body update left the file unchanged', (await readFile(hugeExistingFile, 'utf8')) === beforeHugeOmitted)

const switchCreate = await call(harness, `${BASE}/create`, {
  method: 'POST',
  body: {
    cwd: projectRoot,
    root: 'project',
    name: 'switch-skill',
    description: 'Switch skill',
    whenToUse: 'keep me',
    modelInvocable: false,
    userInvocable: false,
    body: 'v1',
    waitMs: 400,
  },
})
check('switch-skill created', switchCreate.status === 201, switchCreate.json)
const switchFile = join(projectSkills, 'switch-skill', 'SKILL.md')
const omittedFieldsUpdate = await call(harness, `${BASE}/update`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'switch-skill', description: 'Switch v2', body: 'v2', waitMs: 400 },
})
check('update omitting invocation/whenToUse succeeds', omittedFieldsUpdate.status === 200, omittedFieldsUpdate.json)
const omittedText = await readFile(switchFile, 'utf8')
check('omitted modelInvocable keeps the disabled policy', omittedText.includes('disable-model-invocation: true'), omittedText)
check('omitted userInvocable keeps the disabled policy', omittedText.includes('user-invocable: false'), omittedText)
check('omitted whenToUse keeps the existing value', omittedText.includes('whenToUse: "keep me"'), omittedText)

const reenableUpdate = await call(harness, `${BASE}/update`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'switch-skill', description: 'Switch v3', whenToUse: '', modelInvocable: true, body: 'v3', waitMs: 400 },
})
check('explicit modelInvocable:true re-enables the model surface', reenableUpdate.status === 200, reenableUpdate.json)
const reenabledText = await readFile(switchFile, 'utf8')
check('disable-model-invocation line removed', !reenabledText.includes('disable-model-invocation'), reenabledText)
check('empty whenToUse clears the field', !reenabledText.includes('whenToUse:'), reenabledText)
check('still-omitted userInvocable stays disabled', reenabledText.includes('user-invocable: false'), reenabledText)

const badBooleanUpdate = await call(harness, `${BASE}/update`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'switch-skill', description: 'x', modelInvocable: 'yes' },
})
check('non-boolean modelInvocable on update → 400', badBooleanUpdate.status === 400 && code(badBooleanUpdate) === 'BAD_REQUEST', badBooleanUpdate.json)

await call(harness, `${BASE}/create`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', name: 'stale-skill', description: 'Snapshot A', whenToUse: 'X', body: 'v1', waitMs: 400 },
})
const staleFile = join(projectSkills, 'stale-skill', 'SKILL.md')
await registry.freeze()
try {
  // Simulate an external edit the watcher has not seen yet: the snapshot below
  // still says "Snapshot A"/"X" while the file says "File B"/"Y".
  await writeFile(
    staleFile,
    '---\nname: "stale-skill"\ndescription: "File B"\nwhenToUse: "Y"\n---\n\nv2\n',
    'utf8',
  )
  const staleDetail = await call(harness, `${BASE}/detail`, {
    query: `cwd=${encodeURIComponent(projectRoot)}&name=stale-skill`,
  })
  check(
    'detail uses the provider current parse, not the stale snapshot',
    staleDetail.status === 200 &&
      staleDetail.json.skill.frontmatter.description === 'File B' &&
      staleDetail.json.skill.frontmatter.whenToUse === 'Y',
    staleDetail.json.skill.frontmatter,
  )
  check('detail body still comes from the file', staleDetail.json.skill.body === 'v2', staleDetail.json.skill.body)
  const staleBaselineUpdate = await call(harness, `${BASE}/update`, {
    method: 'POST',
    body: { cwd: projectRoot, name: 'stale-skill', description: 'File B', body: 'v3', waitMs: 400 },
  })
  check(
    'update baseline uses current values (body-only path, no wait)',
    staleBaselineUpdate.status === 200 && staleBaselineUpdate.json.discovery.waitedMs === 0,
    staleBaselineUpdate.json,
  )
  const staleAfter = await readFile(staleFile, 'utf8')
  check('omitted whenToUse preserved from the current parse', staleAfter.includes('whenToUse: "Y"') && staleAfter.includes('v3'), staleAfter)
} finally {
  registry.thaw()
}

/* ---------------------------------------------------------------- 6. delete */

section('POST /delete')
const missingConfirm = await call(harness, `${BASE}/delete`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'alpha' },
})
check('missing confirmName → 400 CONFIRM_REQUIRED', missingConfirm.status === 400 && code(missingConfirm) === 'CONFIRM_REQUIRED', missingConfirm.json)

const deleteAlpha = await call(harness, `${BASE}/delete`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'alpha', confirmName: 'alpha', waitMs: 400 },
})
check('delete bundle 200 removed', deleteAlpha.status === 200 && deleteAlpha.json.discovery.state === 'removed', deleteAlpha.json)
check('bundle directory removed', !(await exists(join(projectSkills, 'alpha'))))

await writeFile(join(projectSkills, 'flat-one.md'), '---\nname: "flat-one"\ndescription: "Flat skill"\n---\n\nflat body\n', 'utf8')
const flatState = await call(harness, `${BASE}/state`, { query: `cwd=${encodeURIComponent(projectRoot)}` })
const flatRow = flatState.json.skills.find((skill) => skill.name === 'flat-one')
check('flat skill detected as layout flat', Boolean(flatRow) && flatRow.layout === 'flat', flatRow)
const deleteFlat = await call(harness, `${BASE}/delete`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'flat-one', confirmName: 'flat-one', waitMs: 400 },
})
check('delete flat file 200 removed', deleteFlat.status === 200 && !(await exists(join(projectSkills, 'flat-one.md'))), deleteFlat.json)

/* ----------------------------------------------------------- 7. import file */

section('POST /import (file)')
const importContent = '---\nname: "imported-one"\ndescription: "Imported skill"\n---\n\nimported body\n'
const imported = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', mode: 'file', filename: 'imported-one.md', content: importContent, waitMs: 400 },
})
check('import file 201 discovered', imported.status === 201 && imported.json.discovery.state === 'discovered', imported.json)
check('import file written as a bundle', await exists(join(projectSkills, 'imported-one', 'SKILL.md')))

const missingDescription = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', mode: 'file', content: '---\nname: "no-desc"\n---\n\nbody\n', waitMs: 200 },
})
check('missing description → 400 INVALID_FRONTMATTER', missingDescription.status === 400 && code(missingDescription) === 'INVALID_FRONTMATTER', missingDescription.json)
check('rejected import left nothing on disk', !(await exists(join(projectSkills, 'no-desc'))))

const invalidBoolean = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: {
    cwd: projectRoot,
    root: 'project',
    mode: 'file',
    content: '---\nname: "bad-bool"\ndescription: "x"\ndisable-model-invocation: maybe\n---\n\nbody\n',
    waitMs: 150,
  },
})
check('provider-rejected import → 400 and rolled back', invalidBoolean.status === 400 && code(invalidBoolean) === 'INVALID_FRONTMATTER' && !(await exists(join(projectSkills, 'bad-bool'))), invalidBoolean.json)

const bomContent = `\uFEFF---\nname: "bom-skill"\ndescription: "BOM tolerated"\n---\n\nbom body\n`
const bomImport = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', mode: 'file', content: bomContent, waitMs: 400 },
})
const bomText = await readFile(join(projectSkills, 'bom-skill', 'SKILL.md'), 'utf8')
check('BOM stripped on import', bomImport.status === 201 && !bomText.startsWith('\uFEFF'), bomImport.json)

const commentedImport = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: {
    cwd: projectRoot,
    root: 'project',
    mode: 'file',
    content: '---\nname: "commented-name" # trailing comment\ndescription: "with comment" # note\n---\n\nbody\n',
    waitMs: 400,
  },
})
check('quoted scalars with trailing comments are accepted', commentedImport.status === 201, commentedImport.json)

const hugeContent = `---\nname: "huge-skill"\ndescription: "x"\n---\n\n${'z'.repeat(256 * 1024)}`
const hugeImport = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', mode: 'file', content: hugeContent },
})
check('oversized skill body → 413', hugeImport.status === 413 && code(hugeImport) === 'PAYLOAD_TOO_LARGE', hugeImport.status)

/* ------------------------------------------------------ 8. import directory */

section('POST /import (directory)')
const folderRoot = join(tempRoot, 'folder-skill')
await mkdir(join(folderRoot, 'references'), { recursive: true })
await writeFile(join(folderRoot, 'SKILL.md'), '---\nname: "folder-skill"\ndescription: "Folder skill"\n---\n\nfolder body\n', 'utf8')
await writeFile(join(folderRoot, 'references', 'note.txt'), 'resource', 'utf8')
const folderImport = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', mode: 'directory', sourcePath: folderRoot, waitMs: 500 },
})
check('import directory 201 discovered', folderImport.status === 201 && folderImport.json.discovery.state === 'discovered', folderImport.json)
check('directory copied with resources', await exists(join(projectSkills, 'folder-skill', 'references', 'note.txt')))

const noManifestRoot = join(tempRoot, 'no-manifest')
await mkdir(noManifestRoot, { recursive: true })
const noManifest = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', mode: 'directory', sourcePath: noManifestRoot },
})
check('folder without SKILL.md → 400', noManifest.status === 400, noManifest.json)

const reservedFolderRoot = join(tempRoot, 'aux.txt')
await mkdir(reservedFolderRoot, { recursive: true })
await writeFile(join(reservedFolderRoot, 'SKILL.md'), '---\nname: "aux-dir"\ndescription: "reserved"\n---\n', 'utf8')
const reservedFolderImport = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', mode: 'directory', sourcePath: reservedFolderRoot },
})
check(
  'reserved folder name with extension (aux.txt) → 400 INVALID_NAME',
  reservedFolderImport.status === 400 && code(reservedFolderImport) === 'INVALID_NAME',
  reservedFolderImport.json,
)

const missingSource = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', mode: 'directory', sourcePath: join(tempRoot, 'does-not-exist') },
})
check('missing source folder → 400', missingSource.status === 400, missingSource.json)

const deepRoot = join(tempRoot, 'deep-skill')
await mkdir(deepRoot, { recursive: true })
await writeFile(join(deepRoot, 'SKILL.md'), '---\nname: "deep-skill"\ndescription: "x"\n---\n', 'utf8')
let deepPath = deepRoot
for (let level = 0; level < 12; level += 1) {
  deepPath = join(deepPath, `d${level}`)
  await mkdir(deepPath, { recursive: true })
}
const tooDeep = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', mode: 'directory', sourcePath: deepRoot },
})
check('depth limit → 413', tooDeep.status === 413 && code(tooDeep) === 'PAYLOAD_TOO_LARGE', tooDeep.json)

const bigFileRoot = join(tempRoot, 'big-file-skill')
await mkdir(bigFileRoot, { recursive: true })
await writeFile(join(bigFileRoot, 'SKILL.md'), '---\nname: "big-file-skill"\ndescription: "x"\n---\n', 'utf8')
await writeFile(join(bigFileRoot, 'blob.bin'), Buffer.alloc(2 * 1024 * 1024 + 1))
const bigFile = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', mode: 'directory', sourcePath: bigFileRoot },
})
check('single file limit → 413', bigFile.status === 413 && code(bigFile) === 'PAYLOAD_TOO_LARGE', bigFile.json)

const manyFileRoot = join(tempRoot, 'many-file-skill')
await mkdir(manyFileRoot, { recursive: true })
await writeFile(join(manyFileRoot, 'SKILL.md'), '---\nname: "many-file-skill"\ndescription: "x"\n---\n', 'utf8')
for (let index = 0; index < 201; index += 1) {
  await writeFile(join(manyFileRoot, `f${index}.txt`), 'x')
}
const manyFiles = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', mode: 'directory', sourcePath: manyFileRoot },
})
check('file count limit → 413', manyFiles.status === 413 && code(manyFiles) === 'PAYLOAD_TOO_LARGE', manyFiles.json)

const conflictRoot = join(tempRoot, 'conflict-folder')
await mkdir(conflictRoot, { recursive: true })
await writeFile(join(conflictRoot, 'SKILL.md'), '---\nname: "conflict-folder"\ndescription: "x"\n---\n', 'utf8')
await mkdir(join(projectSkills, 'conflict-folder'), { recursive: true })
const conflictImport = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', mode: 'directory', sourcePath: conflictRoot },
})
check('target conflict → 409 NAME_CONFLICT', conflictImport.status === 409 && code(conflictImport) === 'NAME_CONFLICT', conflictImport.json)
check('conflicting target left untouched', (await readdir(join(projectSkills, 'conflict-folder'))).length === 0)

await registry.freeze()
const pendingFolder = join(tempRoot, 'pending-folder')
await mkdir(pendingFolder, { recursive: true })
await writeFile(join(pendingFolder, 'SKILL.md'), '---\nname: "pending-folder"\ndescription: "x"\n---\n', 'utf8')
const pendingImport = await call(harness, `${BASE}/import`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', mode: 'directory', sourcePath: pendingFolder, waitMs: 150 },
})
registry.thaw()
check('unobserved folder import → 400 and rolled back', pendingImport.status === 400 && !(await exists(join(projectSkills, 'pending-folder'))), pendingImport.json)

/* --------------------------------------------------- 9. read-only and safety */

section('read-only sources and path safety')
registry.extras.push({
  name: 'badge-skill',
  description: 'Bundled provider skill',
  provider: 'dsh-badge',
  source: 'bundled',
  rank: 600,
  invocation: { modelInvocable: true, userInvocable: true },
  content: 'bundled body',
})
registry.extras.push({
  name: 'custom-skill',
  description: 'Custom root skill',
  provider: 'filesystem',
  source: 'custom',
  rank: 300,
  invocation: { modelInvocable: true, userInvocable: true },
  path: join(tempRoot, 'custom-root', 'custom-skill', 'SKILL.md'),
})
await mkdir(join(tempRoot, 'custom-root', 'custom-skill'), { recursive: true })
await writeFile(join(tempRoot, 'custom-root', 'custom-skill', 'SKILL.md'), '---\nname: "custom-skill"\ndescription: "Custom root skill"\n---\n', 'utf8')

const readonlyState = await call(harness, `${BASE}/state`, { query: `cwd=${encodeURIComponent(projectRoot)}` })
const badgeRow = readonlyState.json.skills.find((skill) => skill.name === 'badge-skill')
const customRow = readonlyState.json.skills.find((skill) => skill.name === 'custom-skill')
check('bundled skill is read-only', badgeRow && badgeRow.writable === false && badgeRow.readonlyReason === 'bundled', badgeRow)
check('custom root skill is read-only', customRow && customRow.writable === false && customRow.readonlyReason === 'custom', customRow)

const readonlyUpdate = await call(harness, `${BASE}/update`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'badge-skill', description: 'nope' },
})
check('update bundled → 403 READ_ONLY_SKILL', readonlyUpdate.status === 403 && code(readonlyUpdate) === 'READ_ONLY_SKILL', readonlyUpdate.json)

const readonlyDelete = await call(harness, `${BASE}/delete`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'badge-skill', confirmName: 'badge-skill' },
})
check('delete bundled → 403 READ_ONLY_SKILL', readonlyDelete.status === 403 && code(readonlyDelete) === 'READ_ONLY_SKILL', readonlyDelete.json)

const outsideRoot = join(tempRoot, 'outside-root')
await mkdir(join(outsideRoot, 'escaped'), { recursive: true })
await writeFile(join(outsideRoot, 'escaped', 'SKILL.md'), '---\nname: "escaped"\ndescription: "outside"\n---\n', 'utf8')
registry.extras.push({
  name: 'escaped',
  description: 'Outside the writable root',
  provider: 'filesystem',
  source: 'project-agents',
  rank: 200,
  invocation: { modelInvocable: true, userInvocable: true },
  path: join(outsideRoot, 'escaped', 'SKILL.md'),
})
const escapedState = await call(harness, `${BASE}/state`, { query: `cwd=${encodeURIComponent(projectRoot)}` })
const escapedRow = escapedState.json.skills.find((skill) => skill.name === 'escaped')
check('path outside the writable root is read-only', escapedRow && escapedRow.writable === false && escapedRow.readonlyReason === 'outside-root', escapedRow)
const escapedDelete = await call(harness, `${BASE}/delete`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'escaped', confirmName: 'escaped' },
})
check('delete outside the root → 403', escapedDelete.status === 403, escapedDelete.json)

// ---- B1: a discovered catalog path must never move the user writable root --

const userRootReal = await realpath(userSkills)

// Real-path fallback (no junction needed) for the B1 boundary itself.
const realOutsideUser = join(tempRoot, 'outside-user-real', 'user-outside')
await mkdir(realOutsideUser, { recursive: true })
await writeFile(join(realOutsideUser, 'SKILL.md'), '---\nname: "user-outside"\ndescription: "Outside the user root"\n---\n', 'utf8')
registry.extras.push({
  name: 'user-outside',
  description: 'Outside the user root',
  provider: 'filesystem',
  source: 'user-dsh',
  rank: 400,
  invocation: { modelInvocable: true, userInvocable: true },
  path: join(realOutsideUser, 'SKILL.md'),
})
const b1State = await call(harness, `${BASE}/state`, { query: `cwd=${encodeURIComponent(projectRoot)}` })
const userRootRow = b1State.json.roots.find((root) => root.key === 'user')
check('B1: state keeps the user root fixed at $DSH_HOME/skills', userRootRow && userRootRow.path === userSkills, userRootRow)
const outsideUserRow = b1State.json.skills.find((skill) => skill.name === 'user-outside')
check(
  'B1: a catalog path outside the user root is read-only outside-root',
  outsideUserRow && outsideUserRow.writable === false && outsideUserRow.readonlyReason === 'outside-root',
  outsideUserRow,
)
const outsideUserUpdate = await call(harness, `${BASE}/update`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'user-outside', description: 'nope' },
})
check('B1: updating an outside user-root skill → 403', outsideUserUpdate.status === 403 && code(outsideUserUpdate) === 'READ_ONLY_SKILL', outsideUserUpdate.json)
const outsideUserDelete = await call(harness, `${BASE}/delete`, {
  method: 'POST',
  body: { cwd: projectRoot, name: 'user-outside', confirmName: 'user-outside' },
})
check('B1: deleting an outside user-root skill → 403', outsideUserDelete.status === 403 && code(outsideUserDelete) === 'READ_ONLY_SKILL', outsideUserDelete.json)
check('B1: the outside user-root file survived both refusals', await exists(join(realOutsideUser, 'SKILL.md')))

// Junction variant: the exact attack the review reproduced.
const outsideSkills = join(tempRoot, 'outside-user', 'skills')
const hijackTarget = join(outsideSkills, 'hijack')
await mkdir(hijackTarget, { recursive: true })
await writeFile(join(hijackTarget, 'SKILL.md'), '---\nname: "hijack"\ndescription: "Junction target"\n---\n\noutside body\n', 'utf8')
const userJunctionError = await tryJunction(hijackTarget, join(userSkills, 'hijack'))
check('B1: junction creation works for the user-root security test', userJunctionError === null, userJunctionError && userJunctionError.code)
if (userJunctionError === null) {
  const junctionState = await call(harness, `${BASE}/state`, { query: `cwd=${encodeURIComponent(projectRoot)}` })
  const hijackRow = junctionState.json.skills.find((skill) => skill.name === 'hijack')
  check(
    'B1 junction: a catalog path reached through the junction is read-only outside-root',
    hijackRow && hijackRow.writable === false && hijackRow.readonlyReason === 'outside-root',
    hijackRow,
  )
  const hijackDelete = await call(harness, `${BASE}/delete`, {
    method: 'POST',
    body: { cwd: projectRoot, name: 'hijack', confirmName: 'hijack' },
  })
  check('B1 junction: delete is refused', hijackDelete.status === 403 && code(hijackDelete) === 'READ_ONLY_SKILL', hijackDelete.json)
  check('B1 junction: the external target survived', await exists(join(hijackTarget, 'SKILL.md')))
}

const createdInUserRoot = await call(harness, `${BASE}/create`, {
  method: 'POST',
  body: { root: 'user', name: 'created-in-user-root', description: 'created inside the fixed root', body: 'x', waitMs: 400 },
})
check(
  'B1: create(root:user) lands in $DSH_HOME/skills, not the junction target',
  createdInUserRoot.status === 201 && String(createdInUserRoot.json.path) === join(userRootReal, 'created-in-user-root', 'SKILL.md'),
  createdInUserRoot.json,
)
check('B1: the junction target did not receive the new skill', !(await exists(join(outsideSkills, 'created-in-user-root'))))

// Project-root junction: same class of boundary, other writable root.
const outsideProjectDir = join(tempRoot, 'outside-project', 'ext-linked')
await mkdir(outsideProjectDir, { recursive: true })
await writeFile(join(outsideProjectDir, 'SKILL.md'), '---\nname: "ext-linked"\ndescription: "Project junction target"\n---\n', 'utf8')
const projectJunctionError = await tryJunction(outsideProjectDir, join(projectSkills, 'ext-junction'))
check('M3: junction creation works for the project-root security test', projectJunctionError === null, projectJunctionError && projectJunctionError.code)
if (projectJunctionError === null) {
  const projectJunctionState = await call(harness, `${BASE}/state`, { query: `cwd=${encodeURIComponent(projectRoot)}` })
  const extLinkedRow = projectJunctionState.json.skills.find((skill) => skill.name === 'ext-linked')
  check(
    'M3: a project catalog path reached through the junction is read-only outside-root',
    extLinkedRow && extLinkedRow.writable === false && extLinkedRow.readonlyReason === 'outside-root',
    extLinkedRow,
  )
  const extLinkedDelete = await call(harness, `${BASE}/delete`, {
    method: 'POST',
    body: { cwd: projectRoot, name: 'ext-linked', confirmName: 'ext-linked' },
  })
  check('M3: delete through the project junction is refused', extLinkedDelete.status === 403 && code(extLinkedDelete) === 'READ_ONLY_SKILL', extLinkedDelete.json)
  check('M3: the project junction target survived', await exists(join(outsideProjectDir, 'SKILL.md')))
}

/* --------------------------------------------------------------- M4 (rename) */

section('rename retry (M4)')

const retrySource = join(tempRoot, 'rename-retry-source.txt')
await writeFile(retrySource, 'retry', 'utf8')
const retryTarget = join(tempRoot, 'rename-retry-target.txt')
let transientAttempts = 0
await renameWithRetry(retrySource, retryTarget, {
  renameImpl: async (source, destination) => {
    transientAttempts += 1
    if (transientAttempts < 4) {
      const error = new Error('locked')
      error.code = 'EPERM'
      throw error
    }
    await rename(source, destination)
  },
})
check('transient EPERM retries three times then succeeds', transientAttempts === 4 && (await exists(retryTarget)), transientAttempts)

let exhaustedAttempts = 0
let exhaustedError
try {
  await renameWithRetry(join(tempRoot, 'never-source'), join(tempRoot, 'never-target'), {
    renameImpl: async () => {
      exhaustedAttempts += 1
      const error = new Error('busy')
      error.code = 'EBUSY'
      throw error
    },
  })
} catch (error) {
  exhaustedError = error
}
check(
  'exhausted rename returns a structured IO_ERROR',
  exhaustedError instanceof SkillError && exhaustedError.code === 'IO_ERROR' && exhaustedError.detail && exhaustedError.detail.errno === 'EBUSY',
  exhaustedError && { code: exhaustedError.code, detail: exhaustedError.detail },
)
check('exhausted rename attempted once plus three retries', exhaustedAttempts === 4, exhaustedAttempts)

let fastFailAttempts = 0
try {
  await renameWithRetry(join(tempRoot, 'never-source-2'), join(tempRoot, 'never-target-2'), {
    renameImpl: async () => {
      fastFailAttempts += 1
      const error = new Error('exists')
      error.code = 'EEXIST'
      throw error
    },
  })
} catch {
  /* expected */
}
check('non-retryable rename fails on the first attempt', fastFailAttempts === 1, fastFailAttempts)

/* -------------------------------------------------------- 10. mounted = false */

section('preset without the filesystem provider')
const unmounted = createHarness({ mounted: false })
const unmountedState = await call(unmounted, `${BASE}/state`, { query: `cwd=${encodeURIComponent(projectRoot)}` })
check('mounted false is reported', unmountedState.json.ok === true && unmountedState.json.mounted === false, unmountedState.json.mounted)
check('unmounted roots are not writable', unmountedState.json.roots.every((root) => root.writable === false), unmountedState.json.roots)
const unmountedCreate = await call(unmounted, `${BASE}/create`, {
  method: 'POST',
  body: { cwd: projectRoot, root: 'project', name: 'blocked', description: 'x' },
})
check('write without the provider → 503 NOT_MOUNTED', unmountedCreate.status === 503 && code(unmountedCreate) === 'NOT_MOUNTED', unmountedCreate.json)
unmounted.dispose()

/* ------------------------------------------------------------------- report */

harness.dispose()
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) console.log(`failed checks: ${failures.join(' | ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
