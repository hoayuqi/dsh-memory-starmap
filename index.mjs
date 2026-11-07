/**
 * @gzqdev/dsh-memory-starmap —— 宿主半侧（只读）。
 *
 * 只做两件事，都不碰记忆库的内容与计数：
 *   1. 把 dsh-memento 的条目 / 预算 / 审计整理成一份星图 JSON（GET /api/memory-starmap/graph）；
 *   2. 把 ui/starmap.html 原样吐给浏览器（GET /api/memory-starmap/page）。
 *
 * 为什么不用 service.query()：dsh-memento 的 query 会给命中条目 recall_count +1
 * （lib/store.mjs 的 queryEntries 末尾那条 UPDATE）。星图的亮度就是 recall_count，
 * 面板一开就把所有星的亮度推高，等于自己污染指标。所以这里只走无副作用的读面：
 * 优先 service.store.listEntries()，缺服务时才用 node:sqlite 以 readOnly:true 直读。
 *
 * 本插件不注册模型工具、不注入上下文、不写库，卸载后不留痕迹。
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-memory-starmap'

/** webServer 与 memory 都是可选服务：缺失时降级，不写进 inject 免得 fiber 永久挂起。 */
export const inject = []

/** 配置缺省值（与 cordis.patch.yml 的注释保持一致）。 */
export const DEFAULTS = {
  /** 没装 dsh-memento 服务时的兜底：直接读这个 SQLite 文件（readOnly）。留空则不兜底。 */
  dbPath: '',
  /** 一次最多吐多少条（防前端把 2000+ 条塞进画布）。 */
  entryLimit: 2000,
  /** 审计尾最多多少条。 */
  auditLimit: 400,
  /** 兜底直读时的每层字符预算上限（dsh-memento 0.5.x 的默认值：user 2000 / agent 4000）。 */
  budgetLimits: { user: 2000, agent: 4000 },
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE_FILE = path.join(HERE, 'ui', 'starmap.html')

/** 合并配置（只认已知键，其它忽略；坏值退回缺省）。 */
export function normalizeConfig(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const int = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)
  const limits = src.budgetLimits !== null && typeof src.budgetLimits === 'object' ? src.budgetLimits : {}
  return {
    dbPath: typeof src.dbPath === 'string' ? src.dbPath.trim() : DEFAULTS.dbPath,
    entryLimit: int(src.entryLimit, DEFAULTS.entryLimit),
    auditLimit: int(src.auditLimit, DEFAULTS.auditLimit),
    budgetLimits: {
      user: int(limits.user, DEFAULTS.budgetLimits.user),
      agent: int(limits.agent, DEFAULTS.budgetLimits.agent),
    },
  }
}

/** tags 列是 Provider 自写的 JSON 字符串数组；坏了就空数组，不让星图整页炸掉。 */
function parseTags(raw) {
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every(t => typeof t === 'string') ? parsed : []
  } catch {
    return []
  }
}

/** SQLite 行 → 页面消费的条目形状（与 dsh-memento 的 toEntry 对齐）。 */
function rowToEntry(row) {
  return {
    id: row.id,
    track: row.track,
    scope: row.scope,
    workspaceKey: row.workspace_key ?? '',
    agentKey: row.agent_key ?? '',
    text: row.text ?? '',
    source: row.source ?? '',
    tags: parseTags(row.tags),
    version: row.version ?? 1,
    createdAt: row.created_at ?? 0,
    updatedAt: row.updated_at ?? 0,
    lastRecalled: row.last_recalled ?? null,
    recallCount: row.recall_count ?? 0,
    sessionId: row.session_id ?? null,
  }
}

/** 直读库：与 lib/mcp.mjs 同款只读连接，不跑迁移、不写 WAL。 */
async function readFromDb(dbPath, config) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const entries = db.prepare('SELECT * FROM entries ORDER BY created_at, id').all()
      .slice(0, config.entryLimit)
      .map(rowToEntry)
    const audit = db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(config.auditLimit)
      .map(row => ({
        seq: row.seq,
        ts: row.ts,
        action: row.action,
        track: row.track,
        scope: row.scope,
        entryId: row.entry_id,
        outcome: typeof row.outcome === 'string' ? row.outcome : '',
        source: row.source,
        sessionId: row.session_id,
      }))
    const used = new Map()
    for (const entry of entries) {
      const key = entry.track + '/' + entry.scope
      used.set(key, (used.get(key) ?? 0) + entry.text.length)
    }
    const budgets = [...used.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, chars]) => {
        const [track, scope] = key.split('/')
        return { track, scope, used: chars, limit: config.budgetLimits[track] ?? config.budgetLimits.agent }
      })
    return { entries, budgets, audit, source: 'sqlite' }
  } finally {
    db.close()
  }
}

/** 走 dsh-memento 的公开读面：listEntries / budgets / store.auditList —— 都不会改 recall_count。 */
function readFromService(service, config) {
  const store = service?.store
  const listEntries = store?.listEntries
  if (typeof listEntries !== 'function') throw new Error('memory 服务没有 store.listEntries，无法只读取条目')
  const entries = listEntries.call(store).slice(0, config.entryLimit)
  const budgets = typeof service.budgets === 'function' ? service.budgets() : []
  const auditList = store?.auditList
  const audit = typeof auditList === 'function' ? auditList.call(store, config.auditLimit) : []
  return { entries, budgets, audit, source: 'service' }
}

/**
 * 组装星图数据。优先 memory 服务；服务缺席时按配置的 dbPath 直读；两者都无则抛错。
 * @returns {Promise<{entries: object[], budgets: object[], audit: object[], source: string, dbPath: string}>}
 */
export async function collectGraph(ctx, config) {
  const service = ctx.get('memory')
  let data
  if (service !== undefined && service !== null) {
    try {
      data = readFromService(service, config)
    } catch (error) {
      // 服务在、但读面变了（dsh-memento 升级换了 store API）——有 dbPath 就直读兜底，
      // 没配 dbPath 就把原始原因抛上去，别用一句"星图没数据"盖住真正的错误。
      if (!config.dbPath) throw error
      data = { ...(await readFromDb(config.dbPath, config)), source: 'sqlite(fallback)' }
    }
  } else if (config.dbPath) {
    data = await readFromDb(config.dbPath, config)
  } else {
    throw new Error('没有 memory 服务，也没有配置 dbPath：星图没有数据可画')
  }
  return { ...data, dbPath: config.dbPath || 'dsh-memento' }
}

/** 读页面文件（带 mtime 缓存：改 ui/starmap.html 后刷新浏览器即生效，不用重启）。 */
let pageCache = { mtime: -1, text: '' }
function readPage() {
  const mtime = statSync(PAGE_FILE).mtimeMs
  if (pageCache.mtime !== mtime) pageCache = { mtime, text: readFileSync(PAGE_FILE, 'utf8') }
  return pageCache.text
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/**
 * 注册两条只读路由。webServer 缺席（headless / CLI profile）时静默跳过。
 * register 返回的 disposer 不随 fiber 自动撤销，统一挂进 ctx.effect 逆序摘除。
 */
export function registerRoutes(ctx, config, log = { info: () => {}, warn: () => {} }) {
  let disposers = []
  const attach = (webServer) => {
    if (typeof webServer?.register !== 'function') return
    try {
      disposers.push(webServer.register({
        kind: 'exact',
        path: '/api/memory-starmap/graph',
        handler: async (req, res) => {
          if (req?.method && req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'GET only' })
          try {
            const data = await collectGraph(ctx, config)
            sendJson(res, 200, { ok: true, generatedAt: Date.now(), ...data })
          } catch (error) {
            sendJson(res, 503, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }))
      disposers.push(webServer.register({
        kind: 'exact',
        path: '/api/memory-starmap/page',
        handler: async (req, res) => {
          if (req?.method && req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'GET only' })
          try {
            const html = readPage()
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            res.end(html)
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }))
      log.info('星图路由已注册：/api/memory-starmap/{graph,page}')
    } catch (error) {
      log.warn('星图路由注册失败：' + (error instanceof Error ? error.message : String(error)))
      disposeAll()
    }
  }

  const disposeAll = () => {
    const list = disposers
    disposers = []
    for (const dispose of list.reverse()) {
      try { dispose?.() } catch { /* 摘除失败不影响卸载 */ }
    }
  }

  // 与 dsh-memento 同一套等待姿势：服务已在就立刻装，未到就等 internal/service。
  const existing = ctx.get('webServer')
  if (existing !== undefined && existing !== null) {
    attach(existing)
  } else if (typeof ctx.on === 'function') {
    const off = ctx.on('internal/service', (serviceName) => {
      if (serviceName !== 'webServer') return
      const webServer = ctx.get('webServer')
      if (webServer === undefined || webServer === null) return
      off?.()
      attach(webServer)
    })
    disposers.push(() => off?.())
  }

  ctx.effect(() => disposeAll, 'dsh-memory-starmap: routes')
  return disposeAll
}

/** 插件入口。 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  // cordis 的 logger 面在不同主机线上是「方法」或「对象」，探测不到就退回 console。
  const emit = (level, message) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('memory-starmap') : ctx.logger
      const fn = logger?.[level]
      if (typeof fn === 'function') { fn.call(logger, message); return }
    } catch { /* 忽略：日志不是功能 */ }
    try { console[level === 'warn' ? 'warn' : 'log']('[memory-starmap] ' + message) } catch { /* 忽略 */ }
  }
  registerRoutes(ctx, config, {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
  })
}
