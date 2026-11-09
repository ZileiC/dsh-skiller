/**
 * dsh-skill-manager client half.
 *
 * A hand-written browser bundle in the harness module format
 * (`window.__ModuleLoader__.load({ id, factory })`): no build tool, no
 * third-party dependency, `react` from the platform seed only.
 *
 * Surfaces:
 *  - `main` (keyed, key = "skill-manager"): the manager page.
 *  - `sidebar.panellist` (list, id = "skill-manager"): the sidebar glyph.
 * The panellist entry is registered only after the main registration
 * succeeded: clicking a panel row calls `ctx.layout.selectPanel(id)`, which
 * throws when no main panel carries that key.
 *
 * Data comes from the host half's same-origin JSON routes under
 * `/api/skill-manager/*`; the contract is documented in the feature design
 * (.trellis/tasks/feat-11-09-skill-manager/design.md).
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-manager',
  factory(require) {
    const module = { exports: {} }

    let React = null
    try {
      React = require('react')
    } catch (error) {
      React = null
    }
    if (React === null) {
      // A carrier without the React seed also has no slot to fill; stay inert
      // instead of failing the whole plugin fiber.
      module.exports.inject = []
      module.exports.apply = function apply() {}
      return module.exports
    }

    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef

    const NS = 'dsh-skill-manager'
    const PANEL_ID = 'skill-manager'
    const API_ROOT = '/api/skill-manager'
    const STYLE_ID = 'dsh-skill-manager/client.css'
    const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
    const MAX_BODY_BYTES = 256 * 1024
    const PREVIEW_MAX_LINES = 120

    /**
     * Module-level client root context, captured in apply(ctx). Components
     * registered into slots do not receive ctx, so this is the bridge used for
     * `sessions`, `uiWorkspace`, `layout` and the locale subscription.
     */
    let clientCtx = null
    /** Bound translator for NS; translate() resolves the active locale per call. */
    let boundT = null

    /* ------------------------------------------------------------------ utils */

    function warn(message, error) {
      try {
        console.warn('[dsh-skill-manager] ' + message, error)
      } catch (error) {
        /* console is best effort */
      }
    }

    function getT() {
      return boundT === null ? function raw(key) { return key } : boundT
    }

    function messageOf(error) {
      if (error === null || error === undefined) return ''
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    function isAbort(error) {
      return !!error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
    }

    function formatBytes(value) {
      const n = Number(value)
      if (!isFinite(n) || n < 0) return '—'
      if (n < 1024) return String(n) + ' B'
      if (n < 1024 * 1024) return String(Math.round((n / 1024) * 10) / 10) + ' KiB'
      return String(Math.round((n / (1024 * 1024)) * 10) / 10) + ' MiB'
    }

    function unique(values) {
      const seen = {}
      const out = []
      for (let i = 0; i < values.length; i++) {
        const value = values[i]
        if (typeof value !== 'string' || value === '' || seen[value] === true) continue
        seen[value] = true
        out.push(value)
      }
      return out
    }

    function limitOf(limits, keys, fallback) {
      if (limits && typeof limits === 'object') {
        for (let i = 0; i < keys.length; i++) {
          const value = Number(limits[keys[i]])
          if (isFinite(value) && value > 0) return value
        }
      }
      return fallback
    }

    /* ------------------------------------------------------------ data shape */

    function sessionSnapshot() {
      try {
        if (clientCtx === null || !clientCtx.sessions || !clientCtx.sessions.list) return null
        return clientCtx.sessions.list.getSnapshot()
      } catch (error) {
        return null
      }
    }

    function currentSession() {
      const snapshot = sessionSnapshot()
      if (!snapshot || typeof snapshot !== 'object') return null
      const id = snapshot.current
      if (id === undefined || id === null) return null
      const row = snapshot.byId ? snapshot.byId[id] : null
      return { id: String(id), row: row && typeof row === 'object' ? row : null, cwd: row && typeof row.cwd === 'string' ? row.cwd : null }
    }

    function currentContext() {
      const session = currentSession()
      if (session === null) return { sessionId: null, cwd: null, hasSession: false }
      return { sessionId: session.id, cwd: session.cwd, hasSession: true }
    }

    function contextKey() {
      const context = currentContext()
      return String(context.sessionId || '') + '|' + String(context.cwd || '')
    }

    class ApiError extends Error {
      constructor(code, message, status) {
        super(message || code)
        this.name = 'ApiError'
        this.code = code || 'UNKNOWN'
        this.status = status || 0
      }
    }

    function toUiError(error) {
      if (error && error.code) {
        return { code: String(error.code), message: messageOf(error), status: error.status || 0 }
      }
      return { code: 'UNKNOWN', message: messageOf(error), status: 0 }
    }

    const ERROR_KEYS = {
      BAD_REQUEST: 'error.badRequest',
      INVALID_JSON: 'error.invalidResponse',
      INVALID_NAME: 'error.invalidName',
      INVALID_FRONTMATTER: 'error.invalidFrontmatter',
      CWD_REQUIRED: 'error.cwdRequired',
      CONFIRM_REQUIRED: 'error.confirmRequired',
      HOST_FORBIDDEN: 'error.forbidden',
      ORIGIN_FORBIDDEN: 'error.forbidden',
      READ_ONLY_SKILL: 'error.readOnly',
      PATH_OUTSIDE_ROOT: 'error.pathOutside',
      SKILL_NOT_FOUND: 'error.notFound',
      METHOD_NOT_ALLOWED: 'error.method',
      NAME_CONFLICT: 'error.conflict',
      FILE_CHANGED: 'error.fileChanged',
      VALIDATION_FAILED: 'error.validation',
      PAYLOAD_TOO_LARGE: 'error.payload',
      IO_ERROR: 'error.io',
      SKILLS_UNAVAILABLE: 'error.unavailable',
      PRESET_SCOPE_UNAVAILABLE: 'error.unavailable',
      NOT_MOUNTED: 'error.notMounted',
      INVALID_RESPONSE: 'error.invalidResponse',
      NETWORK: 'error.network',
    }

    function errorText(error, t) {
      if (!error) return ''
      const key = ERROR_KEYS[error.code]
      if (key === 'error.network' || key === 'error.unknown') return t(key, { message: error.message || '' })
      if (key !== undefined) return t(key)
      return t('error.unknown', { message: error.message || '' })
    }

    function isWritable(skill) {
      return !!skill && skill.writable === true
    }

    const READONLY_KEYS = {
      bundled: 'readonly.bundled',
      runtime: 'readonly.runtime',
      custom: 'readonly.custom',
      'project-dsh': 'readonly.project-dsh',
      'user-agents': 'readonly.user-agents',
      'no-path': 'readonly.no-path',
      'no-cwd': 'readonly.no-cwd',
      missing: 'readonly.missing',
      symlink: 'readonly.symlink',
      'outside-root': 'readonly.outside-root',
      'not-mounted': 'readonly.not-mounted',
    }

    function readonlyReasonKey(skill) {
      const reason = skill && typeof skill.readonlyReason === 'string' ? skill.readonlyReason : ''
      return READONLY_KEYS[reason] || 'readonly.unknown'
    }

    const SOURCE_KEYS = {
      'project-dsh': 'source.project-dsh',
      'project-agents': 'source.project-agents',
      custom: 'source.custom',
      'user-dsh': 'source.user-dsh',
      'user-agents': 'source.user-agents',
      bundled: 'source.bundled',
      runtime: 'source.runtime',
    }

    function sourceLabel(t, source) {
      if (typeof source !== 'string' || source === '') return t('source.unknown')
      const key = SOURCE_KEYS[source]
      return key ? t(key) : source
    }

    function policyText(t, skill) {
      const invocation = skill && skill.invocation && typeof skill.invocation === 'object' ? skill.invocation : null
      if (invocation === null) return t('policy.unknown')
      const model = invocation.modelInvocable
      const user = invocation.userInvocable
      if (typeof model !== 'boolean' && typeof user !== 'boolean') return t('policy.unknown')
      if (model === true && user === true) return t('policy.both')
      if (model === true) return t('policy.model')
      if (user === true) return t('policy.user')
      return t('policy.none')
    }

    function targetLabel(t, target) {
      if (!target || typeof target !== 'object') return ''
      const suffix = typeof target.path === 'string' && target.path !== '' ? ' — ' + target.path : ''
      if (target.key === 'project') return t('fields.targetProject') + suffix
      if (target.key === 'user') return t('fields.targetUser') + suffix
      return String(target.label || target.key || '') + suffix
    }

    function sanitizeId(value) {
      return String(value || '').replace(/[^A-Za-z0-9_-]/g, '-')
    }

    function previewText(body) {
      const text = typeof body === 'string' ? body : ''
      const lines = text.split(/\r?\n/)
      return {
        text: lines.slice(0, PREVIEW_MAX_LINES).join('\n'),
        truncated: lines.length > PREVIEW_MAX_LINES,
      }
    }

    function normalizeWarnings(value) {
      if (!Array.isArray(value)) return []
      const out = []
      for (let i = 0; i < value.length; i++) {
        const item = value[i]
        if (typeof item === 'string' && item !== '') {
          // The host now emits stable warning codes; a plain string is treated
          // as a code so an unknown one still renders as its original text.
          out.push({ code: item, text: item })
          continue
        }
        if (!item || typeof item !== 'object') continue
        const code = typeof item.code === 'string' && item.code !== '' ? item.code : ''
        const text = typeof item.message === 'string' && item.message !== ''
          ? item.message
          : (typeof item.text === 'string' && item.text !== '' ? item.text : code)
        if (code !== '' || text !== '') out.push({ code: code, text: text })
      }
      return out
    }

    /** Map a host warning code through `warning.<code>`; unknown codes keep their raw text. */
    function warningText(t, warning) {
      if (!warning || typeof warning !== 'object') return ''
      if (typeof warning.code === 'string' && warning.code !== '') {
        const key = 'warning.' + warning.code
        const translated = t(key)
        if (translated !== key) return translated
      }
      return typeof warning.text === 'string' ? warning.text : (warning.code || '')
    }

    function normalizeState(payload) {
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.skills)) {
        throw new ApiError('INVALID_RESPONSE', 'state payload carries no skills array')
      }
      return {
        view: payload.view && typeof payload.view === 'object' ? payload.view : {},
        mounted: payload.mounted !== false,
        roots: Array.isArray(payload.roots) ? payload.roots : [],
        skills: payload.skills,
        targets: Array.isArray(payload.targets) ? payload.targets : [],
        limits: payload.limits && typeof payload.limits === 'object' ? payload.limits : {},
        warnings: normalizeWarnings(payload.warnings),
      }
    }

    /* ------------------------------------------------------------------- http */

    function withQuery(path, params) {
      const parts = []
      const keys = Object.keys(params)
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]
        const value = params[key]
        if (value === undefined || value === null || value === '') continue
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      }
      return parts.length === 0 ? path : path + '?' + parts.join('&')
    }

    async function requestJson(path, options) {
      const settings = options || {}
      const init = { method: settings.method || 'GET', headers: { accept: 'application/json' } }
      if (settings.signal !== undefined) init.signal = settings.signal
      if (settings.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(settings.body)
      }
      let response
      try {
        response = await fetch(path, init)
      } catch (error) {
        if (isAbort(error)) throw error
        throw new ApiError('NETWORK', messageOf(error), 0)
      }
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (payload && payload.ok === false && payload.error && typeof payload.error === 'object') {
        throw new ApiError(String(payload.error.code || 'BAD_REQUEST'), messageOf(payload.error.message), response.status)
      }
      if (!response.ok) {
        const code = payload && payload.error && payload.error.code ? String(payload.error.code) : 'HTTP_' + response.status
        throw new ApiError(code, (payload && payload.error && messageOf(payload.error.message)) || 'HTTP ' + response.status, response.status)
      }
      if (!payload || typeof payload !== 'object') throw new ApiError('INVALID_RESPONSE', 'empty response body', response.status)
      return payload
    }

    const api = {
      state(signal) {
        const context = currentContext()
        return requestJson(withQuery(API_ROOT + '/state', { sessionId: context.sessionId, cwd: context.cwd }), { signal })
      },
      detail(name, signal) {
        const context = currentContext()
        return requestJson(withQuery(API_ROOT + '/detail', { sessionId: context.sessionId, cwd: context.cwd, name }), { signal })
      },
      create(input) {
        return requestJson(API_ROOT + '/create', { method: 'POST', body: input })
      },
      update(input) {
        return requestJson(API_ROOT + '/update', { method: 'POST', body: input })
      },
      remove(input) {
        return requestJson(API_ROOT + '/delete', { method: 'POST', body: input })
      },
      importSkill(input) {
        return requestJson(API_ROOT + '/import', { method: 'POST', body: input })
      },
    }

    /* ------------------------------------------------------------------ style */

    const CSS = [
      '.dsm-page{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;height:100%;min-height:100%;padding:20px 24px 28px;overflow:auto;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:1.5}',
      '.dsm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}',
      '.dsm-title{font-size:16px;font-weight:600;margin:0}',
      '.dsm-sub{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.dsm-head-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dsm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;height:28px;padding:0 12px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.dsm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsm-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.dsm-btn-primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-base)}',
      '.dsm-btn-primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary);opacity:.88}',
      '.dsm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.dsm-btn-danger:hover:not(:disabled){background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 10%,transparent)}',
      '.dsm-btn-ghost{border-color:transparent;color:var(--dsw-alias-label-secondary);padding:0 8px}',
      '.dsm-banners{display:flex;flex-direction:column;gap:6px}',
      '.dsm-banner{display:flex;gap:8px;align-items:flex-start;border-radius:8px;padding:8px 10px;font-size:12px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}',
      '.dsm-banner-info{border-color:var(--dsw-alias-state-business-primary)}',
      '.dsm-banner-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary)}',
      '.dsm-banner-err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dsm-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dsm-search{flex:1 1 220px;min-width:160px;height:30px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px;font:inherit;font-size:12px}',
      '.dsm-search:focus-visible,.dsm-select:focus-visible,.dsm-input:focus-visible,.dsm-textarea:focus-visible,.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dsm-select{height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 8px;font:inherit;font-size:12px}',
      '.dsm-count{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.dsm-list{display:flex;flex-direction:column;gap:6px}',
      '.dsm-row{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.dsm-row-head{display:flex;align-items:center;gap:8px;padding:8px 10px}',
      '.dsm-row-head:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsm-expand{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;background:transparent;border:0;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer;min-height:24px}',
      '.dsm-chev{flex:none;width:12px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dsm-name{flex:none;font-weight:600;font-size:13px;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsm-desc{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsm-badges{display:flex;gap:4px;align-items:center;flex:none;flex-wrap:wrap;justify-content:flex-end}',
      '.dsm-badge{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}',
      '.dsm-badge-accent{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
      '.dsm-badge-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.dsm-details{padding:8px 12px 12px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsm-detail-grid{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;font-size:12px}',
      '.dsm-k{color:var(--dsw-alias-label-tertiary)}',
      '.dsm-v{color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.dsm-path{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.dsm-preview{max-height:260px;overflow:auto;margin:0;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word}',
      '.dsm-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:2px 0 0}',
      '.dsm-err-text{font-size:12px;color:var(--dsw-alias-state-error-primary);margin:2px 0 0}',
      '.dsm-empty{padding:36px 12px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsm-empty-title{font-size:13px;font-weight:600;margin:0 0 6px}',
      '.dsm-empty-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0}',
      '.dsm-error{padding:16px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsm-loading{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:12px 0}',
      '.dsm-notice{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:12px}',
      '.dsm-notice-ok{border-color:var(--dsw-alias-state-success-primary)}',
      '.dsm-notice-warn{border-color:var(--dsw-alias-state-warn-primary)}',
      '.dsm-notice-err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dsm-notice-info{border-color:var(--dsw-alias-state-business-primary)}',
      '.dsm-notice-text{flex:1;min-width:0;word-break:break-word}',
      '.dsm-modal-mask{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in oklab,var(--dsw-alias-bg-base) 55%,transparent);backdrop-filter:blur(2px)}',
      '.dsm-modal{width:min(620px,100%);max-height:88vh;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-base);box-shadow:0 12px 40px color-mix(in oklab,var(--dsw-alias-label-primary) 18%,transparent)}',
      '.dsm-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dsm-modal-title{font-size:14px;font-weight:600;margin:0}',
      '.dsm-close{width:26px;height:26px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:18px;line-height:1;cursor:pointer}',
      '.dsm-close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsm-modal-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:10px}',
      '.dsm-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsm-field{display:flex;flex-direction:column;gap:4px}',
      '.dsm-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsm-input,.dsm-textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:7px 9px;font:inherit;font-size:12px}',
      '.dsm-input:disabled,.dsm-textarea:disabled{opacity:.6}',
      '.dsm-textarea{min-height:180px;resize:vertical;font-family:var(--ds-font-family-code);line-height:1.5}',
      '.dsm-checkrow{display:flex;flex-direction:column;gap:6px}',
      '.dsm-check{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsm-row-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}',
      '.dsm-delete-text{margin:0;font-size:13px}',
      '.dsm-delete-path{margin:0;font-size:12px}',
    ].join('\n')

    function ensureStyle() {
      if (typeof document === 'undefined' || !document.head) return function () {}
      const SELECTOR = 'style[data-plugin-css="' + STYLE_ID + '"]'
      const existing = document.querySelector(SELECTOR)
      if (existing !== null && existing !== undefined) return function () {}
      const node = document.createElement('style')
      node.setAttribute('data-plugin', 'dsh-skill-manager')
      node.setAttribute('data-plugin-css', STYLE_ID)
      node.textContent = CSS
      document.head.appendChild(node)
      return function () {
        if (node && typeof node.remove === 'function') node.remove()
      }
    }

    /* ---------------------------------------------------------------- locales */

    const DICT_ZH = {
      'panel.title': 'Skill 管理',
      'page.title': '技能管理',
      'page.subtitleProject': '项目：{path}',
      'page.subtitleUser': '用户级（当前没有会话）',
      'page.subtitlePreset': '预设：{id}',
      'actions.back': '返回会话',
      'actions.refresh': '刷新',
      'actions.create': '新建技能',
      'actions.import': '导入',
      'actions.edit': '编辑',
      'actions.delete': '删除',
      'actions.cancel': '取消',
      'actions.save': '保存',
      'actions.saving': '保存中…',
      'actions.creating': '创建中…',
      'actions.confirmDelete': '确认删除',
      'actions.deleting': '删除中…',
      'actions.importing': '导入中…',
      'actions.retry': '重试',
      'actions.reload': '重新加载',
      'actions.chooseFile': '选择 .md 文件',
      'actions.chooseFolder': '选择技能文件夹',
      'actions.clearFilters': '清除筛选',
      'actions.dismiss': '关闭',
      'search.label': '搜索技能',
      'search.placeholder': '搜索名称、描述或路径…',
      'filter.label': '来源筛选',
      'filter.all': '全部来源',
      'list.count': '{n} 个技能',
      'list.loading': '正在读取技能…',
      'list.empty': '此视图下没有发现任何技能。',
      'list.emptyFiltered': '没有匹配的技能。试试清除搜索或来源筛选。',
      'list.emptyNoSession': '当前没有会话，仅显示用户级与全局技能；新建和导入会写入用户级根。',
      'list.emptyNotMounted': '当前会话预设未挂载 skill 文件系统，无法发现项目技能。',
      'source.project-dsh': '项目 .dsh',
      'source.project-agents': '项目 .agents',
      'source.custom': '自定义目录',
      'source.user-dsh': '用户级',
      'source.user-agents': '用户 agents',
      'source.bundled': '内置',
      'source.runtime': '运行时',
      'source.unknown': '未知来源',
      'policy.label': '调用策略',
      'policy.both': '模型 + 用户',
      'policy.model': '仅模型',
      'policy.user': '仅用户',
      'policy.none': '不可调用',
      'policy.unknown': '未知',
      'badge.readonly': '只读',
      'readonly.bundled': '随应用分发的内置技能，不可修改。',
      'readonly.runtime': '运行时注册的技能，不可修改。',
      'readonly.custom': '自定义目录中的技能，本版只读。',
      'readonly.project-dsh': '项目 .dsh/skills 中的技能，本版只读。',
      'readonly.user-agents': '用户 agents 目录中的技能，本版只读。',
      'readonly.no-path': '宿主未提供指令文件路径，无法修改。',
      'readonly.no-cwd': '找不到当前会话的工作目录，无法定位可写根。',
      'readonly.missing': '指令文件已不存在，无法修改。',
      'readonly.symlink': '指令文件是符号链接，出于安全原因不可修改。',
      'readonly.outside-root': '指令文件不在可写根内，无法修改。',
      'readonly.not-mounted': '当前会话预设未挂载 skill 文件系统。',
      'readonly.unknown': '宿主未标记为可写，已按只读处理。',
      'detail.loading': '正在读取详情…',
      'detail.error': '读取技能详情失败。',
      'detail.path': '指令文件',
      'detail.whenToUse': '何时使用',
      'detail.provider': '提供方',
      'detail.source': '来源',
      'detail.policy': '调用策略',
      'detail.size': '大小',
      'detail.preview': '正文预览',
      'detail.more': '仅显示前 {n} 行；完整正文可在编辑中查看。',
      'detail.emptyBody': '（正文为空）',
      'error.title': '读取技能失败',
      'error.boundary': '面板渲染失败：{message}',
      'error.network': '无法连接宿主路由（{message}）。',
      'error.unknown': '操作失败：{message}',
      'error.invalidResponse': '宿主返回了无法识别的数据。',
      'error.required': '请填写此项。',
      'error.invalidName': '名称必须是小写 kebab-case（字母/数字，单个连字符分隔，≤ 64 字符）。',
      'error.invalidFile': '请选择 .md 文件。',
      'error.fileTooLarge': '文件超过 256 KiB，无法导入。',
      'error.fileRead': '读取所选文件失败。',
      'error.pickDirectory': '无法打开文件夹选择器（当前环境不支持或没有权限），请改用 .md 文件导入。',
      'error.cwdRequired': '当前没有会话工作目录，无法写入项目技能。',
      'error.confirmRequired': '确认名称不匹配。',
      'error.readOnly': '该技能为只读，不能修改。',
      'error.conflict': '同名技能已存在，未覆盖。',
      'error.fileChanged': '文件已被外部修改，请重新加载后再保存。',
      'error.validation': '宿主未接受写入的内容（校验失败），原文件已恢复。',
      'error.notFound': '技能不存在或已被移除。',
      'error.forbidden': '请求被宿主拒绝（来源或 Host 校验失败）。',
      'error.method': '请求方法不被接受。',
      'error.payload': '请求内容过大。',
      'error.io': '宿主读写文件失败。',
      'error.unavailable': '技能注册表暂不可用（preset scope 获取失败）。',
      'error.notMounted': '当前会话预设未挂载 skill 文件系统。',
      'error.badRequest': '请求参数不被接受。',
      'error.invalidFrontmatter': 'frontmatter 不合法（需要 name 与 description）。',
      'error.pathOutside': '目标路径越出可写根，已拒绝。',
      'dialog.createTitle': '新建技能',
      'dialog.editTitle': '编辑技能',
      'dialog.importTitle': '导入技能',
      'dialog.deleteTitle': '删除技能？',
      'fields.name': '名称',
      'fields.nameHint': '小写 kebab-case，例如 my-skill。将写入 <name>/SKILL.md。',
      'fields.description': '描述',
      'fields.descriptionHint': '必填；一句话说明技能用途。',
      'fields.whenToUse': '何时使用（whenToUse）',
      'fields.whenToUseHint': '可选；提示模型在什么场景使用该技能。',
      'fields.body': '正文（Markdown）',
      'fields.bodyHint': 'frontmatter 由宿主生成，这里只写正文。',
      'fields.target': '写入位置',
      'fields.targetProject': '项目 .agents/skills',
      'fields.targetUser': '用户级 skills',
      'fields.invocation': '调用策略',
      'fields.modelInvocable': '允许模型调用',
      'fields.userInvocable': '允许用户调用',
      'fields.nameLocked': '名称不可修改（重命名不在本版范围）。',
      'fields.readonlyNote': '该技能为只读，仅可查看。',
      'import.modeFile': '单个 .md 文件',
      'import.modeDirectory': '技能文件夹',
      'import.fileHint': '读取本机文件后交由宿主校验并落盘（≤ 256 KiB）。',
      'import.fileChosen': '已选择 {name}（{size}）',
      'import.dirHint': '选择包含 SKILL.md 的文件夹；宿主会复制整个目录并校验上限。',
      'import.dirChosen': '已选择文件夹：{path}',
      'import.noTarget': '当前没有可写的目标根。',
      'delete.body': '将删除「{name}」及其{type}，此操作不可撤销。',
      'delete.typeDirectory': '整个技能目录',
      'delete.typeFile': '指令文件',
      'delete.path': '路径',
      'delete.confirmHint': '宿主会再次校验名称与路径。',
      'notice.created': '已创建：{path}',
      'notice.saved': '已保存：{path}',
      'notice.deleted': '已删除：{path}',
      'notice.imported': '已导入：{path}',
      'notice.pending': '已写入，等待目录刷新（watcher 生效后才会出现）。',
      'notice.deletedPending': '已删除，等待目录刷新。',
      'notice.shadowed': '已写入，但同名技能被更高优先级来源遮蔽。',
      'banner.noSession': '当前没有会话：仅显示用户级/全局技能，新建与导入写入用户级根。',
      'banner.notMounted': '当前会话预设未挂载 skill 文件系统：无法发现或修改项目技能。',
      'banner.warnings': '宿主警告：{message}',
      'banner.refreshError': '刷新失败：{message}（仍显示上一次结果）',
      'warning.degraded-sources': '来源未知：当前预设作用域不可用，仅显示目录可读的部分技能。',
      'warning.not-mounted': '当前会话预设未挂载 skill 文件系统，项目技能不可发现。',
      'warning.incomplete-discovery': '技能目录发现不完整，列表可能缺少部分条目。',
      'footer.limits': '正文上限 {body}；文件夹导入上限由宿主校验。',
    }

    const DICT_EN = {
      'panel.title': 'Skill manager',
      'page.title': 'Skills',
      'page.subtitleProject': 'Project: {path}',
      'page.subtitleUser': 'User-level (no session)',
      'page.subtitlePreset': 'Preset: {id}',
      'actions.back': 'Back to chat',
      'actions.refresh': 'Refresh',
      'actions.create': 'New skill',
      'actions.import': 'Import',
      'actions.edit': 'Edit',
      'actions.delete': 'Delete',
      'actions.cancel': 'Cancel',
      'actions.save': 'Save',
      'actions.saving': 'Saving…',
      'actions.creating': 'Creating…',
      'actions.confirmDelete': 'Delete',
      'actions.deleting': 'Deleting…',
      'actions.importing': 'Importing…',
      'actions.retry': 'Retry',
      'actions.reload': 'Reload',
      'actions.chooseFile': 'Choose .md file',
      'actions.chooseFolder': 'Choose skill folder',
      'actions.clearFilters': 'Clear filters',
      'actions.dismiss': 'Close',
      'search.label': 'Search skills',
      'search.placeholder': 'Search name, description, or path…',
      'filter.label': 'Source filter',
      'filter.all': 'All sources',
      'list.count': '{n} skills',
      'list.loading': 'Reading skills…',
      'list.empty': 'No skills were discovered in this view.',
      'list.emptyFiltered': 'No skills match. Try clearing the search or source filter.',
      'list.emptyNoSession': 'No session is open; showing user-level and global skills. New skills and imports go to the user-level root.',
      'list.emptyNotMounted': 'The current session preset does not mount the skill filesystem, so project skills cannot be discovered.',
      'source.project-dsh': 'Project .dsh',
      'source.project-agents': 'Project .agents',
      'source.custom': 'Custom directory',
      'source.user-dsh': 'User-level',
      'source.user-agents': 'User agents',
      'source.bundled': 'Bundled',
      'source.runtime': 'Runtime',
      'source.unknown': 'Unknown source',
      'policy.label': 'Invocation',
      'policy.both': 'Model + user',
      'policy.model': 'Model only',
      'policy.user': 'User only',
      'policy.none': 'Not invocable',
      'policy.unknown': 'Unknown',
      'badge.readonly': 'Read-only',
      'readonly.bundled': 'Bundled with the app; read-only.',
      'readonly.runtime': 'Registered at runtime; read-only.',
      'readonly.custom': 'Skills in a custom directory are read-only in this version.',
      'readonly.project-dsh': 'Skills under the project .dsh/skills are read-only in this version.',
      'readonly.user-agents': 'Skills under the user agents directory are read-only in this version.',
      'readonly.no-path': 'The host did not provide an instruction path, so this skill cannot be changed.',
      'readonly.no-cwd': 'There is no session working directory, so the writable root cannot be located.',
      'readonly.missing': 'The instruction file no longer exists and cannot be changed.',
      'readonly.symlink': 'The instruction file is a symbolic link; read-only for safety.',
      'readonly.outside-root': 'The instruction file is outside the writable roots.',
      'readonly.not-mounted': 'The current session preset does not mount the skill filesystem.',
      'readonly.unknown': 'The host did not mark this skill writable; treated as read-only.',
      'detail.loading': 'Loading details…',
      'detail.error': 'Could not load the skill details.',
      'detail.path': 'Instruction file',
      'detail.whenToUse': 'When to use',
      'detail.provider': 'Provider',
      'detail.source': 'Source',
      'detail.policy': 'Invocation',
      'detail.size': 'Size',
      'detail.preview': 'Body preview',
      'detail.more': 'Showing the first {n} lines; open Edit for the full body.',
      'detail.emptyBody': '(empty body)',
      'error.title': 'Could not load skills',
      'error.boundary': 'The panel failed to render: {message}',
      'error.network': 'Could not reach the host route ({message}).',
      'error.unknown': 'Operation failed: {message}',
      'error.invalidResponse': 'The host returned an unrecognized payload.',
      'error.required': 'This field is required.',
      'error.invalidName': 'Name must be lowercase kebab-case (letters/digits, single hyphens, ≤ 64 chars).',
      'error.invalidFile': 'Choose a .md file.',
      'error.fileTooLarge': 'The file exceeds 256 KiB and cannot be imported.',
      'error.fileRead': 'Could not read the selected file.',
      'error.pickDirectory': 'Could not open the folder picker (unsupported or not permitted here). Import a .md file instead.',
      'error.cwdRequired': 'There is no session working directory, so project skills cannot be written.',
      'error.confirmRequired': 'The confirmation name does not match.',
      'error.readOnly': 'This skill is read-only and cannot be changed.',
      'error.conflict': 'A skill with this name already exists; nothing was overwritten.',
      'error.fileChanged': 'The file changed on disk. Reload before saving again.',
      'error.validation': 'The host rejected the write (validation failed); the original file was restored.',
      'error.notFound': 'The skill does not exist or was already removed.',
      'error.forbidden': 'The host rejected the request (origin or Host check failed).',
      'error.method': 'The request method is not accepted.',
      'error.payload': 'The request payload is too large.',
      'error.io': 'The host failed to read or write the file.',
      'error.unavailable': 'The skill registry is unavailable (preset scope lookup failed).',
      'error.notMounted': 'The current session preset does not mount the skill filesystem.',
      'error.badRequest': 'The request parameters were not accepted.',
      'error.invalidFrontmatter': 'Invalid frontmatter (name and description are required).',
      'error.pathOutside': 'The target path escapes the writable root and was refused.',
      'dialog.createTitle': 'New skill',
      'dialog.editTitle': 'Edit skill',
      'dialog.importTitle': 'Import skill',
      'dialog.deleteTitle': 'Delete skill?',
      'fields.name': 'Name',
      'fields.nameHint': 'Lowercase kebab-case, e.g. my-skill. Written to <name>/SKILL.md.',
      'fields.description': 'Description',
      'fields.descriptionHint': 'Required; one sentence on what the skill does.',
      'fields.whenToUse': 'When to use (whenToUse)',
      'fields.whenToUseHint': 'Optional; hints when the model should load this skill.',
      'fields.body': 'Body (Markdown)',
      'fields.bodyHint': 'The host generates frontmatter; write only the body here.',
      'fields.target': 'Target',
      'fields.targetProject': 'Project .agents/skills',
      'fields.targetUser': 'User-level skills',
      'fields.invocation': 'Invocation',
      'fields.modelInvocable': 'Model-invocable',
      'fields.userInvocable': 'User-invocable',
      'fields.nameLocked': 'The name cannot be changed (renaming is out of scope).',
      'fields.readonlyNote': 'This skill is read-only and can only be inspected.',
      'import.modeFile': 'Single .md file',
      'import.modeDirectory': 'Skill folder',
      'import.fileHint': 'Read locally, then the host validates and writes it (≤ 256 KiB).',
      'import.fileChosen': 'Selected {name} ({size})',
      'import.dirHint': 'Pick a folder containing SKILL.md; the host copies the tree and enforces its limits.',
      'import.dirChosen': 'Selected folder: {path}',
      'import.noTarget': 'No writable target is available.',
      'delete.body': 'Delete "{name}" and its {type}? This cannot be undone.',
      'delete.typeDirectory': 'entire skill directory',
      'delete.typeFile': 'instruction file',
      'delete.path': 'Path',
      'delete.confirmHint': 'The host re-validates the name and path.',
      'notice.created': 'Created: {path}',
      'notice.saved': 'Saved: {path}',
      'notice.deleted': 'Deleted: {path}',
      'notice.imported': 'Imported: {path}',
      'notice.pending': 'Written; waiting for the directory refresh (the watcher has not caught up yet).',
      'notice.deletedPending': 'Deleted; waiting for the directory refresh.',
      'notice.shadowed': 'Written, but a higher-priority skill with the same name shadows it.',
      'banner.noSession': 'No session is open: showing user-level/global skills; new skills and imports go to the user-level root.',
      'banner.notMounted': 'The current session preset does not mount the skill filesystem, so project skills cannot be discovered or changed.',
      'banner.warnings': 'Host warning: {message}',
      'banner.refreshError': 'Refresh failed: {message} (showing the previous result)',
      'warning.degraded-sources': 'Sources are unknown: the preset scope is unavailable, so only catalog-readable skills are shown.',
      'warning.not-mounted': 'The current session preset does not mount the skill filesystem, so project skills cannot be discovered.',
      'warning.incomplete-discovery': 'Skill discovery is incomplete; some entries may be missing.',
      'footer.limits': 'Body limit {body}; folder-import limits are enforced by the host.',
    }

    /* ------------------------------------------------------------- components */

    function Button(props) {
      const className = 'dsm-btn' + (props.variant ? ' dsm-btn-' + props.variant : '')
      return h('button', {
        type: 'button',
        className: className,
        disabled: props.disabled === true,
        title: props.title,
        autoFocus: props.autoFocus === true ? true : undefined,
        'aria-describedby': props.describedBy,
        onClick: props.disabled === true ? undefined : props.onClick,
      }, props.children)
    }

    function Field(props) {
      return h('div', { className: 'dsm-field' }, [
        props.label ? h('label', { className: 'dsm-label', htmlFor: props.id }, props.label) : null,
        props.children,
        props.hint ? h('p', { className: 'dsm-hint', id: props.hintId }, props.hint) : null,
        props.error ? h('p', { className: 'dsm-err-text', id: props.errorId, role: 'alert' }, props.error) : null,
      ])
    }

    function Modal(props) {
      const t = props.t
      const openerRef = useRef(null)
      useEffect(function () {
        if (typeof document !== 'undefined' && document.activeElement) openerRef.current = document.activeElement
        return function () {
          const opener = openerRef.current
          if (opener && typeof opener.focus === 'function') {
            try { opener.focus() } catch (failure) { /* focus restore is best effort */ }
          }
        }
      }, [])
      return h('div', {
        className: 'dsm-modal-mask',
        onMouseDown: function (event) {
          if (event && event.target === event.currentTarget && props.busy !== true) props.onClose()
        },
        onKeyDown: function (event) {
          if (!event) return
          if (event.key === 'Escape' && props.busy !== true) {
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
            props.onClose()
            return
          }
          if (event.key !== 'Tab') return
          const container = event.currentTarget
          if (!container || typeof container.querySelectorAll !== 'function') return
          const found = container.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
          const focusable = []
          for (let i = 0; i < found.length; i++) if (found[i].disabled !== true) focusable.push(found[i])
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey === true && event.target === first) {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            if (typeof last.focus === 'function') last.focus()
          } else if (event.shiftKey !== true && event.target === last) {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            if (typeof first.focus === 'function') first.focus()
          }
        },
      }, h('div', {
        className: 'dsm-modal',
        role: props.role || 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'dsm-dialog-title',
        'aria-describedby': props.describedBy,
      }, [
        h('div', { className: 'dsm-modal-head' }, [
          h('h2', { className: 'dsm-modal-title', id: 'dsm-dialog-title' }, props.title),
          h('button', {
            type: 'button',
            className: 'dsm-close',
            'aria-label': t('actions.dismiss'),
            disabled: props.busy === true,
            onClick: props.busy === true ? undefined : props.onClose,
          }, '×'),
        ]),
        h('div', { className: 'dsm-modal-body' }, props.children),
        props.footer ? h('div', { className: 'dsm-modal-foot' }, props.footer) : null,
      ]))
    }

    function Badge(props) {
      return h('span', { className: 'dsm-badge' + (props.tone ? ' dsm-badge-' + props.tone : '') }, props.children)
    }

    function SkillDetails(props) {
      const t = props.t
      const skill = props.skill
      const detail = props.detail
      const writable = isWritable(skill)
      const canModify = writable && props.mounted !== false && typeof skill.path === 'string' && skill.path !== ''
      const reasonId = 'dsm-readonly-' + sanitizeId(skill.name)
      const rows = []
      if (typeof skill.path === 'string' && skill.path !== '') {
        rows.push(h('span', { className: 'dsm-k', key: 'k-path' }, t('detail.path')))
        rows.push(h('code', { className: 'dsm-path', key: 'v-path' }, skill.path))
      }
      if (typeof skill.whenToUse === 'string' && skill.whenToUse !== '') {
        rows.push(h('span', { className: 'dsm-k', key: 'k-when' }, t('detail.whenToUse')))
        rows.push(h('span', { className: 'dsm-v', key: 'v-when' }, skill.whenToUse))
      }
      rows.push(h('span', { className: 'dsm-k', key: 'k-source' }, t('detail.source')))
      rows.push(h('span', { className: 'dsm-v', key: 'v-source' }, sourceLabel(t, skill.source)))
      if (typeof skill.provider === 'string' && skill.provider !== '') {
        rows.push(h('span', { className: 'dsm-k', key: 'k-provider' }, t('detail.provider')))
        rows.push(h('span', { className: 'dsm-v', key: 'v-provider' }, skill.provider))
      }
      rows.push(h('span', { className: 'dsm-k', key: 'k-policy' }, t('detail.policy')))
      rows.push(h('span', { className: 'dsm-v', key: 'v-policy' }, policyText(t, skill)))
      if (typeof skill.bytes === 'number') {
        rows.push(h('span', { className: 'dsm-k', key: 'k-size' }, t('detail.size')))
        rows.push(h('span', { className: 'dsm-v', key: 'v-size' }, formatBytes(skill.bytes)))
      }

      let preview = null
      if (detail && detail.phase === 'loading') {
        preview = h('p', { className: 'dsm-hint', role: 'status' }, t('detail.loading'))
      } else if (detail && detail.phase === 'error') {
        preview = h('div', null, [
          h('p', { className: 'dsm-err-text', role: 'alert' }, errorText(detail.error, t)),
          h('button', { type: 'button', className: 'dsm-btn', onClick: props.onRetry }, t('actions.retry')),
        ])
      } else if (detail && detail.phase === 'ready' && detail.skill) {
        const body = typeof detail.skill.body === 'string' ? detail.skill.body : ''
        const shown = previewText(body)
        preview = h('div', null, [
          h('p', { className: 'dsm-k', key: 'preview-label' }, t('detail.preview')),
          h('pre', { className: 'dsm-preview', key: 'preview-body' }, shown.text === '' ? t('detail.emptyBody') : shown.text),
          shown.truncated ? h('p', { className: 'dsm-hint' }, t('detail.more', { n: PREVIEW_MAX_LINES })) : null,
        ])
      }

      return h('div', { className: 'dsm-details' }, [
        h('div', { className: 'dsm-detail-grid' }, rows),
        !writable ? h('p', { className: 'dsm-readonly-note', id: reasonId }, t(readonlyReasonKey(skill))) : null,
        preview,
        h('div', { className: 'dsm-row-actions' }, [
          h('button', {
            type: 'button',
            className: 'dsm-btn',
            disabled: !canModify,
            'aria-describedby': !writable ? reasonId : undefined,
            onClick: canModify ? function () { props.onEdit(skill) } : undefined,
          }, t('actions.edit')),
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn-danger',
            disabled: !canModify,
            'aria-describedby': !writable ? reasonId : undefined,
            onClick: canModify ? function () { props.onDelete(skill) } : undefined,
          }, t('actions.delete')),
        ]),
      ])
    }

    function SkillRow(props) {
      const t = props.t
      const skill = props.skill || {}
      const name = typeof skill.name === 'string' && skill.name !== '' ? skill.name : '?'
      const directoryId = 'dsm-details-' + sanitizeId(name)
      return h('div', { className: 'dsm-row' + (props.open ? ' dsm-row-open' : '') }, [
        h('div', { className: 'dsm-row-head' }, [
          h('button', {
            type: 'button',
            className: 'dsm-expand',
            'aria-expanded': props.open === true,
            'aria-controls': directoryId,
            onClick: props.onToggle,
          }, [
            h('span', { className: 'dsm-chev', 'aria-hidden': 'true' }, props.open ? '▾' : '▸'),
            h('span', { className: 'dsm-name', title: name }, name),
            h('span', { className: 'dsm-desc' }, typeof skill.description === 'string' ? skill.description : ''),
          ]),
          h('div', { className: 'dsm-badges' }, [
            h(Badge, { key: 'source', tone: 'accent' }, sourceLabel(t, skill.source)),
            h(Badge, { key: 'policy' }, policyText(t, skill)),
            !isWritable(skill) ? h(Badge, { key: 'readonly', tone: 'danger' }, t('badge.readonly')) : null,
          ]),
        ]),
        props.open ? h('div', { id: directoryId }, h(SkillDetails, {
          skill: skill,
          detail: props.detail,
          mounted: props.mounted,
          t: t,
          onRetry: props.onRetry,
          onEdit: props.onEdit,
          onDelete: props.onDelete,
        })) : null,
      ])
    }

    function EmptyState(props) {
      return h('div', { className: 'dsm-empty', role: 'status' }, [
        h('p', { className: 'dsm-empty-title' }, props.title),
        props.hint ? h('p', { className: 'dsm-empty-hint' }, props.hint) : null,
        props.action ? h('div', { className: 'dsm-row-actions' }, props.action) : null,
      ])
    }

    function ErrorState(props) {
      return h('div', { className: 'dsm-error', role: 'alert' }, [
        h('p', { className: 'dsm-empty-title' }, props.t('error.title')),
        h('p', { className: 'dsm-empty-hint' }, props.message),
        h('div', { className: 'dsm-row-actions' }, h('button', {
          type: 'button',
          className: 'dsm-btn',
          onClick: props.onRetry,
        }, props.t('actions.retry'))),
      ])
    }

    function StatusBanner(props) {
      if (!props.items || props.items.length === 0) return null
      return h('div', { className: 'dsm-banners' }, props.items.map(function (item, index) {
        return h('div', { className: 'dsm-banner dsm-banner-' + item.tone, role: 'status', key: 'banner-' + index }, item.text)
      }))
    }

    function NoticeBar(props) {
      const t = props.t
      const notice = props.notice
      if (!notice) return null
      return h('div', { className: 'dsm-notice dsm-notice-' + (notice.tone || 'ok'), role: notice.tone === 'err' ? 'alert' : 'status' }, [
        h('span', { className: 'dsm-notice-text', key: 'text' }, t(notice.key, notice.params)),
        h('button', {
          type: 'button',
          className: 'dsm-close',
          'aria-label': t('actions.dismiss'),
          onClick: props.onDismiss,
        }, '×'),
      ])
    }

    function PageHeader(props) {
      const t = props.t
      const view = props.data && props.data.view ? props.data.view : {}
      const subtitle = props.hasSession
        ? (typeof view.cwd === 'string' && view.cwd !== '' ? t('page.subtitleProject', { path: view.cwd }) : t('page.subtitleProject', { path: view.projectRoot || '' }))
        : t('page.subtitleUser')
      const presetId = view.preset && typeof view.preset.id === 'string' && view.preset.id !== '' ? view.preset.id : ''
      const writeReason = props.canWrite ? undefined : (props.writeReason || '')
      return h('header', { className: 'dsm-head' }, [
        h('div', { key: 'identity' }, [
          h('h1', { className: 'dsm-title' }, t('page.title')),
          h('p', { className: 'dsm-sub' }, subtitle),
          presetId !== '' ? h('p', { className: 'dsm-sub' }, t('page.subtitlePreset', { id: presetId })) : null,
        ]),
        h('div', { className: 'dsm-head-actions', key: 'actions' }, [
          h(Button, { key: 'back', variant: 'ghost', onClick: props.onBack }, t('actions.back')),
          h(Button, { key: 'refresh', onClick: props.onRefresh, disabled: props.refreshing }, t('actions.refresh')),
          h(Button, { key: 'import', onClick: props.onImport, disabled: !props.canWrite, title: writeReason }, t('actions.import')),
          h(Button, { key: 'create', variant: 'primary', onClick: props.onCreate, disabled: !props.canWrite, title: writeReason }, t('actions.create')),
        ]),
      ])
    }

    function Toolbar(props) {
      const t = props.t
      const options = [h('option', { value: 'all', key: 'all' }, t('filter.all'))]
      for (let i = 0; i < props.sources.length; i++) {
        const source = props.sources[i]
        options.push(h('option', { value: source, key: source }, sourceLabel(t, source)))
      }
      return h('div', { className: 'dsm-toolbar' }, [
        h('input', {
          key: 'search',
          className: 'dsm-search',
          type: 'search',
          value: props.query,
          placeholder: t('search.placeholder'),
          'aria-label': t('search.label'),
          onChange: function (event) { props.onQuery(event && event.target ? event.target.value : '') },
        }),
        props.sources.length > 1 ? h('select', {
          key: 'source',
          className: 'dsm-select',
          value: props.source,
          'aria-label': t('filter.label'),
          onChange: function (event) { props.onSource(event && event.target ? event.target.value : 'all') },
        }, options) : null,
        h('span', { className: 'dsm-count', role: 'status', key: 'count' }, t('list.count', { n: props.count })),
      ])
    }

    function SkillFormDialog(props) {
      const t = props.t
      const editing = props.mode === 'edit'
      const [load, setLoad] = useState({ phase: editing ? 'loading' : 'ready', detail: null, error: null })
      const [reloadTick, setReloadTick] = useState(0)
      const [form, setForm] = useState({
        name: editing ? String(props.editName || '') : '',
        description: '',
        whenToUse: '',
        body: '',
        modelInvocable: true,
        userInvocable: true,
        root: props.defaultRoot || 'user',
      })
      const [errors, setErrors] = useState({})
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      useEffect(function () {
        if (!editing) return undefined
        let alive = true
        setLoad({ phase: 'loading', detail: null, error: null })
        api.detail(String(props.editName || '')).then(function (payload) {
          if (!alive) return
          const skill = payload && payload.skill ? payload.skill : null
          if (skill === null) throw new ApiError('INVALID_RESPONSE', 'detail payload carries no skill')
          const invocation = skill.invocation && typeof skill.invocation === 'object' ? skill.invocation : {}
          setForm({
            name: typeof skill.name === 'string' ? skill.name : String(props.editName || ''),
            description: typeof skill.description === 'string' ? skill.description : '',
            whenToUse: typeof skill.whenToUse === 'string' ? skill.whenToUse : '',
            body: typeof skill.body === 'string' ? skill.body : '',
            modelInvocable: invocation.modelInvocable !== false,
            userInvocable: invocation.userInvocable !== false,
            root: props.defaultRoot || 'user',
          })
          setLoad({ phase: 'ready', detail: skill, error: null })
        }).catch(function (failure) {
          if (!alive || isAbort(failure)) return
          setLoad({ phase: 'error', detail: null, error: toUiError(failure) })
        })
        return function () { alive = false }
      }, [editing, props.editName, reloadTick])

      function update(field, value) {
        setForm(function (previous) {
          const next = {}
          for (const key in previous) next[key] = previous[key]
          next[field] = value
          return next
        })
      }

      function submit() {
        if (busy) return
        const validation = validateForm(form, props.mode, currentContext())
        setErrors(validation)
        let invalid = false
        for (const key in validation) invalid = true
        if (invalid) return
        const context = currentContext()
        const whenToUse = String(form.whenToUse || '').trim()
        const payload = {
          sessionId: context.sessionId || undefined,
          cwd: context.cwd || undefined,
          name: String(form.name || '').trim(),
          description: String(form.description || '').trim(),
          // Edit always sends the field explicitly: a missing field means "keep
          // the current value" to the host, so clearing must send "".
          whenToUse: editing ? whenToUse : (whenToUse === '' ? undefined : whenToUse),
          modelInvocable: form.modelInvocable !== false,
          userInvocable: form.userInvocable !== false,
          body: typeof form.body === 'string' ? form.body : '',
        }
        setBusy(true)
        setError(null)
        let action
        if (editing) {
          payload.baseMtimeMs = load.detail && load.detail.mtimeMs !== undefined ? load.detail.mtimeMs : undefined
          action = api.update(payload)
        } else {
          payload.root = form.root
          action = api.create(payload)
        }
        action.then(function (result) {
          setBusy(false)
          props.onDone(editing ? 'update' : 'create', result)
        }).catch(function (failure) {
          if (isAbort(failure)) return
          setBusy(false)
          setError(toUiError(failure))
        })
      }

      const footer = [
        h(Button, { key: 'cancel', onClick: props.onClose, disabled: busy }, t('actions.cancel')),
        h(Button, {
          key: 'save',
          variant: 'primary',
          onClick: submit,
          disabled: busy || (editing && load.phase !== 'ready'),
        }, busy ? (editing ? t('actions.saving') : t('actions.creating')) : t('actions.save')),
      ]

      if (editing && load.phase === 'loading') {
        return h(Modal, { title: t('dialog.editTitle'), t: t, onClose: props.onClose, footer: footer }, h('p', { className: 'dsm-hint', role: 'status' }, t('detail.loading')))
      }
      if (editing && load.phase === 'error') {
        return h(Modal, { title: t('dialog.editTitle'), t: t, onClose: props.onClose, footer: footer }, [
          h('p', { className: 'dsm-err-text', role: 'alert' }, errorText(load.error, t)),
          h(Button, { onClick: function () { setReloadTick(function (n) { return n + 1 }) } }, t('actions.reload')),
        ])
      }

      const nameError = errors.name ? t(errors.name) : null
      const descriptionError = errors.description ? t(errors.description) : null
      const rootError = errors.root ? t(errors.root) : null
      const targetOptions = []
      for (let i = 0; i < props.targets.length; i++) {
        const target = props.targets[i]
        targetOptions.push(h('option', { value: target.key, key: target.key || String(i) }, targetLabel(t, target)))
      }

      const body = [
        h(Field, {
          key: 'name',
          id: 'dsm-field-name',
          label: t('fields.name'),
          hint: editing ? t('fields.nameLocked') : t('fields.nameHint'),
          hintId: 'dsm-field-name-hint',
          error: nameError,
          errorId: 'dsm-field-name-error',
        }, h('input', {
          id: 'dsm-field-name',
          className: 'dsm-input',
          type: 'text',
          value: form.name,
          disabled: editing || busy,
          autoFocus: !editing,
          'aria-invalid': nameError ? 'true' : undefined,
          'aria-describedby': nameError ? 'dsm-field-name-error' : 'dsm-field-name-hint',
          onChange: function (event) { update('name', event && event.target ? event.target.value : '') },
        })),
        !editing ? h(Field, {
          key: 'target',
          id: 'dsm-field-target',
          label: t('fields.target'),
          error: rootError,
          errorId: 'dsm-field-target-error',
        }, h('select', {
          id: 'dsm-field-target',
          className: 'dsm-select',
          value: form.root,
          disabled: busy,
          onChange: function (event) { update('root', event && event.target ? event.target.value : 'user') },
        }, targetOptions)) : (load.detail && typeof load.detail.path === 'string' ? h('p', { className: 'dsm-hint', key: 'edit-path' }, t('detail.path') + ': ' + load.detail.path) : null),
        h(Field, {
          key: 'description',
          id: 'dsm-field-description',
          label: t('fields.description'),
          hint: t('fields.descriptionHint'),
          hintId: 'dsm-field-description-hint',
          error: descriptionError,
          errorId: 'dsm-field-description-error',
        }, h('input', {
          id: 'dsm-field-description',
          className: 'dsm-input',
          type: 'text',
          value: form.description,
          disabled: busy,
          autoFocus: editing,
          'aria-invalid': descriptionError ? 'true' : undefined,
          'aria-describedby': descriptionError ? 'dsm-field-description-error' : 'dsm-field-description-hint',
          onChange: function (event) { update('description', event && event.target ? event.target.value : '') },
        })),
        h(Field, {
          key: 'when',
          id: 'dsm-field-when',
          label: t('fields.whenToUse'),
          hint: t('fields.whenToUseHint'),
          hintId: 'dsm-field-when-hint',
        }, h('input', {
          id: 'dsm-field-when',
          className: 'dsm-input',
          type: 'text',
          value: form.whenToUse,
          disabled: busy,
          onChange: function (event) { update('whenToUse', event && event.target ? event.target.value : '') },
        })),
        h('div', { className: 'dsm-field', key: 'invocation' }, [
          h('span', { className: 'dsm-label' }, t('fields.invocation')),
          h('div', { className: 'dsm-checkrow' }, [
            h('label', { className: 'dsm-check', key: 'model' }, [
              h('input', {
                type: 'checkbox',
                checked: form.modelInvocable !== false,
                disabled: busy,
                onChange: function (event) { update('modelInvocable', !!(event && event.target && event.target.checked)) },
              }),
              t('fields.modelInvocable'),
            ]),
            h('label', { className: 'dsm-check', key: 'user' }, [
              h('input', {
                type: 'checkbox',
                checked: form.userInvocable !== false,
                disabled: busy,
                onChange: function (event) { update('userInvocable', !!(event && event.target && event.target.checked)) },
              }),
              t('fields.userInvocable'),
            ]),
          ]),
        ]),
        h(Field, {
          key: 'body',
          id: 'dsm-field-body',
          label: t('fields.body'),
          hint: t('fields.bodyHint'),
          hintId: 'dsm-field-body-hint',
        }, h('textarea', {
          id: 'dsm-field-body',
          className: 'dsm-textarea',
          value: form.body,
          disabled: busy,
          onChange: function (event) { update('body', event && event.target ? event.target.value : '') },
        })),
      ]
      if (error) {
        body.push(h('div', { key: 'server-error' }, [
          h('p', { className: 'dsm-err-text', role: 'alert' }, errorText(error, t)),
          error.code === 'FILE_CHANGED' || error.code === 'VALIDATION_FAILED'
            ? h(Button, { onClick: function () { setReloadTick(function (n) { return n + 1 }) } }, t('actions.reload'))
            : null,
        ]))
      }

      return h(Modal, {
        title: editing ? t('dialog.editTitle') : t('dialog.createTitle'),
        t: t,
        busy: busy,
        onClose: props.onClose,
        footer: footer,
      }, body)
    }

    function ImportDialog(props) {
      const t = props.t
      const [mode, setMode] = useState('file')
      const [picked, setPicked] = useState(null)
      const [dirPath, setDirPath] = useState('')
      const [root, setRoot] = useState(props.defaultRoot || 'user')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      function switchMode(next) {
        if (busy || next === mode) return
        setMode(next)
        setError(null)
        if (next === 'file') setDirPath('')
        else setPicked(null)
      }

      function onFilePicked(event) {
        const input = event && event.target ? event.target : null
        const files = input && input.files ? input.files : null
        const file = files && files.length > 0 ? files[0] : null
        if (input) {
          try { input.value = '' } catch (failure) { /* ignore */ }
        }
        if (!file) return
        if (!/\.md$/i.test(String(file.name || ''))) {
          setError('error.invalidFile')
          return
        }
        if (typeof file.size === 'number' && file.size > MAX_BODY_BYTES) {
          setError('error.fileTooLarge')
          return
        }
        readFileText(file).then(function (text) {
          setPicked({ name: String(file.name || 'skill.md'), size: file.size, text: text })
          setError(null)
        }).catch(function () {
          setError('error.fileRead')
        })
      }

      function chooseFolder() {
        if (busy) return
        const workspace = clientCtx && clientCtx.uiWorkspace ? clientCtx.uiWorkspace : null
        const pick = workspace && typeof workspace.pickDirectory === 'function' ? workspace.pickDirectory : null
        if (pick === null) {
          setError('error.pickDirectory')
          return
        }
        let pending
        try {
          pending = pick.call(workspace)
        } catch (failure) {
          setError('error.pickDirectory')
          return
        }
        Promise.resolve(pending).then(function (value) {
          if (value === null || value === undefined) return
          setDirPath(String(value))
          setError(null)
        }).catch(function () {
          setError('error.pickDirectory')
        })
      }

      function submit() {
        if (busy) return
        const context = currentContext()
        const payload = {
          sessionId: context.sessionId || undefined,
          cwd: context.cwd || undefined,
          root: root,
          mode: mode,
        }
        if (mode === 'file') {
          if (picked === null) {
            setError('error.invalidFile')
            return
          }
          payload.content = picked.text
          payload.filename = picked.name
        } else {
          if (dirPath === '') {
            setError('error.pickDirectory')
            return
          }
          payload.sourcePath = dirPath
        }
        setBusy(true)
        setError(null)
        api.importSkill(payload).then(function (result) {
          setBusy(false)
          props.onDone('import', result)
        }).catch(function (failure) {
          if (isAbort(failure)) return
          setBusy(false)
          setError(toUiError(failure))
        })
      }

      const targetOptions = []
      for (let i = 0; i < props.targets.length; i++) {
        const target = props.targets[i]
        targetOptions.push(h('option', { value: target.key, key: target.key || String(i) }, targetLabel(t, target)))
      }

      const footer = [
        h(Button, { key: 'cancel', onClick: props.onClose, disabled: busy }, t('actions.cancel')),
        h(Button, { key: 'import', variant: 'primary', onClick: submit, disabled: busy }, busy ? t('actions.importing') : t('actions.import')),
      ]

      const body = [
        h('div', { className: 'dsm-checkrow', key: 'mode' }, [
          h('label', { className: 'dsm-check' }, [
            h('input', {
              type: 'radio',
              name: 'dsm-import-mode',
              checked: mode === 'file',
              disabled: busy,
              onChange: function () { switchMode('file') },
            }),
            t('import.modeFile'),
          ]),
          h('label', { className: 'dsm-check' }, [
            h('input', {
              type: 'radio',
              name: 'dsm-import-mode',
              checked: mode === 'directory',
              disabled: busy,
              onChange: function () { switchMode('directory') },
            }),
            t('import.modeDirectory'),
          ]),
        ]),
        mode === 'file' ? h('div', { className: 'dsm-field', key: 'file' }, [
          h('input', {
            type: 'file',
            accept: '.md,text/markdown',
            disabled: busy,
            'aria-label': t('actions.chooseFile'),
            onChange: onFilePicked,
          }),
          h('p', { className: 'dsm-hint' }, picked ? t('import.fileChosen', { name: picked.name, size: formatBytes(picked.size) }) : t('import.fileHint')),
        ]) : h('div', { className: 'dsm-field', key: 'dir' }, [
          h(Button, { onClick: chooseFolder, disabled: busy }, t('actions.chooseFolder')),
          h('p', { className: 'dsm-hint' }, dirPath === '' ? t('import.dirHint') : t('import.dirChosen', { path: dirPath })),
        ]),
        h('div', { className: 'dsm-field', key: 'root' }, [
          h('label', { className: 'dsm-label', htmlFor: 'dsm-import-root' }, t('fields.target')),
          h('select', {
            id: 'dsm-import-root',
            className: 'dsm-select',
            value: root,
            disabled: busy,
            onChange: function (event) { setRoot(event && event.target ? event.target.value : 'user') },
          }, targetOptions),
        ]),
      ]
      if (error) {
        body.push(h('p', { className: 'dsm-err-text', role: 'alert', key: 'error' }, typeof error === 'string' ? t(error) : errorText(error, t)))
      }

      return h(Modal, {
        title: t('dialog.importTitle'),
        t: t,
        busy: busy,
        onClose: props.onClose,
        footer: footer,
      }, body)
    }

    function DeleteDialog(props) {
      const t = props.t
      const skill = props.skill || {}
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const type = skill.layout === 'directory' ? t('delete.typeDirectory') : t('delete.typeFile')

      function confirm() {
        if (busy) return
        const context = currentContext()
        setBusy(true)
        setError(null)
        api.remove({
          sessionId: context.sessionId || undefined,
          cwd: context.cwd || undefined,
          name: skill.name,
          confirmName: skill.name,
          baseMtimeMs: skill.mtimeMs !== undefined ? skill.mtimeMs : undefined,
        }).then(function (result) {
          setBusy(false)
          props.onDone('delete', result)
        }).catch(function (failure) {
          if (isAbort(failure)) return
          setBusy(false)
          setError(toUiError(failure))
        })
      }

      const footer = [
        h(Button, { key: 'cancel', onClick: props.onClose, disabled: busy, autoFocus: true }, t('actions.cancel')),
        h(Button, { key: 'delete', variant: 'danger', onClick: confirm, disabled: busy }, busy ? t('actions.deleting') : t('actions.confirmDelete', { name: skill.name })),
      ]

      return h(Modal, {
        title: t('dialog.deleteTitle'),
        role: 'alertdialog',
        t: t,
        busy: busy,
        onClose: props.onClose,
        footer: footer,
        describedBy: 'dsm-delete-description',
      }, [
        h('p', { className: 'dsm-delete-text', id: 'dsm-delete-description', key: 'body' }, t('delete.body', { name: skill.name || '?', type: type })),
        h('p', { className: 'dsm-delete-path', key: 'path' }, [
          h('span', { className: 'dsm-k', key: 'k' }, t('delete.path') + ': '),
          h('code', { className: 'dsm-path', key: 'v' }, typeof skill.path === 'string' && skill.path !== '' ? skill.path : '—'),
        ]),
        h('p', { className: 'dsm-hint', key: 'hint' }, t('delete.confirmHint')),
        error ? h('p', { className: 'dsm-err-text', role: 'alert', key: 'error' }, errorText(error, t)) : null,
      ])
    }

    function PageBoundary(props) {
      const t = getT()
      if (props.error) {
        return h('div', { className: 'dsm-page' }, h('div', { className: 'dsm-error', role: 'alert' }, t('error.boundary', { message: messageOf(props.error) })))
      }
      return props.children || null
    }

    /** Class boundary: catches render throws from the page body. */
    class SkillManagerBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        warn('panel render crashed', error)
      }
      render() {
        return h(PageBoundary, { error: this.state ? this.state.error : null }, this.props ? this.props.children : null)
      }
    }

    function PanelPage() {
      return h(SkillManagerBoundary, null, h(SkillManagerPage))
    }

    function SkillManagerPage() {
      const t = getT()
      const [state, setState] = useState({ phase: 'loading', data: null, error: null })
      const [loadTick, setLoadTick] = useState(0)
      const [query, setQuery] = useState('')
      const [source, setSource] = useState('all')
      const [expanded, setExpanded] = useState(null)
      const [details, setDetails] = useState({})
      const [dialog, setDialog] = useState(null)
      const [notice, setNotice] = useState(null)
      const [, setLocaleRevision] = useState(0)
      const sessionKeyRef = useRef('')
      const abortRef = useRef(null)
      const detailSeqRef = useRef({})
      const requestSeqRef = useRef(0)

      useEffect(function () {
        if (!clientCtx || !clientCtx.locale || typeof clientCtx.locale.subscribe !== 'function') return undefined
        const off = clientCtx.locale.subscribe(function () {
          setLocaleRevision(function (value) { return value + 1 })
        })
        return typeof off === 'function' ? off : undefined
      }, [])

      useEffect(function () {
        const list = clientCtx && clientCtx.sessions ? clientCtx.sessions.list : null
        if (!list || typeof list.subscribe !== 'function') return undefined
        const off = list.subscribe(function () {
          const key = contextKey()
          if (key === sessionKeyRef.current) return
          sessionKeyRef.current = key
          setExpanded(null)
          setDetails({})
          setLoadTick(function (value) { return value + 1 })
        })
        return typeof off === 'function' ? off : undefined
      }, [])

      useEffect(function () {
        requestSeqRef.current = requestSeqRef.current + 1
        const sequence = requestSeqRef.current
        const previousAbort = abortRef.current
        if (previousAbort && typeof previousAbort.abort === 'function') previousAbort.abort()
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        abortRef.current = controller
        sessionKeyRef.current = contextKey()
        setState(function (previous) {
          return { phase: previous.data ? 'refreshing' : 'loading', data: previous.data, error: null }
        })
        api.state(controller ? controller.signal : undefined).then(function (payload) {
          if (sequence !== requestSeqRef.current) return
          let data
          try {
            data = normalizeState(payload)
          } catch (failure) {
            throw failure
          }
          setState({ phase: 'ready', data: data, error: null })
        }).catch(function (failure) {
          if (isAbort(failure) || sequence !== requestSeqRef.current) return
          setState(function (previous) {
            return { phase: 'error', data: previous.data, error: toUiError(failure) }
          })
        })
        return function () {
          if (controller) controller.abort()
        }
      }, [loadTick])

      const context = currentContext()
      const data = state.data
      const skills = data !== null && Array.isArray(data.skills) ? data.skills : []
      const targets = data !== null && Array.isArray(data.targets) ? data.targets : []
      const mounted = data === null ? true : data.mounted !== false
      const canWrite = data !== null && mounted && targets.length > 0
      const writeReason = data === null ? '' : (!mounted ? t('banner.notMounted') : (!targets.length ? t('import.noTarget') : ''))
      const sources = unique(skills.map(function (skill) { return skill && skill.source ? skill.source : '' }))
      const visible = filterSkills(skills, query, source)
      const defaultRoot = (function () {
        for (let i = 0; i < targets.length; i++) if (targets[i] && targets[i].key === 'project') return 'project'
        return targets.length > 0 && targets[0] && targets[0].key ? targets[0].key : 'user'
      })()

      const banners = []
      if (data !== null && !context.hasSession) banners.push({ tone: 'info', text: t('banner.noSession') })
      if (data !== null && data.mounted === false) banners.push({ tone: 'warn', text: t('banner.notMounted') })
      if (data !== null && data.warnings.length > 0) {
        const messages = []
        for (let i = 0; i < data.warnings.length; i++) messages.push(warningText(t, data.warnings[i]))
        banners.push({ tone: 'warn', text: t('banner.warnings', { message: messages.join('; ') }) })
      }
      // A failed refresh keeps the last successful snapshot on screen; the
      // failure is non-blocking (role=status banner), not the full error state.
      if (state.phase === 'error' && data !== null) {
        banners.push({ tone: 'warn', text: t('banner.refreshError', { message: errorText(state.error, t) }) })
      }

      function loadDetail(name) {
        if (typeof name !== 'string' || name === '') return
        const seq = (detailSeqRef.current[name] || 0) + 1
        detailSeqRef.current[name] = seq
        setDetails(function (previous) {
          const next = {}
          for (const key in previous) next[key] = previous[key]
          const entry = next[name]
          next[name] = { phase: 'loading', skill: entry && entry.skill ? entry.skill : null, error: null }
          return next
        })
        api.detail(name).then(function (payload) {
          if (detailSeqRef.current[name] !== seq) return
          const skill = payload && payload.skill ? payload.skill : null
          if (skill === null) throw new ApiError('INVALID_RESPONSE', 'detail payload carries no skill')
          setDetails(function (previous) {
            const next = {}
            for (const key in previous) next[key] = previous[key]
            next[name] = { phase: 'ready', skill: skill, error: null }
            return next
          })
        }).catch(function (failure) {
          if (isAbort(failure) || detailSeqRef.current[name] !== seq) return
          setDetails(function (previous) {
            const next = {}
            for (const key in previous) next[key] = previous[key]
            next[name] = { phase: 'error', skill: null, error: toUiError(failure) }
            return next
          })
        })
      }

      useEffect(function () {
        if (expanded === null) return
        const entry = details[expanded]
        if (entry) return
        loadDetail(expanded)
      }, [expanded])

      function toggleRow(name) {
        setExpanded(function (current) {
          return current === name ? null : name
        })
      }

      function refreshAfterWrite() {
        detailSeqRef.current = {}
        setDetails({})
        setExpanded(null)
        setLoadTick(function (value) { return value + 1 })
      }

      function handleDone(kind, result) {
        setDialog(null)
        const noticeItem = noticeForResult(kind, result)
        setNotice(noticeItem)
        refreshAfterWrite()
      }

      function onBack() {
        try {
          if (clientCtx && clientCtx.layout && typeof clientCtx.layout.selectPanel === 'function') {
            clientCtx.layout.selectPanel(null)
            return
          }
        } catch (failure) {
          warn('selectPanel(null) failed', failure)
        }
        warn('layout service unavailable; cannot return to the conversation', null)
      }

      let body
      if (state.phase === 'loading' && data === null) {
        body = h('p', { className: 'dsm-loading', role: 'status', key: 'loading' }, t('list.loading'))
      } else if (state.phase === 'error' && data === null) {
        body = h(ErrorState, { key: 'error', t: t, message: errorText(state.error, t), onRetry: function () { setLoadTick(function (value) { return value + 1 }) } })
      } else if (skills.length === 0) {
        let title = t('list.empty')
        let hint = ''
        if (!mounted) { title = t('list.emptyNotMounted') } else if (!context.hasSession) { title = t('list.emptyNoSession') }
        body = h(EmptyState, {
          key: 'empty',
          title: title,
          hint: hint,
          action: (!mounted || !context.hasSession) ? null : h(Button, { onClick: function () { setLoadTick(function (value) { return value + 1 }) } }, t('actions.refresh')),
        })
      } else if (visible.length === 0) {
        body = h(EmptyState, {
          key: 'filtered',
          title: t('list.emptyFiltered'),
          hint: '',
          action: h(Button, { onClick: function () { setQuery(''); setSource('all') } }, t('actions.clearFilters')),
        })
      } else {
        body = h('div', { className: 'dsm-list', key: 'list' }, visible.map(function (skill, index) {
          const name = skill && typeof skill.name === 'string' ? skill.name : '#' + index
          return h(SkillRow, {
            key: name,
            skill: skill,
            open: expanded === name,
            detail: details[name],
            mounted: mounted,
            t: t,
            onToggle: function () { toggleRow(name) },
            onRetry: function () { loadDetail(name) },
            onEdit: function (target) { setDialog({ kind: 'edit', name: target.name }) },
            onDelete: function (target) { setDialog({ kind: 'delete', skill: target }) },
          })
        }))
      }

      let dialogNode = null
      if (dialog !== null) {
        if (dialog.kind === 'create') {
          dialogNode = h(SkillFormDialog, {
            key: 'dialog-create',
            mode: 'create',
            targets: targets,
            defaultRoot: defaultRoot,
            t: t,
            onClose: function () { setDialog(null) },
            onDone: handleDone,
          })
        } else if (dialog.kind === 'edit') {
          dialogNode = h(SkillFormDialog, {
            key: 'dialog-edit',
            mode: 'edit',
            editName: dialog.name,
            targets: targets,
            defaultRoot: defaultRoot,
            t: t,
            onClose: function () { setDialog(null) },
            onDone: handleDone,
          })
        } else if (dialog.kind === 'import') {
          dialogNode = h(ImportDialog, {
            key: 'dialog-import',
            targets: targets,
            defaultRoot: defaultRoot,
            t: t,
            onClose: function () { setDialog(null) },
            onDone: handleDone,
          })
        } else if (dialog.kind === 'delete') {
          dialogNode = h(DeleteDialog, {
            key: 'dialog-delete',
            skill: dialog.skill,
            t: t,
            onClose: function () { setDialog(null) },
            onDone: handleDone,
          })
        }
      }

      const bodyLimit = data !== null ? limitOf(data.limits, ['bodyBytes', 'skillBodyBytes', 'maxBodyBytes'], MAX_BODY_BYTES) : MAX_BODY_BYTES
      const footer = data !== null ? h('p', { className: 'dsm-hint' }, t('footer.limits', { body: formatBytes(bodyLimit) })) : null

      return h('div', { className: 'dsm-page' }, [
        h(PageHeader, {
          key: 'header',
          data: data,
          hasSession: context.hasSession,
          canWrite: canWrite,
          writeReason: writeReason,
          refreshing: state.phase === 'refreshing',
          t: t,
          onBack: onBack,
          onRefresh: function () { setLoadTick(function (value) { return value + 1 }) },
          onCreate: function () { setDialog({ kind: 'create' }) },
          onImport: function () { setDialog({ kind: 'import' }) },
        }),
        h(StatusBanner, { key: 'banners', items: banners }),
        data !== null ? h(Toolbar, {
          key: 'toolbar',
          t: t,
          query: query,
          source: source,
          sources: sources,
          count: visible.length,
          onQuery: setQuery,
          onSource: setSource,
        }) : null,
        h(NoticeBar, { key: 'notice', t: t, notice: notice, onDismiss: function () { setNotice(null) } }),
        body,
        footer,
        dialogNode,
      ])
    }

    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      }, [
        h('path', {
          key: 'book',
          d: 'M3.1 3.6h6.1a2.7 2.7 0 0 1 2.7 2.7v6.1H5.8a2.7 2.7 0 0 1-2.7-2.7V3.6Z',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinejoin: 'round',
        }),
        h('path', { key: 'line-a', d: 'M5.6 6.2h3.7', stroke: 'currentColor', strokeWidth: '1.1', strokeLinecap: 'round' }),
        h('path', { key: 'line-b', d: 'M5.6 8.4h3.7', stroke: 'currentColor', strokeWidth: '1.1', strokeLinecap: 'round' }),
        h('path', {
          key: 'spark',
          d: 'M12.6 3.1l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5.5-1.2Z',
          fill: 'currentColor',
          opacity: props && props.active === false ? '0.75' : '1',
        }),
      ])
    }

    /* -------------------------------------------------------------- helpers */

    function validateForm(form, mode, context) {
      const errors = {}
      if (mode !== 'edit') {
        const name = String(form.name || '').trim()
        if (name === '') errors.name = 'error.required'
        else if (name.length > 64 || !NAME_RE.test(name)) errors.name = 'error.invalidName'
        if (form.root === 'project' && !context.cwd) errors.root = 'error.cwdRequired'
      }
      if (String(form.description || '').trim() === '') errors.description = 'error.required'
      return errors
    }

    function filterSkills(skills, query, source) {
      const q = String(query || '').trim().toLowerCase()
      const list = Array.isArray(skills) ? skills : []
      const out = []
      for (let i = 0; i < list.length; i++) {
        const skill = list[i]
        if (!skill || typeof skill !== 'object') continue
        if (source && source !== 'all' && skill.source !== source) continue
        if (q === '') { out.push(skill); continue }
        const haystack = [skill.name, skill.description, skill.whenToUse, skill.path]
        let match = false
        for (let j = 0; j < haystack.length; j++) {
          const value = haystack[j]
          if (typeof value === 'string' && value.toLowerCase().indexOf(q) !== -1) { match = true; break }
        }
        if (match) out.push(skill)
      }
      return out
    }

    function noticeForResult(kind, result) {
      const discovery = result && result.discovery && typeof result.discovery === 'object' ? result.discovery.state : null
      const path = result && (result.path || result.deletedPath) ? String(result.path || result.deletedPath) : ''
      if (discovery === 'shadowed') return { tone: 'warn', key: 'notice.shadowed', params: {} }
      if (discovery === 'pending') return kind === 'delete' ? { tone: 'info', key: 'notice.deletedPending', params: {} } : { tone: 'info', key: 'notice.pending', params: {} }
      if (kind === 'delete' || discovery === 'removed') return { tone: 'ok', key: 'notice.deleted', params: { path: path } }
      if (kind === 'import') return { tone: 'ok', key: 'notice.imported', params: { path: path } }
      if (kind === 'create') return { tone: 'ok', key: 'notice.created', params: { path: path } }
      return { tone: 'ok', key: 'notice.saved', params: { path: path } }
    }

    function readFileText(file) {
      if (file && typeof file.text === 'function') {
        return Promise.resolve(file.text())
      }
      return new Promise(function (resolve, reject) {
        try {
          if (typeof FileReader === 'undefined') { reject(new Error('FileReader is unavailable')); return }
          const reader = new FileReader()
          reader.onload = function () { resolve(String(reader.result || '')) }
          reader.onerror = function () { reject(reader.error || new Error('file read failed')) }
          reader.readAsText(file)
        } catch (failure) {
          reject(failure)
        }
      })
    }

    /* ------------------------------------------------------------ registration */

    function mountSlot(ctx, label, slotName, options, component, onRegistered) {
      try {
        ctx.effect(function () {
          try {
            return ctx.slots.inject(slotName, function () {
              try {
                const dispose = ctx.slots.register(options, component)
                if (typeof onRegistered === 'function') {
                  try { onRegistered() } catch (failure) { warn(label + ' onRegistered failed', failure) }
                }
                return dispose
              } catch (failure) {
                warn(label + ' registration refused', failure)
                return function () {}
              }
            })
          } catch (failure) {
            warn(label + ' inject failed', failure)
            return function () {}
          }
        }, 'skill-manager: ' + label)
      } catch (failure) {
        warn(label + ' mount failed', failure)
      }
    }

    function apply(ctx) {
      clientCtx = ctx
      try {
        if (ctx.locale && typeof ctx.locale.bind === 'function') boundT = ctx.locale.bind(NS)
      } catch (failure) {
        warn('locale bind failed', failure)
      }
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.effect(function () {
            return ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN })
          }, 'skill-manager: dictionaries')
        }
      } catch (failure) {
        warn('dictionary registration failed', failure)
      }
      try {
        ctx.effect(function () { return ensureStyle() }, 'skill-manager: styles')
      } catch (failure) {
        warn('style injection failed', failure)
      }
      mountSlot(ctx, 'main', 'main', {
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: function () { return {} },
      }, PanelPage, function () {
        mountSlot(ctx, 'panellist', 'sidebar.panellist', {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 35,
          locale: NS,
          label: function () { return getT()('panel.title') },
        }, PanelIcon)
      })
    }

    module.exports.inject = ['slots', 'locale', 'sessions', 'uiWorkspace', 'layout']
    module.exports.apply = apply
    module.exports.name = PANEL_ID
    return module.exports
  },
})
