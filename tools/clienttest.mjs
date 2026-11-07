/**
 * 浏览器半侧自测：不启浏览器，用最小 DOM 桩把 client.js 跑一遍。
 *
 * 重点是「一次 load、不炸、能开能关」三件事：
 *   - client.js 是 classic script，靠 window.__ModuleLoader__.load 注册；
 *   - apply() 后 body 上真的有 #dsm-open，点击能造出 #dsm-overlay + iframe；
 *   - iframe 的 src 指向本插件的只读路由，并且每次打开都带新时间戳；
 *   - 关闭时 iframe 被移除（不留后台 rAF 循环）；Esc 也能关。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'client', 'client.js')

let pass = 0
const failures = []
function ok(label, condition, detail) {
  if (condition) { pass++; return }
  failures.push(label + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)))
}

/* ── 最小 DOM 桩 ───────────────────────────────────────────────────────── */
class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.style = {}
    this.dataset = {}
    this.attributes = new Map()
    this.textContent = ''
    this.id = ''
    this.type = ''
    this.src = ''
    this.title = ''
    this.listeners = new Map()
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  removeChild(child) {
    const i = this.children.indexOf(child)
    if (i < 0) throw new Error('removeChild: not a child')
    this.children.splice(i, 1); child.parentNode = null; return child
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); if (key === 'id') this.id = String(value) }
  getAttribute(key) { return this.attributes.has(key) ? this.attributes.get(key) : null }
  removeAttribute(key) { this.attributes.delete(key) }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) fn({ target: this, preventDefault() {}, ...event })
  }
  querySelector(selector) {
    const want = selector.replace(/^#/, '')
    const walk = (node) => {
      for (const child of node.children) {
        if (child.id === want) return child
        const hit = walk(child)
        if (hit) return hit
      }
      return null
    }
    return walk(this)
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 88, height: 32, right: 88, bottom: 32 } }
  get isContentEditable() { return false }
}

function makeWindow() {
  const head = new StubElement('head')
  const body = new StubElement('body')
  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    listeners: new Map(),
    document: {
      head,
      body,
      createElement: (tag) => new StubElement(tag),
      getElementById: (id) => body.querySelector('#' + id),
      addEventListener() {},
    },
    addEventListener(type, fn) {
      if (!win.listeners.has(type)) win.listeners.set(type, [])
      win.listeners.get(type).push(fn)
    },
    dispatch(type, event = {}) { for (const fn of win.listeners.get(type) || []) fn(event) },
    localStorage: {
      store: new Map(),
      getItem(k) { return this.store.has(k) ? this.store.get(k) : null },
      setItem(k, v) { this.store.set(k, String(v)) },
      removeItem(k) { this.store.delete(k) },
    },
  }
  return win
}

/* ── 载入 client.js ────────────────────────────────────────────────────── */
const win = makeWindow()
const loaded = []
win.__ModuleLoader__ = {
  load(entry) {
    loaded.push(entry)
    const factory = entry.factory((id) => { throw new Error('未预期的 require: ' + id) })
    // 宿主会把它当模块返回：name / inject / apply
    win.__registered = factory
    return factory
  },
}

const source = readFileSync(CLIENT, 'utf8')
const sandbox = { window: win, document: win.document, localStorage: win.localStorage, console, Date, Math, JSON, Number, String, Object, Array, Error, setTimeout, clearTimeout }
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

/* ── 断言 ──────────────────────────────────────────────────────────────── */
ok('只调用了一次 __ModuleLoader__.load', loaded.length === 1, loaded.length)
ok('load id 是包名', loaded[0] && loaded[0].id === '@gzqdev/dsh-memory-starmap', loaded[0] && loaded[0].id)

const mod = win.__registered
ok('factory 返回 name', typeof mod.name === 'string' && mod.name.length > 0, mod.name)
ok('inject 是数组', Array.isArray(mod.inject))
ok('apply 是函数', typeof mod.apply === 'function')

mod.apply({})
const opener = win.document.body.querySelector('#dsm-open')
ok('挂载了悬浮按钮', !!opener)
ok('按钮有文案', !!opener && opener.textContent.includes('星图'), opener && opener.textContent)
ok('按钮默认左下（样式表里 left:16px）', win.document.head.children[0].textContent.includes('#dsm-open{position:fixed;left:16px'))
ok('注入了一份样式', win.document.head.children.length === 1 && win.document.head.children[0].tagName === 'STYLE')

// 纯点击（未超过拖动阈值）→ 打开浮层
opener.dispatch('mousedown', { clientX: 10, clientY: 10 })
win.dispatch('mouseup', {})
const overlay = win.document.body.querySelector('#dsm-overlay')
ok('点击后出现浮层', !!overlay)
const frame = overlay && overlay.querySelector('#dsm-frame')
ok('浮层里有 iframe', !!frame)
ok('iframe 指向只读路由', !!frame && String(frame.src).startsWith('/api/memory-starmap/page?t='), frame && frame.src)

// 再次点击 → 关闭且销毁 iframe
opener.dispatch('mousedown', { clientX: 10, clientY: 10 })
win.dispatch('mouseup', {})
ok('再点击关闭浮层', overlay.style.display === 'none', overlay.style.display)
ok('关闭时销毁 iframe', !overlay.querySelector('#dsm-frame'))

// 拖动超过阈值 → 落位并持久化，不触发开关
opener.dispatch('mousedown', { clientX: 10, clientY: 10 })
win.dispatch('mousemove', { clientX: 300, clientY: 400 })
win.dispatch('mouseup', {})
ok('拖动后浮层仍关闭', overlay.style.display === 'none')
ok('拖动后位置持久化', win.localStorage.getItem('dsh.starmap.fab.position.v1') !== null, win.localStorage.getItem('dsh.starmap.fab.position.v1'))

// Esc 关闭
opener.dispatch('mousedown', { clientX: 10, clientY: 10 })
win.dispatch('mouseup', {})
ok('Esc 前是开的', overlay.style.display === 'flex', overlay.style.display)
win.dispatch('keydown', { key: 'Escape', target: { tagName: 'BODY' } })
ok('Esc 关闭', overlay.style.display === 'none', overlay.style.display)

// 重复 apply 不重复挂载
mod.apply({})
const buttons = win.document.body.children.filter((child) => child.querySelector && child.querySelector('#dsm-open'))
ok('重复 apply 不重复挂载', buttons.length === 1, buttons.length)

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${pass} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const failure of failures) console.log('  ✗ ' + failure)
  process.exitCode = 1
}
