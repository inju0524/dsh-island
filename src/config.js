/**
 * dsh-island · 配置层
 * ---------------------------------------------------------------------------------------
 * 三层合并，与 DSH 其它插件同构：
 *   内置默认值 DEFAULTS  ←  cordis.patch.yml 那一行的 config  ←  <DSH_HOME>/dsh-island/config.json
 * 设置页写最后一层，所以升级插件 / 改 YAML 都不会抹掉用户的选择。
 *
 * 本文件不认识任何 Harness 概念：只做「读 / 写 / 收敛 / 合并」四件事。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 内置默认值。设置页读到的每一项都必须在这里有一个出厂值。 */
export const DEFAULTS = {
  /* ---------------- 总开关 ---------------- */
  /** 灵动岛总开关。关掉后不监听事件、不发布消息，设置页仍可打开。 */
  enabled: true,

  /* ---------------- 显示模式 ---------------- */
  /**
   * 常驻屏幕。
   *   true  → 没有消息时保持最小圆形（DeepSeek Logo），低存在感常驻；
   *   false → 没有消息时完全隐藏在屏幕顶部之外，有新消息才滑入。
   */
  persistent: true,
  /**
   * 桌面悬浮窗（也就是灵动岛本体）的开关。
   * 灵动岛只有这一种形态：屏幕顶部居中、永远置顶的独立窗口；
   * 关掉后不会再有任何灵动岛。
   */
  desktopWindow: true,
  /** 展开后的最大宽度（px）。胶囊与圆角矩形都不会超过它。 */
  maxWidth: 460,
  /**
   * 最小态圆形直径（px）。想更精致就调小，想更醒目就调大。
   * Logo 尺寸与归心位移都跟着它等比走，所以改一个值就够了。
   */
  minSize: 30,
  /**
   * 文字大小倍率。1 为标准，调小更精致、调大更易读。
   * 标题 / 正文 / 选项文字全部等比缩放，卡片尺寸会跟着重新测量。
   */
  textScale: 1,
  /** 动画时长倍率：>1 更慢更从容，<1 更快。默认 1.2。 */
  durationScale: 1.2,

  /* ---------------- 动画 ---------------- */
  /** 弹性强度 0~1：0 = 干脆（几乎无 overshoot），1 = 明显 Q 弹。 */
  bounce: 0.62,
  /** 液态形变的「横向先行」比例 0~1：越大，宽度越明显领先于高度。 */
  liquidLead: 0.55,
  /** 进出场滑行距离（px），非常驻模式退场时往下滑出的距离。 */
  slideDistance: 96,
  /**
   * 非常驻模式：小球弹出后停顿多久才展开（毫秒）。
   * 它是**绝对时长**，不随 durationScale 缩放 —— 停顿就是停顿。
   */
  settlePauseMs: 120,

  /* ---------------- 材质与音效 ---------------- */
  /** 高光/折射层开关（液态镜面高光 + 微噪点）。 */
  specular: true,
  /** 材质风格预设：auto（跟随系统）| midnight（深空曜石）| pure-crystal（超白水晶）| aurora（极光幻彩）| frosted（微晶雾面）。 */
  materialTheme: 'auto',
  /** 触感音效：展开、收起、点击时合成播放水滴轻触音效。 */
  sound: true,
  /** 音效音量 0~1。 */
  soundVolume: 0.6,

  /* ---------------- 消息策略 ---------------- */
  /** 自动消失时长的倍率，1 = 各类型自带时长。 */
  autoDismissScale: 1,
  /** 任务开始时也提示一条 PROGRESS（默认关，避免打扰）。 */
  notifyOnTaskStart: false,
  /** 同一会话在这么长时间内的连续状态变化合并成一条（毫秒，0 = 不合并）。 */
  coalesceWindowMs: 1200,
  /** 历史保留条数（长轮询回溯用）。 */
  historySize: 60,

  /* ---------------- ACTION_REQUIRED & APPROVAL ---------------- */
  /**
   * 让灵动岛参与「需要用户选择方案」的应答。
   *   true  → 岛与 Harness 自带界面同时可用，谁先答谁生效（推荐，最安全）；
   *   false → 完全交给 Harness 自带界面。
   */
  interceptQuestions: true,
  /** 岛上等待回答的最长时间（毫秒）。超时后交回自带界面继续等待。 */
  questionWaitMs: 180000,
  /** 单个问题最多在岛上显示几个选项按钮（超出只显示前 N 个）。 */
  maxOptions: 6,
  /** 让灵动岛参与操作审批（工具调用、高权限操作确认）。 */
  interceptApprovals: true,
}

/* ------------------------------------------------------------------ 小工具 */

const clamp = (value, min, max, fallback) => {
  const n = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

const int = (value, min, max, fallback) => Math.round(clamp(value, min, max, fallback))

export function clone(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(clone)
  const out = {}
  for (const [key, inner] of Object.entries(value)) out[key] = clone(inner)
  return out
}

/** 极简深合并：对象递归，其余按值覆盖。 */
export function merge(base, patch) {
  if (patch === undefined || patch === null) return clone(base)
  if (Array.isArray(base) || Array.isArray(patch)) {
    if (!Array.isArray(base) || !Array.isArray(patch)) return clone(patch)
    const out = base.map(clone)
    for (let i = 0; i < patch.length; i++) out[i] = merge(base[i], patch[i])
    return out
  }
  if (typeof base === 'object' && typeof patch === 'object') {
    const out = { ...base }
    for (const [key, value] of Object.entries(patch)) out[key] = merge(base[key], value)
    return out
  }
  return clone(patch)
}

/** 只保留已知字段并做范围收敛——设置页与 YAML 都可能送进任意东西。 */
export function normalizeConfig(input, base = DEFAULTS) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  return {
    enabled: bool(raw.enabled, base.enabled),

    persistent: bool(raw.persistent, base.persistent),
    desktopWindow: bool(raw.desktopWindow, base.desktopWindow),
    maxWidth: int(raw.maxWidth, 280, 900, base.maxWidth),
    minSize: int(raw.minSize, 26, 56, base.minSize),
    textScale: clamp(raw.textScale, 0.8, 1.35, base.textScale),
    durationScale: clamp(raw.durationScale, 0.4, 3, base.durationScale),

    bounce: clamp(raw.bounce, 0, 1, base.bounce),
    liquidLead: clamp(raw.liquidLead, 0, 1, base.liquidLead),
    slideDistance: int(raw.slideDistance, 0, 400, base.slideDistance),
    settlePauseMs: int(raw.settlePauseMs, 0, 1500, base.settlePauseMs),

    specular: bool(raw.specular, base.specular),
    materialTheme: typeof raw.materialTheme === 'string' && ['auto', 'midnight', 'pure-crystal', 'aurora', 'frosted'].includes(raw.materialTheme)
      ? raw.materialTheme
      : base.materialTheme,
    sound: bool(raw.sound, base.sound),
    soundVolume: clamp(raw.soundVolume, 0, 1, base.soundVolume),

    autoDismissScale: clamp(raw.autoDismissScale, 0.2, 6, base.autoDismissScale),
    notifyOnTaskStart: bool(raw.notifyOnTaskStart, base.notifyOnTaskStart),
    coalesceWindowMs: int(raw.coalesceWindowMs, 0, 60000, base.coalesceWindowMs),
    historySize: int(raw.historySize, 10, 500, base.historySize),

    interceptQuestions: bool(raw.interceptQuestions, base.interceptQuestions),
    questionWaitMs: int(raw.questionWaitMs, 5000, 1800000, base.questionWaitMs),
    maxOptions: int(raw.maxOptions, 1, 12, base.maxOptions),
    interceptApprovals: bool(raw.interceptApprovals, base.interceptApprovals),
  }
}

/* ------------------------------------------------------------------ 落盘 */

export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

export function configFile() {
  return join(dshHome(), 'dsh-island', 'config.json')
}

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/**
 * 拥有插件配置：解析三层合并结果，并暴露读 / 改 / 订阅。
 * @param seed - cordis.patch.yml 那一行的 config（出厂种子）。
 */
export function createConfig(seed) {
  const normalizedSeed = normalizeConfig(seed, DEFAULTS)
  const file = configFile()

  let fileConfig = readJsonFile(file)
  if (fileConfig === null) {
    // 第一次挂载就把种子落盘，用户与设置页有一个看得见、改得动的文件。
    try {
      writeJsonFile(file, normalizedSeed)
      fileConfig = {}
    } catch {
      fileConfig = {}
    }
  }

  let current = normalizeConfig(merge(normalizedSeed, fileConfig), normalizedSeed)
  let revision = 1
  let saveTimer = null
  const listeners = new Set()

  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener(current)
      } catch {
        /* 一个订阅者出错不影响其它订阅者 */
      }
    }
  }

  return {
    get file() {
      return file
    },
    /** 配置版本号：每次写入 +1。两个宿主靠它决定要不要重新拉配置。 */
    get revision() {
      return revision
    },
    /** 出厂种子（设置页「恢复出厂默认」用）。 */
    get seed() {
      return clone(normalizedSeed)
    },
    get() {
      return current
    },
    snapshot() {
      return { config: clone(current), file, seed: clone(normalizedSeed), revision }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /**
     * 实时预览配置（内存立即广播给灵动岛，防抖自动落盘）。
     * @param patch - 增量补丁。
     */
    preview(patch) {
      if (!patch || typeof patch !== 'object') return
      current = normalizeConfig(merge(current, patch), current)
      revision += 1
      emit()
      if (saveTimer !== null) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = null
        try { writeJsonFile(file, current) } catch {}
      }, 600)
    },

    /**
     * 写入配置。
     * @param patch - 增量补丁；`replace` 为 true 时整份替换。
     * @param replace - 是否整份替换（设置页「恢复出厂默认」用 replace + seed）。
     * @returns 失败原因文本，成功为 null。
     */
    update(patch, replace = false) {
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
      const next = replace
        ? normalizeConfig(patch, DEFAULTS)
        : normalizeConfig(merge(current, patch), current)
      current = next
      revision += 1
      try {
        writeJsonFile(file, current)
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      emit()
      return null
    },
  }
}
