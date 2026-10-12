/**
 * dsh-island · 传输层（HTTP 路由）
 * ---------------------------------------------------------------------------------------
 * 两个宿主（Harness 窗口内的叠加层、桌面悬浮窗）与 Host 之间只有这一条通道，
 * 而且是**普通 HTTP**：
 *   · 事件流用长轮询（GET /stream?since=N）——不是 SSE、不是 WebSocket，
 *     因为 Electron 的协议转发对「普通请求-响应」最稳；
 *   · 回执（选择 / 收起 / 改配置 / 报告窗口可见性）用普通 POST；
 *   · 共用 UI 资源（ui/island.js、ui/window.html）也从这里发出去，
 *     这样两个宿主加载的是同一份代码。
 *
 * 这一层刻意不做业务判断：只把请求翻译成 store / config / questions / presence 的调用。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { draft } from './notification.js'

const BASE = '/api/dsh-island'
const UI_BASE = `${BASE}/ui`
const LONG_POLL_MS = 20000
const BODY_LIMIT = 512 * 1024

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const UI_DIR = join(PACKAGE_DIR, 'ui')

const UI_FILES = {
  'island.js': 'text/javascript; charset=utf-8',
  'window.html': 'text/html; charset=utf-8',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendText(res, status, text, contentType) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow, 'cache-control': 'no-store' })
  res.end()
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object')
  }
  return parsed
}

/**
 * @param ctx - 已注入 webServer 的上下文。
 * @param deps - `{ config, store, questions, presence, approval, watcher }`
 * @returns 注销函数。
 */
export function registerRoutes(ctx, deps) {
  const { config, store, questions, presence, approval, watcher } = deps

  /** 浏览器半身的自检回执。出问题时 GET /health 能直接看出卡在哪一步。 */
  let client = { at: 0, phase: 'never-reported', detail: null }

  const withMode = (payload) => ({
    ...payload,
    configRevision: config.revision,
    liveSession: watcher?.getLiveSession?.() ?? null,
  })

  /* ------------------------------------------------------------ 共用 UI 资源 */

  function serveUi(res, name) {
    const type = UI_FILES[name]
    if (type === undefined) {
      sendJson(res, 404, { ok: false, error: `unknown ui asset: ${name}` })
      return
    }
    const target = resolve(UI_DIR, name)
    if (dirname(target) !== resolve(UI_DIR)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    try {
      sendText(res, 200, readFileSync(target, 'utf8'), type)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /* ------------------------------------------------------------ 长轮询 */

  async function stream(req, res, url) {
    const raw = url.searchParams.get('since')
    const parsed = raw === null ? null : Number.parseInt(raw, 10)
    // 空的 / 非数字的 since 一律当作「首次握手」，必须**立即**返回。
    // 之前没做这一步：`since=` 解析成 NaN，`since === null` 不成立，于是握手请求
    // 也进了长轮询 —— 没有新消息就挂 20 秒，灵动岛一直停在 HIDDEN 不显示。
    const since = parsed !== null && Number.isFinite(parsed) ? parsed : null
    const wait = url.searchParams.get('wait') !== '0'

    const initial = store.snapshot(since)
    const hasFresh = since !== null && initial.notifications.length > 0
    if (!wait || hasFresh || since === null) {
      sendJson(res, 200, withMode({ ok: true, ...initial, stats: store.stats() }))
      return
    }

    let done = false
    await new Promise((resolve_) => {
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        off()
        res.off('close', finish)
        resolve_()
      }
      const timer = setTimeout(finish, LONG_POLL_MS)
      const off = store.subscribe(finish)
      res.on('close', finish)
    })

    if (res.writableEnded === true) return
    sendJson(res, 200, withMode({ ok: true, ...store.snapshot(since), stats: store.stats() }))
  }

  /* ------------------------------------------------------------ 预览 / 自检 */

  function emitDemo(kind) {
    const now = Date.now()
    if (kind === 'success') {
      store.publish(draft('SUCCESS', '任务执行完成', {
        message: '灵动岛自检 · 成功态',
        metadata: { demo: true, coalesceKey: `demo:${now}` },
      }))
      return
    }
    if (kind === 'error') {
      store.publish(draft('ERROR', '任务执行失败', {
        message: '灵动岛自检 · 失败态：示例错误原因',
        metadata: { demo: true, coalesceKey: `demo:${now}` },
      }))
      return
    }
    if (kind === 'question') {
      store.publish(draft('ACTION_REQUIRED', '请选择执行方案', {
        message: '这是一条预览消息，用来检查圆角矩形的展开形态。',
        actions: [
          { id: 'opt-0', label: '方案 A', description: '稳妥推进，分步验证', style: 'primary', value: '方案 A' },
          { id: 'opt-1', label: '方案 B', description: '并行展开，速度优先', style: 'default', value: '方案 B' },
          { id: 'opt-2', label: '方案 C', description: '先做最小可行版本', style: 'default', value: '方案 C' },
        ],
        requiresAction: true,
        duration: null,
        metadata: { demo: true, preview: true },
      }))
      return
    }
    if (kind === 'progress') {
      store.publish(draft('PROGRESS', '任务执行中', {
        message: '灵动岛自检 · 进行中态（带液态微旋）',
        duration: 4800,
        metadata: { demo: true, coalesceKey: `demo:${now}` },
      }))
      return
    }
    if (kind === 'warning') {
      store.publish(draft('WARNING', '注意：检测到性能波动', {
        message: '内存使用率达到 85%，正在调度垃圾回收',
        duration: 6000,
        metadata: { demo: true, coalesceKey: `demo:${now}` },
      }))
      return
    }
    if (kind === 'approval' || kind === 'confirm') {
      store.publish(draft('CONFIRM', '操作审批：运行 PowerShell 命令', {
        message: '脚本试图执行危险命令：pwsh -Command "rm -Recurse -Force .\\cache"',
        detail: '调用标识：call-sample-9182',
        actions: [
          { id: 'opt-allow', label: '允许一次', style: 'primary', value: 'allowed-once' },
          { id: 'opt-reject', label: '拒绝', style: 'danger', value: 'rejected' },
        ],
        requiresAction: true,
        duration: null,
        metadata: { demo: true, kind: 'approval', toolName: 'pwsh' },
      }))
      return
    }
    if (kind === 'live-stream' || kind === 'stream' || kind === 'live') {
      const sim = watcher?.simulateLiveStream?.()
      store.publish(draft('PROGRESS', '会话进行中 · 实时分析', {
        message: '点击灵动岛展开查看实时会话流',
        duration: null,
        metadata: { demo: true, coalesceKey: `stream:${now}`, sessionId: sim?.id },
      }))
      return
    }
    store.publish(draft('SUCCESS', '任务执行完成', {
      message: '灵动岛已就绪',
      metadata: { demo: true, coalesceKey: `demo:${now}` },
    }))
    setTimeout(() => store.publish(draft('ERROR', '任务执行失败', {
      message: '示例错误：TARGET 连接超时',
      metadata: { demo: true, coalesceKey: `demo:${now + 1}` },
    })), 2600)
    setTimeout(() => store.publish(draft('ACTION_REQUIRED', '请选择执行方案', {
      message: '示例：需要你决定下一步怎么走。',
      actions: [
        { id: 'opt-0', label: '方案 A', description: '稳妥推进，分步验证', style: 'primary', value: '方案 A' },
        { id: 'opt-1', label: '方案 B', description: '并行展开，速度优先', value: '方案 B' },
        { id: 'opt-2', label: '方案 C', description: '先做最小可行版本', value: '方案 C' },
      ],
      requiresAction: true,
      duration: null,
      metadata: { demo: true, preview: true },
    })), 5600)
  }

  /* ------------------------------------------------------------ 分发 */

  async function handle(req, res) {
    let url
    try {
      url = new URL(req.url ?? '', 'http://127.0.0.1')
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad url' })
      return
    }
    const path = url.pathname
    const method = req.method ?? 'GET'

    try {
      /* ---- 共用 UI 资源 ---- */
      if (path.startsWith(`${UI_BASE}/`)) {
        if (method !== 'GET') {
          methodNotAllowed(res, 'GET')
          return
        }
        serveUi(res, path.slice(UI_BASE.length + 1))
        return
      }

      /* ---- 配置 ---- */
      if (path === `${BASE}/config`) {
        if (method === 'GET') {
          sendJson(res, 200, withMode({ ok: true, ...config.snapshot(), stats: store.stats() }))
          return
        }
        if (method !== 'POST') {
          methodNotAllowed(res, 'GET, POST')
          return
        }
        const body = await readJsonBody(req)
        if (body.preview === true) {
          config.preview(body.config ?? body)
          presence.sync()
          store.notify()
          sendJson(res, 200, withMode({ ok: true, ...config.snapshot(), stats: store.stats() }))
          return
        }
        const failure = body.reset === true
          ? config.update(config.seed, true)
          : config.update(body.config ?? body, body.replace === true)
        presence.sync()
        // 叫醒挂着的长轮询：桌面上那个窗口靠 stream 的 configRevision 变化来重取配置，
        // 不叫醒就要等 20 秒超时，设置页改了圆形直径要等半天才看到效果。
        if (failure === null) store.notify()
        sendJson(res, failure === null ? 200 : 500, withMode({
          ok: failure === null,
          ...(failure === null ? {} : { error: failure }),
          ...config.snapshot(),
          stats: store.stats(),
        }))
        return
      }

      /* ---- 事件流（长轮询） ---- */
      if (path === `${BASE}/stream`) {
        if (method !== 'GET') {
          methodNotAllowed(res, 'GET')
          return
        }
        presence.sync()
        await stream(req, res, url)
        return
      }

      /* ---- 实时会话流数据查询 ---- */
      if (path === `${BASE}/live-session`) {
        if (method !== 'GET') {
          methodNotAllowed(res, 'GET')
          return
        }
        const session = watcher?.getLiveSession?.() ?? null
        sendJson(res, 200, {
          ok: true,
          active: session !== null,
          session,
        })
        return
      }

      /* ---- 健康检查 ---- */
      if (path === `${BASE}/health`) {
        if (method !== 'GET') {
          methodNotAllowed(res, 'GET')
          return
        }
        sendJson(res, 200, withMode({
          ok: true,
          ...store.stats(),
          ...questions.stats(),
          ...(approval ? { approval: approval.stats() } : {}),
          client,
          presence: presence.status(),
          config: config.get(),
        }))
        return
      }

      /* ---- 浏览器半身自检回执 ---- */
      if (path === `${BASE}/ping`) {
        if (method !== 'POST') {
          methodNotAllowed(res, 'POST')
          return
        }
        const body = await readJsonBody(req)
        client = {
          at: Date.now(),
          phase: typeof body.phase === 'string' ? body.phase.slice(0, 64) : 'unknown',
          detail: body.detail && typeof body.detail === 'object' ? body.detail : null,
        }
        sendJson(res, 200, { ok: true })
        return
      }

      /* ---- 收起一条消息 ---- */
      if (path === `${BASE}/dismiss`) {
        if (method !== 'POST') {
          methodNotAllowed(res, 'POST')
          return
        }
        const body = await readJsonBody(req)
        if (body.all === true) {
          store.dismissAll()
          sendJson(res, 200, withMode({ ok: true, ...store.snapshot(null) }))
          return
        }
        if (typeof body.id !== 'string' || body.id === '') {
          sendJson(res, 400, { ok: false, error: 'id is required' })
          return
        }
        if (body.actionable === true) {
          questions.abandon(body.id)
          approval?.abandon(body.id)
        }
        store.dismiss(body.id)
        sendJson(res, 200, withMode({ ok: true, ...store.snapshot(null) }))
        return
      }

      /* ---- 用户在岛上完成选择（兼顾选择与审批） ---- */
      if (path === `${BASE}/answer`) {
        if (method !== 'POST') {
          methodNotAllowed(res, 'POST')
          return
        }
        const body = await readJsonBody(req)
        if (typeof body.id !== 'string' || body.id === '') {
          sendJson(res, 400, { ok: false, error: 'id is required' })
          return
        }
        let result = questions.answer(body.id, body.actionId)
        if (result.ok !== true && approval) {
          const appResult = approval.decide(body.id, body.actionId)
          if (appResult.ok === true) result = appResult
        }
        // 这次提问/审批已经不在等了（别处答完了 / 已超时 / 只是一张预览卡片）：收起
        if (result.ok !== true) store.dismiss(body.id)
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }

      /* ---- 操作审批决议专用端点 ---- */
      if (path === `${BASE}/approval`) {
        if (method !== 'POST') {
          methodNotAllowed(res, 'POST')
          return
        }
        const body = await readJsonBody(req)
        if (typeof body.id !== 'string' || body.id === '') {
          sendJson(res, 400, { ok: false, error: 'id is required' })
          return
        }
        const result = approval ? approval.decide(body.id, body.decision ?? body.actionId) : { ok: false, error: 'approval bridge unavailable' }
        if (result.ok !== true) store.dismiss(body.id)
        sendJson(res, result.ok ? 200 : 409, result)
        return
      }

      /* ---- 预览 / 自检 ---- */
      if (path === `${BASE}/demo`) {
        if (method !== 'POST') {
          methodNotAllowed(res, 'POST')
          return
        }
        const body = await readJsonBody(req)
        emitDemo(typeof body.kind === 'string' ? body.kind : 'sequence')
        presence.sync()
        sendJson(res, 200, withMode({ ok: true, ...store.snapshot(null) }))
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found: ' + path })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: (req, res) => {
      handle(req, res).catch((error) => {
        try {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        } catch {
          /* 响应已经发出 */
        }
      })
    },
  })
}

export { BASE as ISLAND_ROUTE_BASE, UI_BASE as ISLAND_UI_BASE, UI_FILES as ISLAND_UI_FILES }
