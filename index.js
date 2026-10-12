/* =======================================================================================
   dsh-island · Host 半身
   ---------------------------------------------------------------------------------------
   这一半只做几件事，且分别落在各自的模块里，彼此不认识对方：

     src/config.js       配置层：三层合并 + 落盘（<DSH_HOME>/dsh-island/config.json）
     src/store.js        状态层：消息盖章、环形历史、待处理集合、订阅中心
     src/notification.js 消息层：Notification 模型 + 可扩展的类型注册表
     src/watcher.js      事件层：Harness 事件 → Notification
     src/questions.js    交互层：user-questions/request ↔ 灵动岛选择
     src/desktop.js      窗口层：桌面悬浮窗的供给、生命周期、以及「该显示在哪里」的唯一权威
     src/routes.js       传输层：/api/dsh-island/*（普通 HTTP + 长轮询 + 共用 UI 资源）

   两个宿主（Harness 窗口内的叠加层、桌面悬浮窗）加载的是**同一份** ui/island.js，
   所以只有一套 UI 实现。

   零外部依赖：只用 node: 内建模块，不 import 任何 @deepseek-ai/* 运行时包
   （宿主端的 API 面会漂移，能不依赖就不依赖）。
   ======================================================================================= */

import { createConfig } from './src/config.js'
import { createDesktopWindow, createPresence } from './src/desktop.js'
import { createQuestionBridge } from './src/questions.js'
import { createApprovalBridge } from './src/approval.js'
import { registerRoutes, ISLAND_UI_BASE } from './src/routes.js'
import { createStore } from './src/store.js'
import { createWatcher } from './src/watcher.js'

export const name = 'dsh-island'

/**
 * @param ctx - 宿主 cordis 上下文。
 * @param patchConfig - cordis.patch.yml 那一行的 config（出厂种子）。
 */
export function apply(ctx, patchConfig = {}) {
  const config = createConfig(patchConfig)
  const store = createStore(config)
  const questions = createQuestionBridge({ ctx, store, config })
  const approval = createApprovalBridge({ ctx, store, config })
  const watcher = createWatcher({ ctx, store, config })

  const log = (message) => {
    try {
      ctx.logger?.info?.(String(message))
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  const desktop = createDesktopWindow({ log })
  /** 桌面悬浮窗的页面地址；webServer 就绪后才知道端口。 */
  let pageUrl = () => 'about:blank'
  let presence = null

  /**
   * 「需要用户选择方案」与「操作审批」的接入点。
   *
   * `prepend: true` 是关键：我们排在它前面，才能先把选择/审批拿给用户；
   * 一旦我们不接管（功能关闭/非标准形态），就 `next()` 原样交回去，自带界面的行为一个字节都不会变。
   */
  ctx.on('user-questions/request', (request, next) => questions.handler(request, next), { prepend: true })
  ctx.on('approval/request', (request, next) => approval.handler(request, next), { prepend: true })

  ctx.effect(() => () => watcher.stop(), 'dsh-island: harness watchers')
  ctx.effect(() => () => questions.stop(), 'dsh-island: question bridge')
  ctx.effect(() => () => approval.stop(), 'dsh-island: approval bridge')
  ctx.effect(() => () => desktop.stop(), 'dsh-island: desktop window')

  ctx.inject(['webServer'], (hostCtx) => {
    const port = hostCtx.webServer.port
    // 页面地址从路由层的常量拼出来，不要手写路径 ——
    // 之前少写了一层 `/ui/`，桌面窗直接显示 `{"ok":false,"error":"not found"}`。
    pageUrl = () => `http://127.0.0.1:${String(port)}${ISLAND_UI_BASE}/window.html`
    presence = createPresence({ config, desktop, pageUrl, log })

    // 设置页改了开关后立刻生效，不用等下一次消息。
    hostCtx.effect(
      () => config.subscribe(() => presence.sync()),
      'dsh-island: desktop window follows config',
    )

    hostCtx.effect(() => () => presence.stop(), 'dsh-island: presence watchdog')

    hostCtx.effect(
      () => registerRoutes(hostCtx, { config, store, questions, presence, approval, watcher }),
      'dsh-island: /api/dsh-island routes',
    )

    presence.sync()
  })
}

/* 供设置页与自检引用；不改变运行时状态。 */
export { DEFAULTS } from './src/config.js'
export { TYPE_REGISTRY } from './src/notification.js'
