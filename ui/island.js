/**
 * dsh-island · 灵动岛本体（无框架，两个宿主共用）
 * =======================================================================================
 * 这一个文件同时跑在两个地方：
 *
 *   · Harness 窗口内的 shell.overlay 槽位（由 client.js 的 React 包装器挂载）
 *   · 桌面悬浮窗（独立的 Electron 窗口，由 desktop/ 启动，最小化时仍然可见）
 *
 * 为什么不用 React：桌面窗口复用 DeepSeek Harness 自带的 Electron 运行时，
 * 而 Harness 的 React 只存在于它自己的页面里（dsh-client-modules 的 staticModules 种子），
 * 外部窗口拿不到。所以本体写成无框架的 DOM 组件，两边挂载同一份代码 —— 只有一个实现。
 *
 * 分层（自上而下）：
 *   L5 view      createIsland  —— DOM 结构与交互
 *   L4 anim      spring / morphKeyframes / slideKeyframes / geometryFor
 *   L3 machine   createMachine —— HIDDEN→ENTERING→…→EXITING 的唯一权威
 *   L2 transport createTransport（HTTP 长轮询 + POST）
 *   L1 model     normalize / isActionable
 *   L0 const     几何、材质配方、主题令牌、CSS
 * =======================================================================================
 */

;(function () {
  'use strict'

  /* ===================================================================================
     L0 · 常量
     =================================================================================== */

  var API = '/api/dsh-island'

  /** 最小态圆形直径的**出厂默认**。运行时会被 config.minSize 覆盖，见 mount() 里的 minSize。 */
  var MIN_SIZE = 30
  /** 最小态里 Logo 的宽度（对应 MIN_SIZE）。约为直径的一半，留足呼吸感。 */
  var LOGO_SIZE = 15
  var MIN_SIZE_FLOOR = 26
  var MIN_SIZE_CEIL = 56
  /** 非常驻模式弹出时的起始直径比例。 */
  var ENTER_SEED = 0.46
  /**
   * 弹出过程中的最大竖向拉伸量（0 ~ 0.25）。
   *   0   → 纯粹由小变大的正圆（当前值）
   *   0.2 → 高度比宽度多 20%（实测高宽比 1.20）
   * 0.2 实测「太明显」，已关掉。`popKeyframes` 里的拉伸包络仍然保留可用，想调回来改这个值即可。
   */
  var ENTER_STRETCH = 0
  /** 卡片圆角。比「半高」小很多才像 Apple 那种连续的方圆形，而不是胶囊。 */
  var CARD_RADIUS = 20
  /** 卡片上下留白合计（一半在标题上方、一半在最后一行下方）。 */
  var V_PAD = 12
  var H_PAD = 12
  /** 左侧图标槽。展开态放状态图标，最小态放 Logo。 */
  var ORB = 26
  var GAP = 9
  var CLOSE = 18

  var SIZE = { CIRCLE: 'circle', CAPSULE: 'capsule', CARD: 'card' }

  var STATE = {
    HIDDEN: 'HIDDEN',
    ENTERING: 'ENTERING',
    COMPACT: 'COMPACT',
    EXPANDING: 'EXPANDING',
    EXPANDED: 'EXPANDED',
    WAITING_ACTION: 'WAITING_ACTION',
    COLLAPSING: 'COLLAPSING',
    EXITING: 'EXITING',
  }

  /**
   * 各段动画时长（毫秒，还会再乘 config.durationScale）。
   * ---------------------------------------------------------------------------------------
   * 这些值配合上面那条「长柔尾」曲线来读：曲线在 68% 处就到位了，
   * 所以 540ms 里真正的位移只占前 ~370ms，剩下的是柔和的落点 —— 观感上从容，而不是拖沓。
   * 尺度参考：容器尺寸 400~550、位移 350~500、内容淡入 180~280、淡出 120~220（分层见 CSS）。
   */
  var TIMING = { enter: 480, settle: 120, expand: 540, collapse: 500, exit: 400 }

  var TONE_COLOR = {
    success: 'var(--dsw-alias-state-success-primary, #10b981)',
    error: 'var(--dsw-alias-state-error-primary, #f43f5e)',
    warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
    brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
    neutral: 'var(--dsw-alias-label-secondary, #94a3b8)',
  }

  var TONE_AURORA = {
    success: 'rgba(16, 185, 129, 0.42)',
    error: 'rgba(244, 63, 94, 0.42)',
    warn: 'rgba(245, 158, 11, 0.35)',
    brand: 'rgba(77, 107, 254, 0.45)',
    neutral: 'rgba(148, 163, 184, 0.25)',
  }

  var MATERIAL = {
    midnight: {
      /**
       * iOS 27 液态玻璃质感 · 深色配方（午夜流体晶体 / Midnight Liquid Crystal）
       * 物理光学真实透光率：中心高透透光（让桌面与背景折射穿透）+ 顶部凸透聚光 + 边缘菲涅尔色散
       */
      surface: 'radial-gradient(135% 120% at 50% -10%, rgba(255,255,255,.24) 0%, rgba(28,38,58,.36) 42%, rgba(12,18,30,.52) 100%)',
      prism: 'linear-gradient(115deg, rgba(56,189,248,.65) 0%, rgba(168,85,247,.52) 25%, rgba(244,114,182,.44) 50%, rgba(59,130,246,.58) 75%, rgba(45,212,191,.65) 100%)',
      rimTop: 'radial-gradient(85% 100% at 50% 0%, rgba(255,255,255,.95) 0%, rgba(255,255,255,.45) 42%, transparent 100%)',
      rimBottom: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,.25) 20%, rgba(255,255,255,.55) 50%, rgba(255,255,255,.25) 80%, transparent 100%)',
      edge: 'rgba(255,255,255,.25)',
      shadow: '0 4px 14px -2px rgba(0,0,0,.16), 0 12px 28px -6px rgba(0,0,0,.22), 0 22px 48px -12px rgba(0,0,0,.18)',
      text: '#ffffff',
      subText: 'rgba(255,255,255,.76)',
      chip: 'rgba(255,255,255,.14)',
      chipHover: 'rgba(255,255,255,.25)',
      chipLine: 'rgba(255,255,255,.32)',
      sheen: 'rgba(255,255,255,.45)',
      grain: 0.035,
      sheenBlend: 'screen',
      brand: '#ffffff',
      brandGlow: 'rgba(255,255,255,.85)',
    },
    'pure-crystal': {
      /**
       * iOS 27 液态玻璃质感 · 浅色配方（超白微晶透镜 / Pure Crystal）
       */
      surface: 'radial-gradient(135% 120% at 50% -10%, rgba(255,255,255,.75) 0%, rgba(242,246,255,.42) 42%, rgba(218,228,248,.50) 100%)',
      prism: 'linear-gradient(115deg, rgba(14,165,233,.55) 0%, rgba(168,85,247,.42) 25%, rgba(244,114,182,.35) 50%, rgba(59,130,246,.45) 75%, rgba(20,184,166,.55) 100%)',
      rimTop: 'radial-gradient(85% 100% at 50% 0%, rgba(255,255,255,1) 0%, rgba(255,255,255,.75) 42%, transparent 100%)',
      rimBottom: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,.45) 20%, rgba(255,255,255,.85) 50%, rgba(255,255,255,.45) 80%, transparent 100%)',
      edge: 'rgba(255,255,255,.65)',
      shadow: '0 4px 14px -2px rgba(15,23,42,.06), 0 12px 28px -6px rgba(15,23,42,.10), 0 22px 48px -12px rgba(15,23,42,.12)',
      text: '#0b0f19',
      subText: 'rgba(15,23,42,.72)',
      chip: 'rgba(255,255,255,.45)',
      chipHover: 'rgba(255,255,255,.75)',
      chipLine: 'rgba(255,255,255,.8)',
      sheen: 'rgba(255,255,255,.9)',
      grain: 0.018,
      sheenBlend: 'normal',
      brand: '#0b0f19',
      brandGlow: 'rgba(255,255,255,.9)',
    },
    aurora: {
      /**
       * 极光幻彩（Nebula Aurora）· 星云折射与高饱和微晶
       */
      surface: 'radial-gradient(140% 120% at 50% -15%, rgba(168,85,247,.32) 0%, rgba(30,27,75,.45) 45%, rgba(15,23,42,.62) 100%)',
      prism: 'linear-gradient(115deg, rgba(236,72,153,.75) 0%, rgba(168,85,247,.72) 30%, rgba(59,130,246,.70) 65%, rgba(45,212,191,.75) 100%)',
      rimTop: 'radial-gradient(85% 100% at 50% 0%, rgba(244,114,182,.85) 0%, rgba(192,132,252,.55) 45%, transparent 100%)',
      rimBottom: 'linear-gradient(90deg, transparent 0%, rgba(56,189,248,.4) 30%, rgba(168,85,247,.6) 50%, rgba(236,72,153,.4) 70%, transparent 100%)',
      edge: 'rgba(244,114,182,.35)',
      shadow: '0 4px 18px -2px rgba(168,85,247,.22), 0 14px 32px -6px rgba(15,23,42,.35), 0 24px 52px -12px rgba(0,0,0,.3)',
      text: '#ffffff',
      subText: 'rgba(243,232,255,.8)',
      chip: 'rgba(255,255,255,.16)',
      chipHover: 'rgba(255,255,255,.28)',
      chipLine: 'rgba(244,114,182,.38)',
      sheen: 'rgba(244,114,182,.5)',
      grain: 0.038,
      sheenBlend: 'screen',
      brand: '#f472b6',
      brandGlow: 'rgba(236,72,153,.85)',
    },
    frosted: {
      /**
       * 微晶雾面（Frosted Obsidian）· 柔和半透微磨砂
       */
      surface: 'radial-gradient(120% 100% at 50% 0%, rgba(45,52,68,.72) 0%, rgba(22,27,38,.85) 100%)',
      prism: 'linear-gradient(115deg, rgba(255,255,255,.35) 0%, rgba(203,213,225,.25) 50%, rgba(255,255,255,.4) 100%)',
      rimTop: 'radial-gradient(85% 100% at 50% 0%, rgba(255,255,255,.6) 0%, rgba(255,255,255,.2) 50%, transparent 100%)',
      rimBottom: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,.2) 50%, transparent 100%)',
      edge: 'rgba(255,255,255,.22)',
      shadow: '0 4px 16px -2px rgba(0,0,0,.22), 0 12px 28px -6px rgba(0,0,0,.28)',
      text: '#f8fafc',
      subText: 'rgba(203,213,225,.75)',
      chip: 'rgba(255,255,255,.12)',
      chipHover: 'rgba(255,255,255,.22)',
      chipLine: 'rgba(255,255,255,.25)',
      sheen: 'rgba(255,255,255,.35)',
      grain: 0.065,
      sheenBlend: 'screen',
      brand: '#e2e8f0',
      brandGlow: 'rgba(255,255,255,.6)',
    },
  }
  MATERIAL.dark = MATERIAL.midnight
  MATERIAL.light = MATERIAL['pure-crystal']

  var ICON_PATHS = {
    check: ['M5 12.6 9.6 17 19 7.2'],
    cross: ['M7 7l10 10M17 7 7 17'],
    warn: ['M12 4.6 2.9 20h18.2L12 4.6Z', 'M12 10.2v4.2M12 17.2v.2'],
    question: ['M9.1 9.3a2.95 2.95 0 1 1 3.95 2.75c-.8.3-1.15 1-1.15 1.8v.55'],
    shield: ['M12 3.5 5 6.3v5.3c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6.3L12 3.5Z', 'M9.3 12.2 11.4 14.3 15 10.4'],
    pencil: ['M4.6 19.4h3.9L19 8.9a2.1 2.1 0 0 0-3-3L4.6 17.4v2Z', 'M14.7 6.8 17.7 9.8'],
    spinner: ['M12 3.7a8.3 8.3 0 1 1-6.4 3.1'],
    info: null,
  }

  var SVG_NS = 'http://www.w3.org/2000/svg'

  /* ===================================================================================
     L1 · 消息模型（只兜底；语义与默认值由 Host 端的类型注册表下发）
     =================================================================================== */

  var FALLBACK = {
    type: 'INFO', title: '通知', icon: 'info', tone: 'neutral', size: SIZE.CAPSULE,
    priority: 'normal', duration: 4200, requiresAction: false, actions: [], metadata: {},
  }

  function normalize(raw) {
    if (raw === null || typeof raw !== 'object') return null
    if (typeof raw.id !== 'string' || raw.id === '') return null
    var actions = Array.isArray(raw.actions)
      ? raw.actions.filter(function (a) { return a && typeof a === 'object' && typeof a.label === 'string' })
        .map(function (a, i) {
          return {
            id: typeof a.id === 'string' && a.id !== '' ? a.id : 'action-' + i,
            label: a.label,
            description: typeof a.description === 'string' ? a.description : undefined,
            style: a.style === 'primary' || a.style === 'danger' ? a.style : 'default',
            value: typeof a.value === 'string' ? a.value : a.label,
          }
        })
      : []
    var out = {}
    for (var key in FALLBACK) out[key] = FALLBACK[key]
    for (var key2 in raw) out[key2] = raw[key2]
    out.id = raw.id
    out.actions = actions
    out.requiresAction = raw.requiresAction === true
    out.duration = raw.duration === null
      ? null
      : (typeof raw.duration === 'number' && isFinite(raw.duration) ? Math.max(0, Math.round(raw.duration)) : FALLBACK.duration)
    out.metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}
    return out
  }

  function isActionable(n) {
    return n !== null && n.requiresAction === true && n.actions.length > 0
  }

  /* ===================================================================================
     L2 · 传输层（普通 HTTP 长轮询；不认识 DOM，也不认识状态机）
     =================================================================================== */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

  function postJson(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json() })
  }

  function createTransport(handlers) {
    var stopped = false
    var pingEnabled = true

    function pump() {
      var since = null
      var backoff = 0
      function step() {
        if (stopped) return
        // 首帧必须**立即**拿到（握手帧带当前消息与配置版本），所以带 wait=0；
        // 之后才用长轮询。踩过的坑：首帧也用 wait=1 时，服务端会把空的 since 当成
        // NaN 从而走长轮询，没有新消息就挂 20 秒 —— 灵动岛一直停在 HIDDEN 不显示。
        var first = since === null
        var query = first ? '' : String(since)
        fetch(API + '/stream?since=' + query + '&wait=' + (first ? '0' : '1'), {
          headers: { accept: 'application/json' }, cache: 'no-store',
        }).then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        }).then(function (data) {
          if (stopped) return
          if (data && data.ok === true) {
            if (typeof data.seq === 'number') since = data.seq
            backoff = 0
            handlers.onStream(data, first)
          }
          step()
        }).catch(function () {
          if (stopped) return
          backoff = backoff === 0 ? 500 : Math.min(5000, backoff * 2)
          sleep(backoff).then(step)
        })
      }
      step()
    }

    return {
      start: pump,
      stop: function () { stopped = true },
      dismiss: function (id, actionable) { return postJson('/dismiss', { id: id, actionable: actionable === true }) },
      answer: function (id, actionId) { return postJson('/answer', { id: id, actionId: actionId }) },
      demo: function (kind) { return postJson('/demo', { kind: kind }) },
      fetchLiveSession: function () {
        return fetch(API + '/live-session', { headers: { accept: 'application/json' }, cache: 'no-store' })
          .then(function (r) { return r.json() })
      },
      readConfig: function () {
        return fetch(API + '/config', { headers: { accept: 'application/json' }, cache: 'no-store' })
          .then(function (r) { return r.json() })
      },
      writeConfig: function (body) { return postJson('/config', body) },
      report: function (payload) { return postJson('/window', payload) },
      ping: function (phase, detail) {
        if (!pingEnabled) return Promise.resolve()
        return fetch(API + '/ping', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phase: phase, detail: detail }),
        }).then(function (r) { if (!r.ok) pingEnabled = false }).catch(function () { pingEnabled = false })
      },
    }
  }

  /* ===================================================================================
     L3 · 状态机
     =================================================================================== */

  function createMachine(options) {
    var config = options.getConfig()
    var state = STATE.HIDDEN
    var current = null
    var autoDismissAt = 0
    var timer = null
    var settleTimer = null
    var queue = []
    var seen = Object.create(null)
    var listeners = []

    function snapshot() {
      return {
        state: state, current: current, queued: queue.length,
        autoDismissAt: autoDismissAt, persistent: config.persistent === true,
      }
    }

    function publish() {
      var snap = snapshot()
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](snap) } catch (e) { /* 一个订阅者出错不影响其它 */ }
      }
    }

    function clearTimer() {
      if (timer !== null) { clearTimeout(timer); timer = null }
      autoDismissAt = 0
    }
    function clearSettleTimer() {
      if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
    }

    function armAutoDismiss() {
      clearTimer()
      if (current === null || isActionable(current) || current.duration === null) return
      var delay = Math.max(700, Math.round(current.duration * (config.autoDismissScale || 1)))
      autoDismissAt = Date.now() + delay
      timer = setTimeout(function () { timer = null; dismiss() }, delay)
    }

    function show(notification) {
      current = notification
      seen[notification.id] = true
      clearSettleTimer()
      state = config.persistent === true ? STATE.EXPANDING : STATE.ENTERING
      publish()
    }

    function advance() {
      var upcoming = queue.length > 0 ? queue.shift() : null
      if (upcoming === null) {
        current = null
        state = config.persistent === true ? STATE.COMPACT : STATE.HIDDEN
        publish()
        return
      }
      show(upcoming)
    }

    function dismiss() {
      clearTimer()
      clearSettleTimer()
      if (current === null) { advance(); return }
      state = STATE.COLLAPSING
      publish()
    }

    return {
      getSnapshot: snapshot,
      subscribe: function (fn) {
        listeners.push(fn)
        return function () {
          var i = listeners.indexOf(fn)
          if (i !== -1) listeners.splice(i, 1)
        }
      },
      setConfig: function (next) {
        var wasPersistent = config.persistent === true
        config = next
        var isPersistent = config.persistent === true
        if (wasPersistent === isPersistent) return
        if (!isPersistent && current === null && state === STATE.COMPACT) { state = STATE.HIDDEN; publish() }
        else if (isPersistent && current === null && state === STATE.HIDDEN) { state = STATE.COMPACT; publish() }
      },
      ingest: function (data, first) {
        if (config.enabled !== true) {
          clearTimer(); clearSettleTimer()
          current = null; queue = []; state = STATE.HIDDEN; publish(); return
        }
        if (config.persistent === true && current === null && queue.length === 0 && state === STATE.HIDDEN) {
          state = STATE.COMPACT; publish()
        }
        var pendingIds = Array.isArray(data.pendingIds) ? data.pendingIds : null
        if (current !== null && isActionable(current) && pendingIds !== null && pendingIds.indexOf(current.id) === -1) {
          // ⚠ 这里**不能直接把 current 清掉**。
          // 用户在岛上选了方案之后，宿主把这条提问从 pending 里摘掉，下一帧就走到这里；
          // 直接清空 + 置 COMPACT 会让卡片「啪」地消失，完全没有收起动画（实测就是这样）。
          // 所以要绕回正常路径：COLLAPSING → 动画播完 → settled('collapsed') 才清并推进队列。
          if (state !== STATE.COLLAPSING) dismiss()
        }
        // 队列里**只有需要用户操作的消息**才受 pendingIds 约束。
        // pendingIds 的语义是「还在等用户回答的提问」，一条排队中的成功/失败消息
        // 本来就不在里面 —— 早期版本不加 isActionable 判断，把这类消息一并删掉了，
        // 表现为「上一条答完之后，排队的那条提示凭空消失」。
        for (var i = queue.length - 1; i >= 0; i--) {
          if (isActionable(queue[i]) && pendingIds !== null && pendingIds.indexOf(queue[i].id) === -1) queue.splice(i, 1)
        }
        var incoming = Array.isArray(data.notifications) ? data.notifications : []
        for (var j = 0; j < incoming.length; j++) {
          var notification = normalize(incoming[j])
          if (notification === null) continue
          // 握手帧不重播历史（避免刷新页面就重放旧消息），但两类要放行：
          //   · 仍待用户操作的（否则刷新后就没法回答了）；
          //   · 刚刚产生的（桌面悬浮窗冷启动会晚 1~2 秒，错过的那条必须补上）。
          if (first === true && notification.requiresAction !== true
            && Date.now() - (notification.createdAt || 0) > 10000) {
            seen[notification.id] = true
            continue
          }
          if (current !== null && current.id === notification.id) {
            var prevDuration = current.duration
            current = notification
            if (isActionable(notification)) {
              clearTimer()
              state = STATE.WAITING_ACTION
            } else if (state === STATE.EXPANDED && notification.duration !== null && prevDuration === null) {
              armAutoDismiss()
            }
            publish()
            continue
          }
          var queuedIndex = -1
          for (var k = 0; k < queue.length; k++) if (queue[k].id === notification.id) { queuedIndex = k; break }
          if (queuedIndex !== -1) { queue[queuedIndex] = notification; continue }
          if (seen[notification.id] === true) continue
          if (current === null && queue.length === 0) show(notification)
          else queue.push(notification)
        }
      },
      settled: function (phase) {
        if (phase === 'entered') {
          state = STATE.COMPACT; publish()
          clearSettleTimer()
          // 停顿时长由用户直接给（毫秒），**不乘 durationScale** ——
          // 它是一个绝对的「停一拍」，跟着动画倍率走反而不直观。
          // 0 是合法值（不停顿），所以不能用 `||` 兜底。
          var pause = Math.round(Number(config.settlePauseMs))
          if (!isFinite(pause)) pause = TIMING.settle
          settleTimer = setTimeout(function () {
            settleTimer = null
            if (state === STATE.COMPACT && current !== null) { state = STATE.EXPANDING; publish() }
          }, Math.max(0, pause))
          return
        }
        if (phase === 'expanded') {
          state = isActionable(current) ? STATE.WAITING_ACTION : STATE.EXPANDED
          armAutoDismiss(); publish(); return
        }
        if (phase === 'collapsed') {
          current = null
          if (config.persistent === true) {
            state = STATE.COMPACT; publish()
            if (queue.length > 0) show(queue.shift())
            return
          }
          state = STATE.EXITING; publish(); return
        }
        if (phase === 'exited') {
          current = null
          state = config.persistent === true ? STATE.COMPACT : STATE.HIDDEN
          publish()
          if (queue.length > 0) advance()
        }
      },
      dismiss: dismiss,
      holdAutoDismiss: clearTimer,
      resumeAutoDismiss: armAutoDismiss,
      dispose: function () {
        clearTimer()
        clearSettleTimer()
        listeners = []
      },
    }
  }

  /* ===================================================================================
     L4 · 动画（只认几何 {w,h,r}）
     =================================================================================== */

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)) }
  function lerp(a, b, t) { return a + (b - a) * t }

  /* ===================================================================================
     运动曲线参数（只调参数，曲线系统本身不变）
     -----------------------------------------------------------------------------------
     目标：对齐 Apple `cubic-bezier(0.32, 0.72, 0, 1)` 的 profile ——
       起步斜率 ~2.3（响应迅速但不跳）、t50 17%、t90 37%、t99 72%（很长的柔和落点）
     实测把这套参数代进去得到：起步斜率 2.10、t50 16%、t90 40%、t99 68%、overshoot ≈ 0。
     对比改动前：起步斜率只有 0.55（软起步），t99 却在 20% —— 也就是 20% 的时间就走完了位移，
     剩下 80% 全在回弹震荡，这正是「廉价弹跳感」的来源。

     三个参数的各自作用（都是数出来的，不是拍的）：
       ω（刚度）  决定尾巴长度。ω 越大运动越快走完、尾巴越短；8.6 才能让 t99 落在 68%。
       v0（初速） 决定起步。弹簧阶跃响应天然是零初速（起步发软），必须给一个初速度补回来。
       ζ（阻尼）  决定回弹。接近 1（临界阻尼）时几乎没有 overshoot。
     =================================================================================== */

  var CURVE_OMEGA = 8.6
  var CURVE_V0 = 2.0
  /** 采样窗口：1.05 个归一化时间，保证末帧已经稳稳落位。 */
  var CURVE_WINDOW = 1.05

  /**
   * bounce → 阻尼比。
   * 默认区间（0 ~ 0.62）几乎保持临界阻尼 —— 也就是 Apple 那种「干净落点、不回弹」；
   * 只有把滑杆推过 0.62 之后，才开始出现明显的弹性（推满约 1.5% overshoot）。
   */
  function zetaOf(bounce) {
    return clamp(1 - bounce * 0.032 - Math.max(0, bounce - 0.62) * 0.45, 0.78, 1)
  }

  function spring(bounce, samples) {
    samples = samples || 40
    var zeta = zetaOf(bounce)
    var omega = CURVE_OMEGA
    var v0 = CURVE_V0
    var out = new Array(samples + 1)
    var damped = 1 - zeta * zeta
    var i, t
    // 临界阻尼时 wd = 0，公式会 0/0；走解析解，否则整条曲线变成 NaN。
    // （带初速的临界解：1 - e^(-ωt)·[1 + (ω - v0)·t]）
    if (damped <= 1e-6) {
      for (i = 0; i <= samples; i++) {
        t = (i / samples) * CURVE_WINDOW
        out[i] = 1 - Math.exp(-omega * t) * (1 + (omega - v0) * t)
      }
      return out
    }
    var wd = omega * Math.sqrt(damped)
    for (i = 0; i <= samples; i++) {
      t = (i / samples) * CURVE_WINDOW
      var envelope = Math.exp(-zeta * omega * t)
      out[i] = 1 - envelope * (Math.cos(wd * t) + ((zeta * omega - v0) / wd) * Math.sin(wd * t))
    }
    return out
  }

  function phased(values, t, lead) {
    if (lead <= 0) return values[clamp(Math.round(t * (values.length - 1)), 0, values.length - 1)]
    var local = (t - lead) / (1 - lead)
    if (local <= 0) return 0
    return values[clamp(Math.round(local * (values.length - 1)), 0, values.length - 1)]
  }

  function morphKeyframes(from, to, options) {
    var duration = options.duration
    var samples = options.samples || 40
    var lead = options.lead || 0
    var curve = spring(options.bounce, samples)
    var frames = []
    for (var i = 0; i <= samples; i++) {
      var t = i / samples
      var direct = curve[clamp(Math.round(t * samples), 0, samples)]
      var followed = phased(curve, t, lead)
      var wv = options.collapse ? followed : direct
      var hv = options.collapse ? direct : followed
      var w = lerp(from.w, to.w, wv)
      var height = lerp(from.h, to.h, hv)
      var radius = Math.min(lerp(from.r, to.r, Math.min(wv, hv)), Math.max(1, height / 2))
      frames.push({
        width: w.toFixed(2) + 'px',
        height: height.toFixed(2) + 'px',
        borderRadius: radius.toFixed(2) + 'px',
      })
    }
    frames.push({
      width: to.w.toFixed(2) + 'px',
      height: to.h.toFixed(2) + 'px',
      borderRadius: Math.min(to.r, Math.max(1, to.h / 2)).toFixed(2) + 'px',
    })
    return frames
  }

  /**
   * 非常驻模式的「弹出」：圆形由小变大，过程中**竖向略微拉伸**，落位后收回成正圆。
   * ---------------------------------------------------------------------------------------
   * 尺寸本身走弹簧，所以有 overshoot 回弹；拉伸用一个**两端为 0** 的包络 `4t(1-t)`：
   * 峰值落在中间、首尾都精确归零 —— 于是「起手是个小球 → 中途拉长 → 落位回到正圆」，
   * 而且完全不影响起止形状（起止值仍然是 seed 和 minSize，不会被拉伸污染）。
   *
   * 不用 morphKeyframes 的 lead 来做拉伸：那个 lead 是按「延后一段时间再追」实现的，
   * 实测早期的拉伸比会到 2 倍以上（高度已经冲到目标、宽度还停在起点），太夸张。
   */
  function popKeyframes(from, to, options) {
    var samples = options.samples || 40
    var curve = spring(options.bounce, samples)
    var stretch = options.stretch || 0
    var frames = []
    for (var i = 0; i <= samples; i++) {
      var t = i / samples
      var s = curve[clamp(Math.round(t * samples), 0, samples)]
      var bump = 4 * t * (1 - t)
      var w = lerp(from.w, to.w, s)
      var height = lerp(from.h, to.h, s) * (1 + stretch * bump)
      var radius = Math.min(lerp(from.r, to.r, s), Math.max(1, height / 2))
      frames.push({
        width: w.toFixed(2) + 'px',
        height: height.toFixed(2) + 'px',
        borderRadius: radius.toFixed(2) + 'px',
        // 前 25% 淡入：否则那个小球是「啪」地凭空出现，而不是长出来。
        opacity: clamp(t * 4, 0, 1).toFixed(3),
        offset: t,
      })
    }
    // 补一帧精确的终点：新的「长柔尾」曲线在采样窗口末尾还有十万分之几的残差，
    // 不补齐的话落位会差 0.01px（自检抓到的）。
    frames.push({
      width: to.w.toFixed(2) + 'px',
      height: to.h.toFixed(2) + 'px',
      borderRadius: Math.min(to.r, Math.max(1, to.h / 2)).toFixed(2) + 'px',
      opacity: '1',
      offset: 1,
    })
    return frames
  }

  function slideKeyframes(fromY, toY, bounce, fadeOut) {
    var curve = spring(bounce, 32)
    var last = curve.length - 1
    return curve.map(function (value, index) {
      return {
        transform: 'translate3d(-50%, ' + lerp(fromY, toY, value).toFixed(2) + 'px, 0)',
        opacity: (fadeOut ? clamp(1 - value * 1.25, 0, 1) : clamp(value * 1.2, 0, 1)).toFixed(3),
        offset: index / last,
      }
    })
  }

  function geometryFor(size, measured, minSize) {
    if (size === SIZE.CIRCLE) return { w: minSize, h: minSize, r: minSize / 2 }
    var vPad = size === SIZE.CARD ? 24 : 14
    var height = Math.max(minSize, measured.h + vPad)
    if (size === SIZE.CARD) return { w: measured.w, h: height, r: Math.min(CARD_RADIUS, height / 2) }
    return { w: measured.w, h: height, r: height / 2 }
  }

  /* ===================================================================================
     L5 · 视图
     =================================================================================== */

  function svgEl(name, attrs) {
    var el = document.createElementNS(SVG_NS, name)
    for (var key in attrs) el.setAttribute(key, attrs[key])
    return el
  }

  function buildIcon(name, size) {
    var paths = ICON_PATHS[name] === undefined ? ICON_PATHS.info : ICON_PATHS[name]
    var svg = svgEl('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': 2.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    })
    svg.style.display = 'block'
    if (name === 'spinner') svg.setAttribute('class', 'dsh-island-spin')
    if (paths === null) {
      svg.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 8.4 }))
      svg.appendChild(svgEl('path', { d: 'M12 11.1v5.3M12 7.9v.2' }))
      return svg
    }
    for (var i = 0; i < paths.length; i++) svg.appendChild(svgEl('path', { d: paths[i] }))
    if (name === 'question') {
      var dot = svgEl('circle', { cx: 12, cy: 17.4, r: 1.05 })
      dot.setAttribute('fill', 'currentColor')
      dot.setAttribute('stroke', 'none')
      svg.appendChild(dot)
    }
    return svg
  }

  /**
   * 官方 DeepSeek 鲸鱼标记。
   * ---------------------------------------------------------------------------------------
   * 路径逐字节取自 Harness 自己用的那一份：`@deepseek-ai/dsh-client-ui-primitives`
   * 的 `FISH_LOGO_PATH`（侧边栏 `sidebar.brand.mark` 就是它，由
   * `@deepseek-ai/dsh-client-ui-brand-official` 的 `FishLogo` 渲染）。
   * 原始 viewBox 23.16 × 17.04，`fill: currentColor`。
   *
   * 不要自己画 —— 手搓的形状和比例一定不对。
   */
  var FISH_LOGO_VIEWBOX = { width: 23.16, height: 17.04 }
  var FISH_LOGO_PATH = 'M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z'

  /**
   * DeepSeek Logo：官方鲸鱼。
   * 它在整个生命周期里**始终挂载**：展开时缩小、位移、淡出，同时状态图标放大淡入，
   * 于是 Logo 是「参与形变」而不是「被隐藏」。
   */
  function buildBrandMark(size) {
    var height = size * FISH_LOGO_VIEWBOX.height / FISH_LOGO_VIEWBOX.width
    var svg = svgEl('svg', {
      width: size,
      height: height,
      viewBox: '0 0 ' + FISH_LOGO_VIEWBOX.width + ' ' + FISH_LOGO_VIEWBOX.height,
      fill: 'none',
      'aria-hidden': 'true',
    })
    svg.style.display = 'block'
    svg.appendChild(svgEl('path', { d: FISH_LOGO_PATH, fill: 'currentColor' }))
    return svg
  }

  function buildLiquidDefs() {
    var svg = svgEl('svg', { width: 0, height: 0, 'aria-hidden': 'true' })
    svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none'
    var defs = svgEl('defs', {})
    var filter = svgEl('filter', {
      id: 'dshIslandLiquid', x: '-30%', y: '-70%', width: '160%', height: '240%',
      colorInterpolationFilters: 'sRGB',
    })
    filter.appendChild(svgEl('feTurbulence', {
      type: 'fractalNoise', baseFrequency: '0.013 0.03', numOctaves: '1', seed: '9', result: 'noise',
    }))
    var displacement = svgEl('feDisplacementMap', {
      in: 'SourceGraphic', in2: 'noise', scale: '0',
      xChannelSelector: 'R', yChannelSelector: 'G',
    })
    filter.appendChild(displacement)
    defs.appendChild(filter)
    svg.appendChild(defs)
    return { svg: svg, displacement: displacement }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  /** 从宿主主题令牌推断明暗。桌面窗口读不到令牌时退回 dark。 */
  function readAppearance() {
    function parse(raw) {
      if (typeof raw !== 'string' || raw.trim() === '') return null
      var text = raw.trim()
      var hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
      if (hex !== null) {
        var body = hex[1].length === 3 ? hex[1].split('').map(function (c) { return c + c }).join('') : hex[1]
        return [parseInt(body.slice(0, 2), 16), parseInt(body.slice(2, 4), 16), parseInt(body.slice(4, 6), 16)]
      }
      var rgb = text.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
      if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
      return null
    }
    try {
      var nodes = [document.body, document.documentElement]
      for (var i = 0; i < nodes.length; i++) {
        if (!nodes[i]) continue
        var channels = parse(getComputedStyle(nodes[i]).getPropertyValue('--dsw-alias-bg-base'))
        if (channels === null) continue
        var luminance = (0.299 * channels[0] + 0.587 * channels[1] + 0.114 * channels[2]) / 255
        return luminance > 0.6 ? 'light' : 'dark'
      }
    } catch (e) { /* 文档尚未就绪 */ }
    return 'dark'
  }

  /**
   * 触感音效引擎（Web Audio API 纯数学合成）
   * ---------------------------------------------------------------------------------------
   * 零外部音频文件依赖、零网络延迟，使用振荡器与平滑包络合成温润晶莹的微滴水珠与晶体轻触音。
   */
  function createHapticAudio(getConfig) {
    var audioCtx = null

    function getCtx() {
      if (typeof window === 'undefined') return null
      if (typeof window.AudioContext === 'undefined' && typeof window.webkitAudioContext === 'undefined') return null
      try {
        if (audioCtx === null) {
          var AudioClass = window.AudioContext || window.webkitAudioContext
          audioCtx = new AudioClass()
        }
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(function () {})
        }
        return audioCtx
      } catch (e) {
        return null
      }
    }

    function canPlay() {
      var cfg = getConfig()
      return cfg && cfg.sound !== false && (cfg.soundVolume === undefined || cfg.soundVolume > 0)
    }

    function volume() {
      var cfg = getConfig()
      var vol = typeof cfg.soundVolume === 'number' ? cfg.soundVolume : 0.6
      return Math.max(0, Math.min(1, vol))
    }

    /** 晶体水滴弹出音：柔和升调滑音，晶莹水珠感 */
    function playPop() {
      if (!canPlay()) return
      var ctx = getCtx()
      if (!ctx) return
      try {
        var now = ctx.currentTime
        var master = ctx.createGain()
        master.gain.setValueAtTime(0.001, now)
        master.gain.linearRampToValueAtTime(0.18 * volume(), now + 0.012)
        master.gain.exponentialRampToValueAtTime(0.0001, now + 0.16)
        master.connect(ctx.destination)

        var osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(440, now)
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.08)
        osc.connect(master)
        osc.start(now)
        osc.stop(now + 0.17)
      } catch (e) {}
    }

    /** 晶体轻触音：微阻尼短脉冲 tick，瞬时触觉反馈 */
    function playChipClick() {
      if (!canPlay()) return
      var ctx = getCtx()
      if (!ctx) return
      try {
        var now = ctx.currentTime
        var master = ctx.createGain()
        master.gain.setValueAtTime(0.22 * volume(), now)
        master.gain.exponentialRampToValueAtTime(0.0001, now + 0.04)
        master.connect(ctx.destination)

        var osc = ctx.createOscillator()
        osc.type = 'triangle'
        osc.frequency.setValueAtTime(1200, now)
        osc.frequency.exponentialRampToValueAtTime(340, now + 0.035)
        osc.connect(master)
        osc.start(now)
        osc.stop(now + 0.045)
      } catch (e) {}
    }

    /** 水珠收缩音：柔和下行反向滑音 */
    function playCollapse() {
      if (!canPlay()) return
      var ctx = getCtx()
      if (!ctx) return
      try {
        var now = ctx.currentTime
        var master = ctx.createGain()
        master.gain.setValueAtTime(0.001, now)
        master.gain.linearRampToValueAtTime(0.14 * volume(), now + 0.015)
        master.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)
        master.connect(ctx.destination)

        var osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(740, now)
        osc.frequency.exponentialRampToValueAtTime(360, now + 0.12)
        osc.connect(master)
        osc.start(now)
        osc.stop(now + 0.19)
      } catch (e) {}
    }

    /** 成功双音和弦晶音：C6 + E6 纯净水晶钟琴音 */
    function playSuccess() {
      if (!canPlay()) return
      var ctx = getCtx()
      if (!ctx) return
      try {
        var now = ctx.currentTime
        var master = ctx.createGain()
        master.gain.setValueAtTime(0.001, now)
        master.gain.linearRampToValueAtTime(0.16 * volume(), now + 0.02)
        master.gain.exponentialRampToValueAtTime(0.0001, now + 0.32)
        master.connect(ctx.destination)

        var osc1 = ctx.createOscillator()
        osc1.type = 'sine'
        osc1.frequency.setValueAtTime(1046.5, now)
        osc1.connect(master)
        osc1.start(now)
        osc1.stop(now + 0.33)

        var osc2 = ctx.createOscillator()
        osc2.type = 'sine'
        osc2.frequency.setValueAtTime(1318.5, now + 0.04)
        osc2.connect(master)
        osc2.start(now + 0.04)
        osc2.stop(now + 0.33)
      } catch (e) {}
    }

    /** 审批与警报温润双音提示 */
    function playNotice() {
      if (!canPlay()) return
      var ctx = getCtx()
      if (!ctx) return
      try {
        var now = ctx.currentTime
        var master = ctx.createGain()
        master.gain.setValueAtTime(0.001, now)
        master.gain.linearRampToValueAtTime(0.18 * volume(), now + 0.02)
        master.gain.exponentialRampToValueAtTime(0.0001, now + 0.28)
        master.connect(ctx.destination)

        var osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(587.33, now)
        osc.frequency.setValueAtTime(880, now + 0.06)
        osc.connect(master)
        osc.start(now)
        osc.stop(now + 0.29)
      } catch (e) {}
    }

    return {
      playPop: playPop,
      playChipClick: playChipClick,
      playCollapse: playCollapse,
      playSuccess: playSuccess,
      playNotice: playNotice,
    }
  }

  /**
   * 挂载一个灵动岛。
   * ---------------------------------------------------------------------------------------
   * 只有桌面悬浮窗会调用它（`ui/window.html`）。所以这里没有「模式」这种东西：
   * 材质固定用更高不透明度的配方，位置固定在窗口顶端 —— 窗口本身就是贴在屏幕顶部的。
   * @param container - 挂载点元素。
   * @param options - `{ appearance }`，可省略。
   * @returns `{ dispose, getState, applyConfig, machine, transport, getConfig }`
   */
  function mount(container, options) {
    options = options || {}
    var config = {
      enabled: true, persistent: true,
      maxWidth: 460, minSize: MIN_SIZE, textScale: 1, durationScale: 1.2, bounce: 0.62, liquidLead: 0.55, slideDistance: 96,
      specular: true, materialTheme: 'auto', sound: true, soundVolume: 0.6,
      autoDismissScale: 1, notifyOnTaskStart: false, settlePauseMs: TIMING.settle,
      coalesceWindowMs: 1200, historySize: 60, interceptQuestions: true, questionWaitMs: 180000, maxOptions: 6,
      interceptApprovals: true,
    }
    var audio = createHapticAudio(function () { return config })
    var appearance = options.appearance || readAppearance()
    var disposed = false
    var animation = null
    var lastGeometry = null
    /** 最小态圆形直径：出厂默认是 MIN_SIZE，可被 config.minSize 覆盖。 */
    var minSize = MIN_SIZE
    var target = { w: minSize, h: minSize, r: minSize / 2 }
    var busy = false
    var measureTimer = null

    var machine = createMachine({ getConfig: function () { return config } })
    var configRevision = null
    var activeLiveSession = null
    var isLiveStreamOpen = false
    var liveStreamTimer = null

    function syncLiveSessionState(session) {
      activeLiveSession = session
      var hasSession = session !== null
      if (hasSession) {
        surface.classList.add('is-session-running')
        if (!isLiveStreamOpen) surface.title = '会话进行中 · 点击查看实时流'
      } else {
        surface.classList.remove('is-session-running')
        if (!isLiveStreamOpen) surface.title = ''
        if (isLiveStreamOpen) {
          var liveBadge = body.querySelector('.dsh-island-live-badge')
          if (liveBadge) {
            liveBadge.textContent = '✓ 本轮执行完成'
            liveBadge.style.color = '#34d399'
            liveBadge.style.borderColor = '#10b981'
          }
          setTimeout(function () {
            if (isLiveStreamOpen) closeLiveStream()
          }, 1800)
        }
      }
    }

    function refetchConfig() {
      transport.readConfig().then(function (snapshot) {
        if (disposed) return
        if (snapshot && snapshot.ok === true) {
          configRevision = snapshot.revision === undefined ? configRevision : snapshot.revision
          if (snapshot.liveSession !== undefined) syncLiveSessionState(snapshot.liveSession)
          applyConfig(snapshot.config)
        }
      }).catch(function () {})
    }
    var transport = createTransport({
      onStream: function (data, first) {
        // 配置版本变了（用户在设置页改过）就重新拉一次。
        if (typeof data.configRevision === 'number' && configRevision !== null && data.configRevision !== configRevision) {
          configRevision = data.configRevision
          refetchConfig()
        }
        if (data.liveSession !== undefined) {
          syncLiveSessionState(data.liveSession)
        }
        machine.ingest(data, first)
      },
    })

    /* ---------------- DOM ---------------- */

    var style = el('style', 'dsh-island-style')
    style.textContent = CSS

    var root = el('div', 'dsh-island-root')
    root.setAttribute('data-state', STATE.HIDDEN)
    root.setAttribute('data-appearance', appearance)
    root.setAttribute('data-surface', 'desktop')

    var liquid = buildLiquidDefs()

    var surface = el('div', 'dsh-island-surface')
    var aurora = el('div', 'dsh-island-aurora')
    var glass = el('div', 'dsh-island-glass')
    var prism = el('span', 'dsh-island-prism')
    var caustic = el('span', 'dsh-island-caustic')
    var rimTop = el('span', 'dsh-island-rim-top')
    var rimBottom = el('span', 'dsh-island-rim-bottom')
    var sheen = el('span', 'dsh-island-sheen')
    var grain = el('span', 'dsh-island-grain')
    glass.appendChild(prism)
    glass.appendChild(caustic)
    glass.appendChild(rimTop)
    glass.appendChild(rimBottom)
    glass.appendChild(sheen)
    glass.appendChild(grain)

    var content = el('div', 'dsh-island-content')
    var orb = el('div', 'dsh-island-orb')
    var orbHalo = el('span', 'dsh-island-orb-halo')
    var orbBrand = el('span', 'dsh-island-orb-brand')
    var brandSvg = buildBrandMark(LOGO_SIZE)
    orbBrand.appendChild(brandSvg)
    var orbState = el('span', 'dsh-island-orb-state')
    orb.appendChild(orbHalo)
    orb.appendChild(orbBrand)
    orb.appendChild(orbState)
    var body = el('div', 'dsh-island-body')
    var close = el('button', 'dsh-island-close')
    close.type = 'button'
    close.title = '收起（仍可在主界面回答）'
    close.appendChild(buildIcon('cross', 11))
    // orb 直接挂在 surface 下（不在 content 里）：它要相对**外层**垂直居中，
    // 而不是相对按目标尺寸钉住的内容层 —— 否则最小态里图标会跑到圆心之外。
    content.appendChild(body)

    surface.appendChild(aurora)
    surface.appendChild(glass)
    surface.appendChild(orb)
    surface.appendChild(content)
    root.appendChild(liquid.svg)
    root.appendChild(surface)
    container.appendChild(style)
    container.appendChild(root)

    var orbIcon = null
    function setOrbIcon(name) {
      if (orbIcon !== null && orbIcon.__name === name) return
      while (orbState.firstChild) orbState.removeChild(orbState.firstChild)
      orbIcon = buildIcon(name, 17)
      orbIcon.__name = name
      orbState.appendChild(orbIcon)
    }

    /* ---------------- 内容与测量 ---------------- */

    var renderedId = null
    var renderedKey = null

    function renderContent(notification) {
      var actionable = isActionable(notification)
      while (body.firstChild) body.removeChild(body.firstChild)

      var title = el('span', 'dsh-island-title', notification.title)
      var nodes = [title]
      if (notification.message !== undefined) nodes.push(el('span', 'dsh-island-message', notification.message))
      if (notification.detail !== undefined) nodes.push(el('span', 'dsh-island-detail', notification.detail))
      if (actionable) {
        var actions = el('span', 'dsh-island-actions')
        notification.actions.forEach(function (action) {
          var chip = el('button', 'dsh-island-chip' + (action.style === 'primary' ? ' is-primary' : '') + (action.style === 'danger' ? ' is-danger' : ''))
          chip.type = 'button'
          chip.title = action.description === undefined ? action.label : action.description
          chip.appendChild(el('span', 'dsh-island-chip-label', action.label))
          if (action.description !== undefined) chip.appendChild(el('span', 'dsh-island-chip-desc', action.description))
          chip.addEventListener('click', function (event) {
            event.stopPropagation()
            if (busy) return
            busy = true
            chip.classList.add('is-selected')
            audio.playChipClick()
            transport.answer(notification.id, action.value || action.id).catch(function () {
              chip.classList.remove('is-selected')
            }).then(function () {
              busy = false
            })
          })
          actions.appendChild(chip)
        })
        nodes.push(actions)
      }
      nodes.forEach(function (node) { body.appendChild(node) })
      surface.className = 'dsh-island-surface' + (actionable ? ' is-actionable' : '')
      if (actionable && close.parentNode === null) surface.appendChild(close)
      if (!actionable && close.parentNode !== null) surface.removeChild(close)
      // 右侧留白要跟着「有没有关闭按钮」走，否则长标题会和 × 撞上。
      surface.style.setProperty('--dsh-island-pad-r', (H_PAD + (actionable ? CLOSE + 4 : 0)) + 'px')
    }

    /**
     * 量内容的自然尺寸。
     * ---------------------------------------------------------------------------------------
     * 直接量 `body`（文字块），而不是量整个 surface —— 两个好处：
     *   1. 不用为了测量去 `animation.cancel()`（那会在形变中途硬切一帧，本身就会「跳」）；
     *   2. 结果与「外层当前多大」完全无关，所以任何时刻量都一样。
     * 用 `offsetWidth/offsetHeight` 而不是 `getBoundingClientRect()`：前者是布局值，
     * 不受入场位移/透明度那类 transform 影响。
     *
     * 卡片宽度 = 文字宽度 + 左右留白 + 图标槽；高度 = 文字高度 + 上下留白。
     */
    function measureTarget() {
      var snapshot = machine.getSnapshot()
      var notification = snapshot.current
      var size = notification === null ? SIZE.CIRCLE : (notification.size || SIZE.CAPSULE)
      if (size === SIZE.CIRCLE) {
        setTarget({ w: minSize, h: minSize, r: minSize / 2 })
        return
      }

      // ⚠ 测量时必须把**两层约束都解开**：
      // content 此刻还是按上一次钉住的宽度（最小态时就是那个圆），而 body 是 flex-shrink:1，
      // 不解开的话 body 会被容器压扁，量出来是压缩后的尺寸（实测卡片会缩成一条竖条）。
      var savedContentW = content.style.width
      var savedBodyW = body.style.width
      var savedBodyFlex = body.style.flex
      content.style.width = 'max-content'
      body.style.flex = '0 0 auto'
      body.style.width = 'max-content'

      var naturalW = body.offsetWidth

      var reserveRight = isActionable(notification) ? CLOSE + 4 : 0
      var chrome = 2 * H_PAD + ORB + GAP + reserveRight
      var room = Math.max(minSize, Math.round(config.maxWidth) - chrome)

      var width = Math.min(naturalW, room)
      // 关键：以最终确定的实际文字排版宽度重新排版，此时测量的高度才是真实的渲染高度
      body.style.width = width + 'px'
      var naturalH = Math.ceil(body.offsetHeight)

      content.style.width = savedContentW
      body.style.width = savedBodyW
      body.style.flex = savedBodyFlex

      setTarget(geometryFor(size, { w: Math.max(minSize, width + chrome), h: naturalH }, minSize))
    }

    function setTarget(next) {
      if (next.w === target.w && next.h === target.h && next.r === target.r) return
      target = next
      // 把内容层钉在**目标几何**上：形变过程中只有外层矩形在长大，
      // 里面按最终尺寸布好的文字一动不动（这正是「文字不跳」的关键）。
      // 收缩时不解除 —— 让外层把文字「擦掉」，而不是让文字先重排回小尺寸。
      if (next.w > minSize || next.h > minSize) {
        root.style.setProperty('--dsh-island-content-w', next.w + 'px')
        root.style.setProperty('--dsh-island-content-h', next.h + 'px')
      }
      scheduleAnim()
    }

    /* ---------------- 动画 ---------------- */

    function scaleOf(ms) { return Math.max(80, Math.round(ms * (config.durationScale || 1))) }

    function place(geometry) {
      surface.style.width = geometry.w + 'px'
      surface.style.height = geometry.h + 'px'
      surface.style.borderRadius = Math.min(geometry.r, geometry.h / 2) + 'px'
      surface.style.transform = 'translate3d(-50%, 0, 0)'
      surface.style.opacity = '1'
      lastGeometry = geometry
    }

    var bubbleStop = null
    function bubble(duration) {
      if (config.specular !== true) return
      var displacement = liquid.displacement
      sheen.style.filter = 'url(#dshIslandLiquid)'
      var started = performance.now()
      var raf = 0
      function tick(now) {
        var t = clamp((now - started) / duration, 0, 1)
        displacement.setAttribute('scale', (Math.sin(Math.PI * t) * 11).toFixed(2))
        if (t < 1) raf = requestAnimationFrame(tick)
        else { displacement.setAttribute('scale', '0'); sheen.style.filter = '' }
      }
      raf = requestAnimationFrame(tick)
      bubbleStop = function () {
        cancelAnimationFrame(raf)
        displacement.setAttribute('scale', '0')
        sheen.style.filter = ''
      }
    }

    function run(keyframes, duration) {
      if (animation !== null) animation.cancel()
      animation = surface.animate(keyframes, { fill: 'both', duration: duration, easing: 'linear' })
      return animation
    }

    var lastState = null
    var lastContentKey = null
    function animate() {
      if (disposed) return
      var snapshot = machine.getSnapshot()
      var notification = snapshot.current
      var from = lastGeometry === null ? { w: minSize, h: minSize, r: minSize / 2 } : lastGeometry
      if (bubbleStop !== null) { bubbleStop(); bubbleStop = null }

      var contentKey = notification === null ? null : (notification.id + ':' + (notification.seq || 0) + ':' + notification.type + ':' + (notification.title || ''))
      if (snapshot.state === lastState && contentKey !== null && contentKey === lastContentKey) return
      lastState = snapshot.state
      lastContentKey = contentKey

      switch (snapshot.state) {
        case STATE.ENTERING: {
          // 非常驻模式的入场：小球弹出来（不是从屏幕外滑进来）。
          audio.playPop()
          var grow = { w: minSize, h: minSize, r: minSize / 2 }
          var seedSize = Math.max(10, Math.round(minSize * ENTER_SEED))
          var enterAnimation = run(popKeyframes(
            { w: seedSize, h: seedSize, r: seedSize / 2 },
            grow,
            { bounce: config.bounce, samples: 40, stretch: ENTER_STRETCH },
          ), scaleOf(TIMING.enter))
          enterAnimation.onfinish = function () {
            place(grow)
            machine.settled('entered')
          }
          break
        }
        case STATE.EXPANDING: {
          audio.playPop()
          var expandGeometry = target
          surface.style.transform = 'translate3d(-50%, 0, 0)'
          surface.style.opacity = '1'
          var lead = clamp(config.liquidLead * 0.42, 0, 0.45)
          var expandDuration = scaleOf(TIMING.expand)
          var expandAnimation = run(morphKeyframes(from, expandGeometry, {
            duration: expandDuration, bounce: config.bounce, lead: lead, samples: 40,
          }), expandDuration)
          bubble(expandDuration)
          expandAnimation.onfinish = function () {
            place(expandGeometry)
            transport.ping('expanded', { w: expandGeometry.w, h: expandGeometry.h, type: notification === null ? null : notification.type })
            if (notification && notification.type === 'SUCCESS') {
              audio.playSuccess()
            } else if (notification && (notification.type === 'CONFIRM' || notification.type === 'ERROR' || notification.type === 'WARNING')) {
              audio.playNotice()
            }
            machine.settled('expanded')
          }
          break
        }
        case STATE.COLLAPSING: {
          audio.playCollapse()
          var circle = { w: minSize, h: minSize, r: minSize / 2 }
          var collapseLead = clamp(config.liquidLead * 0.42, 0, 0.45)
          var collapseDuration = scaleOf(TIMING.collapse)
          var collapseAnimation = run(morphKeyframes(from, circle, {
            duration: collapseDuration, bounce: config.bounce, lead: collapseLead, samples: 40, collapse: true,
          }), collapseDuration)
          bubble(collapseDuration)
          collapseAnimation.onfinish = function () {
            place(circle)
            machine.settled('collapsed')
          }
          break
        }
        case STATE.EXITING: {
          var height = lastGeometry === null ? minSize : lastGeometry.h
          var exitAnimation = run(
            slideKeyframes(0, -(height + config.slideDistance), config.bounce, true),
            scaleOf(TIMING.exit),
          )
          exitAnimation.onfinish = function () { machine.settled('exited') }
          break
        }
        default: {
          if (animation !== null) animation.cancel()
          var targetGeometry = snapshot.state === STATE.COMPACT
            ? { w: minSize, h: minSize, r: minSize / 2 }
            : target
          if ((snapshot.state === STATE.EXPANDED || snapshot.state === STATE.WAITING_ACTION)
              && lastGeometry !== null && (Math.abs(lastGeometry.w - targetGeometry.w) > 1 || Math.abs(lastGeometry.h - targetGeometry.h) > 1)) {
            var morphDuration = Math.round(scaleOf(TIMING.expand) * 0.6)
            var morphAnim = run(morphKeyframes(lastGeometry, targetGeometry, {
              duration: morphDuration, bounce: config.bounce, lead: 0.1, samples: 30,
            }), morphDuration)
            morphAnim.onfinish = function () { place(targetGeometry) }
          } else {
            place(targetGeometry)
          }
          break
        }
      }
    }

    function scheduleAnim() {
      if (measureTimer !== null) return
      measureTimer = requestAnimationFrame(function () {
        measureTimer = null
        animate()
      })
    }

    /* ---------------- 订阅 ---------------- */

    var unsubscribe = machine.subscribe(function (snapshot) {
      var notification = snapshot.current
      root.setAttribute('data-state', snapshot.state)

      if (notification === null) {
        renderedId = null
        renderedKey = null
        while (body.firstChild) body.removeChild(body.firstChild)
        if (close.parentNode !== null) surface.removeChild(close)
        setOrbIcon('info')
      } else {
        var contentKey = notification.id + ':' + (notification.seq || 0) + ':' + notification.type + ':' + (notification.title || '') + ':' + (notification.message || '')
        if (contentKey !== renderedKey) {
          renderedId = notification.id
          renderedKey = contentKey
          renderContent(notification)
          setOrbIcon(notification.icon || 'info')
          orbState.style.color = '#ffffff'
          measureTarget()
        }
      }

      var expanded = snapshot.state === STATE.EXPANDING || snapshot.state === STATE.EXPANDED || snapshot.state === STATE.WAITING_ACTION
      // 收起过程也算「内容还在」：让文字保持可见，被不断缩小的外层**裁掉**，
      // 而不是先淡出、形状再空缩一圈 —— 后者看起来就是「内容闪一下没了」。
      var showing = expanded || snapshot.state === STATE.COLLAPSING
      var actionable = isActionable(notification)
      surface.className = 'dsh-island-surface'
        + (expanded && notification !== null ? ' is-expanded' : '')
        + (showing && notification !== null ? ' is-showing' : '')
        + (actionable ? ' is-actionable' : '')
      // 图标槽的横向锚点：最小态落在圆心，展开态落在左边固定留白处。
      syncOrbAnchor()
      // 时长分层：形变按当前阶段取时长，位移比它略快一点。
      syncMotion(snapshot.state)
      root.setAttribute('data-appearance', appearance)
      applyMaterial()
      scheduleAnim()
    })

    /* ---------------- 材质与配置 ---------------- */

    function applyMaterial() {
      var theme = config.materialTheme || 'auto'
      var material = (theme !== 'auto' && MATERIAL[theme])
        ? MATERIAL[theme]
        : (appearance === 'light' ? MATERIAL['pure-crystal'] : MATERIAL.midnight)
      var paint = material.surface
      var snapshot = machine.getSnapshot()
      var notification = snapshot.current
      var tone = notification ? notification.tone : 'brand'
      var toneColor = TONE_COLOR[tone] || TONE_COLOR.brand
      var toneAurora = TONE_AURORA[tone] || TONE_AURORA.brand

      root.style.setProperty('--dsh-island-maxw', config.maxWidth + 'px')
      // 文字左侧固定从「图标槽右边 + 间距」开始，图标槽本身就落在 H_PAD 处。
      root.style.setProperty('--dsh-island-pad-l', (H_PAD + ORB + GAP) + 'px')
      // 时长变量由 syncMotion() 统一写入（它要按展开/收起分阶段给值），这里不重复设。
      root.style.setProperty('--dsh-island-tscale', String(config.textScale || 1))
      root.style.setProperty('--dsh-island-text', material.text)
      root.style.setProperty('--dsh-island-subtext', material.subText)
      root.style.setProperty('--dsh-island-brand', material.brand)
      root.style.setProperty('--dsh-island-brand-glow', material.brandGlow)
      root.style.setProperty('--dsh-island-tone-aurora', toneAurora)
      root.style.setProperty('--dsh-island-tone-color', toneColor)
      var haloGlow = (notification && notification.tone && TONE_AURORA[notification.tone]) ? TONE_AURORA[notification.tone] : material.brandGlow
      surface.style.setProperty('--dsh-island-halo-glow', haloGlow)

      surface.style.setProperty('--dsh-island-surface', paint)
      surface.style.setProperty('--dsh-island-rim-top', material.rimTop)
      surface.style.setProperty('--dsh-island-rim-bottom', material.rimBottom)
      surface.style.setProperty('--dsh-island-edge', material.edge)
      surface.style.setProperty('--dsh-island-prism-border', material.prism)
      surface.style.setProperty('--dsh-island-shadow', material.shadow)
      surface.style.setProperty('--dsh-island-chip', material.chip)
      surface.style.setProperty('--dsh-island-chip-hover', material.chipHover)
      surface.style.setProperty('--dsh-island-chip-line', material.chipLine)
      surface.style.setProperty('--dsh-island-sheen', material.sheen)
      surface.style.setProperty('--dsh-island-sheen-blend', material.sheenBlend)
      surface.style.setProperty('--dsh-island-grain', String(material.grain))
    }

    /* ---------------- 实时会话流视图 ---------------- */

    function formatTime(ms) {
      var sec = Math.max(0, Math.floor(ms / 1000))
      var m = Math.floor(sec / 60)
      var s = sec % 60
      return '⏱ ' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
    }

    function renderLiveStreamShell(session) {
      while (body.firstChild) body.removeChild(body.firstChild)
      var box = el('div', 'dsh-island-live-box')

      // 顶部操作栏
      var header = el('div', 'dsh-island-live-header')
      var title = el('span', 'dsh-island-live-title', session?.title || '任务执行中')
      var badge = el('span', 'dsh-island-live-badge', '⚡ 流式生成中')
      var timer = el('span', 'dsh-island-live-time', '⏱ 00:00')
      var closeBtn = el('button', 'dsh-island-live-close', '收起')
      closeBtn.type = 'button'
      closeBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        closeLiveStream()
      })
      header.appendChild(title)
      header.appendChild(badge)
      header.appendChild(timer)
      header.appendChild(closeBtn)

      // 滚动输出流
      var streamBox = el('div', 'dsh-island-live-stream')
      var reasoningBox = el('div', 'dsh-island-live-reasoning')
      reasoningBox.style.display = 'none'
      var textBox = el('div', 'dsh-island-live-text')
      var toolBox = el('div', 'dsh-island-live-tool')
      toolBox.style.display = 'none'

      streamBox.appendChild(reasoningBox)
      streamBox.appendChild(textBox)
      streamBox.appendChild(toolBox)

      box.appendChild(header)
      box.appendChild(streamBox)
      body.appendChild(box)

      setOrbIcon('spinner')
    }

    function syncLiveStreamContent(session) {
      if (!isLiveStreamOpen) return
      activeLiveSession = session

      var title = body.querySelector('.dsh-island-live-title')
      if (title && session.title) title.textContent = session.title

      var badge = body.querySelector('.dsh-island-live-badge')
      if (badge) {
        if (session.phase === 'thinking') {
          badge.textContent = '🧠 思考分析中'
          badge.style.color = '#c084fc'
          badge.style.borderColor = 'rgba(168,85,247,0.45)'
        } else if (session.phase === 'tool') {
          badge.textContent = '🛠 调度工具'
          badge.style.color = '#fbbf24'
          badge.style.borderColor = 'rgba(245,158,11,0.45)'
        } else if (session.phase === 'completed') {
          badge.textContent = '✓ 执行完成'
          badge.style.color = '#34d399'
          badge.style.borderColor = 'rgba(16,185,129,0.45)'
        } else {
          badge.textContent = '⚡ 流式生成中'
          badge.style.color = '#93c5fd'
          badge.style.borderColor = 'rgba(59,130,246,0.45)'
        }
      }

      var time = body.querySelector('.dsh-island-live-time')
      if (time && typeof session.elapsedMs === 'number') {
        time.textContent = formatTime(session.elapsedMs)
      }

      var streamBox = body.querySelector('.dsh-island-live-stream')
      var reasoningBox = body.querySelector('.dsh-island-live-reasoning')
      var textBox = body.querySelector('.dsh-island-live-text')
      var toolBox = body.querySelector('.dsh-island-live-tool')

      if (reasoningBox) {
        if (session.reasoning && session.reasoning.trim() !== '') {
          reasoningBox.style.display = 'block'
          reasoningBox.textContent = session.reasoning
        } else {
          reasoningBox.style.display = 'none'
        }
      }

      if (textBox) {
        var text = session.text || (session.reasoning ? '' : '正在连接会话流...')
        textBox.textContent = text
        var cursor = el('span', 'dsh-island-live-cursor', '▍')
        textBox.appendChild(cursor)
      }

      if (toolBox) {
        if (session.currentTool) {
          toolBox.style.display = 'inline-flex'
          toolBox.textContent = '🛠 工具执行：' + session.currentTool
        } else {
          toolBox.style.display = 'none'
        }
      }

      if (streamBox) {
        streamBox.scrollTop = streamBox.scrollHeight
      }
    }

    function startLiveStreamPoll() {
      stopLiveStreamPoll()
      function poll() {
        if (!isLiveStreamOpen || disposed) return
        transport.fetchLiveSession().then(function (res) {
          if (!isLiveStreamOpen || disposed) return
          if (res && res.session) {
            syncLiveStreamContent(res.session)
          } else if (res && res.active === false && activeLiveSession) {
            syncLiveSessionState(null)
          }
        }).catch(function () {}).then(function () {
          if (isLiveStreamOpen && !disposed) {
            liveStreamTimer = setTimeout(poll, 130)
          }
        })
      }
      poll()
    }

    function stopLiveStreamPoll() {
      if (liveStreamTimer !== null) {
        clearTimeout(liveStreamTimer)
        liveStreamTimer = null
      }
    }

    function openLiveStream() {
      if (isLiveStreamOpen) return
      isLiveStreamOpen = true
      surface.classList.add('is-live-streaming')
      surface.classList.add('is-expanded')
      surface.classList.add('is-showing')
      surface.title = '点击收起实时会话流'
      audio.playPop()

      var targetW = Math.min(500, Math.max(380, config.maxWidth))
      var targetH = 220
      var liveGeom = { w: targetW, h: targetH, r: 20 }

      root.style.setProperty('--dsh-island-content-w', targetW + 'px')
      root.style.setProperty('--dsh-island-content-h', targetH + 'px')
      root.style.setProperty('--dsh-island-orb-x', H_PAD + 'px')

      renderLiveStreamShell(activeLiveSession)

      var fromGeom = lastGeometry || { w: minSize, h: minSize, r: minSize / 2 }
      var anim = run(morphKeyframes(fromGeom, liveGeom, {
        duration: scaleOf(TIMING.expand), bounce: config.bounce, lead: 0.15, samples: 36,
      }), scaleOf(TIMING.expand))
      anim.onfinish = function () {
        place(liveGeom)
      }

      startLiveStreamPoll()
    }

    function closeLiveStream() {
      if (!isLiveStreamOpen) return
      isLiveStreamOpen = false
      stopLiveStreamPoll()
      surface.classList.remove('is-live-streaming')
      surface.classList.remove('is-expanded')
      surface.classList.remove('is-showing')
      surface.title = activeLiveSession ? '会话进行中 · 点击查看实时流' : ''
      audio.playCollapse()

      // 收起目标几何：收缩回最小圆
      var circleGeom = { w: minSize, h: minSize, r: minSize / 2 }
      target = circleGeom
      root.style.setProperty('--dsh-island-content-w', minSize + 'px')
      root.style.setProperty('--dsh-island-content-h', minSize + 'px')
      root.style.setProperty('--dsh-island-orb-x', (minSize / 2 - ORB / 2) + 'px')

      var current = machine.getSnapshot().current
      if (current && (current.type === 'PROGRESS' || current.duration === null)) {
        machine.dismiss()
      }

      var fromGeom = lastGeometry || { w: 480, h: 220, r: 20 }
      var anim = run(morphKeyframes(fromGeom, circleGeom, {
        duration: scaleOf(TIMING.collapse), bounce: config.bounce, lead: 0.15, samples: 36, collapse: true,
      }), scaleOf(TIMING.collapse))
      anim.onfinish = function () {
        place(circleGeom)
        renderedId = null
        renderedKey = null
        while (body.firstChild) body.removeChild(body.firstChild)
        setOrbIcon('info')
      }
    }

    /* ---------------- 交互与液态流体拖拽 ---------------- */

    var dragActive = false
    var dragMoved = false
    var dragStartX = 0
    var dragStartY = 0
    var dragTensionX = 0
    var dragTensionY = 0
    var dragPointerId = null
    var reboundAnimation = null

    surface.addEventListener('click', function (event) {
      if (dragMoved) {
        event.stopPropagation()
        return
      }
      if (isLiveStreamOpen) {
        if (event.target && event.target.closest('.dsh-island-live-stream')) {
          return
        }
        closeLiveStream()
        return
      }
      if (activeLiveSession !== null) {
        openLiveStream()
        return
      }
      var notification = machine.getSnapshot().current
      if (notification === null || isActionable(notification)) return
      transport.dismiss(notification.id, false).catch(function () {})
      machine.dismiss()
    })

    surface.addEventListener('pointerenter', function () { machine.holdAutoDismiss() })
    surface.addEventListener('pointerleave', function () {
      if (!dragActive) {
        surface.style.removeProperty('--dsh-island-mx')
        surface.style.removeProperty('--dsh-island-my')
      }
      machine.resumeAutoDismiss()
    })

    surface.addEventListener('pointerdown', function (event) {
      // 若点击在选项胶囊、关闭按钮、收起按钮或实时滚动流文本区上，放行原生点击/选择
      if (event.target && (event.target.closest('.dsh-island-chip') || event.target.closest('.dsh-island-close') || event.target.closest('.dsh-island-live-close') || event.target.closest('.dsh-island-live-stream'))) {
        return
      }
      if (reboundAnimation !== null) {
        reboundAnimation.cancel()
        reboundAnimation = null
      }
      dragActive = true
      dragMoved = false
      dragStartX = event.clientX
      dragStartY = event.clientY
      dragPointerId = event.pointerId

      // 实时定位按下点：光晕精准以绝对像素坐标在鼠标处绽放
      var rect = surface.getBoundingClientRect()
      if (rect.width && rect.height) {
        var x = clamp(event.clientX - rect.left, 0, rect.width)
        var y = clamp(event.clientY - rect.top, 0, rect.height)
        surface.style.setProperty('--dsh-island-mx', x.toFixed(1) + 'px')
        surface.style.setProperty('--dsh-island-my', y.toFixed(1) + 'px')
      }

      surface.classList.add('is-pressed')
      try { surface.setPointerCapture(event.pointerId) } catch (e) {}
    })

    surface.addEventListener('pointermove', function (event) {
      var rect = surface.getBoundingClientRect()
      if (rect.width && rect.height) {
        var x = clamp(event.clientX - rect.left, 0, rect.width)
        var y = clamp(event.clientY - rect.top, 0, rect.height)
        surface.style.setProperty('--dsh-island-mx', x.toFixed(1) + 'px')
        surface.style.setProperty('--dsh-island-my', y.toFixed(1) + 'px')
      }

      if (!dragActive || event.pointerId !== dragPointerId) return

      var dx = event.clientX - dragStartX
      var dy = event.clientY - dragStartY
      var dist = Math.sqrt(dx * dx + dy * dy)
      if (dist > 3) {
        dragMoved = true
      }
      if (!dragMoved) return

      // 径向连续流体极坐标阻尼：消除矩形盒边界与尖锐死角，在全 360° 方向呈光滑超椭圆流体曲面过渡
      var Lx = 9.5
      var Ly = dy >= 0 ? 10.5 : 2.5
      var ux = dx / dist
      var uy = dy / dist

      // 连续光滑椭圆阻尼曲面半径上限（消除方形死角）
      var rMax = 1 / Math.sqrt((ux * ux) / (Lx * Lx) + (uy * uy) / (Ly * Ly))

      // 径向渐近柔和张力阻尼
      var rTension = rMax * (dist / (dist + 26))
      var tensionX = rTension * ux
      var tensionY = rTension * uy
      dragTensionX = tensionX
      dragTensionY = tensionY

      // 形变继承按压状态的弹性放大（圆形基准 1.3，展开卡片基准 1.025）
      var isCard = surface.classList.contains('is-expanded') || surface.classList.contains('is-live-streaming')
      var baseScale = isCard ? 1.025 : 1.3

      // 在继承放大的基准上，按径向张力分量连续平滑叠加流体拉伸与挤压（无阶跃跳动）
      var tensionFraction = rTension / rMax
      var pullX = tensionFraction * Math.abs(ux)
      var pullY = tensionFraction * Math.max(0, uy)

      var stretchX = clamp(1 + pullX * 0.12 - pullY * 0.07, 0.92, 1.15)
      var stretchY = clamp(1 + pullY * 0.14 - pullX * 0.07, 0.92, 1.18)

      var finalScaleX = baseScale * stretchX
      var finalScaleY = baseScale * stretchY

      surface.style.transform = 'translate3d(calc(-50% + ' + tensionX.toFixed(2) + 'px), ' + tensionY.toFixed(2) + 'px, 0) scale(' + finalScaleX.toFixed(3) + ', ' + finalScaleY.toFixed(3) + ')'
      surface.classList.add('is-dragging')
    }, { passive: true })

    function endDrag(event) {
      if (dragPointerId !== null) {
        try { surface.releasePointerCapture(dragPointerId) } catch (e) {}
      }
      var wasActive = dragActive
      var wasMoved = dragMoved
      dragActive = false
      dragPointerId = null
      surface.classList.remove('is-dragging')
      surface.classList.remove('is-pressed')

      if (!wasActive && !wasMoved) return

      var curTransform = surface.style.transform || 'translate3d(-50%, 0, 0)'
      surface.style.transform = 'translate3d(-50%, 0, 0)'
      liquid.displacement.setAttribute('scale', '0')
      sheen.style.filter = ''

      if (!wasMoved || (Math.abs(dragTensionX) < 0.5 && Math.abs(dragTensionY) < 0.5)) {
        dragMoved = false
        dragTensionX = 0
        dragTensionY = 0
        return
      }

      // 果冻弹簧反向阻尼回弹（快速物理反冲 + 优雅微振颤 + 干净归位）
      var oppScaleX = clamp(2 - (1 + Math.abs(dragTensionX / 9) * 0.14), 0.88, 1.05)
      var oppScaleY = clamp(2 - (1 + Math.max(0, dragTensionY / 10) * 0.16), 0.88, 1.05)
      var reboundFrames = [
        { transform: curTransform, offset: 0 },
        { transform: 'translate3d(calc(-50% - ' + (dragTensionX * 0.25).toFixed(1) + 'px), ' + (-dragTensionY * 0.25).toFixed(1) + 'px, 0) scale(' + oppScaleX.toFixed(3) + ', ' + oppScaleY.toFixed(3) + ')', offset: 0.38 },
        { transform: 'translate3d(calc(-50% + ' + (dragTensionX * 0.06).toFixed(1) + 'px), ' + (dragTensionY * 0.06).toFixed(1) + 'px, 0) scale(1.015, 0.99)', offset: 0.70 },
        { transform: 'translate3d(-50%, 0, 0) scale(1, 1)', offset: 1 },
      ]

      audio.playPop()
      reboundAnimation = surface.animate(reboundFrames, {
        duration: 300,
        easing: 'cubic-bezier(.22,1,.36,1)',
        fill: 'none',
      })
      reboundAnimation.onfinish = function () {
        surface.style.transform = 'translate3d(-50%, 0, 0)'
        reboundAnimation = null
        dragMoved = false
        dragTensionX = 0
        dragTensionY = 0
      }
    }

    surface.addEventListener('pointerup', endDrag)
    surface.addEventListener('pointercancel', endDrag)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    window.addEventListener('mouseup', endDrag)
    window.addEventListener('blur', endDrag)
    document.addEventListener('mouseleave', endDrag)

    close.addEventListener('click', function (event) {
      event.stopPropagation()
      var notification = machine.getSnapshot().current
      if (notification === null) return
      transport.dismiss(notification.id, isActionable(notification)).catch(function () {})
      machine.dismiss()
    })

    /* ---------------- 启动 ---------------- */

    setMinSize(config.minSize)
    applyMaterial()
    syncMotion(STATE.HIDDEN)
    place({ w: minSize, h: minSize, r: minSize / 2 })
    transport.readConfig().then(function (snapshot) {
      if (disposed) return
      if (snapshot && snapshot.ok === true) {
        configRevision = snapshot.revision === undefined ? null : snapshot.revision
        applyConfig(snapshot.config)
      }
    }).catch(function () {}).then(function () {
      if (!disposed) transport.start()
    })
    transport.ping('mounted', { surface: 'desktop' })

    /**
     * 改最小态圆形直径。Logo 尺寸与归心位移都按比例跟着走，
     * 所以外部只需要给一个 minSize 值（设置页的滑杆）。
     */
    function setMinSize(value) {
      var next = Math.round(Number(value))
      if (!isFinite(next)) next = MIN_SIZE
      next = Math.min(MIN_SIZE_CEIL, Math.max(MIN_SIZE_FLOOR, next))
      var changed = next !== minSize
      minSize = next
      var logo = Math.max(12, Math.round(minSize * LOGO_SIZE / MIN_SIZE))
      brandSvg.setAttribute('width', String(logo))
      brandSvg.setAttribute('height', String(logo * FISH_LOGO_VIEWBOX.height / FISH_LOGO_VIEWBOX.width))
      return changed
    }

    /**
     * 同步图标槽的横向锚点。
     * 最小态必须落在**圆心**（外层此时就是那个圆）；展开态落在左侧固定留白处。
     * 换锚点时靠 CSS 的 transform 过渡滑过去，所以不会跳。
     * 它依赖 minSize 和当前状态，所以两处变化都要调这个函数。
     */
    function syncOrbAnchor() {
      var snapshot = machine.getSnapshot()
      var expanded = snapshot.current !== null
        && (snapshot.state === STATE.EXPANDING || snapshot.state === STATE.EXPANDED || snapshot.state === STATE.WAITING_ACTION)
      root.style.setProperty('--dsh-island-orb-x', (expanded ? H_PAD : minSize / 2 - ORB / 2) + 'px')
    }

    /**
     * 时长分层。
     * ---------------------------------------------------------------------------------------
     * 两件事：
     *   · `--dsh-island-morph` 按**当前阶段**取时长（展开用 expand、收起用 collapse），
     *     否则收起时图标还按展开的时长走，就会与形状脱节；
     *   · `--dsh-island-shift`（图标位移 / 文字横移）比形变略快一点 ——
     *     位移先到位、形变随后收尾，这是 Apple 常见的层次感。
     */
    function syncMotion(state) {
      var base = state === STATE.COLLAPSING ? TIMING.collapse : TIMING.expand
      root.style.setProperty('--dsh-island-morph', scaleOf(base) + 'ms')
      root.style.setProperty('--dsh-island-shift', scaleOf(Math.round(base * 0.88)) + 'ms')
    }

    function applyConfig(next) {
      if (next === null || typeof next !== 'object') return
      for (var key in next) if (Object.prototype.hasOwnProperty.call(next, key)) config[key] = next[key]
      var resized = setMinSize(config.minSize)
      machine.setConfig(config)
      applyMaterial()
      syncOrbAnchor()
      syncMotion(machine.getSnapshot().state)
      measureTarget()
      // 正处在最小态时，直径变了要立刻落到画面上（展开态不用管，几何由测量决定）。
      if (resized && (machine.getSnapshot().state === STATE.HIDDEN || machine.getSnapshot().state === STATE.COMPACT)) {
        place({ w: minSize, h: minSize, r: minSize / 2 })
      }
    }

    return {
      dispose: function () {
        disposed = true
        unsubscribe()
        stopLiveStreamPoll()
        window.removeEventListener('pointerup', endDrag)
        window.removeEventListener('pointercancel', endDrag)
        window.removeEventListener('mouseup', endDrag)
        window.removeEventListener('blur', endDrag)
        document.removeEventListener('mouseleave', endDrag)
        if (typeof machine.dispose === 'function') machine.dispose()
        transport.stop()
        if (animation !== null) animation.cancel()
        if (bubbleStop !== null) bubbleStop()
        if (measureTimer !== null) cancelAnimationFrame(measureTimer)
        if (root.parentNode !== null) root.parentNode.removeChild(root)
        if (style.parentNode !== null) style.parentNode.removeChild(style)
      },
      getState: function () { return machine.getSnapshot() },
      /** 宿主主题切换时重新判断明暗。 */
      setAppearance: function (next) {
        var value = next === 'light' || next === 'dark' ? next : readAppearance()
        if (value === appearance) return
        appearance = value
        root.setAttribute('data-appearance', appearance)
        applyMaterial()
      },
      applyConfig: applyConfig,
      machine: machine,
      transport: transport,
      getConfig: function () { return config },
    }
  }

  /* ===================================================================================
     CSS
     =================================================================================== */

  var CSS = [
    /* 运动曲线系统 */
    '.dsh-island-root{--dsh-island-ease-move:cubic-bezier(.32,.72,0,1);',
    '  --dsh-island-ease-fade:cubic-bezier(.25,.1,.25,1);',
    '  --dsh-island-ease-out:cubic-bezier(.22,1,.36,1);}',
    '.dsh-island-root{position:absolute;top:14px;left:0;right:0;height:0;display:flex;justify-content:center;',
    '  pointer-events:none;z-index:9999;contain:layout style;}',
    '.dsh-island-root[data-state="HIDDEN"]{visibility:hidden;}',

    /* 物理表面容器：空间悬浮、次表面环境投影（上边缘留出 14px 缓冲，投影与高光平滑衰减至 0，不被窗口硬裁切） */
    '.dsh-island-surface{position:absolute;top:0;left:50%;',
    '  transform:translate3d(-50%,0,0);pointer-events:auto;overflow:hidden;isolation:isolate;',
    '  will-change:width,height,border-radius;box-shadow:var(--dsh-island-shadow);',
    '  transition:box-shadow .42s var(--dsh-island-ease-move);}',
    '.dsh-island-surface.is-expanded{cursor:default;}',
    '.dsh-island-surface:not(.is-actionable):not(.is-expanded){cursor:pointer;}',
    '.dsh-island-surface.is-dragging{cursor:grabbing !important;user-select:none;-webkit-user-select:none;transition:none !important;}',

    /* 按下状态：原生轻微放大反馈 scale(1.3) + 靠近鼠标处的局部流体光晕 */
    '.dsh-island-surface.is-pressed:not(.is-dragging){transform:translate3d(-50%,0,0) scale(1.3) !important;transition:transform 140ms cubic-bezier(.22,1,.36,1) !important;}',
    '.dsh-island-surface.is-pressed.is-expanded:not(.is-dragging),.dsh-island-surface.is-pressed.is-live-streaming:not(.is-dragging){transform:translate3d(-50%,0,0) scale(1.025) !important;}',
    '.dsh-island-surface.is-pressed .dsh-island-sheen{opacity:1 !important;background:radial-gradient(circle 80px at var(--dsh-island-mx, 50%) var(--dsh-island-my, 50%), rgba(255,255,255,0.72) 0%, rgba(160,200,255,0.40) 30%, rgba(255,255,255,0.12) 58%, transparent 75%) !important;transition:opacity 140ms ease !important;}',

    /* 情境极光层：次表面根据状态自发光（绿极光/红焰/量子深蓝），在胶囊内柔和聚焦，不超出容器物理边界 */
    '.dsh-island-aurora{position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0;overflow:hidden;',
    '  background:radial-gradient(ellipse 110px 75px at 28px 50%, var(--dsh-island-tone-aurora, rgba(77,107,254,0.42)) 0%, transparent 75%);',
    '  opacity:0;filter:blur(14px);',
    '  transition:opacity 320ms var(--dsh-island-ease-fade), background 320ms var(--dsh-island-ease-fade);}',
    '.dsh-island-surface.is-showing .dsh-island-aurora{opacity:1;}',

    /* 光学液态玻璃基底：高透晶体 + 倒角双重内反射 + 真实背景模糊折射 */
    '.dsh-island-glass{position:absolute;inset:0;border-radius:inherit;overflow:hidden;z-index:1;',
    '  background:var(--dsh-island-surface);',
    '  border:1px solid var(--dsh-island-edge);',
    '  backdrop-filter:blur(32px) saturate(220%) contrast(108%) brightness(115%);',
    '  -webkit-backdrop-filter:blur(32px) saturate(220%) contrast(108%) brightness(115%);',
    '  box-shadow:inset 0 1.5px 2px 0 rgba(255,255,255,.85), inset 0 -1.5px 2px 0 rgba(255,255,255,.3), inset 0 0 24px 0 rgba(255,255,255,.12);}',

    /* 彩虹微色散棱镜倒角：iOS 27 标志性 0.75px 棱镜折射边缘 */
    '.dsh-island-prism{position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:2;',
    '  border:1px solid transparent;',
    '  background:var(--dsh-island-prism-border) border-box;',
    '  -webkit-mask:linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);',
    '  -webkit-mask-composite:xor;mask-composite:exclude;opacity:.92;}',

    /* 内部焦散微光池：凸面透镜汇聚光晕 */
    '.dsh-island-caustic{position:absolute;top:0;left:5%;width:90%;height:70%;border-radius:50%;pointer-events:none;z-index:2;',
    '  background:radial-gradient(ellipse 75% 55% at 50% 16%, rgba(255,255,255,.35) 0%, rgba(255,255,255,.08) 50%, transparent 85%);}',

    /* 表面张力双曲面月牙高光：顶部主高光弧度 */
    '.dsh-island-rim-top{position:absolute;left:0;right:0;top:0;height:48%;border-radius:inherit;pointer-events:none;z-index:3;',
    '  background:var(--dsh-island-rim-top);opacity:.68;}',

    /* 底部反光地线：环境地光回弹 */
    '.dsh-island-rim-bottom{position:absolute;left:8%;right:8%;bottom:0;height:1px;border-radius:2px;pointer-events:none;z-index:3;',
    '  background:var(--dsh-island-rim-bottom);opacity:.72;}',

    /* 交互式液态镜面釉层：跟随鼠标位置实时漂移反光 */
    /* 交互式液态镜面釉层：以绝对像素精准跟随鼠标触点，消除边缘漂移 */
    '.dsh-island-sheen{position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:4;opacity:.65;',
    '  background:radial-gradient(circle 120px at var(--dsh-island-mx, 50%) var(--dsh-island-my, 50%),',
    '    var(--dsh-island-sheen) 0%, rgba(255,255,255,.14) 45%, transparent 70%);',
    '  mix-blend-mode:var(--dsh-island-sheen-blend,screen);',
    '  transition:opacity 280ms var(--dsh-island-ease-fade);}',

    /* 星光微光子晶体噪点 */
    '.dsh-island-grain{position:absolute;inset:0;pointer-events:none;z-index:5;opacity:var(--dsh-island-grain,.042);',
    '  mix-blend-mode:overlay;',
    '  background-image:url("data:image/svg+xml;utf8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'140\' height=\'140\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'.85\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'140\' height=\'140\' filter=\'url(%23n)\'/%3E%3C/svg%3E");}',

    /* 内容层：钉在目标几何上，外层只负责裁剪揭示 */
    '.dsh-island-content{position:absolute;left:0;top:0;z-index:6;box-sizing:border-box;',
    '  width:var(--dsh-island-content-w,100%);height:var(--dsh-island-content-h,100%);',
    '  display:flex;align-items:center;',
    '  padding:0 var(--dsh-island-pad-r,12px) 0 var(--dsh-island-pad-l,47px);color:var(--dsh-island-text);}',

    /* 液态能量徽章（Orb）与呼吸光环 */
    '.dsh-island-orb{position:absolute;left:0;top:50%;z-index:7;',
    '  flex:0 0 auto;width:26px;height:26px;display:grid;place-items:center;',
    '  transform:translateY(-50%) translateX(var(--dsh-island-orb-x,4px));',
    '  transition:transform var(--dsh-island-shift,520ms) var(--dsh-island-ease-move);}',

    '.dsh-island-orb-halo{position:absolute;inset:-5px;border-radius:50%;pointer-events:none;',
    '  background:radial-gradient(circle, var(--dsh-island-halo-glow, rgba(255,255,255,.7)) 0%, rgba(180,215,255,.25) 45%, transparent 70%);',
    '  opacity:.8;filter:blur(4px);',
    '  animation:dsh-island-breathe 4s ease-in-out infinite;}',
    '@keyframes dsh-island-breathe{0%,100%{transform:scale(.92);opacity:.6;}50%{transform:scale(1.18);opacity:.95;}}',

    /* 图标：熔融液态银 / 霜晶白雕刻，与液态玻璃基底浑然一体 */
    '.dsh-island-orb-brand{position:absolute;inset:0;display:grid;place-items:center;z-index:2;',
    '  color:var(--dsh-island-brand,#ffffff);',
    '  filter:drop-shadow(0 1px 1.5px rgba(255,255,255,.9)) drop-shadow(0 2px 5px rgba(0,0,0,.45));',
    '  transition:transform var(--dsh-island-shift,520ms) var(--dsh-island-ease-move),',
    '    opacity 150ms var(--dsh-island-ease-fade);}',

    '.dsh-island-orb-state{position:absolute;inset:0;display:grid;place-items:center;opacity:0;z-index:2;',
    '  transform:scale(.55);color:#ffffff;',
    '  filter:drop-shadow(0 1px 1.5px rgba(255,255,255,.9)) drop-shadow(0 2px 6px rgba(0,0,0,.45));',
    '  transition:transform var(--dsh-island-shift,520ms) var(--dsh-island-ease-move),',
    '    opacity 150ms var(--dsh-island-ease-fade);}',

    '.dsh-island-surface.is-expanded .dsh-island-orb-brand{opacity:0;transform:scale(.42) translateX(-2px);',
    '  transition:transform var(--dsh-island-shift,520ms) var(--dsh-island-ease-move),',
    '    opacity 150ms var(--dsh-island-ease-fade);}',
    '.dsh-island-surface.is-expanded .dsh-island-orb-state{opacity:1;transform:scale(1);',
    '  transition:transform var(--dsh-island-shift,520ms) var(--dsh-island-ease-move),',
    '    opacity 220ms var(--dsh-island-ease-fade);}',
    '.dsh-island-surface:not(.is-expanded) .dsh-island-orb-brand{opacity:1;transform:scale(1);',
    '  transition:transform var(--dsh-island-shift,520ms) var(--dsh-island-ease-move),',
    '    opacity 220ms var(--dsh-island-ease-fade);}',

    /* 文本主体与 Apple 字体排版 */
    '.dsh-island-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;',
    '  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;',
    '  font-size:calc(11.8px * var(--dsh-island-tscale,1));',
    '  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;',
    '  opacity:0;transform:translateX(-7px);',
    '  transition:opacity 160ms var(--dsh-island-ease-fade),',
    '    transform var(--dsh-island-shift,520ms) var(--dsh-island-ease-move);}',
    '.dsh-island-surface.is-showing .dsh-island-body{opacity:1;transform:translateX(0);',
    '  transition:opacity 240ms var(--dsh-island-ease-fade),',
    '    transform var(--dsh-island-shift,520ms) var(--dsh-island-ease-move);}',

    '.dsh-island-title{font-size:1.06em;font-weight:590;line-height:1.32;letter-spacing:-0.012em;',
    '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
    '  text-shadow:0 1px 2px rgba(0,0,0,.35);}',
    '.dsh-island-surface.is-actionable .dsh-island-title{white-space:normal;}',
    '.dsh-island-message{font-size:.95em;line-height:1.38;letter-spacing:-0.006em;color:var(--dsh-island-subtext);',
    '  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
    '.dsh-island-detail{font-size:.90em;line-height:1.42;letter-spacing:-0.004em;color:var(--dsh-island-subtext);white-space:pre-wrap;',
    '  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}',

    /* 液态触感交互胶囊（Chips） */
    '.dsh-island-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}',
    '.dsh-island-chip{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:0;',
    '  border:1px solid var(--dsh-island-chip-line);background:var(--dsh-island-chip);',
    '  color:var(--dsh-island-text);border-radius:999px;padding:4px 12px;font:inherit;cursor:pointer;',
    '  overflow:hidden;backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);',
    '  box-shadow:inset 0 1px 1px rgba(255,255,255,.55), 0 3px 8px -2px rgba(0,0,0,.3);',
    '  transition:transform 160ms var(--dsh-island-ease-out),',
    '    background 180ms var(--dsh-island-ease-out),',
    '    border-color 180ms var(--dsh-island-ease-out),',
    '    box-shadow 180ms var(--dsh-island-ease-out);}',
    '.dsh-island-chip:hover{background:var(--dsh-island-chip-hover);border-color:rgba(255,255,255,.5);',
    '  transform:translateY(-1px) scale(1.02);box-shadow:inset 0 1px 1.5px rgba(255,255,255,.7), 0 5px 14px -2px rgba(0,0,0,.4);}',
    '.dsh-island-chip:active{transform:scale(.96) translateY(.5px);box-shadow:inset 0 1px 3px rgba(0,0,0,.4);transition-duration:90ms;}',
    '.dsh-island-chip.is-selected{transform:scale(.96) translateY(.5px);filter:brightness(1.15);border-color:rgba(255,255,255,.85);box-shadow:inset 0 1px 2px rgba(255,255,255,.9), 0 0 12px rgba(77,107,254,.7);}',
    '.dsh-island-chip.is-primary{background:linear-gradient(135deg, rgba(79,111,248,.82) 0%, rgba(43,75,242,.92) 100%);',
    '  border-color:rgba(255,255,255,.5);color:#ffffff;',
    '  box-shadow:inset 0 1px 1.5px rgba(255,255,255,.8), 0 4px 16px -2px rgba(77,107,254,.6);}',
    '.dsh-island-chip.is-primary:hover{background:linear-gradient(135deg, rgba(95,125,250,.9) 0%, rgba(58,88,244,.96) 100%);',
    '  box-shadow:inset 0 1px 2px rgba(255,255,255,.95), 0 6px 20px -2px rgba(77,107,254,.75);}',
    '.dsh-island-chip.is-danger{background:linear-gradient(135deg, rgba(244,63,94,.82) 0%, rgba(220,38,38,.92) 100%);',
    '  border-color:rgba(255,255,255,.5);color:#ffffff;',
    '  box-shadow:inset 0 1px 1.5px rgba(255,255,255,.8), 0 4px 16px -2px rgba(244,63,94,.6);}',
    '.dsh-island-chip-label{font-size:1em;font-weight:570;line-height:1.28;white-space:nowrap;}',
    '.dsh-island-chip-desc{font-size:.87em;line-height:1.28;opacity:.74;white-space:nowrap;}',

    /* 晶体关闭按钮 */
    '.dsh-island-close{position:absolute;z-index:8;right:6px;top:6px;width:20px;height:20px;border-radius:50%;',
    '  border:1px solid rgba(255,255,255,.22);padding:0;display:grid;place-items:center;cursor:pointer;',
    '  background:rgba(255,255,255,.12);color:var(--dsh-island-subtext);',
    '  box-shadow:inset 0 .5px .5px rgba(255,255,255,.5);',
    '  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);opacity:0;',
    '  transition:transform 220ms var(--dsh-island-ease-move),',
    '    background 160ms var(--dsh-island-ease-out),color 160ms var(--dsh-island-ease-out),',
    '    opacity 160ms var(--dsh-island-ease-fade),border-color 160ms var(--dsh-island-ease-out);}',
    '.dsh-island-surface.is-expanded .dsh-island-close{opacity:1;',
    '  transition:transform 220ms var(--dsh-island-ease-move),',
    '    background 160ms var(--dsh-island-ease-out),color 160ms var(--dsh-island-ease-out),',
    '    opacity 200ms var(--dsh-island-ease-fade);}',
    '.dsh-island-close:hover{background:rgba(255,255,255,.26);border-color:rgba(255,255,255,.6);color:var(--dsh-island-text);transform:rotate(90deg) scale(1.08);}',
    '.dsh-island-close:active{transform:rotate(90deg) scale(.92);transition-duration:90ms;}',

    '.dsh-island-spin{animation:dsh-island-spin 1.05s linear infinite;transform-origin:50% 50%;}',
    '@keyframes dsh-island-spin{to{transform:rotate(360deg);}}',
    '@media (prefers-reduced-motion:reduce){.dsh-island-spin,.dsh-island-orb-halo{animation:none;}}',

    /* 实时会话流扩展面板 */
    '.dsh-island-surface.is-session-running .dsh-island-orb-halo{opacity:1;filter:blur(5px);animation:dsh-island-breathe 2s ease-in-out infinite;}',
    '.dsh-island-surface.is-live-streaming{cursor:default !important;}',
    '.dsh-island-surface.is-live-streaming .dsh-island-content{display:flex !important;flex-direction:column !important;align-items:stretch !important;padding:10px 14px 10px 42px !important;height:100% !important;box-sizing:border-box !important;overflow:hidden !important;}',
    '.dsh-island-surface.is-live-streaming .dsh-island-body{flex:1 1 0 !important;height:100% !important;max-height:100% !important;min-height:0 !important;overflow:hidden !important;display:flex !important;flex-direction:column !important;transform:none !important;opacity:1 !important;}',
    '.dsh-island-surface.is-live-streaming .dsh-island-orb{top:20px !important;transform:translateY(-50%) translateX(10px) !important;}',
    '.dsh-island-live-box{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;max-height:100%;box-sizing:border-box;overflow:hidden;}',
    '.dsh-island-live-header{flex:0 0 24px;min-height:24px;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:11.5px;z-index:2;}',
    '.dsh-island-live-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;letter-spacing:-0.01em;}',
    '.dsh-island-live-badge{font-size:10px;padding:2px 8px;border-radius:999px;background:rgba(59,130,246,0.18);border:1px solid rgba(96,165,250,0.4);color:#93c5fd;flex:0 0 auto;}',
    '.dsh-island-live-time{font-size:10.5px;color:var(--dsh-island-subtext);font-variant-numeric:tabular-nums;flex:0 0 auto;}',
    '.dsh-island-live-close{border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.12);color:var(--dsh-island-text);border-radius:6px;padding:2px 8px;font-size:10px;cursor:pointer;transition:all 140ms ease;}',
    '.dsh-island-live-close:hover{background:rgba(255,255,255,0.25);border-color:rgba(255,255,255,0.5);transform:scale(1.04);}',
    '.dsh-island-live-stream{flex:1 1 0;min-height:0;overflow-y:auto;overflow-x:hidden;border-radius:10px;background:rgba(0,0,0,0.32);border:1px solid rgba(255,255,255,0.09);padding:8px 10px;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:11px;line-height:1.52;color:var(--dsh-island-text);box-sizing:border-box;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.2) transparent;}',
    '.dsh-island-live-stream::-webkit-scrollbar{width:4px;}',
    '.dsh-island-live-stream::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:2px;}',
    '.dsh-island-live-reasoning{color:#c084fc;font-style:italic;margin-bottom:8px;border-left:2px solid #a855f7;padding:4px 8px;background:rgba(168,85,247,0.08);border-radius:0 6px 6px 0;font-size:10.5px;line-height:1.45;opacity:0.92;white-space:pre-wrap;word-break:break-word;}',
    '.dsh-island-live-text{white-space:pre-wrap;word-break:break-word;color:#f1f5f9;}',
    '.dsh-island-live-tool{display:inline-flex;align-items:center;gap:4px;margin-top:6px;padding:2px 8px;border-radius:6px;background:rgba(245,158,11,0.18);border:1px solid rgba(245,158,11,0.4);color:#fbbf24;font-size:10px;}',
    '.dsh-island-live-cursor{display:inline-block;animation:dsh-island-cursor 750ms infinite;color:#60a5fa;margin-left:2px;font-weight:bold;}',
    '@keyframes dsh-island-cursor{0%,100%{opacity:1;}50%{opacity:0;}}',
  ].join('\n')

  /* ===================================================================================
     导出
     =================================================================================== */

  window.DshIsland = {
    mount: mount,
    core: {
      API: API, SIZE: SIZE, STATE: STATE, TIMING: TIMING, MATERIAL: MATERIAL, CSS: CSS,
      MIN_SIZE: MIN_SIZE, LOGO_SIZE: LOGO_SIZE, V_PAD: V_PAD, H_PAD: H_PAD, ORB: ORB, GAP: GAP, CLOSE: CLOSE,
      spring: spring, phased: phased, morphKeyframes: morphKeyframes, slideKeyframes: slideKeyframes,
      popKeyframes: popKeyframes,
      ENTER_SEED: ENTER_SEED, ENTER_STRETCH: ENTER_STRETCH,
      geometryFor: geometryFor, normalize: normalize, isActionable: isActionable,
      createMachine: createMachine, createTransport: createTransport, readAppearance: readAppearance,
      FISH_LOGO_PATH: FISH_LOGO_PATH, FISH_LOGO_VIEWBOX: FISH_LOGO_VIEWBOX, buildBrandMark: buildBrandMark,
    },
  }
})()
