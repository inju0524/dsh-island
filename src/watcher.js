/**
 * dsh-island · 事件层（Harness 事件 → Notification）
 * ---------------------------------------------------------------------------------------
 * 这是唯一一处「知道 Harness 事件长什么样」的地方。它只做映射，不碰 UI、不碰传输。
 *
 * 已接线的事件（全部来自 cordis_inspect_query 的 Host Event 目录，未使用任何未声明接口）：
 *
 *   agent/status        (emit, agent 作用域)  payload { agent, status: 'idle'|'running' }
 *                       → running：任务开始（可选 PROGRESS）
 *                       → idle   ：本轮结束 → 无错则 SUCCESS
 *
 *   agent/error         (emit, agent 作用域)  payload { agent, turn, step, error }
 *                       → ERROR（带简短失败原因）
 *
 *   api-session/added   (emit)                summary: SessionSummary
 *                       → 只用来记住会话标题，让 SUCCESS/ERROR 有「简短描述」
 *
 *   api-session/error   (emit)                (sessionId, message)
 *                       → ERROR（与 agent/error 用同一个 coalesceKey 合并，不刷屏）
 *
 * 未来要加类型：在这里加一个 ctx.on(...) → store.publish(draft(...))，
 * 并在 notification.js 的 TYPE_REGISTRY 里登记类型即可，UI 不需要改。
 */

import { draft } from './notification.js'

/** 从任意 error 值里抠出一句人能读的短原因。 */
function reasonOf(error, fallback = '执行过程中出现异常') {
  if (error === null || error === undefined) return fallback
  if (typeof error === 'string') return error.trim() === '' ? fallback : error.trim().slice(0, 400)
  if (typeof error === 'object') {
    const message = error.message
    if (typeof message === 'string' && message.trim() !== '') return message.trim().slice(0, 400)
    const code = error.code
    if (typeof code === 'string' && code !== '') return code
  }
  const text = String(error)
  return text === '[object Object]' ? fallback : text.slice(0, 400)
}

export function createWatcher({ ctx, store, config }) {
  /** 每个会话的运行态。插件内存只是派生缓存，真相仍在会话日志里。 */
  const sessions = new Map()
  const disposers = []
  let liveSession = null

  const stateOf = (id) => {
    let state = sessions.get(id)
    if (state === undefined) {
      state = { running: false, errored: false, startedAt: 0, title: undefined }
      sessions.set(id, state)
    }
    return state
  }

  const durationOf = (ms) => Math.round(ms * config.get().autoDismissScale)

  const on = (event, listener) => {
    disposers.push(ctx.on(event, listener))
  }

  /* ------------------------------------------------------------ 会话标题与生命周期 */

  on('api-session/added', (summary) => {
    if (summary === null || typeof summary !== 'object') return
    const id = summary.id ?? summary.sessionId
    if (typeof id !== 'string') return
    const title = typeof summary.title === 'string' && summary.title.trim() !== '' ? summary.title.trim() : undefined
    if (title !== undefined) stateOf(id).title = title
  })

  on('api-session/removed', (sessionId) => {
    if (typeof sessionId === 'string') sessions.delete(sessionId)
  })

  /* ------------------------------------------------------------ 任务开始 / 完成 */

  on('agent/status', (payload) => {
    if (!config.get().enabled) return
    if (payload === null || typeof payload !== 'object') return
    const agent = payload.agent
    const id = typeof agent?.id === 'string' ? agent.id : undefined
    if (id === undefined) return
    const state = stateOf(id)

    if (payload.status === 'running') {
      state.running = true
      state.errored = false
      state.startedAt = Date.now()
      liveSession = {
        id,
        title: state.title || '正在执行任务',
        startedAt: Date.now(),
        text: '',
        reasoning: '',
        currentTool: null,
        tokenCount: 0,
        phase: 'thinking',
      }
      if (config.get().notifyOnTaskStart) {
        store.publish(draft('PROGRESS', '任务执行中', {
          message: state.title,
          duration: null,
          metadata: { sessionId: id, sessionTitle: state.title, coalesceKey: `task:${id}` },
        }))
      }
      return
    }

    if (payload.status !== 'idle') return
    const wasRunning = state.running
    state.running = false
    if (liveSession?.id === id) {
      liveSession = null
    }
    if (!wasRunning) return
    if (state.errored) {
      // 失败已经由 agent/error 报过，这里只负责收尾。
      state.errored = false
      return
    }
    const elapsed = state.startedAt > 0 ? Date.now() - state.startedAt : 0
    state.startedAt = 0
    store.publish(draft('SUCCESS', '任务执行完成', {
      message: state.title,
      duration: durationOf(4200),
      metadata: {
        sessionId: id,
        sessionTitle: state.title,
        elapsedMs: elapsed,
        coalesceKey: `task:${id}`,
      },
    }))
  })

  /* ------------------------------------------------------------ 实时会话流感知 ------------------------------------------------------------ */

  on('agent/assistant-stream', (payload) => {
    if (!config.get().enabled || !liveSession) return
    const agentId = payload?.agent?.id
    if (agentId !== liveSession.id) return
    const frame = payload.frame
    if (!frame) return

    if (frame.type === 'chunk' && frame.chunk) {
      const chunk = frame.chunk
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        liveSession.phase = 'thinking'
        liveSession.reasoning += chunk.text
        if (liveSession.reasoning.length > 2500) liveSession.reasoning = liveSession.reasoning.slice(-2500)
      } else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        liveSession.phase = 'generating'
        liveSession.text += chunk.text
        if (liveSession.text.length > 2500) liveSession.text = liveSession.text.slice(-2500)
      } else if (chunk.type === 'tool-call-delta') {
        liveSession.phase = 'tool'
        if (chunk.name) liveSession.currentTool = chunk.name
      } else if (chunk.type === 'usage' && chunk.usage) {
        liveSession.tokenCount = chunk.usage.outputTokens || chunk.usage.totalTokens || liveSession.tokenCount
      }
    }
  })

  /* ------------------------------------------------------------ 执行失败 */

  on('agent/error', (payload) => {
    if (!config.get().enabled) return
    if (payload === null || typeof payload !== 'object') return
    const agent = payload.agent
    const id = typeof agent?.id === 'string' ? agent.id : undefined
    const state = id === undefined ? undefined : stateOf(id)
    if (state !== undefined) state.errored = true
    store.publish(draft('ERROR', '任务执行失败', {
      message: reasonOf(payload.error),
      duration: durationOf(7600),
      metadata: {
        sessionId: id,
        sessionTitle: state?.title,
        turn: payload.turn,
        step: payload.step,
        reason: reasonOf(payload.error),
        coalesceKey: id === undefined ? undefined : `error:${id}`,
      },
    }))
  })

  on('api-session/error', (sessionId, message) => {
    if (!config.get().enabled) return
    const id = typeof sessionId === 'string' ? sessionId : undefined
    const state = id === undefined ? undefined : stateOf(id)
    if (state !== undefined) state.errored = true
    store.publish(draft('ERROR', '任务执行失败', {
      message: reasonOf(message),
      duration: durationOf(7600),
      metadata: {
        sessionId: id,
        sessionTitle: state?.title,
        reason: reasonOf(message),
        coalesceKey: id === undefined ? undefined : `error:${id}`,
      },
    }))
  })

  /* ------------------------------------------------------------ 账号状态感知 */

  on('deepseek-account/session-expired', () => {
    if (!config.get().enabled) return
    store.publish(draft('WARNING', '账号登录已过期', {
      message: 'DeepSeek 账号会话已失效，请重新登录',
      duration: durationOf(8000),
      metadata: { coalesceKey: 'account:session-expired' },
    }))
  })

  on('deepseek-account/model-sign-in-required', () => {
    if (!config.get().enabled) return
    store.publish(draft('WARNING', '需要登录账号', {
      message: '当前模型请求需要登录 DeepSeek 账号',
      duration: durationOf(8000),
      metadata: { coalesceKey: 'account:sign-in-required' },
    }))
  })

  return {
    start() {
      /* ctx.on 在 apply 里注册，这里保留生命周期钩子以便将来加需要显式启动的订阅。 */
    },
    getLiveSession() {
      if (!liveSession) return null
      return {
        ...liveSession,
        elapsedMs: Date.now() - liveSession.startedAt,
      }
    },
    simulateLiveStream(title = '代码重构与性能优化') {
      const now = Date.now()
      liveSession = {
        id: `sim-${now}`,
        title,
        startedAt: now,
        text: '正在解析依赖拓扑...\n发现 3 处可优化点。\n正在执行流体形变测试与 CDP 探针校验...',
        reasoning: '用户要求展示实时会话流。首先我们需要检查当前任务的进度，并读取模型输出的 token 流。',
        currentTool: 'pwsh',
        tokenCount: 142,
        phase: 'generating',
      }
      setTimeout(() => {
        if (liveSession?.id === `sim-${now}`) {
          liveSession.text += '\n✓ 所有用例校验完毕，已生成完整的优化报告。'
          liveSession.phase = 'completed'
          setTimeout(() => {
            if (liveSession?.id === `sim-${now}`) liveSession = null
          }, 3500)
        }
      }, 5000)
      return liveSession
    },
    stop() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 已经随宿主一起拆掉了 */
        }
      }
      sessions.clear()
      liveSession = null
    },
  }
}
