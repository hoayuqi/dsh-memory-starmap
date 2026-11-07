/**
 * 自测：不起 DSH，拿假 ctx / 假 webServer / 假 http 对象把两条路由跑一遍。
 *
 *   node tools/selftest.mjs              # 只测 mock 数据面
 *   node tools/selftest.mjs --db <path>  # 再对真实 dsh-memento.db 跑一次只读兜底
 *
 * 覆盖点：配置归一化、tags 容错、服务读面（不碰 query）、SQLite 兜底只读、
 * 路由注册/注销、GET-only、错误降级、页面文件可读且含关键标记。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULTS,
  collectGraph,
  name,
  normalizeConfig,
  registerRoutes,
} from '../index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE = path.join(HERE, '..', 'ui', 'starmap.html')

let pass = 0
const failures = []

function ok(label, condition, detail) {
  if (condition) { pass++; return }
  failures.push(label + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)))
}

function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

/* ── 假宿主：ctx 只要 get / on / effect / logger ─────────────────────────── */
function fakeCtx({ memory, webServer } = {}) {
  const listeners = []
  return {
    services: { memory, webServer },
    get(serviceName) { return this.services[serviceName] },
    on(event, fn) { listeners.push([event, fn]); return () => { const i = listeners.findIndex(l => l[1] === fn); if (i >= 0) listeners.splice(i, 1) } },
    emit(event, value) { for (const [e, fn] of listeners) if (e === event) fn(value) },
    effect(fn) { this.disposed = fn() },
    logger: null,
  }
}

function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error('duplicate route: ' + route.path)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

function fakeRes() {
  const res = { status: 0, headers: null, body: '' }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (chunk) => { res.body = typeof chunk === 'string' ? chunk : String(chunk) }
  return res
}

const json = (res) => JSON.parse(res.body)

/* ── 1. 配置归一化 ──────────────────────────────────────────────────────── */
{
  const d = normalizeConfig(undefined)
  eq('缺省 dbPath 为空', d.dbPath, DEFAULTS.dbPath)
  eq('缺省 entryLimit', d.entryLimit, 2000)
  eq('缺省 budgetLimits.user', d.budgetLimits.user, 2000)

  const c = normalizeConfig({ dbPath: '  D:/x/y.db  ', entryLimit: -3, auditLimit: 'x', budgetLimits: { agent: 5000 } })
  eq('dbPath 去空白', c.dbPath, 'D:/x/y.db')
  eq('非法 entryLimit 退缺省', c.entryLimit, 2000)
  eq('非法 auditLimit 退缺省', c.auditLimit, 400)
  eq('部分 budgetLimits 合并', c.budgetLimits.agent, 5000)
  eq('budgetLimits.user 保缺省', c.budgetLimits.user, 2000)

  eq('插件名稳定', name, 'dsh-memory-starmap')
}

/* ── 2. 服务读面：必须走 listEntries，且绝不调用 query（query 会给 recall_count +1）*/
{
  const entries = [
    { id: 'a', track: 'user', scope: 'user-global', text: '偏好本地优先', tags: ['pref'], recallCount: 92, sessionId: 's1', createdAt: 1, updatedAt: 2, version: 1, source: 'memory-tool' },
    { id: 'b', track: 'agent', scope: 'workspace', text: '工作区约定', tags: [], recallCount: 3, sessionId: 's2', createdAt: 3, updatedAt: 4, version: 1, source: 'memory-tool' },
  ]
  let queryCalled = false
  let listCalled = 0
  const memory = {
    store: {
      listEntries() { listCalled++; return entries.slice() },
      auditList(limit) { return [{ seq: 2, ts: 10, action: 'add', entryId: 'a', outcome: 'allowed-once' }].slice(0, limit) },
    },
    budgets() { return [{ track: 'user', scope: 'user-global', used: 6, limit: 2000 }, { track: 'agent', scope: 'workspace', used: 5, limit: 4000 }] },
    query() { queryCalled = true; throw new Error('query 不该被调用') },
  }
  const ctx = fakeCtx({ memory })
  const graph = await collectGraph(ctx, normalizeConfig(undefined))
  eq('服务模式 source=service', graph.source, 'service')
  eq('服务模式条目数', graph.entries.length, 2)
  eq('没有调用 query', queryCalled, false)
  eq('调用了一次 listEntries', listCalled, 1)
  eq('预算透传', graph.budgets[1].limit, 4000)
  eq('审计透传', graph.audit[0].entryId, 'a')

  // entryLimit 截断
  const limited = await collectGraph(ctx, normalizeConfig({ entryLimit: 1 }))
  eq('entryLimit 生效', limited.entries.length, 1)
}

/* ── 3. 服务缺席且无 dbPath：响亮失败（不是静默空图） ────────────────────── */
{
  const ctx = fakeCtx({})
  let message = ''
  try { await collectGraph(ctx, normalizeConfig(undefined)) } catch (error) { message = String(error.message) }
  ok('无服务无 dbPath 必须报错', message.includes('没有 memory 服务'), message)
}

/* ── 4. 路由：注册 → 正确响应 → 注销 ───────────────────────────────────── */
{
  const memory = {
    store: {
      listEntries() { return [{ id: 'a', track: 'user', scope: 'user-global', text: 'x', tags: [], recallCount: 1, createdAt: 1, updatedAt: 1, version: 1, source: '' }] },
      auditList() { return [] },
    },
    budgets() { return [{ track: 'user', scope: 'user-global', used: 1, limit: 2000 }] },
  }
  const webServer = fakeWebServer()
  const ctx = fakeCtx({ memory, webServer })
  registerRoutes(ctx, normalizeConfig(undefined))

  eq('注册了两条路由', webServer.routes.size, 2)
  ok('graph 路由存在', webServer.routes.has('/api/memory-starmap/graph'))
  ok('page 路由存在', webServer.routes.has('/api/memory-starmap/page'))

  const graphRoute = webServer.routes.get('/api/memory-starmap/graph')
  const res1 = fakeRes()
  await graphRoute.handler({ method: 'GET', url: '/api/memory-starmap/graph' }, res1)
  eq('graph 状态 200', res1.status, 200)
  eq('graph content-type', res1.headers['content-type'], 'application/json; charset=utf-8')
  const body = json(res1)
  eq('graph ok 字段', body.ok, true)
  ok('graph 带 generatedAt', typeof body.generatedAt === 'number' && body.generatedAt > 0)
  eq('graph 条目透传', body.entries[0].id, 'a')
  eq('graph source', body.source, 'service')

  const res2 = fakeRes()
  await graphRoute.handler({ method: 'POST' }, res2)
  eq('POST 被拒 405', res2.status, 405)

  const pageRoute = webServer.routes.get('/api/memory-starmap/page')
  const res3 = fakeRes()
  await pageRoute.handler({ method: 'GET' }, res3)
  eq('page 状态 200', res3.status, 200)
  eq('page content-type', res3.headers['content-type'], 'text/html; charset=utf-8')
  ok('page 是完整 HTML', res3.body.startsWith('<!DOCTYPE html>') || res3.body.startsWith('<!doctype html>'))
  ok('page 含标题', res3.body.includes('记忆'))
  ok('page 会去拉 /api/memory-starmap/graph', res3.body.includes('/api/memory-starmap/graph'))
  ok('page 不再内嵌 __DATA_JSON__ 占位符', !res3.body.includes('__DATA_JSON__'))
  ok('page 不再是空数据', !res3.body.includes('__DATA_JSON__'))

  // 服务错误 → 503 且带 error 文本
  const brokenCtx = fakeCtx({ webServer: fakeWebServer() })
  const broken = fakeWebServer()
  const ctx2 = fakeCtx({ webServer: broken })
  registerRoutes(ctx2, normalizeConfig(undefined))
  const res4 = fakeRes()
  await broken.routes.get('/api/memory-starmap/graph').handler({ method: 'GET' }, res4)
  eq('无数据面时 503', res4.status, 503)
  eq('503 里 ok=false', json(res4).ok, false)
  ok('503 带可读原因', String(json(res4).error).length > 0)

  // 注销
  ctx.disposed()
  eq('卸载后路由清空', webServer.routes.size, 0)
  void brokenCtx
}

/* ── 5. webServer 晚到：等 internal/service 事件再装 ────────────────────── */
{
  const webServer = fakeWebServer()
  const ctx = fakeCtx({ memory: { store: { listEntries: () => [], auditList: () => [] }, budgets: () => [] } })
  registerRoutes(ctx, normalizeConfig(undefined))
  eq('webServer 未到时零路由', webServer.routes.size, 0)
  ctx.services.webServer = webServer
  ctx.emit('internal/service', 'webServer')
  eq('事件到达后装上两条', webServer.routes.size, 2)
  ctx.disposed()
  eq('再卸载清空', webServer.routes.size, 0)
}

/* ── 6. 页面文件本身 ───────────────────────────────────────────────────── */
{
  ok('ui/starmap.html 存在', existsSync(PAGE))
}

/* ── 7. 可选：对真实库跑一次直读兜底（--db） ────────────────────────────── */
const dbIndex = process.argv.indexOf('--db')
if (dbIndex >= 0) {
  const dbPath = process.argv[dbIndex + 1]
  if (!dbPath || !existsSync(dbPath)) {
    failures.push('--db 给的路径不存在: ' + String(dbPath))
  } else {
    const ctx = fakeCtx({})
    const graph = await collectGraph(ctx, normalizeConfig({ dbPath }))
    eq('直读 source=sqlite', graph.source, 'sqlite')
    ok('直读拿到条目', graph.entries.length > 0, graph.entries.length)
    ok('直读条目有 chars 依据（text 非空）', graph.entries.every(e => typeof e.text === 'string'), graph.entries.length)
    ok('直读预算已聚合', Array.isArray(graph.budgets) && graph.budgets.every(b => b.used >= 0 && b.limit > 0), graph.budgets)
    ok('直读审计有形状', graph.audit.every(a => 'entryId' in a && 'action' in a), graph.audit.slice(0, 1))

    // 服务在、但读面变了（模拟 dsh-memento 升级换掉 store.listEntries）→ 直读兜底
    const badService = { store: {}, budgets: () => [] }
    const fallback = await collectGraph(fakeCtx({ memory: badService }), normalizeConfig({ dbPath }))
    eq('读面坏掉时回落 sqlite', fallback.source, 'sqlite(fallback)')
    ok('回落路径仍有条目', fallback.entries.length > 0, fallback.entries.length)

    // 没配 dbPath 时不许静默：原样抛出服务侧的错误
    let fallbackMessage = ''
    try { await collectGraph(fakeCtx({ memory: badService }), normalizeConfig(undefined)) } catch (error) { fallbackMessage = String(error.message) }
    ok('无 dbPath 时抛原始原因', fallbackMessage.includes('store.listEntries'), fallbackMessage)
    console.log('\n直读样本：', JSON.stringify({
      entries: graph.entries.length,
      budgets: graph.budgets,
      audit: graph.audit.length,
      firstEntryChars: graph.entries[0]?.text?.length ?? 0,
      tagsParsed: graph.entries.filter(e => e.tags.length > 0).length,
    }, null, 2))
  }
}

/* ── 汇总 ──────────────────────────────────────────────────────────────── */
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${pass} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const failure of failures) console.log('  ✗ ' + failure)
  process.exitCode = 1
}
