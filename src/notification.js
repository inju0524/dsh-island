/**
 * dsh-island · 消息层（Notification 模型 + 类型注册表）
 * ---------------------------------------------------------------------------------------
 * 这是整套消息系统的唯一真相来源。设计目标：**新增消息类型不改 UI**。
 *
 * 一条 Notification：
 *   {
 *     id, seq, type, title, message, icon, priority,
 *     duration, requiresAction, actions[], metadata{}, createdAt
 *   }
 *
 * 类型注册表 TYPE_REGISTRY 为每个 type 声明「默认外观 + 默认行为」：
 *   icon / duration / requiresAction / size / tone / defaultActions
 * UI 只读这张表决定：图标、尺寸档位、展开方式、是否等待用户、是否自动关闭。
 *
 * 目前已实现：SUCCESS / ERROR / ACTION_REQUIRED
 * 已声明待用：INFO / WARNING / PROGRESS / QUESTION / CONFIRM / INPUT
 * 增加新类型 = 在 TYPE_REGISTRY 里加一条 + （可选）在 watcher 里加一个事件映射。
 */

/** 尺寸档位：圆形（最小）→ 胶囊 → 圆角矩形。UI 按此决定目标几何。 */
export const SIZE = {
  CIRCLE: 'circle',
  CAPSULE: 'capsule',
  CARD: 'card',
}

/** 视觉色调：只影响状态图标与状态色，不改变玻璃材质。 */
export const TONE = {
  NEUTRAL: 'neutral',
  SUCCESS: 'success',
  ERROR: 'error',
  WARN: 'warn',
  BRAND: 'brand',
}

/**
 * 类型注册表。`duration` 单位毫秒，`null` = 不自动消失。
 * 新类型只要在这里登记，UI 就会自动获得图标 / 尺寸 / 自动关闭策略。
 */
export const TYPE_REGISTRY = {
  SUCCESS: {
    label: '任务执行完成',
    icon: 'check',
    tone: TONE.SUCCESS,
    size: SIZE.CAPSULE,
    duration: 4200,
    requiresAction: false,
    priority: 'normal',
  },
  ERROR: {
    label: '任务执行失败',
    icon: 'cross',
    tone: TONE.ERROR,
    size: SIZE.CAPSULE,
    duration: 7600,
    requiresAction: false,
    priority: 'high',
  },
  ACTION_REQUIRED: {
    label: '需要你选择',
    icon: 'question',
    tone: TONE.BRAND,
    size: SIZE.CARD,
    duration: null,
    requiresAction: true,
    priority: 'critical',
  },
  INFO: {
    label: '提示',
    icon: 'info',
    tone: TONE.NEUTRAL,
    size: SIZE.CAPSULE,
    duration: 3600,
    requiresAction: false,
    priority: 'low',
  },
  WARNING: {
    label: '注意',
    icon: 'warn',
    tone: TONE.WARN,
    size: SIZE.CAPSULE,
    duration: 5400,
    requiresAction: false,
    priority: 'normal',
  },
  PROGRESS: {
    label: '进行中',
    icon: 'spinner',
    tone: TONE.NEUTRAL,
    size: SIZE.CAPSULE,
    duration: null,
    requiresAction: false,
    priority: 'low',
  },
  QUESTION: {
    label: '需要回答',
    icon: 'question',
    tone: TONE.BRAND,
    size: SIZE.CARD,
    duration: null,
    requiresAction: true,
    priority: 'high',
  },
  CONFIRM: {
    label: '请确认',
    icon: 'shield',
    tone: TONE.WARN,
    size: SIZE.CARD,
    duration: null,
    requiresAction: true,
    priority: 'high',
  },
  INPUT: {
    label: '需要输入',
    icon: 'pencil',
    tone: TONE.NEUTRAL,
    size: SIZE.CARD,
    duration: null,
    requiresAction: true,
    priority: 'normal',
  },
}

/** 未登记类型的安全兜底，保证未知 type 也能渲染而不是崩掉。 */
export const FALLBACK_TYPE = {
  label: '通知',
  icon: 'info',
  tone: TONE.NEUTRAL,
  size: SIZE.CAPSULE,
  duration: 4200,
  requiresAction: false,
  priority: 'normal',
}

export const PRIORITY_RANK = { low: 0, normal: 1, high: 2, critical: 3 }

/** 解析一个 type 的注册项（含兜底）。 */
export function resolveType(type) {
  const entry = TYPE_REGISTRY[type]
  return entry === undefined ? FALLBACK_TYPE : entry
}

const ACTIONS_MAX = 8

function normalizeAction(action, index) {
  if (typeof action === 'string') {
    return { id: `action-${index}`, label: action, value: action, style: 'default' }
  }
  if (action === null || typeof action !== 'object') return null
  const label = typeof action.label === 'string' && action.label.trim() !== '' ? action.label.trim() : null
  if (label === null) return null
  return {
    id: typeof action.id === 'string' && action.id !== '' ? action.id : `action-${index}`,
    label: label.slice(0, 120),
    ...(typeof action.description === 'string' ? { description: action.description.slice(0, 240) } : {}),
    style: action.style === 'primary' || action.style === 'danger' ? action.style : 'default',
    value: typeof action.value === 'string' ? action.value : label,
  }
}

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

/**
 * 把任意来源的草稿收敛成一条合法 Notification。
 * 所有字段都有默认值，所以调用方可以只给 `{ type, title }`。
 *
 * @param draft - 草稿；`type` 决定未给出字段的默认值。
 * @param options - `{ seq, now }` 由 store 注入，保证 id 与序号单调。
 */
export function createNotification(draft, options = {}) {
  const input = draft && typeof draft === 'object' ? draft : {}
  const type = typeof input.type === 'string' && input.type !== '' ? input.type : 'INFO'
  const spec = resolveType(type)
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const seq = typeof options.seq === 'number' ? options.seq : 0

  const rawActions = Array.isArray(input.actions) ? input.actions : (spec.defaultActions ?? [])
  const actions = rawActions
    .slice(0, ACTIONS_MAX)
    .map(normalizeAction)
    .filter((action) => action !== null)

  const requiresAction = typeof input.requiresAction === 'boolean' ? input.requiresAction : spec.requiresAction
  const durationInput = input.duration === undefined ? spec.duration : input.duration
  const duration = durationInput === null
    ? null
    : Number.isFinite(durationInput)
      ? Math.max(0, Math.round(durationInput))
      : spec.duration

  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? { ...input.metadata }
    : {}

  const id = typeof input.id === 'string' && input.id !== ''
    ? input.id
    : `n-${now.toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  return {
    id,
    seq,
    type,
    title: str(input.title, 160) ?? spec.label,
    ...(str(input.message, 400) === undefined ? {} : { message: str(input.message, 400) }),
    ...(str(input.detail, 1200) === undefined ? {} : { detail: str(input.detail, 1200) }),
    icon: str(input.icon, 32) ?? spec.icon,
    tone: str(input.tone, 16) ?? spec.tone,
    size: str(input.size, 16) ?? spec.size,
    priority: str(input.priority, 16) ?? spec.priority,
    duration,
    requiresAction,
    actions,
    metadata,
    createdAt: now,
  }
}

/** 优先级比较：数字大的更靠前。 */
export function priorityOf(notification) {
  return PRIORITY_RANK[notification.priority] ?? 1
}

/* ------------------------------------------------------------------ 便捷构造器 */

/** 草稿构造器：只负责补齐 type 相关的默认值，seq / id 由 store 统一盖章。 */
export function draft(type, title, extra = {}) {
  return { ...extra, type, title }
}

export const success = (title, extra) => draft('SUCCESS', title, extra)
export const failure = (title, extra) => draft('ERROR', title, extra)
export const info = (title, extra) => draft('INFO', title, extra)
export const warning = (title, extra) => draft('WARNING', title, extra)

/**
 * 「需要用户选择方案」。
 * @param title - 例如「请选择执行方案」
 * @param actions - `[{ label, description?, style? }]`
 */
export function actionRequired(title, actions, extra = {}) {
  return draft('ACTION_REQUIRED', title, {
    ...extra,
    actions,
    requiresAction: true,
    duration: null,
  })
}

/**
 * 「操作审批确认」（CONFIRM）。
 * @param title - 例如「操作审批：运行命令」
 * @param actions - 确认与拒绝按钮
 */
export function confirmAction(title, actions, extra = {}) {
  return draft('CONFIRM', title, {
    ...extra,
    actions,
    requiresAction: true,
    duration: null,
  })
}
