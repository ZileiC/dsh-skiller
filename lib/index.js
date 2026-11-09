/**
 * dsh-skill-manager — host half.
 *
 * Registers six same-origin JSON routes under `/api/skill-manager/` and
 * delegates everything skill-related to `./skills.js`:
 *
 *   GET  /api/skill-manager/state    catalog, roots, targets, limits
 *   GET  /api/skill-manager/detail   one skill plus its body
 *   POST /api/skill-manager/create   new `<root>/<name>/SKILL.md`
 *   POST /api/skill-manager/update   rewrite a writable skill in place
 *   POST /api/skill-manager/delete   remove a writable skill
 *   POST /api/skill-manager/import   import a .md body or a host folder
 *
 * The web server has no built-in body parsing, size limit, or authorization:
 * this module owns all of it. Requests are admitted only from a loopback Host
 * with a matching Origin (when the browser sends one); writes additionally
 * require `content-type: application/json`, which forces a cross-origin
 * preflight. Everything fails closed and nothing is written twice.
 */

import {
  LIMITS,
  SkillError,
  withSkillView,
  statePayload,
  detailPayload,
  createSkill,
  updateSkill,
  deleteSkill,
  importSkill,
} from './skills.js'

export const name = 'skill-manager'

/** The HTTP carrier is mandatory; the skill services are resolved per request. */
export const inject = ['webServer']

const BASE = '/api/skill-manager'
const REQUEST_TIMEOUT_MS = 20_000

const ROUTES = [
  { path: `${BASE}/state`, method: 'GET', status: 200, execute: (view) => statePayload(view) },
  {
    path: `${BASE}/detail`,
    method: 'GET',
    status: 200,
    execute: (view, input) => detailPayload(view, input),
  },
  {
    path: `${BASE}/create`,
    method: 'POST',
    status: 201,
    execute: (view, input) => createSkill(view, input),
  },
  {
    path: `${BASE}/update`,
    method: 'POST',
    status: 200,
    execute: (view, input) => updateSkill(view, input),
  },
  {
    path: `${BASE}/delete`,
    method: 'POST',
    status: 200,
    execute: (view, input) => deleteSkill(view, input),
  },
  {
    path: `${BASE}/import`,
    method: 'POST',
    status: 201,
    execute: (view, input) => importSkill(view, input),
  },
]

/** Register every exact route on the web server, disposable with the fiber. */
export function apply(ctx, config = {}) {
  const trustedHosts = new Set(
    (Array.isArray(config && config.trustedHosts) ? config.trustedHosts : [])
      .map((value) => String(value).trim().toLowerCase())
      .filter(Boolean),
  )
  for (const route of ROUTES) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: route.path,
          handler: (req, res) => dispatch(ctx, route, trustedHosts, req, res),
        }),
      `skill-manager: ${route.path}`,
    )
  }
}

async function dispatch(ctx, route, trustedHosts, req, res) {
  try {
    const url = new URL(typeof req.url === 'string' && req.url ? req.url : route.path, 'http://localhost')
    assertRequest(req, route, trustedHosts)
    const input =
      route.method === 'POST'
        ? await readJsonBody(req, LIMITS.writeBodyBytes)
        : Object.fromEntries(url.searchParams.entries())
    const payload = await runRoute(ctx, route, input)
    sendJson(req, res, route.status, { ok: true, ...payload })
  } catch (error) {
    const failure = toFailure(error)
    sendJson(req, res, failure.status, { ok: false, error: failure.error })
  }
}

async function runRoute(ctx, route, input) {
  const options = {}
  if (typeof input.sessionId === 'string' && input.sessionId) options.sessionId = input.sessionId
  if (typeof input.cwd === 'string' && input.cwd) options.cwd = input.cwd
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      options.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }
  } catch {
    /* an older runtime simply runs without a request deadline */
  }
  return await withSkillView(ctx, options, (view) => route.execute(view, input))
}

/* ------------------------------------------------------------------ guards */

function hostnameOf(header) {
  const raw = typeof header === 'string' ? header.trim().toLowerCase() : ''
  if (!raw) return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end > 0 ? raw.slice(1, end) : ''
  }
  const colon = raw.lastIndexOf(':')
  return colon > 0 ? raw.slice(0, colon) : raw
}

function hostAllowed(req, trustedHosts) {
  const host = hostnameOf(req && req.headers ? req.headers.host : undefined)
  if (!host) return false
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  return trustedHosts.has(host)
}

function originAllowed(req) {
  const raw = req && req.headers ? req.headers.origin : undefined
  if (typeof raw !== 'string' || raw.length === 0) return true
  const host = req.headers ? req.headers.host : undefined
  if (typeof host !== 'string' || host.length === 0) return false
  try {
    return new URL(raw).host === host
  } catch {
    return false
  }
}

function assertRequest(req, route, trustedHosts) {
  if (!hostAllowed(req, trustedHosts)) {
    throw new SkillError('HOST_FORBIDDEN', 403, 'untrusted Host header')
  }
  if (!originAllowed(req)) {
    throw new SkillError('ORIGIN_FORBIDDEN', 403, 'cross-origin requests are rejected')
  }
  const method = String((req && req.method) || 'GET').toUpperCase()
  if (route.method === 'GET') {
    if (method !== 'GET' && method !== 'HEAD') {
      throw new SkillError('METHOD_NOT_ALLOWED', 405, `method ${method} is not allowed here`, {
        allow: 'GET, HEAD',
      })
    }
    return
  }
  if (method !== 'POST') {
    throw new SkillError('METHOD_NOT_ALLOWED', 405, `method ${method} is not allowed here`, {
      allow: 'POST',
    })
  }
  const contentType = req && req.headers ? req.headers['content-type'] : undefined
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    throw new SkillError('BAD_REQUEST', 415, 'content-type must be application/json')
  }
}

async function readJsonBody(req, limit) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > limit) {
      throw new SkillError('PAYLOAD_TOO_LARGE', 413, `request body exceeds ${limit} bytes`)
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) throw new SkillError('INVALID_JSON', 400, 'request body must be JSON')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SkillError('INVALID_JSON', 400, 'request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SkillError('INVALID_JSON', 400, 'request body must be a JSON object')
  }
  return parsed
}

/* ---------------------------------------------------------------- response */

function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  if (String((req && req.method) || '').toUpperCase() === 'HEAD') res.end()
  else res.end(body)
}

function toFailure(error) {
  if (error instanceof SkillError) {
    return {
      status: error.status || 500,
      error: {
        code: error.code,
        message: error.message,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      },
    }
  }
  if (error && typeof error.code === 'string') {
    return {
      status: 500,
      error: { code: 'IO_ERROR', message: String(error.message || 'filesystem error'), detail: { errno: error.code } },
    }
  }
  return {
    status: 500,
    error: {
      code: 'IO_ERROR',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}
