/**
 * dsh-skill-manager client half contract tests.
 *
 * The browser bundle is evaluated against a fake module loader, a fake React
 * (hooks with synchronous re-render), a fake client context and a fake fetch.
 * This is a contract/regression harness (the same approach as
 * dsh-api-balance/test/client-test.mjs); it is NOT a visual verification of the
 * running panel.
 *
 * Run with: node test/client-test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log('  ok   ' + label)
  } else {
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' → ' + detail))
    failures.push(label)
  }
}

/* --------------------------------------------------------------- fixtures */

const SESSION = {
  current: 'sess-1',
  byId: { 'sess-1': { cwd: 'C:/work/demo', displayTitle: 'Demo session' } },
  ids: ['sess-1'],
}

function baseState(overrides) {
  const state = {
    ok: true,
    view: {
      cwd: 'C:/work/demo',
      projectRoot: 'C:/work/demo',
      preset: { id: 'standard', source: 'bundled', hasFilesystem: true },
    },
    mounted: true,
    roots: [
      { key: 'project', source: 'project-agents', path: 'C:/work/demo/.agents/skills', exists: true, writable: true },
      { key: 'user', source: 'user-dsh', path: 'C:/Users/demo/.dsh/skills', exists: true, writable: true },
    ],
    skills: [
      {
        name: 'alpha-skill',
        description: 'Alpha helper',
        whenToUse: 'When alpha work appears',
        path: 'C:/work/demo/.agents/skills/alpha-skill/SKILL.md',
        source: 'project-agents',
        provider: 'filesystem',
        layout: 'directory',
        invocation: { modelInvocable: true, userInvocable: true },
        writable: true,
        rootKey: 'project',
        etag: '111:20',
        bytes: 1200,
        mtimeMs: 111,
      },
      {
        name: 'beta-skill',
        description: 'Beta notes',
        path: 'C:/Users/demo/.dsh/skills/beta-skill.md',
        source: 'user-dsh',
        provider: 'filesystem',
        layout: 'flat',
        invocation: { modelInvocable: true, userInvocable: false },
        writable: true,
        rootKey: 'user',
        etag: '222:30',
        bytes: 800,
        mtimeMs: 222,
      },
      {
        name: 'builtin-helper',
        description: 'Bundled helper',
        source: 'bundled',
        provider: 'filesystem',
        layout: 'provider',
        invocation: { modelInvocable: true, userInvocable: true },
        writable: false,
        readonlyReason: 'bundled',
      },
    ],
    targets: [
      { key: 'project', label: 'Project .agents/skills', path: 'C:/work/demo/.agents/skills' },
      { key: 'user', label: 'User skills', path: 'C:/Users/demo/.dsh/skills' },
    ],
    limits: { bodyBytes: 262144 },
    warnings: [],
  }
  const patch = overrides || {}
  return Object.assign(state, patch)
}

function detailFor(name) {
  const state = baseState()
  const summary = state.skills.find((skill) => skill.name === name) || state.skills[0]
  return Object.assign({}, summary, {
    body: '# ' + name + '\n\nFull body for ' + name + '.',
    frontmatter: { name: summary.name, description: summary.description },
    etag: summary.etag || '0:0',
    bytes: summary.bytes || 100,
    mtimeMs: summary.mtimeMs || 0,
  })
}

function baseRoutes(state) {
  return {
    '/api/skill-manager/state': state || baseState(),
    '/api/skill-manager/detail': function (request) {
      const name = request.url.searchParams.get('name')
      return { ok: true, skill: detailFor(name) }
    },
    '/api/skill-manager/create': {
      ok: true,
      path: 'C:/work/demo/.agents/skills/new-skill/SKILL.md',
      discovery: { state: 'discovered', waitedMs: 12 },
    },
    '/api/skill-manager/update': {
      ok: true,
      path: 'C:/work/demo/.agents/skills/alpha-skill/SKILL.md',
      discovery: { state: 'discovered', waitedMs: 9 },
    },
    '/api/skill-manager/delete': {
      ok: true,
      deletedPath: 'C:/work/demo/.agents/skills/alpha-skill',
      discovery: { state: 'removed', waitedMs: 40 },
    },
    '/api/skill-manager/import': function (request) {
      return {
        ok: true,
        action: request.body && request.body.mode === 'directory' ? 'import-directory' : 'import-file',
        path: 'C:/work/demo/.agents/skills/imported-skill/SKILL.md',
        discovery: { state: 'discovered', waitedMs: 15 },
      }
    },
  }
}

/* ------------------------------------------------------------ mini React */

function createRuntime() {
  const shared = { current: null, pending: null }

  class Component {
    constructor(props) {
      this.props = props || {}
      this.state = {}
    }
    setState(update) {
      this.state = Object.assign({}, this.state, typeof update === 'function' ? update(this.state) : update)
    }
  }

  function pushFlat(out, value) {
    if (Array.isArray(value)) {
      for (const item of value) pushFlat(out, item)
      return
    }
    if (value === null || value === undefined || value === false || value === true) return
    out.push(value)
  }

  function createElement(type, propsArg) {
    const children = []
    for (let i = 2; i < arguments.length; i++) pushFlat(children, arguments[i])
    const props = Object.assign({}, propsArg || {})
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    return { type: type, props: props, children: children }
  }

  function useState(initial) {
    const inst = shared.current
    const index = inst.hookIndex++
    if (!(index in inst.hooks)) {
      inst.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = inst.hooks[index]
    const setValue = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      inst.render()
    }
    return [slot.value, setValue]
  }

  function useEffect(effect, deps) {
    const inst = shared.current
    const index = inst.hookIndex++
    const slot = inst.hooks[index] || (inst.hooks[index] = { deps: null, cleanup: null })
    let changed = !slot.deps || !deps || deps.length !== slot.deps.length
    if (!changed) {
      for (let i = 0; i < deps.length; i++) {
        if (deps[i] !== slot.deps[i]) { changed = true; break }
      }
    }
    if (!changed) return
    if (typeof slot.cleanup === 'function') {
      try { slot.cleanup() } catch (error) { /* ignore */ }
    }
    slot.cleanup = null
    slot.deps = deps || null
    if (shared.pending !== null) shared.pending.push({ slot: slot, fn: effect })
  }

  function useRef(initial) {
    const inst = shared.current
    const index = inst.hookIndex++
    if (!(index in inst.hooks)) inst.hooks[index] = { current: initial }
    return inst.hooks[index]
  }

  function useMemo(factory) { return factory() }
  function useCallback(callback) { return callback }

  const React = {
    createElement: createElement,
    Fragment: 'Fragment',
    Component: Component,
    useState: useState,
    useEffect: useEffect,
    useRef: useRef,
    useMemo: useMemo,
    useCallback: useCallback,
  }

  function isClassComponent(type) {
    return typeof type === 'function' && type.prototype instanceof Component
  }

  function build(vnode, owner, path) {
    if (vnode === null || vnode === undefined || vnode === false || vnode === true) return null
    if (Array.isArray(vnode)) {
      const out = []
      for (let i = 0; i < vnode.length; i++) {
        const node = build(vnode[i], owner, path + ':' + i)
        if (node !== null) out.push(node)
      }
      return out
    }
    if (typeof vnode === 'string' || typeof vnode === 'number') return { kind: 'text', text: String(vnode) }
    if (typeof vnode.type === 'function') {
      let inst = owner.childMap[path]
      if (!inst || inst.type !== vnode.type) {
        inst = makeInstance(vnode.type, vnode.props, owner, path)
        owner.childMap[path] = inst
      } else {
        inst.props = vnode.props
        renderInstance(inst)
      }
      return { kind: 'comp', inst: inst }
    }
    const children = []
    for (let i = 0; i < vnode.children.length; i++) {
      const node = build(vnode.children[i], owner, path + '/' + i)
      if (node !== null) children.push(node)
    }
    return { kind: 'host', type: vnode.type, props: vnode.props, children: children }
  }

  function makeInstance(type, props, owner, path) {
    const inst = {
      type: type,
      props: props || {},
      owner: owner,
      path: path,
      hooks: [],
      hookIndex: 0,
      children: [],
      childMap: Object.create(null),
      instance: null,
    }
    inst.render = function () { renderInstance(inst) }
    if (isClassComponent(type)) {
      inst.instance = new type(inst.props)
      inst.instance.props = inst.props
      if (!inst.instance.state) inst.instance.state = {}
    }
    renderInstance(inst)
    return inst
  }

  function renderInstance(inst) {
    let vnode
    if (inst.instance !== null) {
      inst.instance.props = inst.props
      vnode = inst.instance.render()
      inst.children = buildChildren(vnode, inst)
      return
    }
    const pending = []
    const previousPending = shared.pending
    shared.pending = pending
    shared.current = inst
    inst.hookIndex = 0
    try {
      vnode = inst.type(inst.props)
    } finally {
      shared.current = null
      shared.pending = previousPending
    }
    inst.children = buildChildren(vnode, inst)
    for (let i = 0; i < pending.length; i++) {
      const entry = pending[i]
      const cleanup = entry.fn()
      if (typeof cleanup === 'function') entry.slot.cleanup = cleanup
    }
  }

  function buildChildren(vnode, inst) {
    const nodes = build(vnode, inst, 'root')
    if (Array.isArray(nodes)) return nodes.filter(Boolean)
    return nodes === null ? [] : [nodes]
  }

  function mount(component, props) {
    const owner = { childMap: Object.create(null) }
    const node = build(createElement(component, props), owner, 'root')
    return node
  }

  return { React: React, mount: mount }
}

/* ----------------------------------------------------------- rendered tree */

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'string') return node
  if (node.kind === 'text') return node.text
  if (node.kind === 'host') return node.children.map(textOf).join(' ')
  if (node.kind === 'comp') return node.inst.children.map(textOf).join(' ')
  return ''
}

function collect(node, out) {
  const list = out || []
  if (node === null || node === undefined) return list
  if (Array.isArray(node)) {
    for (const item of node) collect(item, list)
    return list
  }
  if (typeof node === 'string') return list
  list.push(node)
  if (node.kind === 'host') for (const child of node.children) collect(child, list)
  else if (node.kind === 'comp') for (const child of node.inst.children) collect(child, list)
  return list
}

function hosts(node, type) {
  return collect(node).filter((item) => item.kind === 'host' && (type === undefined || item.type === type))
}

function hostByText(node, type, text) {
  return hosts(node, type).find((item) => textOf(item).indexOf(text) !== -1) || null
}

function hostById(node, id) {
  return hosts(node, 'input').concat(hosts(node, 'textarea'), hosts(node, 'select')).find((item) => item.props.id === id) || null
}

function click(node) {
  if (node && node.props && typeof node.props.onClick === 'function') node.props.onClick()
}

/* ----------------------------------------------------------------- asar-No fake DOM */

function makeDocument() {
  const headChildren = []
  const documentStub = {
    head: {
      appendChild(node) { headChildren.push(node) },
    },
    createElement(tag) {
      const node = {
        tag: tag,
        attrs: Object.create(null),
        textContent: '',
        setAttribute(name, value) { node.attrs[name] = value },
        remove() {
          const index = headChildren.indexOf(node)
          if (index >= 0) headChildren.splice(index, 1)
        },
      }
      return node
    },
    querySelector(selector) {
      const match = /^style\[data-plugin-css="(.+)"\]$/.exec(selector)
      if (!match) return null
      for (const node of headChildren) {
        if (node.attrs && node.attrs['data-plugin-css'] === match[1]) return node
      }
      return null
    },
  }
  return { document: documentStub, styles: headChildren }
}

/* ------------------------------------------------------------------- fetch */

function makeFetch(routes) {
  const calls = []
  async function fetchImpl(url, options) {
    const settings = options || {}
    const parsed = new URL(url, 'http://127.0.0.1:5816')
    const body = typeof settings.body === 'string' ? JSON.parse(settings.body) : settings.body || null
    calls.push({ path: parsed.pathname, search: parsed.search, method: settings.method || 'GET', body: body })
    if (settings.signal && settings.signal.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    const route = routes[parsed.pathname]
    if (route === undefined) {
      return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'SKILL_NOT_FOUND', message: 'no route ' + parsed.pathname } }) }
    }
    const payload = typeof route === 'function' ? await route({ url: parsed, method: settings.method || 'GET', body: body }) : route
    if (payload && payload.__status !== undefined) {
      return { ok: payload.__status >= 200 && payload.__status < 300, status: payload.__status, json: async () => payload.body }
    }
    return { ok: true, status: 200, json: async () => payload }
  }
  fetchImpl.calls = calls
  fetchImpl.routes = routes
  return fetchImpl
}

/* --------------------------------------------------------------- fake ctx */

function makeCtx(options) {
  const settings = options || {}
  const registrations = []
  const effects = []
  const dicts = Object.create(null)
  const localeSubscribers = new Set()
  let activeLocale = 'zh'

  const ctx = {
    effect(factory, label) {
      const cleanup = factory()
      effects.push({ label: label, cleanup: cleanup })
      return cleanup
    },
    slots: {
      inject(slotName, factory) { return factory() },
      register(registration, component) {
        if (settings.failMain === true && registration && registration.name === 'main') {
          throw new Error('main slot is already taken (test fixture)')
        }
        registrations.push({ options: registration, component: component })
        return function () {}
      },
    },
    locale: {
      register(namespace, entries) {
        dicts[namespace] = Object.assign({}, dicts[namespace] || {}, entries)
        return function () {}
      },
      bind(namespace) {
        return function translate(key, params) {
          const table = dicts[namespace] || {}
          const dictionary = table[activeLocale] || table.en || table.zh || {}
          let text = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key
          if (params) {
            text = text.replace(/\{(\w+)\}/g, function (match, name) {
              return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
            })
          }
          return text
        }
      },
      subscribe(listener) {
        localeSubscribers.add(listener)
        return function () { localeSubscribers.delete(listener) }
      },
      setActive(locale) {
        activeLocale = locale
        for (const listener of Array.from(localeSubscribers)) listener()
      },
      getActive() { return activeLocale },
    },
    sessions: {
      list: {
        getSnapshot() { return settings.session || SESSION },
        subscribe() { return function () {} },
      },
    },
    uiWorkspace: {
      pickDirectory: settings.pickDirectory || function () { return Promise.resolve(null) },
    },
    layout: {
      selectPanel(id) {
        if (settings.panelCalls) settings.panelCalls.push(id)
      },
    },
  }
  return { ctx: ctx, registrations: registrations, effects: effects, dicts: dicts, locale: ctx.locale }
}

/* --------------------------------------------------------------- harness */

function loadBundle(react, documentStub, fetchImpl) {
  let exported = null
  const windowStub = {
    __ModuleLoader__: {
      load(entry) {
        if (entry.id !== 'dsh-skill-manager') throw new Error('unexpected loader id: ' + entry.id)
        exported = entry.factory(function requireModule(name) {
          if (name === 'react') return react
          throw new Error('unexpected require: ' + name)
        })
      },
    },
  }
  const evaluate = new Function('window', 'document', 'fetch', source)
  evaluate(windowStub, documentStub, fetchImpl)
  if (!exported) throw new Error('bundle did not call window.__ModuleLoader__.load')
  return exported
}

function boot(options) {
  const settings = options || {}
  const documentRef = makeDocument()
  const routes = settings.routes || baseRoutes(settings.state)
  const fetchImpl = makeFetch(routes)
  const runtime = createRuntime()
  const bundle = loadBundle(runtime.React, documentRef.document, fetchImpl)
  const env = makeCtx({
    session: settings.session === undefined ? SESSION : settings.session,
    pickDirectory: settings.pickDirectory,
    panelCalls: settings.panelCalls,
    failMain: settings.failMain,
  })
  bundle.apply(env.ctx)
  return { bundle: bundle, env: env, document: documentRef, fetch: fetchImpl, runtime: runtime }
}

async function flush(rounds) {
  const count = rounds === undefined ? 8 : rounds
  for (let i = 0; i < count; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function mountMain(booted) {
  const main = booted.env.registrations.find((entry) => entry.options.name === 'main')
  if (!main) throw new Error('main was not registered')
  const node = booted.runtime.mount(main.component)
  return { node: node, text: function () { return textOf(node) } }
}

function callsTo(booted, path, method) {
  return booted.fetch.calls.filter((call) => call.path === path && (method === undefined || call.method === method))
}

/* ================================================================== tests */

console.log('== registration contract')
{
  const booted = boot()
  const names = booted.env.registrations.map((entry) => entry.options.name)
  check('registers main', names.indexOf('main') !== -1, names.join(','))
  check('registers sidebar.panellist', names.indexOf('sidebar.panellist') !== -1, names.join(','))
  check('main registered before panellist', names[0] === 'main' && names[1] === 'sidebar.panellist', names.join(','))
  const main = booted.env.registrations.find((entry) => entry.options.name === 'main')
  const panel = booted.env.registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  check('main key + locale', main.options.key === 'skill-manager' && main.options.locale === 'dsh-skill-manager')
  check('panellist id + order', panel.options.id === 'skill-manager' && panel.options.order === 35)
  check('panellist label resolves (zh)', panel.options.label() === 'Skill 管理', panel.options.label())
  booted.env.locale.setActive('en')
  check('panellist label resolves (en)', panel.options.label() === 'Skill manager', panel.options.label())
  check('bundle inject services', ['slots', 'locale', 'sessions', 'uiWorkspace', 'layout'].every((name) => booted.bundle.inject.indexOf(name) !== -1), booted.bundle.inject.join(','))
  check('sidebar glyph accepts size/active', (() => {
    const node = booted.runtime.mount(panel.component, { size: 18, active: true })
    const svg = hosts(node, 'svg')[0]
    return svg && svg.props.width === 18 && svg.props.height === 18
  })())
}

console.log('\n== main rejection keeps panellist unregistered')
{
  const originalWarn = console.warn
  console.warn = function () {}
  let booted
  try {
    booted = boot({ failMain: true })
  } finally {
    console.warn = originalWarn
  }
  const names = booted.env.registrations.map((entry) => entry.options.name)
  check('no main', names.indexOf('main') === -1, names.join(','))
  check('no panellist without main', names.indexOf('sidebar.panellist') === -1, names.join(','))
}

console.log('\n== healthy list')
{
  const booted = boot()
  const page = mountMain(booted)
  await flush()
  const text = page.text()
  check('shows skill names', text.indexOf('alpha-skill') !== -1 && text.indexOf('beta-skill') !== -1 && text.indexOf('builtin-helper') !== -1, text.slice(0, 300))
  check('shows descriptions', text.indexOf('Alpha helper') !== -1)
  check('shows source labels', text.indexOf('项目 .agents') !== -1 && text.indexOf('内置') !== -1, text.slice(0, 300))
  check('shows counts', text.indexOf('3 个技能') !== -1, text.slice(0, 200))
  check('shows project subtitle', text.indexOf('C:/work/demo') !== -1)
  check('no-session banner absent', text.indexOf('当前没有会话') === -1)
  check('state route called with sessionId + cwd', (() => {
    const call = callsTo(booted, '/api/skill-manager/state')[0]
    return call && call.search.indexOf('sessionId=sess-1') !== -1 && call.search.indexOf('cwd=C%3A%2Fwork%2Fdemo') !== -1
  })(), JSON.stringify(callsTo(booted, '/api/skill-manager/state')))
}

console.log('\n== search and source filter')
{
  const booted = boot()
  const page = mountMain(booted)
  await flush()
  const search = hosts(page.node, 'input').find((node) => node.props.type === 'search')
  check('search input present', search !== undefined)
  search.props.onChange({ target: { value: 'beta' } })
  await flush(2)
  let text = page.text()
  check('search narrows list', text.indexOf('beta-skill') !== -1 && text.indexOf('alpha-skill') === -1, text.slice(0, 240))
  check('count follows filter', text.indexOf('1 个技能') !== -1, text.slice(0, 200))
  search.props.onChange({ target: { value: 'no-such-skill' } })
  await flush(2)
  text = page.text()
  check('filtered empty state', text.indexOf('没有匹配的技能') !== -1, text.slice(0, 240))
  const clear = hostByText(page.node, 'button', '清除筛选')
  check('clear filters action present', clear !== null)
  if (clear) click(clear)
  await flush(2)
  text = page.text()
  check('clear filters restores list', text.indexOf('alpha-skill') !== -1, text.slice(0, 200))
  const select = hosts(page.node, 'select').find((node) => node.props['aria-label'] === '来源筛选')
  check('source filter present', select !== undefined)
  select.props.onChange({ target: { value: 'bundled' } })
  await flush(2)
  text = page.text()
  check('source filter narrows list', text.indexOf('builtin-helper') !== -1 && text.indexOf('alpha-skill') === -1, text.slice(0, 240))
}

console.log('\n== empty states')
{
  const noSessionState = baseState({ skills: [], targets: [{ key: 'user', label: 'User skills', path: 'C:/Users/demo/.dsh/skills' }] })
  const booted = boot({ state: noSessionState, session: { current: undefined, byId: {}, ids: [] } })
  const page = mountMain(booted)
  await flush()
  const text = page.text()
  check('no session banner', text.indexOf('当前没有会话') !== -1, text.slice(0, 300))
  check('no session empty copy', text.indexOf('仅显示用户级') !== -1, text.slice(0, 300))
  check('user subtitle', text.indexOf('用户级') !== -1, text.slice(0, 200))

  const notMounted = baseState({ mounted: false, skills: [] })
  const booted2 = boot({ state: notMounted })
  const page2 = mountMain(booted2)
  await flush()
  const text2 = page2.text()
  check('not-mounted banner', text2.indexOf('未挂载') !== -1, text2.slice(0, 300))
  check('write actions disabled when not mounted', (() => {
    const create = hostByText(page2.node, 'button', '新建技能')
    return create !== null && create.props.disabled === true
  })(), text2.slice(0, 200))
}

console.log('\n== read-only skill')
{
  const booted = boot()
  const page = mountMain(booted)
  await flush()
  const expand = hosts(page.node, 'button').find((node) => node.props['aria-controls'] === 'dsm-details-builtin-helper')
  check('builtin row expandable', expand !== undefined)
  click(expand)
  await flush(4)
  const text = page.text()
  check('readonly reason shown', text.indexOf('随应用分发的内置技能') !== -1, text.slice(0, 400))
  const edit = hostByText(page.node, 'button', '编辑')
  const remove = hostByText(page.node, 'button', '删除')
  check('edit disabled for read-only', edit !== null && edit.props.disabled === true)
  check('delete disabled for read-only', remove !== null && remove.props.disabled === true)
  check('readonly note linked by aria-describedby', edit !== null && typeof edit.props['aria-describedby'] === 'string', String(edit && edit.props['aria-describedby']))
}

console.log('\n== detail preview')
{
  const booted = boot()
  const page = mountMain(booted)
  await flush()
  const expand = hosts(page.node, 'button').find((node) => node.props['aria-controls'] === 'dsm-details-alpha-skill')
  click(expand)
  await flush(4)
  const text = page.text()
  check('detail path shown', text.indexOf('alpha-skill/SKILL.md') !== -1, text.slice(0, 400))
  check('body preview shown', text.indexOf('Full body for alpha-skill') !== -1, text.slice(0, 500))
  check('detail route called', callsTo(booted, '/api/skill-manager/detail').length >= 1)
}

console.log('\n== edit prefill + baseMtimeMs')
{
  const booted = boot()
  const page = mountMain(booted)
  await flush()
  click(hosts(page.node, 'button').find((node) => node.props['aria-controls'] === 'dsm-details-alpha-skill'))
  await flush(4)
  click(hostByText(page.node, 'button', '编辑'))
  await flush(6)
  let text = page.text()
  check('edit dialog opened', text.indexOf('编辑技能') !== -1, text.slice(0, 300))
  const name = hostById(page.node, 'dsm-field-name')
  const description = hostById(page.node, 'dsm-field-description')
  const body = hostById(page.node, 'dsm-field-body')
  check('name prefilled and locked', name !== null && name.props.value === 'alpha-skill' && name.props.disabled === true, JSON.stringify(name && name.props))
  check('description prefilled', description !== null && description.props.value === 'Alpha helper', String(description && description.props.value))
  check('body prefilled', body !== null && body.props.value.indexOf('Full body for alpha-skill') !== -1, String(body && body.props.value).slice(0, 80))
  const whenToUse = hostById(page.node, 'dsm-field-when')
  check('whenToUse prefilled', whenToUse !== null && whenToUse.props.value === 'When alpha work appears', String(whenToUse && whenToUse.props.value))
  description.props.onChange({ target: { value: 'Alpha updated' } })
  whenToUse.props.onChange({ target: { value: '' } })
  await flush(2)
  const save = hosts(page.node, 'button').find((node) => textOf(node).trim() === '保存')
  check('save button present', save !== undefined)
  click(save)
  await flush(6)
  const updateCalls = callsTo(booted, '/api/skill-manager/update', 'POST')
  check('update posted once', updateCalls.length === 1, String(updateCalls.length))
  const payload = updateCalls[0] ? updateCalls[0].body : null
  check('update carries name/description/baseMtimeMs', payload && payload.name === 'alpha-skill' && payload.description === 'Alpha updated' && payload.baseMtimeMs === 111, JSON.stringify(payload))
  check('edit clearing whenToUse sends explicit empty string', payload !== null && Object.prototype.hasOwnProperty.call(payload, 'whenToUse') && payload.whenToUse === '', JSON.stringify(payload))
  check('update did not send root', payload && payload.root === undefined)
  await flush(4)
  text = page.text()
  check('saved notice shown', text.indexOf('已保存') !== -1, text.slice(0, 400))
}

console.log('\n== delete two-step confirmation')
{
  const booted = boot()
  const page = mountMain(booted)
  await flush()
  click(hosts(page.node, 'button').find((node) => node.props['aria-controls'] === 'dsm-details-alpha-skill'))
  await flush(4)
  click(hostByText(page.node, 'button', '删除'))
  await flush(2)
  let text = page.text()
  check('delete dialog is an alertdialog', (() => {
    const dialog = collect(page.node).find((item) => item.kind === 'host' && item.props.role === 'alertdialog')
    return dialog !== undefined
  })(), text.slice(0, 300))
  check('delete dialog shows name, path and type', text.indexOf('alpha-skill') !== -1 && text.indexOf('alpha-skill/SKILL.md') !== -1 && text.indexOf('整个技能目录') !== -1, text.slice(0, 400))
  click(hostByText(page.node, 'button', '取消'))
  await flush(2)
  check('cancel sends no delete request', callsTo(booted, '/api/skill-manager/delete', 'POST').length === 0)
  click(hostByText(page.node, 'button', '删除'))
  await flush(2)
  const confirm = hosts(page.node, 'button').find((node) => textOf(node).trim() === '确认删除')
  check('confirm button present', confirm !== undefined)
  click(confirm)
  await flush(6)
  const deleteCalls = callsTo(booted, '/api/skill-manager/delete', 'POST')
  check('delete posted once', deleteCalls.length === 1, String(deleteCalls.length))
  check('delete carries confirmName', deleteCalls[0] && deleteCalls[0].body.confirmName === 'alpha-skill', JSON.stringify(deleteCalls[0] && deleteCalls[0].body))
  text = page.text()
  check('deleted notice shown', text.indexOf('已删除') !== -1, text.slice(0, 400))
}

console.log('\n== edit conflict offers reload')
{
  const routes = baseRoutes()
  routes['/api/skill-manager/update'] = { __status: 409, body: { ok: false, error: { code: 'FILE_CHANGED', message: 'changed on disk' } } }
  const booted = boot({ routes: routes })
  const page = mountMain(booted)
  await flush()
  click(hosts(page.node, 'button').find((node) => node.props['aria-controls'] === 'dsm-details-alpha-skill'))
  await flush(4)
  click(hostByText(page.node, 'button', '编辑'))
  await flush(6)
  const save = hosts(page.node, 'button').find((node) => textOf(node).trim() === '保存')
  click(save)
  await flush(6)
  const text = page.text()
  check('conflict explains external change', text.indexOf('文件已被外部修改') !== -1, text.slice(0, 400))
  check('conflict offers reload', hostByText(page.node, 'button', '重新加载') !== null)
}

console.log('\n== discovery pending after delete')
{
  const routes = baseRoutes()
  routes['/api/skill-manager/delete'] = { ok: true, deletedPath: 'C:/work/demo/.agents/skills/alpha-skill', discovery: { state: 'pending' } }
  const booted = boot({ routes: routes })
  const page = mountMain(booted)
  await flush()
  click(hosts(page.node, 'button').find((node) => node.props['aria-controls'] === 'dsm-details-alpha-skill'))
  await flush(4)
  click(hostByText(page.node, 'button', '删除'))
  await flush(2)
  click(hosts(page.node, 'button').find((node) => textOf(node).trim() === '确认删除'))
  await flush(6)
  check('pending delete reported honestly', page.text().indexOf('已删除，等待目录刷新') !== -1, page.text().slice(0, 400))
}

console.log('\n== import file')
{
  const booted = boot()
  const page = mountMain(booted)
  await flush()
  click(hostByText(page.node, 'button', '导入'))
  await flush(2)
  const fileInput = hosts(page.node, 'input').find((node) => node.props.type === 'file')
  check('file input accepts .md', fileInput !== undefined && fileInput.props.accept === '.md,text/markdown')
  const file = { name: 'imported.md', size: 40, text: async () => '---\nname: imported\ndescription: x\n---\nbody' }
  fileInput.props.onChange({ target: { files: [file], value: 'C:\\fakepath\\imported.md' } })
  await flush(4)
  let text = page.text()
  check('picked file echoed', text.indexOf('已选择 imported.md') !== -1, text.slice(0, 400))
  const submit = hosts(page.node, 'button').filter((node) => textOf(node).trim() === '导入').pop()
  check('import submit present', submit !== undefined)
  click(submit)
  await flush(6)
  const importCalls = callsTo(booted, '/api/skill-manager/import', 'POST')
  check('import file posted', importCalls.length === 1, String(importCalls.length))
  const payload = importCalls[0] ? importCalls[0].body : null
  check('import file payload', payload && payload.mode === 'file' && payload.filename === 'imported.md' && payload.content.indexOf('name: imported') !== -1 && payload.root === 'project', JSON.stringify(payload))
  text = page.text()
  check('imported notice shown', text.indexOf('已导入') !== -1, text.slice(0, 400))
}

console.log('\n== import folder: cancel, reject, success')
{
  const booted = boot({ pickDirectory: () => Promise.resolve('C:/tmp/tool-skill') })
  const page = mountMain(booted)
  await flush()
  click(hostByText(page.node, 'button', '导入'))
  await flush(2)
  const radios = hosts(page.node, 'input').filter((node) => node.props.type === 'radio')
  check('two import modes', radios.length === 2)
  radios[1].props.onChange()
  await flush(2)
  click(hostByText(page.node, 'button', '选择技能文件夹'))
  await flush(4)
  let text = page.text()
  check('folder path echoed', text.indexOf('C:/tmp/tool-skill') !== -1, text.slice(0, 400))
  const submit = hosts(page.node, 'button').filter((node) => textOf(node).trim() === '导入').pop()
  click(submit)
  await flush(6)
  const importCalls = callsTo(booted, '/api/skill-manager/import', 'POST')
  check('import folder posted', importCalls.length === 1 && importCalls[0].body.mode === 'directory' && importCalls[0].body.sourcePath === 'C:/tmp/tool-skill', JSON.stringify(importCalls[0] && importCalls[0].body))

  const cancelled = boot({ pickDirectory: () => Promise.resolve(null) })
  const page2 = mountMain(cancelled)
  await flush()
  click(hostByText(page2.node, 'button', '导入'))
  await flush(2)
  hosts(page2.node, 'input').filter((node) => node.props.type === 'radio')[1].props.onChange()
  await flush(2)
  click(hostByText(page2.node, 'button', '选择技能文件夹'))
  await flush(4)
  check('cancelled folder select is not an error', page2.text().indexOf('无法打开文件夹选择器') === -1, page2.text().slice(0, 300))

  const rejected = boot({ pickDirectory: () => Promise.reject(new Error('no picker here')) })
  const page3 = mountMain(rejected)
  await flush()
  click(hostByText(page3.node, 'button', '导入'))
  await flush(2)
  hosts(page3.node, 'input').filter((node) => node.props.type === 'radio')[1].props.onChange()
  await flush(2)
  click(hostByText(page3.node, 'button', '选择技能文件夹'))
  await flush(4)
  check('rejected folder select explains fallback', page3.text().indexOf('无法打开文件夹选择器') !== -1, page3.text().slice(0, 400))
}

console.log('\n== locale switch re-renders')
{
  const booted = boot()
  const page = mountMain(booted)
  await flush()
  booted.env.locale.setActive('en')
  await flush(3)
  const text = page.text()
  check('english header', text.indexOf('Skills') !== -1, text.slice(0, 200))
  check('english actions', text.indexOf('New skill') !== -1 && text.indexOf('Import') !== -1, text.slice(0, 300))
  check('english filter', text.indexOf('All sources') !== -1, text.slice(0, 300))
  check('english source labels', text.indexOf('Bundled') !== -1 && text.indexOf('Project .agents') !== -1, text.slice(0, 400))
}

console.log('\n== style injection is idempotent and disposable')
{
  const booted = boot()
  booted.bundle.apply(booted.env.ctx)
  const styles = booted.document.styles.filter((node) => node.attrs && node.attrs['data-plugin-css'] === 'dsh-skill-manager/client.css')
  check('single style node after two applies', styles.length === 1, String(styles.length))
  for (const effect of booted.env.effects) {
    if (typeof effect.cleanup === 'function') effect.cleanup()
  }
  const remaining = booted.document.styles.filter((node) => node.attrs && node.attrs['data-plugin-css'] === 'dsh-skill-manager/client.css')
  check('style removed by effect cleanup', remaining.length === 0, String(remaining.length))
}

console.log('\n== malformed payloads do not crash the panel')
{
  const booted = boot({ routes: Object.assign(baseRoutes(), { '/api/skill-manager/state': { ok: true } }) })
  const page = mountMain(booted)
  await flush(6)
  const text = page.text()
  check('invalid state shows error state', text.indexOf('无法识别的数据') !== -1, text.slice(0, 300))
  check('error state offers retry', hostByText(page.node, 'button', '重试') !== null)

  const malformed = baseState({ skills: [null, { name: 'lonely-skill' }] })
  const booted2 = boot({ state: malformed })
  const page2 = mountMain(booted2)
  await flush(6)
  const text2 = page2.text()
  check('malformed rows render defensively', text2.indexOf('lonely-skill') !== -1 && text2.indexOf('未知来源') !== -1, text2.slice(0, 300))
  const expand = hosts(page2.node, 'button').find((node) => node.props['aria-controls'] === 'dsm-details-lonely-skill')
  check('malformed row still expandable', expand !== undefined)
  if (expand) {
    click(expand)
    await flush(4)
    const edit = hostByText(page2.node, 'button', '编辑')
    const remove = hostByText(page2.node, 'button', '删除')
    check('missing writable fails closed', edit !== null && edit.props.disabled === true && remove !== null && remove.props.disabled === true)
  }
}

console.log('\n== empty filtered state has no writable target')
{
  const state = baseState({ skills: [], targets: [] })
  const booted = boot({ state: state, session: { current: undefined, byId: {}, ids: [] } })
  const page = mountMain(booted)
  await flush()
  const text = page.text()
  check('no-target notice', text.indexOf('用户级') !== -1, text.slice(0, 300))
  const create = hostByText(page.node, 'button', '新建技能')
  const importButton = hostByText(page.node, 'button', '导入')
  check('create disabled without targets', create !== null && create.props.disabled === true)
  check('import disabled without targets', importButton !== null && importButton.props.disabled === true)
}

console.log('\n== refresh failure keeps old data with a non-blocking warning')
{
  const booted = boot()
  const page = mountMain(booted)
  await flush()
  check('initial list loaded', page.text().indexOf('alpha-skill') !== -1, page.text().slice(0, 240))
  booted.fetch.routes['/api/skill-manager/state'] = function () {
    throw new Error('network down')
  }
  click(hostByText(page.node, 'button', '刷新'))
  await flush(10)
  const text = page.text()
  check('old list preserved after refresh failure', text.indexOf('alpha-skill') !== -1 && text.indexOf('beta-skill') !== -1, text.slice(0, 300))
  check('refresh warning shown', text.indexOf('刷新失败') !== -1, text.slice(0, 400))
  check('refresh warning is a status banner', (() => {
    return collect(page.node).some((item) => item.kind === 'host' && item.props.role === 'status' && textOf(item).indexOf('刷新失败') !== -1)
  })(), text.slice(0, 400))
  check('no full-page error state after refresh failure', text.indexOf('读取技能失败') === -1, text.slice(0, 300))
}

console.log('\n== host warning codes are localized (L3)')
{
  const state = baseState({
    warnings: [
      'degraded-sources',
      'not-mounted',
      { code: 'incomplete-discovery', message: 'raw object message' },
      'brand-new-code',
    ],
  })
  const booted = boot({ state: state })
  const page = mountMain(booted)
  await flush()
  let text = page.text()
  check('degraded-sources localized (zh)', text.indexOf('来源未知') !== -1, text.slice(0, 500))
  check('not-mounted warning localized (zh)', text.indexOf('未挂载') !== -1, text.slice(0, 500))
  check('incomplete-discovery localized (zh)', text.indexOf('发现不完整') !== -1, text.slice(0, 500))
  check('known code ignores raw message', text.indexOf('raw object message') === -1, text.slice(0, 500))
  check('unknown warning code falls back to raw string', text.indexOf('brand-new-code') !== -1, text.slice(0, 500))
  booted.env.locale.setActive('en')
  await flush(3)
  text = page.text()
  check('degraded-sources localized (en)', text.indexOf('Sources are unknown') !== -1, text.slice(0, 600))
  check('not-mounted warning localized (en)', text.indexOf('does not mount the skill filesystem') !== -1, text.slice(0, 600))
  check('incomplete-discovery localized (en)', text.indexOf('discovery is incomplete') !== -1, text.slice(0, 600))
  check('unknown warning code still raw (en)', text.indexOf('brand-new-code') !== -1, text.slice(0, 600))
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : '\n' + failures.length + ' CHECK(S) FAILED: ' + failures.join(' | '))
process.exit(failures.length === 0 ? 0 : 1)
