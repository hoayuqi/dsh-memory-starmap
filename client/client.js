// @local/dsh-memory-starmap —— 浏览器半侧（零构建 vanilla，单模块）。
//
// 宿主 dsh.client 扫描把本文件当 classic script 注入 __DSH_BOOT__，执行时经
// window.__ModuleLoader__.load 注册唯一 factory（id = 包名，与宿主 graph row 对齐）。
// 挂载面：一个可拖动的悬浮按钮 + 全屏浮层，浮层里是一个 iframe，
// 页面来自本插件自己的只读路由 /api/memory-starmap/page。
//
// 用 iframe 而不是拿 React 重画 canvas：星图是 720 行自包含脚本（canvas 2D + 力导向
// + 键盘交互），塞进宿主 React 树只会换来样式打架和生命周期纠缠；iframe 天然隔离、
// 关掉即卸载（requestAnimationFrame 循环跟着停，不留后台耗电）。
;(function () {
  'use strict'
  if (typeof window === 'undefined' || !window.__ModuleLoader__ || !window.__ModuleLoader__.load) return

  window.__ModuleLoader__.load({
    // 必须与 package.json 的 name 完全一致：宿主按它把 graph row 物化到 factory。
    id: '@local/dsh-memory-starmap',
    /**
     * @param {(id: string) => any} _require - 宿主模块解析（本插件不依赖 react）。
     * @returns {{name: string, inject: string[], apply: (ctx: any) => void}}
     */
    factory: function (require) {
      var HOST_ID = 'dsh-starmap-host'
      var BTN_ID = 'dsm-open'
      var POS_KEY = 'dsh.starmap.fab.position.v1'
      var HIDDEN_KEY = 'dsh.starmap.fab.hidden.v1'
      var MARGIN = 8
      var DRAG_THRESHOLD = 4
      var PAGE_URL = '/api/memory-starmap/page'

      // react 是宿主平台内置模块；拿不到就只挂悬浮钮，不挂设置项。
      var react = null
      try { react = require('react') } catch (_reactError) { react = null }

      var root = null
      var opener = null
      var overlay = null
      var frame = null

      /** 悬浮钮是否被用户藏起来（设置页那个勾选框）。 */
      function fabHidden() {
        try { return localStorage.getItem(HIDDEN_KEY) === '1' } catch (_error) { return false }
      }
      function setFabHidden(hidden) {
        try {
          if (hidden) localStorage.setItem(HIDDEN_KEY, '1')
          else localStorage.removeItem(HIDDEN_KEY)
        } catch (_error) { /* 隐私模式忽略 */ }
        if (opener) opener.style.display = hidden ? 'none' : ''
      }

      /** 视口尺寸（iframe 里拿不到宿主尺寸，这里只用 window 安全值）。 */
      function viewport() {
        return {
          width: Number.isFinite(window.innerWidth) ? window.innerWidth : 1024,
          height: Number.isFinite(window.innerHeight) ? window.innerHeight : 768,
        }
      }

      function clampAxis(value, size, limit) {
        return Math.min(Math.max(value, MARGIN), Math.max(MARGIN, limit - size - MARGIN))
      }

      function loadPosition() {
        try {
          var raw = localStorage.getItem(POS_KEY)
          if (!raw) return null
          var parsed = JSON.parse(raw)
          if (typeof parsed.left === 'number' && typeof parsed.top === 'number') return parsed
        } catch (_error) { /* 坏值当没有 */ }
        return null
      }

      function savePosition(left, top) {
        try { localStorage.setItem(POS_KEY, JSON.stringify({ left: left, top: top })) } catch (_error) { /* 隐私模式忽略 */ }
      }

      function placeOpener() {
        if (!opener) return
        var box = opener.getBoundingClientRect()
        var size = viewport()
        var saved = loadPosition()
        if (saved) {
          opener.style.left = clampAxis(saved.left, box.width, size.width) + 'px'
          opener.style.top = clampAxis(saved.top, box.height, size.height) + 'px'
          opener.style.right = 'auto'
          opener.style.bottom = 'auto'
        }
      }

      /** 浮层开关：打开时现造 iframe（每次都是新 document，等于强制重新读库）。 */
      function openOverlay() {
        if (!overlay) {
          overlay = document.createElement('div')
          overlay.id = 'dsm-overlay'
          overlay.setAttribute('role', 'dialog')
          overlay.setAttribute('aria-label', '记忆星图')

          var panel = document.createElement('div')
          panel.id = 'dsm-panel'

          var bar = document.createElement('div')
          bar.id = 'dsm-bar'
          var title = document.createElement('b')
          title.textContent = '记忆星图 · dsh-memento'
          var hint = document.createElement('span')
          hint.textContent = '只读 · 点星看全文 · 滚轮缩放 · Esc 关闭'
          var spacer = document.createElement('span')
          spacer.style.flex = '1'
          var reload = document.createElement('button')
          reload.type = 'button'
          reload.textContent = '重新读取'
          reload.onclick = function () { mountFrame(true) }
          var close = document.createElement('button')
          close.type = 'button'
          close.textContent = '✕'
          close.title = '关闭'
          close.onclick = function () { closeOverlay() }

          bar.appendChild(title)
          bar.appendChild(hint)
          bar.appendChild(spacer)
          bar.appendChild(reload)
          bar.appendChild(close)
          panel.appendChild(bar)
          overlay.appendChild(panel)
          overlay.addEventListener('mousedown', function (event) {
            if (event.target === overlay) closeOverlay()
          })
          document.body.appendChild(overlay)
        }
        overlay.style.display = 'flex'
        mountFrame(false)
      }

      /** 建/换 iframe（reuse=false 时若已存在则先销毁）。 */
      function mountFrame(forceNew) {
        var panel = overlay && overlay.querySelector('#dsm-panel')
        if (!panel) return
        if (frame && forceNew) {
          panel.removeChild(frame)
          frame = null
        }
        if (!frame) {
          frame = document.createElement('iframe')
          frame.id = 'dsm-frame'
          frame.setAttribute('title', '记忆星图')
          panel.appendChild(frame)
        }
        // 时间戳避免浏览器把上一次的页面从 bfcache 里直接端出来。
        frame.src = PAGE_URL + '?t=' + Date.now()
      }

      function closeOverlay() {
        if (!overlay) return
        overlay.style.display = 'none'
        if (frame) {
          var panel = overlay.querySelector('#dsm-panel')
          if (panel) panel.removeChild(frame)
          frame = null
        }
      }

      function isOpen() {
        return !!(overlay && overlay.style.display !== 'none')
      }

      function mount() {
        if (document.getElementById(HOST_ID)) return

        var style = document.createElement('style')
        style.dataset.plugin = 'dsh-memory-starmap'
        style.textContent = [
          '#dsm-open{position:fixed;left:16px;bottom:56px;z-index:2147483000;padding:8px 14px;',
          'border:1px solid #3f6fae;border-radius:999px;background:#0d1526;color:#7db4ff;',
          'font:13px/1.4 system-ui,"Segoe UI",sans-serif;cursor:grab;user-select:none;touch-action:none;',
          'box-shadow:0 4px 14px rgba(0,0,0,.35)}',
          '#dsm-open:hover{background:#16233c}',
          '#dsm-open[data-dragging="1"]{cursor:grabbing}',
          '#dsm-overlay{position:fixed;inset:0;z-index:2147483100;display:none;align-items:center;',
          'justify-content:center;background:rgba(4,6,12,.72);backdrop-filter:blur(3px)}',
          '#dsm-panel{width:min(1240px,94vw);height:min(820px,90vh);display:flex;flex-direction:column;',
          'background:#06080f;border:1px solid #24344d;border-radius:12px;overflow:hidden;',
          'box-shadow:0 24px 60px rgba(0,0,0,.6)}',
          '#dsm-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #1c2a42;',
          'color:#9fb4d4;font:12px/1.4 system-ui,"Segoe UI",sans-serif;background:#0b1120}',
          '#dsm-bar b{color:#dbe7fb;font-size:13px}',
          '#dsm-bar button{background:#1c2a42;color:#cfe1f7;border:1px solid #2f4466;border-radius:6px;',
          'padding:4px 10px;cursor:pointer;font:12px/1.4 system-ui,"Segoe UI",sans-serif}',
          '#dsm-bar button:hover{background:#27395a}',
          '#dsm-frame{flex:1;width:100%;border:0;background:#03040a}',
          '@media (max-width:640px){#dsm-open:not([data-positioned="1"]){bottom:132px}}',
          // 设置页可能是浅色主题：这些样式只在这块用，颜色一律继承宿主，别写死深色
          '.dsm-sec{display:flex;flex-direction:column;gap:10px;font:13px/1.6 inherit;color:inherit}',
          '.dsm-sec-title{margin:0;font-size:15px;font-weight:600;color:inherit}',
          '.dsm-sec-note{margin:0;font-size:12px;color:inherit;opacity:.62}',
          '.dsm-sec-row{display:flex;gap:8px;flex-wrap:wrap}',
          '.dsm-sec-btn{color:inherit;background:transparent;border:1px solid currentColor;border-radius:6px;',
          'padding:5px 12px;cursor:pointer;font:12px/1.4 inherit;opacity:.85}',
          '.dsm-sec-btn:hover{opacity:1}',
          '.dsm-sec-lab{display:flex;align-items:center;gap:8px;font-size:12px;color:inherit;opacity:.85}',
        ].join('')

        opener = document.createElement('button')
        opener.id = BTN_ID
        opener.type = 'button'
        opener.textContent = '✦ 星图'
        opener.title = '记忆星图（只读）'

        root = document.createElement('div')
        root.id = HOST_ID
        root.appendChild(opener)
        document.body.appendChild(root)
        document.head.appendChild(style)
        placeOpener()
        setFabHidden(fabHidden())   // 设置页里关掉的悬浮钮，重启后也不冒出来

        // ── 拖动 = 位移超过阈值；没超过就算点击 ─────────────────────────────
        var drag = null
        opener.addEventListener('mousedown', function (event) {
          event.preventDefault()
          var box = opener.getBoundingClientRect()
          drag = { dx: event.clientX - box.left, dy: event.clientY - box.top, moved: false, sx: event.clientX, sy: event.clientY }
          opener.setAttribute('data-dragging', '1')
          opener.setAttribute('data-positioned', '1')
        })
        window.addEventListener('mousemove', function (event) {
          if (!drag) return
          if (!drag.moved && Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) < DRAG_THRESHOLD) return
          drag.moved = true
          var size = viewport()
          var box = opener.getBoundingClientRect()
          opener.style.left = clampAxis(event.clientX - drag.dx, box.width, size.width) + 'px'
          opener.style.top = clampAxis(event.clientY - drag.dy, box.height, size.height) + 'px'
          opener.style.right = 'auto'
          opener.style.bottom = 'auto'
        })
        window.addEventListener('mouseup', function () {
          if (!drag) return
          var moved = drag.moved
          drag = null
          opener.removeAttribute('data-dragging')
          if (moved) {
            var box = opener.getBoundingClientRect()
            savePosition(box.left, box.top)
          } else {
            if (isOpen()) closeOverlay()
            else openOverlay()
          }
        })
        // 双击复位到左下角默认位
        opener.addEventListener('dblclick', function () {
          try { localStorage.removeItem(POS_KEY) } catch (_error) { /* 忽略 */ }
          opener.style.left = '16px'
          opener.style.top = 'auto'
          opener.style.right = 'auto'
          opener.style.bottom = '56px'
        })
      }

      function isEditable(target) {
        var name = target && target.tagName
        return name === 'INPUT' || name === 'TEXTAREA' || (target && target.isContentEditable === true)
      }

      window.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape' || !isOpen()) return
        // iframe 里的 Esc 由页面自己处理；这条只兜住焦点在宿主文档时的情况。
        if (isEditable(event.target)) return
        closeOverlay()
      })

      return {
        name: 'memory-starmap-client',
        // slots 是「设置页入口」要用的服务：写进 inject，宿主就会等它在场再 apply。
        // （实测：不声明时 apply 里 ctx.slots 拿不到，设置项静默缺席。）
        inject: ['slots'],
        /** @param {any} ctx - 宿主客户端上下文。 */
        apply: function (ctx) {
          mount()
          var slots = null
          try { slots = (ctx && ctx.slots) || null } catch (_slotsError) { slots = null }
          if (!react || !slots) {
            try {
              console.log('[memory-starmap] 设置项跳过：react=' + !!react + ' slots=' + !!slots)
            } catch (_logError) { /* 忽略 */ }
            return
          }
          try {
            var jsx = react.createElement
            var useState = react.useState

            /**
             * 设置页一级项：不常开浮层的人从「设置」里进来，悬浮钮可以关掉。
             * @returns {unknown} react 元素。
             */
            function StarMapSection() {
              var state = useState(fabHidden())
              var hidden = state[0]
              var setHidden = state[1]
              return jsx('div', { className: 'dsm-sec' },
                jsx('h2', { className: 'dsm-sec-title' }, '记忆星图'),
                jsx('p', { className: 'dsm-sec-note' },
                  '只读可视化：一颗星 = 一条记忆条目，体积 = 字符数，亮度 = 召回次数，颜色 = 归属层，'
                  + '连线 = 共享标签/同会话/词元相似。数据直接读 dsh-memento 的库，不写、不召回。'),
                jsx('div', { className: 'dsm-sec-row' },
                  jsx('button', {
                    type: 'button', className: 'dsm-sec-btn',
                    onClick: function () { openOverlay(); },
                  }, '打开星图'),
                  jsx('button', {
                    type: 'button', className: 'dsm-sec-btn',
                    onClick: function () {
                      if (isOpen()) mountFrame(true)
                      else openOverlay()
                    },
                  }, '重新读取')),
                jsx('label', { className: 'dsm-sec-lab' },
                  jsx('input', {
                    type: 'checkbox', checked: !hidden,
                    onChange: function (event) {
                      var next = !event.target.checked
                      setHidden(next)
                      setFabHidden(next)
                    },
                  }),
                  '在左下角显示悬浮按钮'),
                jsx('p', { className: 'dsm-sec-note' },
                  '关掉悬浮钮后，随时可以从这个设置项打开星图；勾选状态记在本机浏览器里。'))
            }

            ctx.effect(function () {
              // effect 可能在 apply 之外才执行，异常必须在这里兜住，
              // 否则会变成 unhandled rejection，宿主把整条 client 入口标记为 failed。
              try {
                return ctx.slots.inject('settings.section', function () {
                  return ctx.slots.register({
                    name: 'settings.section',
                    id: 'dsh-memory-starmap',
                    order: 17,
                    label: '记忆星图',
                  }, StarMapSection)
                })
              } catch (error) {
                try { console.warn('[memory-starmap] settings.section 注册失败', error) } catch (_e) { /* 忽略 */ }
                return function () {}
              }
            }, 'dsh-memory-starmap: settings section')
          } catch (error) {
            try { console.warn('[memory-starmap] 设置项挂不上（宿主可能没有 settings.section）', error) } catch (_e) { /* 忽略 */ }
          }
        },
      }
    },
  })
})()
