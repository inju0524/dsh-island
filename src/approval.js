/**
 * dsh-island · 操作审批桥（Harness approval/request ↔ 灵动岛确认）
 * ---------------------------------------------------------------------------------------
 * 将工具执行与权限审批（approval/request）接入灵动岛：
 *
 *   1. 使用 { prepend: true } 注册在 approval/request 瀑布前列；
 *   2. 接管时同时调用 next()，灵动岛与 Harness 主界面同时等待，谁先决议谁生效；
 *   3. 岛上呈现 CONFIRM（盾牌）卡片，支持「允许一次」与「拒绝」；
 *   4. 超时或用户收起只是放弃岛上应答，主界面仍可正常处理，不阻塞任务流。
 */

import { confirmAction } from './notification.js'

function firstSuccess(promises) {
  return new Promise((resolve, reject) => {
    if (promises.length === 0) {
      reject(new Error('no approval answerer accepted the request'))
      return
    }
    let remaining = promises.length
    for (const promise of promises) {
      promise.then(resolve, (error) => {
        remaining -= 1
        if (remaining === 0) reject(error)
      })
    }
  })
}

export function createApprovalBridge({ ctx, store, config }) {
  /** notificationId → 等待句柄。 */
  const waiting = new Map()

  function askApproval(req) {
    const zh = req.displayReason?.zh || req.displayReason?.['zh-CN']
    const message = zh || req.displayReason?.en || req.reason || `即将调用工具：${req.toolName || '未知工具'}`
    const title = req.toolName ? `工具审批：${req.toolName}` : '操作审批确认'

    const actions = [
      { id: 'opt-allow', label: '允许一次', style: 'primary', value: 'allowed-once' },
      { id: 'opt-reject', label: '拒绝', style: 'danger', value: 'rejected' },
    ]

    const notification = store.publish(confirmAction(
      title,
      actions,
      {
        message,
        detail: req.callId ? `调用标识：${req.callId}` : undefined,
        metadata: {
          sessionId: typeof req.agent?.id === 'string' ? req.agent.id : undefined,
          callId: req.callId,
          toolName: req.toolName,
          kind: 'approval',
        },
      },
    ))

    const waitMs = config.get().questionWaitMs
    return new Promise((resolve, reject) => {
      let settled = false
      const signal = req.signal

      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        waiting.delete(notification.id)
      }
      const fail = (error) => {
        if (settled) return
        settled = true
        cleanup()
        store.dismiss(notification.id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const succeed = (decision) => {
        if (settled) return
        settled = true
        cleanup()
        store.dismiss(notification.id)
        resolve(decision)
      }
      const onAbort = () => fail(signal?.reason ?? new Error('the approval request was cancelled'))
      const timer = setTimeout(() => fail(new Error('island approval wait timed out')), waitMs)

      signal?.addEventListener?.('abort', onAbort, { once: true })

      waiting.set(notification.id, {
        succeed,
        fail,
        callId: req.callId,
        toolName: req.toolName,
      })
    })
  }

  async function handler(req, next) {
    const settings = config.get()
    if (!settings.enabled || !settings.interceptApprovals) return next()
    if (req === null || typeof req !== 'object') return next()
    if (req.agent === undefined || req.agent === null) return next()

    const islandDecision = askApproval(req)
    const upstream = next()

    try {
      return await firstSuccess([islandDecision, upstream])
    } finally {
      // 无论哪方先行结算，岛上悬浮卡片均应退场
      for (const [, handle] of [...waiting]) {
        if (handle.callId === req.callId && handle.toolName === req.toolName) {
          handle.fail(new Error('the approval settled elsewhere'))
        }
      }
    }
  }

  return {
    handler,

    /** 判定一次审批：decision 可为 'allowed-once'、'rejected' 或对应 actionId */
    decide(notificationId, decisionOrActionId) {
      const handle = waiting.get(notificationId)
      if (handle === undefined) return { ok: false, error: 'this approval is no longer waiting' }
      let outcome = null
      if (decisionOrActionId === 'allowed-once' || decisionOrActionId === 'opt-allow') {
        outcome = 'allowed-once'
      } else if (decisionOrActionId === 'rejected' || decisionOrActionId === 'opt-reject') {
        outcome = 'rejected'
      }
      if (outcome === null) return { ok: false, error: 'unknown decision' }
      handle.succeed(outcome)
      return { ok: true, decision: outcome }
    },

    abandon(notificationId) {
      const handle = waiting.get(notificationId)
      if (handle === undefined) return { ok: true, already: true }
      handle.fail(new Error('the user dismissed the island approval'))
      return { ok: true }
    },

    stats() {
      return { waiting: waiting.size }
    },

    stop() {
      for (const [, handle] of [...waiting]) {
        try {
          handle.fail(new Error('dsh-island approval bridge was stopped'))
        } catch {}
      }
      waiting.clear()
    },
  }
}
