/**
 * dsh-skill-manager — host-side skill catalog and safe filesystem mutations.
 *
 * Everything in this module is plain Node: it imports only `node:` builtins so
 * the bundle can be installed as a linked local package with zero third-party
 * dependencies. Two hard-won facts shape the design (see the approved design
 * document):
 *
 * 1. The Web profile disables `@deepseek-ai/dsh-skill-filesystem` at the host
 *    plane; the filesystem provider only exists inside an agent preset's scope.
 *    Reads therefore go through `agentPresets.acquireScope(presetId)` and
 *    `ctx.skills.snapshot({ cwd, scope })`, never through a bare `cwd` view.
 * 2. The skill registry has no TTL: only a provider `invalidate()` (driven by
 *    its chokidar watcher) clears the catalog cache. Our own `node:fs` writes
 *    do not emit the `fs/observed` event the provider listens to for tool
 *    writes, so write confirmation must poll `snapshot()` (or wake on the
 *    `skills/change` event) until the watcher invalidates the catalog.
 *
 * The module deliberately does not parse YAML. Writes build frontmatter from
 * scalars the host controls; the provider's own discovery is the authority on
 * whether the result is acceptable, and edits/imports roll back when it is not.
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Public kebab-case skill-name grammar (mirrors @deepseek-ai/dsh-skill). */
export const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NAME_MAX_LENGTH = 64
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
// Directory segments may carry an extension (`aux.txt` is still reserved on
// Windows), so the reserved check must tolerate a suffix (review L4).
const RESERVED_WINDOWS_DIRECTORY_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const RENAME_RETRY_DELAYS_MS = Object.freeze([50, 100, 200])
const RENAME_RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const FILESYSTEM_PROVIDER = '@deepseek-ai/dsh-skill-filesystem'
const WINDOWS = process.platform === 'win32'

/** Limits shared with the HTTP layer and the browser half. */
export const LIMITS = Object.freeze({
  bodyBytes: 256 * 1024,
  readBodyBytes: 16 * 1024,
  writeBodyBytes: 1024 * 1024,
  descriptionMax: 1024,
  whenToUseMax: 1024,
  importFiles: 200,
  importFileBytes: 2 * 1024 * 1024,
  importTotalBytes: 10 * 1024 * 1024,
  importDepth: 10,
  waitMsDefault: 2500,
  waitMsMax: 5000,
  discoveryPollMs: 100,
})

/** An error carrying a stable HTTP status and machine-readable code. */
export class SkillError extends Error {
  constructor(code, status, message, detail) {
    super(message)
    this.name = 'SkillError'
    this.code = code
    this.status = status
    if (detail !== undefined) this.detail = detail
  }
}

/* ------------------------------------------------------------------ helpers */

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return WINDOWS ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Whether `target` is strictly below `root` (the root itself is not inside). */
function isInside(root, target) {
  if (!root || !target) return false
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function sleep(ms) {
  return new Promise((done) => {
    setTimeout(done, ms)
  })
}

async function pathInfo(target) {
  try {
    return await lstat(target)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}

async function realpathOrNull(target) {
  try {
    return await realpath(target)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

function expandHome(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return resolve(text)
}

/** `$DSH_HOME` with the harness default, mirroring @deepseek-ai/dsh-home-paths. */
export function resolveDshHome() {
  return expandHome(process.env.DSH_HOME) || join(homedir(), '.dsh')
}

function userSkillRoot() {
  return join(resolveDshHome(), 'skills')
}

/** The nearest ancestor containing `.git`, else the resolved cwd itself. */
export async function findProjectRoot(cwd) {
  let current = resolve(cwd)
  for (;;) {
    try {
      await access(join(current, '.git'))
      return current
    } catch {
      /* keep walking up */
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/* -------------------------------------------------------------- validation */

/** Validate a public skill name. */
export function assertSkillName(value) {
  if (typeof value !== 'string') {
    throw new SkillError('INVALID_NAME', 400, 'skill name must be a string')
  }
  const name = value.trim()
  if (!name) throw new SkillError('INVALID_NAME', 400, 'skill name must not be empty')
  if (name.length > NAME_MAX_LENGTH) {
    throw new SkillError('INVALID_NAME', 400, `skill name must be at most ${NAME_MAX_LENGTH} characters`)
  }
  if (!NAME_PATTERN.test(name)) {
    throw new SkillError('INVALID_NAME', 400, 'skill name must be kebab-case (a-z, 0-9 and single dashes)')
  }
  if (RESERVED_WINDOWS_NAME.test(name)) {
    throw new SkillError('INVALID_NAME', 400, `skill name "${name}" is reserved on Windows`)
  }
  return name
}

function singleLine(value, field, { required = false, maxLength = 1024 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new SkillError('BAD_REQUEST', 400, `${field} is required`)
    return ''
  }
  if (typeof value !== 'string') {
    throw new SkillError('BAD_REQUEST', 400, `${field} must be a string`)
  }
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (!text) {
    if (required) throw new SkillError('BAD_REQUEST', 400, `${field} must not be empty`)
    return ''
  }
  if (/[\n\r]/.test(text)) {
    throw new SkillError('BAD_REQUEST', 400, `${field} must be a single line`)
  }
  if (text.length > maxLength) {
    throw new SkillError('PAYLOAD_TOO_LARGE', 413, `${field} exceeds ${maxLength} characters`)
  }
  return text
}

function normalizeBody(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new SkillError('BAD_REQUEST', 400, 'body must be a string')
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '')
}

/** Enforce the 256 KiB instruction-body ceiling before anything touches disk. */
function assertBodySize(body) {
  const bytes = Buffer.byteLength(String(body ?? ''), 'utf8')
  if (bytes > LIMITS.bodyBytes) {
    throw new SkillError(
      'PAYLOAD_TOO_LARGE',
      413,
      `the skill body is limited to ${LIMITS.bodyBytes} bytes (got ${bytes})`,
    )
  }
}

function booleanField(value, field) {
  if (typeof value !== 'boolean') {
    throw new SkillError('BAD_REQUEST', 400, `${field} must be a boolean when provided`)
  }
  return value
}

function hasField(input, key) {
  return Boolean(input) && Object.prototype.hasOwnProperty.call(input, key)
}

/** Validate `cwd`: absolute, existing directory, canonical real path. */
export async function validateCwd(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SkillError('BAD_REQUEST', 400, 'cwd must be a non-empty absolute path')
  }
  if (!isAbsolute(value)) throw new SkillError('BAD_REQUEST', 400, 'cwd must be an absolute path')
  let info
  try {
    info = await stat(value)
  } catch {
    throw new SkillError('BAD_REQUEST', 400, 'cwd does not exist or is not readable')
  }
  if (!info.isDirectory()) throw new SkillError('BAD_REQUEST', 400, 'cwd must be a directory')
  return realpath(value)
}

/* ------------------------------------------------------------- frontmatter */

/**
 * Split a skill file into frontmatter lines and body without parsing YAML.
 * Mirrors the provider's delimiter rules: the first line must be exactly `---`
 * (a lone trailing CR is tolerated) and a later `---` line closes the block.
 */
export function splitFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  const lines = text.split('\n')
  if ((lines[0] ?? '').replace(/\r$/, '') !== '---') return null
  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/\r$/, '') === '---') {
      close = index
      break
    }
  }
  if (close < 0) return null
  return {
    frontmatterLines: lines.slice(1, close).map((line) => line.replace(/\r$/, '')),
    body: lines.slice(close + 1).join('\n'),
  }
}

const REWRITTEN_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'whenToUse',
  'disable-model-invocation',
  'user-invocable',
  'disableModelInvocation',
  'modelInvocable',
  'userInvocable',
])

/** A YAML double-quoted scalar made from a JSON string (valid YAML 1.2). */
function yamlScalar(value) {
  return JSON.stringify(String(value))
}

function canonicalFrontmatterLines({ name, description, whenToUse, modelInvocable, userInvocable }) {
  const lines = [`name: ${yamlScalar(name)}`, `description: ${yamlScalar(description)}`]
  if (whenToUse) lines.push(`whenToUse: ${yamlScalar(whenToUse)}`)
  if (modelInvocable === false) lines.push('disable-model-invocation: true')
  if (userInvocable === false) lines.push('user-invocable: false')
  return lines
}

/** Compose a brand-new skill file. */
export function composeSkillFile(fields, body) {
  const normalized = normalizeBody(body)
  const head = `---\n${canonicalFrontmatterLines(fields).join('\n')}\n---\n`
  return normalized ? `${head}\n${normalized}\n` : head
}

/**
 * Rebuild known frontmatter keys while keeping every unknown key verbatim
 * (including `metadata` and comments). Line-based on purpose: no YAML parser.
 */
export function rewriteFrontmatter(raw, fields, body) {
  const parsed = splitFrontmatter(raw)
  if (!parsed) {
    throw new SkillError('VALIDATION_FAILED', 409, 'the instruction file has no readable YAML frontmatter')
  }
  const blocks = []
  let current = null
  for (const line of parsed.frontmatterLines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      if (current) current.lines.push(line)
      else blocks.push({ kind: 'blank', lines: [''] })
      continue
    }
    if (/^\s*#/.test(line) && current === null) {
      blocks.push({ kind: 'comment', lines: [line] })
      continue
    }
    if (/^\S/.test(line)) {
      const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line)
      const key = match ? match[1] : undefined
      current = { kind: key && REWRITTEN_FRONTMATTER_KEYS.has(key) ? 'known' : 'unknown', lines: [line] }
      blocks.push(current)
      continue
    }
    if (current) current.lines.push(line)
    else blocks.push({ kind: 'unknown', lines: [line] })
  }

  const canonical = canonicalFrontmatterLines(fields)
  const output = []
  let inserted = false
  for (const block of blocks) {
    if (block.kind === 'known') {
      if (!inserted) {
        output.push(...canonical)
        inserted = true
      }
      continue
    }
    output.push(...block.lines)
  }
  if (!inserted) output.push(...canonical)
  while (output.length > 0 && output[output.length - 1].trim() === '') output.pop()

  const normalized = body === undefined ? normalizeBody(parsed.body) : normalizeBody(body)
  const head = `---\n${output.join('\n')}\n---\n`
  return normalized ? `${head}\n${normalized}\n` : head
}

function parseScalar(raw) {
  let value = String(raw ?? '').trim()
  if (!value) return ''
  if (value.startsWith('"')) {
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] === '\\') {
        index += 1
        continue
      }
      if (value[index] === '"') {
        try {
          return String(JSON.parse(value.slice(0, index + 1)))
        } catch {
          return value.slice(1, index)
        }
      }
    }
    return value
  }
  if (value.startsWith("'")) {
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] !== "'") continue
      if (value[index + 1] === "'") {
        index += 1
        continue
      }
      return value.slice(1, index).replace(/''/g, "'")
    }
    return value.slice(1)
  }
  const comment = /\s#/.exec(value)
  if (comment) value = value.slice(0, comment.index).trim()
  return value
}

/**
 * Cheap pre-write check for imported files: delimiters, `name:` and
 * `description:` lines, kebab-case name. The provider's discovery remains the
 * authority on everything else (booleans, block scalars, duplicate keys).
 */
export function checkFrontmatterShallow(content) {
  const parsed = splitFrontmatter(content)
  if (!parsed) {
    throw new SkillError('INVALID_FRONTMATTER', 400, 'the file must start with a YAML frontmatter block delimited by ---')
  }
  const find = (key) => {
    const pattern = new RegExp(`^${key}\\s*:(.*)$`)
    for (const line of parsed.frontmatterLines) {
      const match = pattern.exec(line.trim())
      if (match) return match[1]
    }
    return undefined
  }
  const rawName = find('name')
  const rawDescription = find('description')
  if (rawName === undefined) {
    throw new SkillError('INVALID_FRONTMATTER', 400, 'frontmatter requires a name field')
  }
  const name = parseScalar(rawName)
  if (!name || name.length > NAME_MAX_LENGTH || !NAME_PATTERN.test(name) || RESERVED_WINDOWS_NAME.test(name)) {
    throw new SkillError('INVALID_FRONTMATTER', 400, 'frontmatter name must be kebab-case (a-z, 0-9 and single dashes)')
  }
  if (rawDescription === undefined || parseScalar(rawDescription) === '') {
    throw new SkillError('INVALID_FRONTMATTER', 400, 'frontmatter requires a description field')
  }
  return { name }
}

/* --------------------------------------------------------------- the view */

function catalogEntryToSummary(entry) {
  if (!entry || typeof entry.name !== 'string' || !NAME_PATTERN.test(entry.name)) return undefined
  if (typeof entry.description !== 'string' || entry.description.length === 0) return undefined
  const summary = {
    name: entry.name,
    description: entry.description,
    provider: 'unknown',
    source: 'unknown',
    invocation: {
      modelInvocable: entry.modelInvocable !== false,
      userInvocable: true,
    },
  }
  if (typeof entry.whenToUse === 'string' && entry.whenToUse) summary.whenToUse = entry.whenToUse
  if (typeof entry.path === 'string' && entry.path) summary.path = entry.path
  return summary
}

async function resolvePresetInfo(ctx, presets, sessionId) {
  const info = { id: null, source: 'default' }
  if (!presets || typeof presets.resolve !== 'function') return info
  if (sessionId) {
    const sessions = ctx.get('sessions')
    if (sessions && typeof sessions.get === 'function' && typeof presets.presetForSession === 'function') {
      try {
        const session = sessions.get(sessionId)
        if (session) {
          const recorded = presets.presetForSession(session)
          if (typeof recorded === 'string' && recorded) {
            info.id = recorded
            info.source = 'session'
          }
        }
      } catch {
        /* fall through to the deployment default */
      }
    }
  }
  if (!info.id) {
    try {
      const preset = await presets.resolve()
      if (preset && typeof preset.id === 'string' && preset.id) info.id = preset.id
    } catch {
      /* the caller reports PRESET_SCOPE_UNAVAILABLE */
    }
  }
  return info
}

async function detectMounted(presets, presetId) {
  if (!presets || typeof presets.compositionInventory !== 'function') return null
  try {
    const inventory = await presets.compositionInventory()
    const rows = Array.isArray(inventory) ? inventory : []
    const preset = presetId ? rows.find((item) => item && item.id === presetId) : undefined
    if (!preset) return null
    if (preset.broken) return false
    const pluginRows = Array.isArray(preset.rows) ? preset.rows : []
    return pluginRows.some(
      (row) => row && row.moduleName === FILESYSTEM_PROVIDER && row.enabled !== false,
    )
  } catch {
    return null
  }
}

function fallbackState(ctx, sessionId, presetInfo) {
  const catalog = ctx.get('sessionSkillCatalog')
  if (catalog && typeof catalog.list === 'function' && sessionId) {
    return { mode: 'catalog', catalog, presetInfo, mounted: null, degraded: true }
  }
  throw new SkillError(
    'PRESET_SCOPE_UNAVAILABLE',
    503,
    'the agent preset registry is unavailable, so skills cannot be read',
  )
}

async function resolveScopeState(ctx, presets, sessionId) {
  const presetInfo = await resolvePresetInfo(ctx, presets, sessionId)
  if (presets && typeof presets.acquireScope === 'function') {
    try {
      const lease = await presets.acquireScope(presetInfo.id ?? undefined)
      const mounted = await detectMounted(presets, presetInfo.id)
      return { mode: 'scope', lease, presetInfo, mounted, degraded: false }
    } catch (error) {
      if (sessionId) {
        try {
          return fallbackState(ctx, sessionId, presetInfo)
        } catch {
          throw new SkillError(
            'PRESET_SCOPE_UNAVAILABLE',
            503,
            'the agent preset scope could not be acquired',
            { reason: error instanceof Error ? error.message : String(error) },
          )
        }
      }
      throw new SkillError(
        'PRESET_SCOPE_UNAVAILABLE',
        503,
        'the agent preset scope could not be acquired',
        { reason: error instanceof Error ? error.message : String(error) },
      )
    }
  }
  return fallbackState(ctx, sessionId, presetInfo)
}

async function disposeScopeState(state) {
  if (!state || state.mode !== 'scope' || !state.lease) return
  const lease = state.lease
  try {
    const dispose = lease[Symbol.asyncDispose]
    if (typeof dispose === 'function') await dispose.call(lease)
  } catch {
    /* releasing a revision lease must never fail the request */
  }
}

/** Take one snapshot through whichever catalog path this view resolved to. */
async function snapshotOf(view) {
  if (view.mode === 'catalog') {
    const value = await view.catalog.list(
      { sessionId: view.sessionId },
      view.signal ?? new AbortController().signal,
    )
    const skills = Array.isArray(value && value.skills)
      ? value.skills.map(catalogEntryToSummary).filter(Boolean)
      : []
    return { skills, complete: true, degraded: true }
  }
  const options = {}
  if (view.cwd) options.cwd = view.cwd
  if (view.scope) options.scope = view.scope
  if (view.signal) options.signal = view.signal
  const snapshot = await view.skills.snapshot(options)
  return {
    skills: Array.isArray(snapshot && snapshot.skills) ? snapshot.skills : [],
    complete: !snapshot || snapshot.complete !== false,
    degraded: false,
  }
}

/**
 * Acquire the preset scope, take the initial snapshot, run `fn(view)` and
 * release the lease. All handlers share this: it is the only place a ScopeKey
 * exists, and it never leaves the host.
 *
 * `view.userRoot` is deliberately fixed to `$DSH_HOME/skills` and never
 * derived from a discovered catalog path: a catalog path is a real path, so a
 * symlink or junction inside the user root could otherwise redirect writes and
 * deletes outside it (review B1). A profile that configures a non-default
 * `dshHome` fails closed: its skills resolve outside the fixed root and stay
 * read-only.
 */
export async function withSkillView(ctx, options, fn) {
  const skills = ctx.get('skills')
  if (!skills || typeof skills.snapshot !== 'function' || typeof skills.get !== 'function') {
    throw new SkillError('SKILLS_UNAVAILABLE', 503, 'the skill registry is not available in this profile')
  }
  const sessionId = typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : undefined
  const cwd = typeof options.cwd === 'string' && options.cwd ? await validateCwd(options.cwd) : null
  const presets = ctx.get('agentPresets')
  const scopeState = await resolveScopeState(ctx, presets, sessionId)
  const view = {
    ctx,
    skills,
    cwd,
    sessionId,
    signal: options.signal,
    mode: scopeState.mode,
    scope: scopeState.mode === 'scope' ? scopeState.lease && scopeState.lease.key : undefined,
    catalog: scopeState.catalog,
    lease: scopeState.lease,
    presetInfo: scopeState.presetInfo,
    mounted: scopeState.mounted,
    degraded: Boolean(scopeState.degraded),
    projectRoot: cwd ? await findProjectRoot(cwd) : null,
    userRoot: userSkillRoot(),
    initial: null,
  }
  try {
    view.initial = await snapshotOf(view)
    return await fn(view)
  } finally {
    await disposeScopeState(scopeState)
  }
}

/* ------------------------------------------------------- writability rules */

const READ_ONLY_SOURCE_REASON = Object.freeze({
  bundled: 'bundled',
  runtime: 'runtime',
  custom: 'custom',
  'project-dsh': 'project-dsh',
  'user-agents': 'user-agents',
})

function projectSkillRoot(view) {
  return view.projectRoot ? join(view.projectRoot, '.agents', 'skills') : null
}

async function writableCandidates(view, source) {
  const candidates = []
  const project = projectSkillRoot(view)
  if (source === 'project-agents' || source === 'unknown') {
    if (project) candidates.push({ rootKey: 'project', root: project })
  }
  if (source === 'user-dsh' || source === 'unknown') {
    candidates.push({ rootKey: 'user', root: view.userRoot })
  }
  return candidates
}

/** Evaluate one registry summary into the browser-facing row. */
async function evaluateSkill(view, summary) {
  const row = {
    name: summary.name,
    description: summary.description,
    provider: summary.provider,
    source: summary.source,
    invocation: {
      modelInvocable: !summary.invocation || summary.invocation.modelInvocable !== false,
      userInvocable: !summary.invocation || summary.invocation.userInvocable !== false,
    },
    writable: false,
  }
  if (summary.whenToUse) row.whenToUse = summary.whenToUse
  if (typeof summary.path === 'string' && summary.path) {
    row.path = summary.path
    row.layout = basename(summary.path) === 'SKILL.md' ? 'directory' : 'flat'
  } else {
    row.layout = 'provider'
  }

  if (view.mounted === false) {
    row.readonlyReason = 'not-mounted'
    return row
  }
  const sourceReason = READ_ONLY_SOURCE_REASON[row.source]
  if (sourceReason) {
    row.readonlyReason = sourceReason
    return row
  }
  if (!row.path) {
    row.readonlyReason = 'no-path'
    return row
  }

  const candidates = await writableCandidates(view, row.source)
  if (candidates.length === 0) {
    row.readonlyReason = row.source === 'project-agents' ? 'no-cwd' : 'unknown'
    return row
  }

  const targetReal = await realpathOrNull(row.path)
  if (!targetReal) {
    row.readonlyReason = 'missing'
    return row
  }
  for (const candidate of candidates) {
    const rootReal = await realpathOrNull(candidate.root)
    if (!rootReal || !isInside(rootReal, targetReal)) continue
    const fileInfo = await pathInfo(row.path)
    if (fileInfo && fileInfo.isSymbolicLink()) {
      row.readonlyReason = 'symlink'
      return row
    }
    if (row.layout === 'directory') {
      const parentInfo = await pathInfo(dirname(row.path))
      if (parentInfo && parentInfo.isSymbolicLink()) {
        row.readonlyReason = 'symlink'
        return row
      }
    }
    try {
      const info = await stat(targetReal)
      row.writable = true
      row.rootKey = candidate.rootKey
      row.rootReal = rootReal
      row.realPath = targetReal
      row.bytes = info.size
      row.mtimeMs = Math.round(info.mtimeMs)
      row.etag = `${row.mtimeMs}:${info.size}`
    } catch {
      row.readonlyReason = 'missing'
    }
    return row
  }
  row.readonlyReason = 'outside-root'
  return row
}

/** Strip host-only fields (absolute root spellings) before a row leaves the process. */
function publicRow(row) {
  const { realPath, rootReal, ...rest } = row
  return rest
}

/**
 * Load the provider's *current* parsed view of one skill. Definitions are never
 * cached by the registry, so this is fresher than the discovery snapshot when a
 * watcher lags (review L2). Returns undefined when the scope or load is not
 * available; callers fall back to the snapshot values.
 */
async function loadCurrentDefinition(view, name) {
  if (view.mode !== 'scope' || typeof view.skills.get !== 'function') {
    return { available: false, definition: undefined }
  }
  try {
    const options = {}
    if (view.cwd) options.cwd = view.cwd
    if (view.scope) options.scope = view.scope
    if (view.signal) options.signal = view.signal
    return { available: true, definition: await view.skills.get(name, options) }
  } catch {
    return { available: true, definition: undefined }
  }
}

/** Frontmatter values to display or use as an edit baseline. */
function currentFields(definition, fallbackRow) {
  if (definition) {
    return {
      description: typeof definition.description === 'string' ? definition.description : '',
      whenToUse: typeof definition.whenToUse === 'string' ? definition.whenToUse : '',
      modelInvocable: !definition.invocation || definition.invocation.modelInvocable !== false,
      userInvocable: !definition.invocation || definition.invocation.userInvocable !== false,
    }
  }
  return {
    description: typeof fallbackRow.description === 'string' ? fallbackRow.description : '',
    whenToUse: typeof fallbackRow.whenToUse === 'string' ? fallbackRow.whenToUse : '',
    modelInvocable: fallbackRow.invocation.modelInvocable,
    userInvocable: fallbackRow.invocation.userInvocable,
  }
}

function assertWritableContext(view) {
  if (view.mounted === false) {
    throw new SkillError(
      'NOT_MOUNTED',
      503,
      'the active agent preset does not mount the filesystem skill provider; skill writes are disabled',
    )
  }
}

async function writableRootFor(view, rootKey) {
  if (rootKey === 'project') {
    const root = projectSkillRoot(view)
    if (!view.cwd || !root) {
      throw new SkillError('CWD_REQUIRED', 400, 'writing to the project skill root needs the current working directory')
    }
    return { key: 'project', path: root }
  }
  if (rootKey === 'user') {
    return { key: 'user', path: view.userRoot }
  }
  throw new SkillError('BAD_REQUEST', 400, 'root must be "project" or "user"')
}

async function assertNoNameConflict(view, name, rootReal, extraSegments) {
  const skills = view.initial && Array.isArray(view.initial.skills) ? view.initial.skills : []
  if (skills.some((entry) => entry && entry.name === name)) {
    throw new SkillError('NAME_CONFLICT', 409, `a skill named "${name}" already exists in this view`)
  }
  const segments = [name, `${name}.md`, ...(extraSegments ?? [])]
  for (const segment of segments) {
    const info = await pathInfo(join(rootReal, segment))
    if (info) {
      throw new SkillError('NAME_CONFLICT', 409, `"${join(rootReal, segment)}" already exists`)
    }
  }
}

function assertEtagMatches(input, info) {
  const expected = input && input.etag !== undefined ? input.etag : input && input.baseMtimeMs
  if (expected === undefined || expected === null || expected === '') return
  const mtimeMs = Math.round(info.mtimeMs)
  if (typeof expected === 'number') {
    if (Math.round(expected) !== mtimeMs) {
      throw new SkillError('FILE_CHANGED', 409, 'the skill file changed since it was read; reload and try again')
    }
    return
  }
  if (typeof expected === 'string') {
    if (expected !== `${mtimeMs}:${info.size}`) {
      throw new SkillError('FILE_CHANGED', 409, 'the skill file changed since it was read; reload and try again')
    }
    return
  }
  throw new SkillError('BAD_REQUEST', 400, 'baseMtimeMs/etag must be a number or a string')
}

function ioError(error) {
  if (error instanceof SkillError) return error
  const errno = error && typeof error.code === 'string' ? error.code : 'UNKNOWN'
  if (errno === 'EEXIST') return new SkillError('NAME_CONFLICT', 409, 'the target already exists')
  const message = error instanceof Error ? error.message : String(error)
  return new SkillError('IO_ERROR', 500, message, { errno })
}

/**
 * Rename with three bounded retries. Windows can transiently report EPERM,
 * EBUSY, or EACCES for a rename over a just-closed handle (observed once for
 * the import-directory temp rename), so the atomic-write and import paths use
 * this. The final failure is a structured IO_ERROR, never a raw errno error.
 * `options.renameImpl` exists so the retry policy is testable without real
 * filesystem contention.
 */
export async function renameWithRetry(source, destination, options = {}) {
  const renameImpl = typeof options.renameImpl === 'function' ? options.renameImpl : rename
  let lastError
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await renameImpl(source, destination)
      return
    } catch (error) {
      lastError = error
      const retryable = Boolean(error && RENAME_RETRYABLE_CODES.has(error.code))
      if (!retryable || attempt === RENAME_RETRY_DELAYS_MS.length) break
      await sleep(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
  throw ioError(lastError)
}

async function writeFileAtomic(target, content) {
  const directory = dirname(target)
  const temporary = join(directory, `.tmp-${randomUUID()}`)
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
  try {
    await renameWithRetry(temporary, target)
  } catch (error) {
    try {
      await rm(temporary, { force: true })
    } catch {
      /* the rename failure is the interesting one */
    }
    throw error
  }
}

/* ------------------------------------------------------- discovery waiting */

function clampWait(waitMs) {
  const value = Number(waitMs)
  if (!Number.isFinite(value) || value < 0) return LIMITS.waitMsDefault
  return Math.min(Math.floor(value), LIMITS.waitMsMax)
}

function matchesExpectedMetadata(entry, expected) {
  if (!expected) return true
  if (expected.description !== undefined && (entry.description ?? '') !== expected.description) return false
  if (expected.whenToUse !== undefined) {
    const actual = entry.whenToUse ?? ''
    if (actual !== expected.whenToUse) return false
  }
  if (expected.modelInvocable !== undefined) {
    const actual = !entry.invocation || entry.invocation.modelInvocable !== false
    if (actual !== expected.modelInvocable) return false
  }
  if (expected.userInvocable !== undefined) {
    const actual = !entry.invocation || entry.invocation.userInvocable !== false
    if (actual !== expected.userInvocable) return false
  }
  return true
}

function evaluateDiscovery(skills, name, targetPath, mode, expected) {
  if (mode === 'removed') {
    const entry = skills.find((item) => item && item.name === name)
    if (!entry) return { state: 'removed' }
    if (!targetPath || typeof entry.path !== 'string' || !samePath(entry.path, targetPath)) {
      return { state: 'removed', skillName: entry.name }
    }
    return null
  }
  if (targetPath) {
    const exact = skills.find(
      (item) => item && typeof item.path === 'string' && samePath(item.path, targetPath),
    )
    if (exact && matchesExpectedMetadata(exact, expected)) {
      return { state: 'discovered', skillName: exact.name }
    }
  }
  const sameName = skills.find((item) => item && item.name === name)
  if (sameName) {
    const sameTarget = targetPath && typeof sameName.path === 'string' && samePath(sameName.path, targetPath)
    if (!sameTarget) {
      return {
        state: 'shadowed',
        skillName: sameName.name,
        shadowedBy: sameName.source,
        shadowedPath: sameName.path,
      }
    }
    // The stale catalog entry still points at our file: keep waiting until the
    // watcher-driven invalidation exposes the metadata we just wrote.
    return null
  }
  return null
}

/**
 * Poll the catalog until the watcher-driven invalidation reveals (or removes)
 * the skill. `skills/change` only wakes the loop earlier; the snapshot is the
 * authority. A timeout is reported honestly as `pending`.
 */
export async function waitForSkillDiscovery(view, options) {
  const name = options && options.name
  const targetPath = options && options.path
  const mode = options && options.mode === 'removed' ? 'removed' : 'appeared'
  const expected = options && options.expected
  const limit = clampWait(options && options.waitMs)
  const started = Date.now()
  const deadline = started + limit

  let wakeResolve = null
  const signalWake = () => {
    if (!wakeResolve) return
    const resolveWake = wakeResolve
    wakeResolve = null
    resolveWake()
  }
  let disposeListener = null
  try {
    if (view.ctx && typeof view.ctx.on === 'function') {
      const returned = view.ctx.on('skills/change', signalWake)
      if (typeof returned === 'function') disposeListener = returned
    }
  } catch {
    /* a missing event bus only costs the wake-up hint */
  }

  try {
    for (;;) {
      const snapshot = await snapshotOf(view)
      const outcome = evaluateDiscovery(snapshot.skills, name, targetPath, mode, expected)
      if (outcome) return { ...outcome, waitedMs: Date.now() - started }
      const now = Date.now()
      if (now >= deadline) return { state: 'pending', waitedMs: now - started }
      await Promise.race([
        sleep(Math.min(LIMITS.discoveryPollMs, Math.max(1, deadline - now))),
        new Promise((resolveWake) => {
          wakeResolve = resolveWake
        }),
      ])
    }
  } finally {
    if (typeof disposeListener === 'function') disposeListener()
  }
}

/* ------------------------------------------------------------------- reads */

async function buildDeletePlan(row) {
  if (row.layout === 'flat') {
    return { kind: 'flat', path: row.realPath, fileCount: 1, totalBytes: row.bytes ?? 0 }
  }
  if (row.layout !== 'directory') return undefined
  const directory = dirname(row.realPath)
  let fileCount = 0
  let totalBytes = 0
  const walk = async (current, depth) => {
    if (depth > 10 || fileCount > 5000) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (fileCount > 5000) return
      const target = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(target, depth + 1)
        continue
      }
      if (entry.isSymbolicLink()) {
        fileCount += 1
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(target)
        fileCount += 1
        totalBytes += info.size
      } catch {
        fileCount += 1
      }
    }
  }
  await walk(directory, 0)
  return { kind: 'directory', path: directory, fileCount, totalBytes }
}

function stripBody(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '')
}

/** GET /state payload. */
export async function statePayload(view) {
  const snapshot = view.initial ?? (await snapshotOf(view))
  const skills = []
  for (const summary of snapshot.skills) {
    if (!summary || typeof summary.name !== 'string') continue
    skills.push(publicRow(await evaluateSkill(view, summary)))
  }
  skills.sort((left, right) => left.name.localeCompare(right.name))

  const roots = []
  const project = projectSkillRoot(view)
  if (project) {
    roots.push({
      key: 'project',
      source: 'project-agents',
      path: project,
      exists: await isDirectory(project),
      writable: view.mounted !== false,
    })
  }
  roots.push({
    key: 'user',
    source: 'user-dsh',
    path: view.userRoot,
    exists: await isDirectory(view.userRoot),
    writable: view.mounted !== false,
  })

  const warnings = []
  if (view.degraded) warnings.push('degraded-sources')
  if (view.mounted === false) warnings.push('not-mounted')
  if (snapshot.complete === false) warnings.push('incomplete-discovery')

  return {
    view: {
      cwd: view.cwd,
      projectRoot: view.projectRoot,
      preset: {
        id: view.presetInfo ? view.presetInfo.id : null,
        source: view.presetInfo ? view.presetInfo.source : 'default',
        hasFilesystem: view.mounted !== false,
      },
      complete: snapshot.complete !== false,
      degraded: Boolean(view.degraded),
    },
    mounted: view.mounted !== false,
    mountedKnown: view.mounted !== null && view.mounted !== undefined,
    roots,
    targets: roots.map((root) => ({ key: root.key, label: root.path, path: root.path })),
    skills,
    limits: LIMITS,
    warnings,
  }
}

/** GET /detail payload: the body plus everything the edit form needs. */
export async function detailPayload(view, input) {
  const name = assertSkillName(input && input.name)
  const snapshot = view.initial ?? (await snapshotOf(view))
  const summary = snapshot.skills.find((entry) => entry && entry.name === name)
  if (!summary) throw new SkillError('SKILL_NOT_FOUND', 404, `skill "${name}" is not visible in this view`)
  const row = await evaluateSkill(view, summary)
  const loaded = await loadCurrentDefinition(view, name)
  const parsedFields = currentFields(loaded.definition, row)
  const frontmatter = {
    name: row.name,
    description: parsedFields.description,
    modelInvocable: parsedFields.modelInvocable,
    userInvocable: parsedFields.userInvocable,
  }
  if (parsedFields.whenToUse) frontmatter.whenToUse = parsedFields.whenToUse

  if (row.writable && row.realPath) {
    const raw = await readFile(row.realPath, 'utf8')
    const parsed = splitFrontmatter(raw)
    const body = parsed ? stripBody(parsed.body) : ''
    const deletePlan = await buildDeletePlan(row)
    return { skill: { ...publicRow(row), body, frontmatter, ...(deletePlan ? { deletePlan } : {}) } }
  }

  if (loaded.available) {
    if (!loaded.definition) {
      throw new SkillError('SKILL_NOT_FOUND', 404, `skill "${name}" could not be loaded`)
    }
    return { skill: { ...publicRow(row), body: stripBody(loaded.definition.content), frontmatter } }
  }
  return { skill: { ...publicRow(row), body: '', frontmatter } }
}

/* ------------------------------------------------------------------ writes */

/** POST /create: a new `<root>/<name>/SKILL.md` bundle. */
export async function createSkill(view, input) {
  assertWritableContext(view)
  const name = assertSkillName(input && input.name)
  const fields = {
    name,
    description: singleLine(input && input.description, 'description', {
      required: true,
      maxLength: LIMITS.descriptionMax,
    }),
    whenToUse: singleLine(input && input.whenToUse, 'whenToUse', { maxLength: LIMITS.whenToUseMax }),
    modelInvocable: hasField(input, 'modelInvocable') ? booleanField(input.modelInvocable, 'modelInvocable') : true,
    userInvocable: hasField(input, 'userInvocable') ? booleanField(input.userInvocable, 'userInvocable') : true,
  }
  const body = normalizeBody(input && input.body)
  assertBodySize(body)
  const root = await writableRootFor(view, input && input.root)
  await mkdir(root.path, { recursive: true })
  const rootReal = await realpath(root.path)
  await assertNoNameConflict(view, name, rootReal)

  const targetDir = join(rootReal, name)
  const targetFile = join(targetDir, 'SKILL.md')
  const content = composeSkillFile(fields, body)
  let createdDirectory = false
  try {
    await mkdir(targetDir, { recursive: false })
    createdDirectory = true
    await writeFile(targetFile, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (createdDirectory) {
      try {
        await rm(targetDir, { recursive: true, force: true })
      } catch {
        /* keep the original failure */
      }
    }
    throw ioError(error)
  }

  const targetReal = await realpath(targetFile)
  const discovery = await waitForSkillDiscovery(view, {
    name,
    path: targetReal,
    mode: 'appeared',
    waitMs: input && input.waitMs,
  })
  return { action: 'create', path: targetReal, root: root.key, discovery }
}

/** POST /update: rewrite known frontmatter keys and the body in place. */
export async function updateSkill(view, input) {
  assertWritableContext(view)
  const name = assertSkillName(input && input.name)
  const description = singleLine(input && input.description, 'description', {
    required: true,
    maxLength: LIMITS.descriptionMax,
  })

  const snapshot = view.initial ?? (await snapshotOf(view))
  const summary = snapshot.skills.find((entry) => entry && entry.name === name)
  if (!summary) throw new SkillError('SKILL_NOT_FOUND', 404, `skill "${name}" is not visible in this view`)
  const row = await evaluateSkill(view, summary)
  if (!row.writable || !row.realPath) {
    throw new SkillError('READ_ONLY_SKILL', 403, `skill "${name}" is read-only (${row.readonlyReason})`)
  }

  const raw = await readFile(row.realPath, 'utf8')
  const info = await stat(row.realPath)
  assertEtagMatches(input, info)
  const parsed = splitFrontmatter(raw)
  if (!parsed) {
    throw new SkillError('VALIDATION_FAILED', 409, 'the instruction file has no readable YAML frontmatter')
  }

  // Baseline from the provider's current parse when available (review L2):
  // a lagging watcher must not make an omitted field fall back to default.
  const loaded = await loadCurrentDefinition(view, name)
  const current = currentFields(loaded.definition, row)
  const whenToUse = hasField(input, 'whenToUse')
    ? singleLine(input.whenToUse, 'whenToUse', { maxLength: LIMITS.whenToUseMax })
    : current.whenToUse
  const modelInvocable = hasField(input, 'modelInvocable')
    ? booleanField(input.modelInvocable, 'modelInvocable')
    : current.modelInvocable
  const userInvocable = hasField(input, 'userInvocable')
    ? booleanField(input.userInvocable, 'userInvocable')
    : current.userInvocable

  const frontmatterChanged =
    current.description !== description ||
    current.whenToUse !== whenToUse ||
    current.modelInvocable !== modelInvocable ||
    current.userInvocable !== userInvocable

  const fields = { name, description, whenToUse, modelInvocable, userInvocable }
  const body = hasField(input, 'body') ? input.body : stripBody(parsed.body)
  assertBodySize(normalizeBody(body))
  const content = rewriteFrontmatter(raw, fields, body)
  await writeFileAtomic(row.realPath, content)

  if (!frontmatterChanged) {
    const verify = splitFrontmatter(await readFile(row.realPath, 'utf8'))
    if (!verify) {
      await writeFileAtomic(row.realPath, raw)
      throw new SkillError('VALIDATION_FAILED', 409, 'the rewritten skill file could not be read back')
    }
    return { action: 'update', path: row.realPath, discovery: { state: 'discovered', waitedMs: 0 } }
  }

  const discovery = await waitForSkillDiscovery(view, {
    name,
    path: row.realPath,
    mode: 'appeared',
    expected: { description, whenToUse, modelInvocable, userInvocable },
    waitMs: input && input.waitMs,
  })
  if (discovery.state === 'pending') {
    await writeFileAtomic(row.realPath, raw)
    throw new SkillError(
      'VALIDATION_FAILED',
      409,
      'the skill provider did not accept the updated frontmatter within the discovery window; the original file was restored',
      { restored: true },
    )
  }
  return { action: 'update', path: row.realPath, discovery }
}

/** POST /delete: remove a writable bundle directory or flat file by name. */
export async function deleteSkill(view, input) {
  assertWritableContext(view)
  const name = assertSkillName(input && input.name)
  const confirmName = typeof (input && input.confirmName) === 'string' ? input.confirmName : ''
  if (confirmName !== name) {
    throw new SkillError('CONFIRM_REQUIRED', 400, 'confirmName must repeat the skill name to confirm deletion')
  }

  const snapshot = view.initial ?? (await snapshotOf(view))
  const summary = snapshot.skills.find((entry) => entry && entry.name === name)
  if (!summary) throw new SkillError('SKILL_NOT_FOUND', 404, `skill "${name}" is not visible in this view`)
  const row = await evaluateSkill(view, summary)
  if (!row.writable || !row.realPath) {
    throw new SkillError('READ_ONLY_SKILL', 403, `skill "${name}" is read-only (${row.readonlyReason})`)
  }

  const info = await stat(row.realPath)
  assertEtagMatches(input, info)
  const fileInfo = await pathInfo(row.realPath)
  if (fileInfo && fileInfo.isSymbolicLink()) {
    throw new SkillError('PATH_OUTSIDE_ROOT', 403, 'the instruction file is a symbolic link')
  }

  let deleteTarget
  if (row.layout === 'directory') {
    const directory = dirname(row.realPath)
    if (!samePath(dirname(directory), row.rootReal)) {
      throw new SkillError('PATH_OUTSIDE_ROOT', 403, 'the skill directory is not directly inside the writable root')
    }
    const directoryInfo = await pathInfo(directory)
    if (!directoryInfo || directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new SkillError('PATH_OUTSIDE_ROOT', 403, 'the skill directory is not a plain directory')
    }
    deleteTarget = directory
    await rm(deleteTarget, { recursive: true, force: false })
  } else {
    if (!samePath(dirname(row.realPath), row.rootReal)) {
      throw new SkillError('PATH_OUTSIDE_ROOT', 403, 'the skill file is not directly inside the writable root')
    }
    deleteTarget = row.realPath
    await unlink(deleteTarget)
  }

  const discovery = await waitForSkillDiscovery(view, {
    name,
    path: row.realPath,
    mode: 'removed',
    waitMs: input && input.waitMs,
  })
  return { action: 'delete', deletedPath: deleteTarget, discovery }
}

/* ----------------------------------------------------------------- imports */

function normalizeImportedContent(content) {
  const text = String(content ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  return text.endsWith('\n') ? text : `${text}\n`
}

function assertDirectorySegment(value) {
  const segment = typeof value === 'string' ? value.trim() : ''
  if (!segment || segment === '.' || segment === '..') {
    throw new SkillError('INVALID_NAME', 400, 'the target directory name is invalid')
  }
  if (segment.length > 100) {
    throw new SkillError('INVALID_NAME', 400, 'the target directory name is too long')
  }
  if (RESERVED_WINDOWS_DIRECTORY_NAME.test(segment)) {
    throw new SkillError('INVALID_NAME', 400, `directory name "${segment}" is reserved on Windows`)
  }
  if (/[\\/:*?"<>|\0]/.test(segment) || segment.endsWith('.') || segment.endsWith(' ')) {
    throw new SkillError('INVALID_NAME', 400, 'the target directory name contains an illegal character')
  }
  return segment
}

async function importFile(view, input) {
  if (typeof (input && input.content) !== 'string') {
    throw new SkillError('BAD_REQUEST', 400, 'content must be a string for mode=file')
  }
  if (Buffer.byteLength(input.content, 'utf8') > LIMITS.bodyBytes) {
    throw new SkillError('PAYLOAD_TOO_LARGE', 413, `skill files are limited to ${LIMITS.bodyBytes} bytes`)
  }
  const { name } = checkFrontmatterShallow(input.content)
  const root = await writableRootFor(view, input.root)
  await mkdir(root.path, { recursive: true })
  const rootReal = await realpath(root.path)
  await assertNoNameConflict(view, name, rootReal)

  const targetDir = join(rootReal, name)
  const targetFile = join(targetDir, 'SKILL.md')
  const content = normalizeImportedContent(input.content)
  let createdDirectory = false
  try {
    await mkdir(targetDir, { recursive: false })
    createdDirectory = true
    await writeFile(targetFile, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (createdDirectory) {
      try {
        await rm(targetDir, { recursive: true, force: true })
      } catch {
        /* keep the original failure */
      }
    }
    throw ioError(error)
  }

  const targetReal = await realpath(targetFile)
  const discovery = await waitForSkillDiscovery(view, {
    name,
    path: targetReal,
    mode: 'appeared',
    waitMs: input.waitMs,
  })
  if (discovery.state === 'pending') {
    try {
      await rm(targetDir, { recursive: true, force: true })
    } catch {
      /* the provider rejection is the interesting failure */
    }
    throw new SkillError(
      'INVALID_FRONTMATTER',
      400,
      'the skill provider did not accept the imported frontmatter; the file was removed',
    )
  }
  return { action: 'import-file', path: targetReal, root: root.key, discovery }
}

async function collectImportFiles(sourceReal) {
  const files = []
  let totalBytes = 0
  const walk = async (directory, prefix, depth) => {
    if (depth > LIMITS.importDepth) {
      throw new SkillError('PAYLOAD_TOO_LARGE', 413, `skill folders are limited to ${LIMITS.importDepth} levels`)
    }
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const rel = prefix ? join(prefix, entry.name) : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), rel, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(join(directory, entry.name))
      if (info.size > LIMITS.importFileBytes) {
        throw new SkillError(
          'PAYLOAD_TOO_LARGE',
          413,
          `each imported file is limited to ${LIMITS.importFileBytes} bytes`,
        )
      }
      totalBytes += info.size
      if (totalBytes > LIMITS.importTotalBytes) {
        throw new SkillError('PAYLOAD_TOO_LARGE', 413, `an imported skill is limited to ${LIMITS.importTotalBytes} bytes`)
      }
      files.push(rel)
      if (files.length > LIMITS.importFiles) {
        throw new SkillError('PAYLOAD_TOO_LARGE', 413, `a skill is limited to ${LIMITS.importFiles} files`)
      }
    }
  }
  await walk(sourceReal, '', 0)
  if (!files.includes('SKILL.md')) {
    throw new SkillError('BAD_REQUEST', 400, 'the folder has no top-level SKILL.md')
  }
  return files
}

async function importDirectory(view, input) {
  const sourcePath = input && input.sourcePath
  if (typeof sourcePath !== 'string' || !sourcePath.trim() || !isAbsolute(sourcePath)) {
    throw new SkillError('BAD_REQUEST', 400, 'sourcePath must be an absolute directory path')
  }
  const sourceInfo = await pathInfo(sourcePath)
  if (!sourceInfo || sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new SkillError('BAD_REQUEST', 400, 'sourcePath must be a real directory (symbolic links are not followed)')
  }
  const sourceReal = await realpath(sourcePath)
  const sourceSkill = join(sourceReal, 'SKILL.md')
  const skillInfo = await pathInfo(sourceSkill)
  if (!skillInfo || !skillInfo.isFile()) {
    throw new SkillError('BAD_REQUEST', 400, 'the selected folder has no top-level SKILL.md')
  }
  const { name } = checkFrontmatterShallow(await readFile(sourceSkill, 'utf8'))
  const directoryName = assertDirectorySegment(basename(sourceReal))
  const files = await collectImportFiles(sourceReal)

  const root = await writableRootFor(view, input.root)
  await mkdir(root.path, { recursive: true })
  const rootReal = await realpath(root.path)
  await assertNoNameConflict(view, name, rootReal, [directoryName])

  const targetDir = join(rootReal, directoryName)
  const temporaryDir = join(rootReal, `.import-${randomUUID()}`)
  let createdTemporary = false
  try {
    await mkdir(temporaryDir, { recursive: false })
    createdTemporary = true
    for (const rel of files) {
      const destination = join(temporaryDir, rel)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(join(sourceReal, rel), destination)
    }
    await renameWithRetry(temporaryDir, targetDir)
    createdTemporary = false
  } catch (error) {
    if (createdTemporary) {
      try {
        await rm(temporaryDir, { recursive: true, force: true })
      } catch {
        /* keep the original failure */
      }
    }
    throw ioError(error)
  }

  const targetSkill = join(targetDir, 'SKILL.md')
  const targetReal = await realpath(targetSkill)
  const discovery = await waitForSkillDiscovery(view, {
    name,
    path: targetReal,
    mode: 'appeared',
    waitMs: input.waitMs,
  })
  if (discovery.state === 'pending') {
    try {
      await rm(targetDir, { recursive: true, force: true })
    } catch {
      /* the provider rejection is the interesting failure */
    }
    throw new SkillError(
      'INVALID_FRONTMATTER',
      400,
      'the skill provider did not accept the imported frontmatter; the folder was removed',
    )
  }
  return { action: 'import-directory', path: targetReal, root: root.key, discovery }
}

/** POST /import: either an uploaded file body or a host-side folder path. */
export async function importSkill(view, input) {
  assertWritableContext(view)
  const mode = input && input.mode
  if (mode === 'file') return importFile(view, input)
  if (mode === 'directory') return importDirectory(view, input)
  throw new SkillError('BAD_REQUEST', 400, 'mode must be "file" or "directory"')
}
