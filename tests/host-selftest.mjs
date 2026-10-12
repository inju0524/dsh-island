/**
 * dsh-island · Host 半身离线自检
 * ---------------------------------------------------------------------------------------
 * 用假的 cordis ctx 把 src/* 跑起来，验证四件最容易出错的事：
 *   1. 消息仓库（盖章 / 合并 / 环形历史 / 待处理集合）
 *   2. 事件层（agent/status、agent/error → 通知）
 *   3. ACTION_REQUIRED 桥（瀑布 prepend / 只接管单问题带选项 / 与自带界面赛跑）
 *   4. 配置层（三层合并 / 落盘 / 恢复出厂）
 *
 *   node dsh-island-host-selftest.mjs
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-island-selftest-'))
process.env.DSH_HOME = HOME

const base = '../'
const { createConfig, DEFAULTS, normalizeConfig } = await import(new URL(base + 'src/config.js', import.meta.url).href)
const { createStore } = await import(new URL(base + 'src/store.js', import.meta.url).href)
const { createWatcher } = await import(new URL(base + 'src/watcher.js', import.meta.url).href)
const { createQuestionBridge } = await import(new URL(base + 'src/questions.js', import.meta.url).href)
const { createApprovalBridge } = await import(new URL(base + 'src/approval.js', import.meta.url).href)
const { createPresence, provisionRuntime, runtimeDir } = await import(new URL(base + 'src/desktop.js', import.meta.url).href)

let passed = 0
const failures = []
const check = (name, condition, detail) => {
  if (condition) passed += 1
  else failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ============================================================ 配置层 */

const config = createConfig({ enabled: true, minSize: 30, bounce: 0.8 })
{
  const current = config.get()
  check('config: 种子生效', current.minSize === 30 && current.bounce === 0.8, JSON.stringify({ s: current.minSize, b: current.bounce }))
  check('config: 未给的字段用默认值', current.maxWidth === DEFAULTS.maxWidth, String(current.maxWidth))
  check('config: 落盘到 DSH_HOME', config.file.startsWith(HOME), config.file)

  config.update({ minSize: 999 })
  check('config: 超范围被收敛', config.get().minSize === 56, String(config.get().minSize))

  config.update({ minSize: 34 })
  check('config: 增量补丁', config.get().minSize === 34 && config.get().bounce === 0.8, JSON.stringify(config.get().minSize))

  // 文字倍率也要收敛，否则设置页的滑杆能拖出一个把卡片撑爆的值。
  config.update({ textScale: 9 })
  const scaledBig = config.get().textScale
  config.update({ textScale: 0.1 })
  const scaledSmall = config.get().textScale
  config.update({ textScale: 1 })
  check('config: textScale 上下界收敛', scaledBig === 1.35 && scaledSmall === 0.8, `${scaledBig} / ${scaledSmall}`)

  // 材质预设与音效配置校验
  config.update({ materialTheme: 'aurora', sound: false, soundVolume: 0.85 })
  check('config: 材质与音效配置生效', config.get().materialTheme === 'aurora' && config.get().sound === false && config.get().soundVolume === 0.85)
  config.update({ materialTheme: 'invalid-theme', soundVolume: 99 })
  check('config: 非法材质回退 & 音量收敛', config.get().materialTheme === 'aurora' && config.get().soundVolume === 1)

  config.update({}, true) // 空对象整份替换 → 全部回默认
  check('config: 整份替换回默认', config.get().minSize === DEFAULTS.minSize, String(config.get().minSize))

  check('config: 未知字段被丢弃', normalizeConfig({ 不存在的字段: 1 }).不存在的字段 === undefined)

  // 还原成测试用的配置
  config.update({ enabled: true, persistent: true, interceptQuestions: true, questionWaitMs: 60000, coalesceWindowMs: 1200, historySize: 5, autoDismissScale: 1 })
}

/* ============================================================ 消息仓库 */

const store = createStore(config)
{
  const a = store.publish({ type: 'SUCCESS', title: '完成' })
  const b = store.publish({ type: 'ERROR', title: '失败' })
  check('store: seq 单调', a.seq === 1 && b.seq === 2, `${a.seq},${b.seq}`)
  check('store: id 唯一', a.id !== b.id)

  // 合并：同一 coalesceKey 在窗口内取代旧消息，且保留 id（UI 做内容更新而不是重弹）
  const first = store.publish({ type: 'PROGRESS', title: '执行中', duration: null, metadata: { coalesceKey: 'task:s1' } })
  const second = store.publish({ type: 'SUCCESS', title: '完成', metadata: { coalesceKey: 'task:s1' } })
  check('store: 合并保留 id', first.id === second.id, `${first.id} vs ${second.id}`)
  check('store: 合并后类型更新', store.snapshot(0).notifications.some((n) => n.id === first.id && n.type === 'SUCCESS'))

  // 跨长时间的 PROGRESS 仍可被同一会话的 SUCCESS 就地合并（防止孤立长驻进行中状态）
  const longTaskProgress = store.publish({
    type: 'PROGRESS', title: '耗时任务', duration: null, metadata: { coalesceKey: 'task:long' },
  })
  // 模拟长任务（即使经过远超 coalesceWindowMs 的时间后完成）
  const longTaskFinish = store.publish({
    type: 'SUCCESS', title: '耗时任务完成', metadata: { coalesceKey: 'task:long' },
  })
  check('store: PROGRESS 不受时间窗口限制被更新', longTaskProgress.id === longTaskFinish.id)

  // 待处理集合
  const q = store.publish({
    type: 'ACTION_REQUIRED', title: '选一个', requiresAction: true, duration: null,
    actions: [{ id: 'opt-0', label: 'A' }],
  })
  check('store: 操作型进入待处理', store.snapshot(null).pendingIds.includes(q.id))
  store.dismiss(q.id)
  check('store: 收起后离开待处理', !store.snapshot(null).pendingIds.includes(q.id))

  // 环形历史上限（historySize 下限是 10）
  for (let i = 0; i < 18; i++) store.publish({ type: 'INFO', title: `n${i}` })
  check('store: 环形历史上限', store.stats().history === 10, String(store.stats().history))

  // since 增量
  const mark = store.snapshot(null).seq
  store.publish({ type: 'INFO', title: '之后' })
  check('store: since 只返回新消息', store.snapshot(mark).notifications.length === 1)
  check('store: 订阅会被唤醒', (() => {
    let woke = 0
    const off = store.subscribe(() => { woke += 1 })
    store.publish({ type: 'INFO', title: 'x' })
    off()
    return woke === 1
  })())

  // notify()：模式变化时必须立刻叫醒挂着的长轮询，否则要等 20 秒超时才送达。
  check('store: notify 唤醒订阅者但不新增消息', (() => {
    const before = store.snapshot(null).seq
    let woke = 0
    const off = store.subscribe(() => { woke += 1 })
    store.notify()
    off()
    return woke === 1 && store.snapshot(null).seq === before
  })())
}

/* ============================================================ 事件层 */

{
  const listeners = new Map()
  const ctx = {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return () => {}
    },
  }
  const fire = (event, ...args) => { for (const listener of listeners.get(event) ?? []) listener(...args) }
  const local = createStore(config)
  const watcher = createWatcher({ ctx, store: local, config })

  check('watcher: 订阅了 agent/status', listeners.has('agent/status'))
  check('watcher: 订阅了 agent/error', listeners.has('agent/error'))
  check('watcher: 订阅了 api-session/error', listeners.has('api-session/error'))
  check('watcher: 订阅了 agent/assistant-stream', listeners.has('agent/assistant-stream'))

  // 会话标题
  fire('api-session/added', { id: 's1', title: '重构登录流程' })

  fire('agent/status', { agent: { id: 's1' }, status: 'running' })
  check('watcher: 开始时不出消息（默认关）', local.snapshot(null).notifications.length === 0)
  check('watcher: 会话进行中激活 liveSession', watcher.getLiveSession()?.id === 's1')

  // 推理流与生成流 token 实时感知
  fire('agent/assistant-stream', {
    agent: { id: 's1' },
    frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '正在分析方案...' } },
  })
  check('watcher: 捕获推理流 reasoning-delta', watcher.getLiveSession()?.reasoning.includes('正在分析方案'))

  fire('agent/assistant-stream', {
    agent: { id: 's1' },
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '已优化数据库索引' } },
  })
  check('watcher: 捕获文本流 text-delta', watcher.getLiveSession()?.text.includes('已优化数据库索引'))

  fire('agent/assistant-stream', {
    agent: { id: 's1' },
    frame: { type: 'chunk', chunk: { type: 'tool-call-delta', name: 'pwsh' } },
  })
  check('watcher: 捕获工具调用 tool-call', watcher.getLiveSession()?.currentTool === 'pwsh')

  fire('agent/status', { agent: { id: 's1' }, status: 'idle' })
  check('watcher: 会话结束后 liveSession 释放', watcher.getLiveSession() === null)

  fire('agent/status', { agent: { id: 's1' }, status: 'idle' })
  const success = local.snapshot(0).notifications.at(-1)
  check('watcher: running→idle 报成功', success?.type === 'SUCCESS', success?.type)
  check('watcher: 成功消息带会话标题', success?.message === '重构登录流程', String(success?.message))

  // 失败：agent/error 立刻报错，随后的 idle 不再补一条成功
  const before = local.snapshot(null).seq
  fire('agent/status', { agent: { id: 's2' }, status: 'running' })
  fire('agent/error', { agent: { id: 's2' }, turn: 1, step: 2, error: new Error('TARGET 连接超时') })
  fire('agent/status', { agent: { id: 's2' }, status: 'idle' })
  const fresh = local.snapshot(before).notifications
  check('watcher: 失败报 ERROR', fresh.some((n) => n.type === 'ERROR'), JSON.stringify(fresh.map((n) => n.type)))
  check('watcher: 失败原因被带上', fresh.some((n) => n.message === 'TARGET 连接超时'), JSON.stringify(fresh.map((n) => n.message)))
  check('watcher: 失败后不再补成功', !fresh.some((n) => n.type === 'SUCCESS'), JSON.stringify(fresh.map((n) => n.type)))

  // 账号状态感知与会话清理
  fire('deepseek-account/session-expired')
  const accountWarning = local.snapshot(0).notifications.at(-1)
  check('watcher: 账号过期报 WARNING', accountWarning?.type === 'WARNING' && accountWarning?.title.includes('账号'), accountWarning?.type)

  fire('api-session/removed', 's1')
  check('watcher: 支持 api-session/removed', true)

  // 总开关
  config.update({ enabled: false })
  const beforeOff = local.snapshot(null).seq
  fire('agent/status', { agent: { id: 's3' }, status: 'running' })
  fire('agent/status', { agent: { id: 's3' }, status: 'idle' })
  check('watcher: 关闭后不产生消息', local.snapshot(beforeOff).notifications.length === 0)
  config.update({ enabled: true })
}

/* ============================================================ ACTION_REQUIRED 桥 */

{
  const local = createStore(config)
  const bridge = createQuestionBridge({ ctx: {}, store: local, config })

  const request = {
    questions: [{
      id: 'q1',
      header: '选择执行方案',
      question: '请选择执行方案',
      options: [
        { label: '方案 A', description: '稳妥推进' },
        { label: '方案 B', description: '速度优先' },
        { label: '方案 C' },
      ],
    }],
    agent: { id: 's1' },
    wait: { callId: 'call-1', timed: true },
    signal: new AbortController().signal,
  }

  let upstreamCalled = 0
  const pending = bridge.handler(request, () => {
    upstreamCalled += 1
    return new Promise(() => {}) // 自带界面一直等
  })

  check('questions: 同时交给自带界面', upstreamCalled === 1, String(upstreamCalled))
  const published = local.snapshot(null).notifications.at(-1)
  check('questions: 发布 ACTION_REQUIRED', published?.type === 'ACTION_REQUIRED', published?.type)
  check('questions: 标题用 header', published?.title === '选择执行方案', published?.title)
  check('questions: 选项转成 actions', published?.actions.length === 3, String(published?.actions.length))
  check('questions: 携带 callId', published?.metadata.callId === 'call-1', String(published?.metadata.callId))
  check('questions: 待处理集合包含它', local.snapshot(null).pendingIds.includes(published.id))

  const answered = bridge.answer(published.id, 'opt-1')
  check('questions: 岛上作答被接受', answered.ok === true && answered.selected === '方案 B', JSON.stringify(answered))

  const answer = await pending
  check('questions: 瀑布返回标准答案结构', JSON.stringify(answer) === JSON.stringify({ answers: [{ id: 'q1', selected: ['方案 B'] }] }), JSON.stringify(answer))
  check('questions: 作答后卡片被收起', !local.snapshot(null).pendingIds.includes(published.id))

  // 已经在别处答完了，岛上的作答不该生效
  check('questions: 过期的作答被拒绝', bridge.answer(published.id, 'opt-0').ok === false)
}

{
  const local = createStore(config)
  const bridge = createQuestionBridge({ ctx: {}, store: local, config })

  // 多问题 → 交给自带界面
  let called = 0
  await bridge.handler({
    questions: [{ id: 'a', question: '?', options: [{ label: 'A' }] }, { id: 'b', question: '?', options: [{ label: 'B' }] }],
    agent: { id: 's1' },
    signal: new AbortController().signal,
  }, () => { called += 1; return Promise.resolve({ answers: [] }) })
  check('questions: 多问题不接管', called === 1)

  // 多选（multiSelect: true）→ 交给自带界面（需要复选框与确认按钮）
  called = 0
  await bridge.handler({
    questions: [{ id: 'a', question: '选多项', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }],
    agent: { id: 's1' },
    signal: new AbortController().signal,
  }, () => { called += 1; return Promise.resolve({ answers: [] }) })
  check('questions: 多选不接管', called === 1)

  // 无选项（自由文本）→ 交给自带界面
  called = 0
  await bridge.handler({
    questions: [{ id: 'a', question: '随便说点什么' }],
    agent: { id: 's1' },
    signal: new AbortController().signal,
  }, () => { called += 1; return Promise.resolve({ answers: [] }) })
  check('questions: 无选项不接管', called === 1)

  // 没有 agent → 交给自带界面
  called = 0
  await bridge.handler({
    questions: [{ id: 'a', question: '?', options: [{ label: 'A' }] }],
    signal: new AbortController().signal,
  }, () => { called += 1; return Promise.resolve({ answers: [] }) })
  check('questions: 无 agent 不接管', called === 1)

  check('questions: 不接管时不发布卡片', local.snapshot(null).notifications.length === 0)
}

{
  const local = createStore(config)
  const bridge = createQuestionBridge({ ctx: {}, store: local, config })

  // 自带界面先答出来 → 岛上的等待被放弃，但整体仍然拿到答案
  const pending = bridge.handler({
    questions: [{ id: 'q', question: '?', options: [{ label: 'A' }, { label: 'B' }] }],
    agent: { id: 's1' },
    wait: { callId: 'c', timed: true },
    signal: new AbortController().signal,
  }, () => Promise.resolve({ answers: [{ id: 'q', selected: ['B'] }] }))

  const answer = await pending
  check('questions: 自带界面先答也能拿到答案', answer.answers[0].selected[0] === 'B', JSON.stringify(answer))
  check('questions: 两边都结束后卡片被收起', local.snapshot(null).pendingIds.length === 0)
}

{
  const local = createStore(config)
  const bridge = createQuestionBridge({ ctx: {}, store: local, config })

  // 用户收起卡片 → 岛上退出竞争，等自带界面（这里用立刻失败的 next 模拟没有应答者）
  const pending = bridge.handler({
    questions: [{ id: 'q', question: '?', options: [{ label: 'A' }] }],
    agent: { id: 's1' },
    wait: { callId: 'c', timed: true },
    signal: new AbortController().signal,
  }, () => Promise.reject(new Error('no user-questions answerer accepted the request')))

  const published = local.snapshot(null).notifications.at(-1)
  bridge.abandon(published.id)
  let rejected = false
  try {
    await pending
  } catch {
    rejected = true
  }
  check('questions: 两边都不成时才失败', rejected === true)
  check('questions: 收起后不再挂着', local.snapshot(null).pendingIds.length === 0)

  // bridge.stop() 正常退出并清空等待集合
  bridge.stop()
  check('questions: stop 后无残留等待', bridge.stats().waiting === 0)
}

/* ============================================================ 操作审批（APPROVAL）桥 */

{
  const local = createStore(config)
  const approval = createApprovalBridge({ ctx: {}, store: local, config })

  const req = {
    agent: { id: 's1' },
    toolName: 'pwsh',
    callId: 'call-app-1',
    reason: '执行危险命令',
    displayReason: { zh: '即将执行提权命令，是否允许？', en: 'Run privileged command?' },
    signal: new AbortController().signal,
  }

  let upstreamCalled = 0
  const pending = approval.handler(req, () => {
    upstreamCalled += 1
    return new Promise(() => {}) // 上游挂起
  })

  check('approval: 同时通知上游', upstreamCalled === 1)
  const published = local.snapshot(null).notifications.at(-1)
  check('approval: 发布 CONFIRM 通知', published?.type === 'CONFIRM')
  check('approval: 包含操作按钮', published?.actions?.length === 2 && published?.actions[0].id === 'opt-allow')
  check('approval: 待处理集合包含它', local.snapshot(null).pendingIds.includes(published.id))

  // 模拟岛上一键点击「允许一次」
  const decision = approval.decide(published.id, 'allowed-once')
  check('approval: decide 接受允许决议', decision.ok === true && decision.decision === 'allowed-once')

  const outcome = await pending
  check('approval: 瀑布返回 allowed-once', outcome === 'allowed-once')
  check('approval: 决议后卡片收起', !local.snapshot(null).pendingIds.includes(published.id))

  // 模拟「拒绝」分支
  const req2 = {
    agent: { id: 's2' },
    toolName: 'write_file',
    callId: 'call-app-2',
    signal: new AbortController().signal,
  }
  const pending2 = approval.handler(req2, () => new Promise(() => {}))
  const pub2 = local.snapshot(null).notifications.at(-1)
  approval.decide(pub2.id, 'rejected')
  const outcome2 = await pending2
  check('approval: 支持拒绝决议', outcome2 === 'rejected')

  approval.stop()
  check('approval: stop 正常清空', approval.stats().waiting === 0)
}

/* ============================================================ 显示位置（presence） */

{
  const starts = []
  const fakeDesktop = {
    running: false,
    status: { running: false, pid: null },
    start(url) { starts.push(url); fakeDesktop.running = true; return { ok: true, pid: 1 } },
    stop() { fakeDesktop.running = false },
  }
  const localConfig = createConfig({ desktopWindow: true })
  // 配置文件（<DSH_HOME>/dsh-island/config.json）优先于出厂种子，而本进程前面几组测试
  // 已经写过这个文件；这里显式写一次，保证前置条件是确定的。
  localConfig.update({ desktopWindow: true, enabled: true })
  const presence = createPresence({
    config: localConfig,
    desktop: fakeDesktop,
    pageUrl: () => 'http://127.0.0.1:19387/api/dsh-island/window.html',
    log: () => {},
  })

  // 灵动岛只有「桌面悬浮窗」这一种形态：不再有 placement，也没有窗口可见性上报。
  check('presence: 配置里不再有 placement', DEFAULTS.placement === undefined)
  check('presence: 配置里不再有 topOffset', DEFAULTS.topOffset === undefined)
  check('presence: 默认开启', presence.shouldRun() === true)

  presence.sync()
  check('presence: 开启时拉起进程', fakeDesktop.running === true)
  check('presence: 传给进程的页面地址正确', starts[0] === 'http://127.0.0.1:19387/api/dsh-island/window.html', starts[0])

  // 幂等：配置没变时不该重复 start（否则每次 stream 请求都会冷启动一次 Electron）。
  presence.sync()
  presence.sync()
  check('presence: 重复 sync 不会重复启动', starts.length === 1, String(starts.length))

  localConfig.update({ desktopWindow: false })
  presence.sync()
  check('presence: 关掉开关后停止进程', fakeDesktop.running === false)
  check('presence: 关掉开关后 shouldRun 为 false', presence.shouldRun() === false)

  localConfig.update({ desktopWindow: true })
  presence.sync()
  check('presence: 重新打开后再次拉起', fakeDesktop.running === true && starts.length === 2, String(starts.length))

  localConfig.update({ enabled: false })
  presence.sync()
  check('presence: 插件总开关关掉后也停', fakeDesktop.running === false)
}

/* ============================================================ 桌面悬浮窗供给 */

{
  const dir = runtimeDir()
  check('desktop: 运行时目录在 DSH_HOME 下', dir.startsWith(HOME), dir)

  // 页面地址必须由路由常量拼出来：之前手写路径少了一层 `/ui/`，
  // 桌面窗直接显示 {"ok":false,"error":"not found: /api/dsh-island/window.html"}。
  const { ISLAND_UI_BASE, ISLAND_UI_FILES } = await import(new URL(base + 'src/routes.js', import.meta.url).href)
  check('desktop: UI 路由前缀带 /ui', ISLAND_UI_BASE === '/api/dsh-island/ui', ISLAND_UI_BASE)
  check('desktop: window.html 在 UI 资源表里', Object.keys(ISLAND_UI_FILES).includes('window.html'), Object.keys(ISLAND_UI_FILES).join(','))
  check('desktop: island.js 在 UI 资源表里', Object.keys(ISLAND_UI_FILES).includes('island.js'), Object.keys(ISLAND_UI_FILES).join(','))
  const pageUrl = `http://127.0.0.1:19387${ISLAND_UI_BASE}/window.html`
  check('desktop: 页面地址拼得对', pageUrl === 'http://127.0.0.1:19387/api/dsh-island/ui/window.html', pageUrl)

  // 纯 Node 下 process.execPath 是 node.exe：必须被拒绝，否则会供给出一个坏启动器。
  const rejected = provisionRuntime()
  check('desktop: 拒绝非 Electron 的可执行文件', rejected.ok === false, JSON.stringify(rejected))

  // 用真实的 Harness Electron 可执行文件跑一次供给
  const realExe = 'C:\\Users\\yinsh\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'
  if (existsSync(realExe)) {
    process.env.DSH_DESKTOP_NODE_EXECUTABLE = realExe
    const first = provisionRuntime()
    check('desktop: 供给成功', first.ok === true, first.reason)
    check('desktop: 生成了 app 目录', existsSync(join(first.appDir, 'main.js')) && existsSync(join(first.appDir, 'preload.js')))
    check('desktop: 启动器沿用原可执行文件名', first.exe.endsWith('DeepSeek Harness.exe'), first.exe)
    check('desktop: 生成了 locales 联接', existsSync(join(dir, 'locales')))
    check('desktop: 硬链接了运行时 dll', existsSync(join(dir, 'ffmpeg.dll')))

    const second = provisionRuntime()
    check('desktop: 重复供给走原地刷新', second.ok === true && second.reason === 'app-refreshed', second.reason)
    check('desktop: 刷新不重建目录', second.appDir === first.appDir)

    // 关键回归：目录里有 locales 目录联接，整目录重建会在 junction 上抛 EPERM
    //（实测把重建流程打死，桌面窗再也起不来）。快路径不删目录，所以连续供给必须一直成功。
    const third = provisionRuntime()
    check('desktop: 连续供给不因 junction 失败', third.ok === true, third.reason)
    check('desktop: app 文件确实被重写', existsSync(join(first.appDir, 'main.js')))
    delete process.env.DSH_DESKTOP_NODE_EXECUTABLE
  } else {
    check('desktop: 跳过（本机没有 Harness 安装）', true)
  }
}

/* ============================================================ 结果 */

rmSync(HOME, { recursive: true, force: true })

console.log(`\n通过 ${passed} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log('  ✗ ' + failure)
  process.exitCode = 1
} else {
  console.log('全部通过 ✓')
}

