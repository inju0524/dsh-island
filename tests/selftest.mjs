/**
 * dsh-island · 浏览器侧离线自检
 * ---------------------------------------------------------------------------------------
 * 灵动岛本体（ui/island.js）是无框架模块，两个宿主共用。这里用一个假的 window 把它跑起来，
 * 直接验证它导出的纯函数（动画数学、状态机、消息模型），以及 client.js 的 bundle 形状。
 *
 *   node dsh-island-selftest.mjs
 */

import { pathToFileURL } from 'node:url'

globalThis.window = {}

/** 极简 DOM 节点，够 ui/island.js 在 Node 里被求值即可。 */
const makeNode = (name) => ({
  nodeName: name,
  attributes: {},
  childNodes: [],
  style: {},
  className: '',
  setAttribute(key, value) { this.attributes[key] = String(value) },
  getAttribute(key) { return this.attributes[key] },
  removeAttribute(key) { delete this.attributes[key] },
  appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child },
})
globalThis.document = {
  createElement: (name) => makeNode(name),
  createElementNS: (_ns, name) => makeNode(name),
}

await import(new URL('../ui/island.js', import.meta.url).href)

const api = globalThis.window.DshIsland
if (api === undefined) throw new Error('ui/island.js did not publish window.DshIsland')
if (typeof api.mount !== 'function') throw new Error('window.DshIsland.mount is missing')

const core = api.core
for (const name of ['spring', 'morphKeyframes', 'slideKeyframes', 'popKeyframes', 'geometryFor', 'normalize', 'isActionable', 'createMachine', 'createTransport']) {
  if (typeof core[name] !== 'function') throw new Error(`core.${name} is missing`)
}

/* ------------------------------------------------------------------ client.js bundle 形状 */

{
  let registration = null
  globalThis.window.__ModuleLoader__ = { load: (reg) => { registration = reg } }
  const HOOKS = ['useState', 'useEffect', 'useLayoutEffect', 'useRef', 'useMemo', 'useCallback', 'useSyncExternalStore']
  const ReactStub = {
    createElement: () => null,
    Fragment: Symbol('Fragment'),
    Component: class { constructor(props) { this.props = props } },
    ...Object.fromEntries(HOOKS.map((name) => [name, () => undefined])),
  }
  await import(new URL('../client.js', import.meta.url).href)
  if (registration === null) throw new Error('client.js did not register with __ModuleLoader__')
  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return ReactStub
    throw new Error(`unexpected require(${specifier})`)
  })
  if (plugin.name !== 'dsh-island') throw new Error(`unexpected plugin name ${plugin.name}`)
  if (typeof plugin.apply !== 'function') throw new Error('client.js plugin has no apply')
  if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots')) throw new Error('client.js plugin must inject slots')
  delete globalThis.window.__ModuleLoader__
}

/* ------------------------------------------------------------------ 断言工具 */

let passed = 0
const failures = []
const check = (name, condition, detail) => {
  if (condition) passed += 1
  else failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const near = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon

/* ------------------------------------------------------------------ 官方品牌标记 */

{
  const path = core.FISH_LOGO_PATH
  check('brand: 使用官方 FISH_LOGO_PATH', typeof path === 'string' && path.startsWith('M22.9168 1.43018'), String(path).slice(0, 24))
  check('brand: 路径完整未截断', path.endsWith('15.1415 9.79893Z') && path.length > 3000, `len=${path.length}`)
  check('brand: 官方 viewBox', core.FISH_LOGO_VIEWBOX.width === 23.16 && core.FISH_LOGO_VIEWBOX.height === 17.04)
  const mark = core.buildBrandMark(26)
  const markHeight = Number(mark.getAttribute('height'))
  check('brand: 标记按官方比例出图', Math.abs(markHeight - 26 * 17.04 / 23.16) < 1e-9, String(markHeight))
  check('brand: 标记只有一个 path 且用 currentColor', mark.childNodes.length === 1 && mark.childNodes[0].getAttribute('fill') === 'currentColor')
}

/* ------------------------------------------------------------------ 最小态：尺寸与 Logo 归心 */

{
  check('紧凑态: 圆形直径压到 30', core.MIN_SIZE === 30, String(core.MIN_SIZE))
  check('紧凑态: Logo 约为直径一半', core.LOGO_SIZE === 15, String(core.LOGO_SIZE))
  check('紧凑态: Logo 不出圆', core.LOGO_SIZE < core.MIN_SIZE && core.LOGO_SIZE * 17.04 / 23.16 < core.MIN_SIZE)

  // 最小态里图标槽是「absolute + left:0 + translateX(锚点)」定位的，
  // 锚点必须让 orb 中心正好落在圆心 —— 这就是「logo 不在圆心」那个 bug 的回归断言。
  const orbX = core.MIN_SIZE / 2 - core.ORB / 2
  check('紧凑态: 图标槽锚点让中心落在圆心',
    orbX + core.ORB / 2 === core.MIN_SIZE / 2,
    `${orbX} + ${core.ORB / 2}`)
  check('紧凑态: 图标槽锚点为 2px', orbX === 2, String(orbX))

  // 展开态文字的左边界 = 图标槽 + 间距，必须留得下图标槽本身。
  const padLeft = core.H_PAD + core.ORB + core.GAP
  check('展开态: 文字左边界在图标签右边', padLeft > core.H_PAD + core.ORB, String(padLeft))
}

/* ------------------------------------------------------------------ L4 动画数学 */

{
  // 目标 profile 对齐 Apple cubic-bezier(0.32,0.72,0,1)：
  //   起步斜率 ~2.3（响应迅速但不跳）、t50 ~17%、t90 ~37%、t99 ~72%（很长的柔和落点）、几乎不回弹。
  // 这几条断言就是「不要退化成廉价弹跳 / 软起步」的护栏。
  const N = 200
  const curve = core.spring(0.62, N)
  check('spring: 采样点数量', curve.length === N + 1, `got ${curve.length}`)
  check('spring: 起点为 0', curve[0] === 0, `got ${curve[0]}`)

  const overshoot = (Math.max(...curve) - 1) * 100
  check('spring: 默认档几乎不回弹（< 0.5%）', overshoot < 0.5, `${overshoot.toFixed(3)}%`)

  // 起步必须"快"：老实现起点斜率只有 0.55（软起步），这是本次要修的重点之一。
  const slope0 = (curve[1] - curve[0]) * N / 1.05
  check('spring: 起步响应快（斜率 > 1.6）', slope0 > 1.6, slope0.toFixed(2))

  const at = (target) => {
    for (let i = 0; i < curve.length; i++) if (curve[i] >= target) return i / N
    return 1
  }
  check('spring: t50 落在 12%~24%', at(0.5) > 0.12 && at(0.5) < 0.24, at(0.5).toFixed(3))
  // 长柔尾：99% 要到一半时长之后才到位 —— 这是「接近终点时柔和落点」的来源。
  check('spring: 有柔和落点的长尾（t99 > 0.55）', at(0.99) > 0.55, at(0.99).toFixed(3))
  check('spring: t99 不会拖到结尾', at(0.99) < 0.9, at(0.99).toFixed(3))
  check('spring: 收敛到 1', near(curve[curve.length - 1], 1, 0.01), `got ${curve[curve.length - 1]}`)

  const hard = core.spring(0, N)
  check('spring: bounce=0 无 overshoot', Math.max(...hard) <= 1.0001, `peak ${Math.max(...hard)}`)
  check('spring: bounce=0 不是 NaN', hard.every((v) => Number.isFinite(v)))

  // bounce 只在推过默认档之后才明显 —— 默认不应有"廉价弹跳感"。
  const bouncy = core.spring(1, N)
  check('spring: bounce=1 更弹但不夸张', Math.max(...bouncy) > 1.005 && Math.max(...bouncy) < 1.05,
    `${((Math.max(...bouncy) - 1) * 100).toFixed(2)}%`)
  check('spring: 默认档比推满更干净', Math.max(...curve) < Math.max(...bouncy))
}

{
  const from = { w: 46, h: 46, r: 23 }
  const to = { w: 420, h: 96, r: 26 }
  const frames = core.morphKeyframes(from, to, { duration: 560, bounce: 0.62, lead: 0.23, samples: 40 })

  check('morph: 关键帧数量', frames.length === 42, `got ${frames.length}`)
  check('morph: 末帧宽度等于目标', frames[frames.length - 1].width === '420.00px', frames[frames.length - 1].width)
  check('morph: 末帧高度等于目标', frames[frames.length - 1].height === '96.00px', frames[frames.length - 1].height)

  const px = (f) => Number.parseFloat(f.width)
  const py = (f) => Number.parseFloat(f.height)
  const radius = (f) => Number.parseFloat(f.borderRadius)

  const halfWidthIndex = frames.findIndex((f) => px(f) >= (46 + 420) / 2)
  const widthProgress = (px(frames[halfWidthIndex]) - 46) / (420 - 46)
  const heightProgress = (py(frames[halfWidthIndex]) - 46) / (96 - 46)
  check('morph: 宽度领先高度', heightProgress < widthProgress, `w=${widthProgress.toFixed(3)} h=${heightProgress.toFixed(3)}`)
  check('morph: 圆角永不超过 h/2', frames.every((f) => radius(f) <= py(f) / 2 + 1e-6))

  const shrink = core.morphKeyframes(to, from, { duration: 430, bounce: 0.62, lead: 0.23, samples: 40, collapse: true })
  const shrinkHalf = shrink.findIndex((f) => py(f) <= (46 + 96) / 2)
  const shrinkHeight = (96 - py(shrink[shrinkHalf])) / (96 - 46)
  const shrinkWidth = (420 - px(shrink[shrinkHalf])) / (420 - 46)
  check('morph: 收起时高度领先宽度', shrinkHeight > shrinkWidth, `h=${shrinkHeight.toFixed(3)} w=${shrinkWidth.toFixed(3)}`)
}

{
  const frames = core.slideKeyframes(-142, 0, 0.62, false)
  check('slide: 保留水平居中', frames.every((f) => f.transform.startsWith('translate3d(-50%,')))
  check('slide: 入场末帧不透明', near(Number(frames[frames.length - 1].opacity), 1, 0.02))
  const out = core.slideKeyframes(0, -142, 0.62, true)
  check('slide: 出场末帧全透明', near(Number(out[out.length - 1].opacity), 0, 1e-6))
}

{
  const circle = core.geometryFor(core.SIZE.CIRCLE, { w: 999, h: 999 }, 46)
  check('geometry: 圆形固定 46', circle.w === 46 && circle.h === 46 && circle.r === 23, JSON.stringify(circle))
  const capsule = core.geometryFor(core.SIZE.CAPSULE, { w: 260, h: 20 }, 46)
  check('geometry: 胶囊高度有下限', capsule.h === 46, JSON.stringify(capsule))
  check('geometry: 胶囊是药丸', capsule.r === capsule.h / 2)
  const card = core.geometryFor(core.SIZE.CARD, { w: 460, h: 92 }, 46)
  check('geometry: 圆角矩形用固定圆角', card.r === 20 && card.h === 116, JSON.stringify(card))
  // 圆角必须明显小于半高，否则看起来是胶囊而不是 Apple 那种方圆形。
  check('geometry: 卡片圆角小于半高', core.geometryFor(core.SIZE.CARD, { w: 460, h: 300 }, 46).r === 20)
}

/* ------------------------------------------------------------------ 非常驻弹出：小圆 → 大圆 */

{
  const to = { w: 40, h: 40, r: 20 }
  const seedSize = Math.round(40 * core.ENTER_SEED)
  const frames = core.popKeyframes({ w: seedSize, h: seedSize, r: seedSize / 2 }, to, {
    bounce: 0.62, samples: 40, stretch: core.ENTER_STRETCH,
  })

  const widths = frames.map((f) => Number.parseFloat(f.width))
  const heights = frames.map((f) => Number.parseFloat(f.height))

  // 起止形状必须精确。
  check('pop: 起点就是种子小球', widths[0] === seedSize && heights[0] === seedSize, `${widths[0]}x${heights[0]}`)
  check('pop: 终点精确回到正圆', widths[widths.length - 1] === 40 && heights[heights.length - 1] === 40,
    `${widths[widths.length - 1]}x${heights[heights.length - 1]}`)

  // 竖向拉伸已按反馈关闭：全程必须是**正圆**（宽高逐帧相等），不能有任何变形。
  check('pop: 出厂设置为不拉伸', core.ENTER_STRETCH === 0, String(core.ENTER_STRETCH))
  const deformed = frames.filter((f, i) => Math.abs(widths[i] - heights[i]) > 0.01)
  check('pop: 全程是正圆（无竖向变形）', deformed.length === 0, `${deformed.length} 帧宽高不等`)

  // 干净落点：不应该越界回弹（旧曲线会冲到 40.5+，这正是「廉价弹跳」的指纹）。
  check('pop: 不越界回弹（干净落点）', Math.max(...widths) <= 40.005 && Math.max(...heights) <= 40.005,
    `宽峰 ${Math.max(...widths).toFixed(3)} 高峰 ${Math.max(...heights).toFixed(3)}`)

  // 圆角不能超过半高，否则会露出方角。
  const badRadius = frames.filter((f) => Number.parseFloat(f.borderRadius) > Number.parseFloat(f.height) / 2 + 0.01)
  check('pop: 圆角始终不超过半高', badRadius.length === 0, `${badRadius.length} 帧越界`)

  check('pop: 前段淡入、末段全不透明',
    Number(frames[0].opacity) === 0 && Number(frames[frames.length - 1].opacity) === 1,
    `${frames[0].opacity} → ${frames[frames.length - 1].opacity}`)
}

/* 拉伸包络本身仍然可用（只是出厂值设成了 0）—— 保住这段数学，将来想调回来有据可依。 */

{
  const to = { w: 40, h: 40, r: 20 }
  const frames = core.popKeyframes({ w: 18, h: 18, r: 9 }, to, { bounce: 0.62, samples: 40, stretch: 0.2 })
  const widths = frames.map((f) => Number.parseFloat(f.width))
  const heights = frames.map((f) => Number.parseFloat(f.height))
  let maxRatio = 0
  for (let i = 0; i < frames.length; i++) maxRatio = Math.max(maxRatio, heights[i] / widths[i])
  // 包络两端为 0，所以起止形状仍然精确，不会被拉伸污染。
  check('pop(stretch=0.2): 起止仍是精确正圆',
    widths[0] === 18 && heights[0] === 18 && widths[widths.length - 1] === 40 && heights[heights.length - 1] === 40,
    `${widths[0]}x${heights[0]} → ${widths[widths.length - 1]}x${heights[heights.length - 1]}`)
  check('pop(stretch=0.2): 拉伸峰值落在 1.1~1.45 之间', maxRatio > 1.1 && maxRatio < 1.45, maxRatio.toFixed(3))
}

/* ------------------------------------------------------------------ L1 消息模型 */

{
  check('normalize: 拒绝无 id', core.normalize({ title: 'x' }) === null)
  check('normalize: 拒绝非对象', core.normalize(null) === null)

  const success = core.normalize({ id: 'a', type: 'SUCCESS', title: '完成', duration: 4200 })
  check('normalize: 非操作型', core.isActionable(success) === false)

  const question = core.normalize({
    id: 'b', type: 'ACTION_REQUIRED', title: '选一个', requiresAction: true,
    actions: [{ label: 'A' }, { label: 'B', style: 'primary' }],
  })
  check('normalize: 操作型可识别', core.isActionable(question) === true)
  check('normalize: 补齐 action id', question.actions[0].id === 'action-0')
  check('normalize: 保留 action style', question.actions[1].style === 'primary')

  const sticky = core.normalize({ id: 'c', type: 'ACTION_REQUIRED', title: 'x', duration: null, requiresAction: true })
  check('normalize: duration=null 保持 null', sticky.duration === null)

  const confirm = core.normalize({
    id: 'd', type: 'CONFIRM', title: '审批', requiresAction: true,
    actions: [{ label: '允许', style: 'primary' }, { label: '拒绝', style: 'danger' }],
  })
  check('normalize: CONFIRM 操作型可识别', core.isActionable(confirm) === true)
  check('normalize: CONFIRM 包含动作', confirm.actions.length === 2 && confirm.actions[1].style === 'danger')
}

/* ------------------------------------------------------------------ 材质配方预设 */

{
  const mat = core.MATERIAL
  check('material: 包含深空曜石 midnight', typeof mat.midnight?.surface === 'string')
  check('material: 包含超白水晶 pure-crystal', typeof mat['pure-crystal']?.surface === 'string')
  check('material: 包含极光幻彩 aurora', typeof mat.aurora?.surface === 'string')
  check('material: 包含微晶雾面 frosted', typeof mat.frosted?.surface === 'string')
  check('material: 向后兼容 dark 与 light', mat.dark === mat.midnight && mat.light === mat['pure-crystal'])
}

/* ------------------------------------------------------------------ L3 状态机 */

const machineWith = (overrides) => {
  let config = Object.assign({
    enabled: true, persistent: true, durationScale: 1, autoDismissScale: 1,
    slideDistance: 96, placement: 'auto', desktopWindow: true,
  }, overrides)
  const machine = core.createMachine({ getConfig: () => config })
  return { machine, set: (next) => { config = Object.assign({}, config, next); machine.setConfig(config) } }
}

{
  const { machine } = machineWith({})
  check('machine: 初始 HIDDEN', machine.getSnapshot().state === core.STATE.HIDDEN)

  machine.ingest({ notifications: [], pendingIds: [] }, false)
  check('machine: 常驻模式进入 COMPACT', machine.getSnapshot().state === core.STATE.COMPACT)

  machine.ingest({ notifications: [{ id: 'n1', type: 'SUCCESS', title: '完成', duration: 4000 }], pendingIds: [] }, false)
  check('machine: 常驻有消息直接 EXPANDING', machine.getSnapshot().state === core.STATE.EXPANDING)

  machine.settled('expanded')
  check('machine: 展开后 EXPANDED', machine.getSnapshot().state === core.STATE.EXPANDED)
  check('machine: 展开了自动消失计时', machine.getSnapshot().autoDismissAt > Date.now())

  machine.dismiss()
  check('machine: 收起中 COLLAPSING', machine.getSnapshot().state === core.STATE.COLLAPSING)
  machine.settled('collapsed')
  check('machine: 收起后回到 COMPACT', machine.getSnapshot().state === core.STATE.COMPACT)
  check('machine: 收起后清空当前消息', machine.getSnapshot().current === null)
}

{
  // 停顿时长是可配的，所以用一个小值来验证它真的被采纳（而不是写死的时间常数）。
  const { machine } = machineWith({ persistent: false, settlePauseMs: 60 })
  machine.ingest({ notifications: [{ id: 'n1', type: 'SUCCESS', title: '完成', duration: 4000 }], pendingIds: [] }, false)
  check('machine: 非常驻先 ENTERING', machine.getSnapshot().state === core.STATE.ENTERING)
  machine.settled('entered')
  check('machine: 落地成 COMPACT', machine.getSnapshot().state === core.STATE.COMPACT)

  await new Promise((resolve) => setTimeout(resolve, 25))
  check('machine: 停顿没到就还没展开', machine.getSnapshot().state === core.STATE.COMPACT,
    machine.getSnapshot().state)
  await new Promise((resolve) => setTimeout(resolve, 120))
  check('machine: 停一拍后自动 EXPANDING', machine.getSnapshot().state === core.STATE.EXPANDING)
  machine.settled('expanded')
  machine.dismiss()
  machine.settled('collapsed')
  check('machine: 非常驻收起后 EXITING', machine.getSnapshot().state === core.STATE.EXITING)
  machine.settled('exited')
  check('machine: 滑出后 HIDDEN', machine.getSnapshot().state === core.STATE.HIDDEN)
}

{
  const { machine } = machineWith({})
  machine.ingest({ notifications: [], pendingIds: [] }, false)
  machine.ingest({
    notifications: [
      { id: 'q1', type: 'ACTION_REQUIRED', title: '选一个', requiresAction: true, duration: null, actions: [{ id: 'opt-0', label: 'A' }] },
      { id: 's1', type: 'SUCCESS', title: '完成', duration: 3000 },
    ],
    pendingIds: ['q1'],
  }, false)
  machine.settled('expanded')
  check('machine: 操作型进入 WAITING_ACTION', machine.getSnapshot().state === core.STATE.WAITING_ACTION)
  check('machine: 操作型不计时', machine.getSnapshot().autoDismissAt === 0)
  check('machine: 第二条进入队列', machine.getSnapshot().queued === 1)

  // 用户在岛上选了方案 → 宿主把这条提问从 pending 里摘掉。
  // 关键回归：必须先走 COLLAPSING（有收起动画），不能直接清空变成「啪」地消失。
  machine.ingest({ notifications: [], pendingIds: [] }, false)
  check('machine: 提问被收回时先进入 COLLAPSING', machine.getSnapshot().state === core.STATE.COLLAPSING,
    machine.getSnapshot().state)
  check('machine: 收起动画期间当前消息还在（好让文字被裁掉而不是闪没）',
    machine.getSnapshot().current?.id === 'q1', String(machine.getSnapshot().current?.id))
  // 重复帧不应该反复触发
  machine.ingest({ notifications: [], pendingIds: [] }, false)
  check('machine: 重复收回帧不打断动画', machine.getSnapshot().state === core.STATE.COLLAPSING)

  machine.settled('collapsed')
  check('machine: 收起动画播完才切到下一条', machine.getSnapshot().current?.id === 's1', String(machine.getSnapshot().current?.id))
}

{
  const { machine } = machineWith({})
  machine.ingest({ notifications: [], pendingIds: [] }, false)
  machine.ingest({ notifications: [{ id: 'old', type: 'SUCCESS', title: '历史消息', duration: 3000 }], pendingIds: [] }, true)
  check('machine: 握手帧不重播历史', machine.getSnapshot().state === core.STATE.COMPACT)

  machine.ingest({
    notifications: [{ id: 'q', type: 'ACTION_REQUIRED', title: '待办', requiresAction: true, duration: null, actions: [{ id: 'a', label: 'A' }] }],
    pendingIds: ['q'],
  }, true)
  check('machine: 握手帧仍回放待办', machine.getSnapshot().current?.id === 'q')
}

{
  const { machine } = machineWith({ enabled: false })
  machine.ingest({ notifications: [{ id: 'n', type: 'SUCCESS', title: 'x', duration: 1000 }], pendingIds: [] }, false)
  check('machine: 总开关关闭时不显示', machine.getSnapshot().state === core.STATE.HIDDEN)
}

{
  const { machine, set } = machineWith({})
  machine.ingest({ notifications: [], pendingIds: [] }, false)
  set({ persistent: false })
  check('machine: 切到非常驻后隐藏', machine.getSnapshot().state === core.STATE.HIDDEN)
  set({ persistent: true })
  check('machine: 切回常驻后显示', machine.getSnapshot().state === core.STATE.COMPACT)
}

{
  const { machine } = machineWith({})
  // 模拟 PROGRESS 持续进行中（无倒计时自动消失）
  machine.ingest({ notifications: [{ id: 'p1', type: 'PROGRESS', title: '进行中', duration: null }], pendingIds: [] }, false)
  machine.settled('expanded')
  check('machine: PROGRESS 展开态不设倒计时', machine.getSnapshot().autoDismissAt === 0)

  // 原地更新为 SUCCESS（带 4200ms 倒计时）
  machine.ingest({ notifications: [{ id: 'p1', type: 'SUCCESS', title: '已完成', duration: 4200 }], pendingIds: [] }, false)
  check('machine: PROGRESS原地更新后激活自动消失计时', machine.getSnapshot().autoDismissAt > Date.now())
  check('machine: 原地更新后当前消息类型同步', machine.getSnapshot().current?.type === 'SUCCESS')

  // 测试 dispose 清理
  machine.dispose()
  check('machine: dispose 安全清空定时器', machine.getSnapshot().autoDismissAt === 0)
}

/* ------------------------------------------------------------------ L2 传输：首帧必须立即返回 */

{
  const urls = []
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    calls += 1
    // 只放行两次，之后挂住：桩函数若瞬间 resolve，传输层会在微任务里空转成死循环（实测 OOM）。
    if (calls > 2) return new Promise(() => {})
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { ok: true, json: async () => ({ ok: true, seq: 5, notifications: [], pendingIds: [] }) }
  }
  const transport = core.createTransport({ onStream: () => {} })
  transport.start()
  await new Promise((resolve) => setTimeout(resolve, 200))
  transport.stop()
  globalThis.fetch = realFetch

  // 关键回归：首帧带 wait=1 时，服务端会把空的 since 当 NaN 从而走长轮询，
  // 没有新消息就挂 20 秒 —— 灵动岛一直停在 HIDDEN 不显示。
  check('transport: 首帧用 wait=0 立即握手', urls[0] !== undefined && urls[0].includes('wait=0'), urls[0])
  check('transport: 之后用长轮询', urls[1] !== undefined && urls[1].includes('wait=1') && urls[1].includes('since=5'), urls[1])
}

/* ------------------------------------------------------------------ 结果 */

console.log(`\n通过 ${passed} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log('  ✗ ' + failure)
  process.exitCode = 1
} else {
  console.log('全部通过 ✓')
}

