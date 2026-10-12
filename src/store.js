/**
 * dsh-island · 状态管理层（消息仓库 + 订阅中心）
 * ---------------------------------------------------------------------------------------
 * 职责：
 *   1. 给每条 Notification 盖章（单调递增的 seq + 稳定 id），推进环形历史；
 *   2. 维护「当前仍待用户处理」的集合（长轮询回执用它告诉浏览器哪些卡片该收回）；
 *   3. 提供订阅：HTTP 长轮询挂在这上面，与传输方式完全解耦——
 *      将来换成 SSE、WebSocket，或者换成一个真正的桌面悬浮窗进程，都不用改这一层。
 *
 * 本文件不认识任何 Harness 概念，也不认识 DOM。
 */

import { createNotification, priorityOf } from './notification.js'

export function createStore(config) {
  /** 环形历史，按 seq 升序。 */
  let history = []
  /** 仍待用户处理的 id 集合。 */
  const pending = new Set()
  let seq = 0
  const subscribers = new Set()

  const size = () => Math.max(10, config.get().historySize)

  const wake = () => {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber()
      } catch {
        /* 一个订阅者出错不影响其它订阅者 */
      }
    }
  }

  const trim = () => {
    const limit = size()
    if (history.length > limit) history = history.slice(history.length - limit)
  }

  /** 同 key 的旧消息在合并窗口内被新消息取代（避免任务抖动刷屏）；进行中的任务（PROGRESS）不受时间窗口限制。 */
  const coalesce = (notification) => {
    const window = config.get().coalesceWindowMs
    const key = notification.metadata?.coalesceKey
    if (typeof key !== 'string' || key === '') return null
    for (let i = history.length - 1; i >= 0; i--) {
      const item = history[i]
      if (item.metadata?.coalesceKey === key) {
        if (item.type === 'PROGRESS' || (window > 0 && notification.createdAt - item.createdAt <= window)) {
          return item
        }
      }
      if (window > 0 && notification.createdAt - item.createdAt > window && item.type !== 'PROGRESS') {
        break
      }
    }
    return null
  }

  return {
    /**
     * 发布一条消息。
     * @param draft - Notification 草稿（见 notification.js）。
     * @returns 盖章后的完整 Notification。
     */
    publish(draft) {
      const now = Date.now()
      const nextSeq = ++seq
      const notification = createNotification(draft, { seq: nextSeq, now })

      const replaced = coalesce(notification)
      if (replaced !== null) {
        // 原地替换：保留 id 让 UI 做「内容更新」而不是「重新弹一条」。
        const index = history.indexOf(replaced)
        const updated = { ...notification, id: replaced.id }
        history[index] = updated
        if (updated.requiresAction) pending.add(updated.id)
        else pending.delete(updated.id)
        trim()
        wake()
        return updated
      }

      history.push(notification)
      if (notification.requiresAction) pending.add(notification.id)
      trim()
      wake()
      return notification
    },

    /** 局部更新（例如把 PROGRESS 改成 SUCCESS）。 */
    update(id, patch) {
      const index = history.findIndex((item) => item.id === id)
      if (index === -1) return null
      const merged = { ...history[index], ...patch, id }
      history[index] = merged
      if (merged.requiresAction) pending.add(id)
      else pending.delete(id)
      wake()
      return merged
    },

    /** 收起一条消息（用户点了、或 Host 侧判定问题已结束）。 */
    dismiss(id) {
      pending.delete(id)
      const index = history.findIndex((item) => item.id === id)
      if (index !== -1) history.splice(index, 1)
      wake()
      return true
    },

    dismissAll() {
      pending.clear()
      history = []
      wake()
    },

    /** 取当前状态快照，供长轮询 / 首次握手使用。 */
    snapshot(since) {
      const current = seq
      const from = Number.isFinite(since) ? Math.max(0, Math.trunc(since)) : null
      const fresh = from === null
        ? history.slice(-3)
        : history.filter((item) => item.seq > from)
      return {
        seq: current,
        notifications: fresh.map((item) => ({ ...item })),
        pendingIds: [...pending],
      }
    },

    /** 按优先级排序的待处理队列（供 UI 决定「下一条显示谁」）。 */
    queued() {
      return history
        .filter((item) => pending.has(item.id))
        .sort((a, b) => priorityOf(b) - priorityOf(a) || a.seq - b.seq)
        .map((item) => ({ ...item }))
    },

    subscribe(listener) {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },

    /**
     * 主动唤醒所有挂着的长轮询（不新增消息）。
     * 用途：窗口模式（窗口内 / 桌面窗）变化时必须**立刻**送达两个宿主 ——
     * 长轮询在等待新消息时是挂住的，模式变化不会自己唤醒它，
     * 只会在下一条消息或 20 秒超时后才送达（表现为「最小化后有时立刻出现、有时十几秒没有」）。
     */
    notify: wake,

    /** 供调试 / 设置页显示。 */
    stats() {
      return { seq, history: history.length, pending: pending.size, subscribers: subscribers.size }
    },
  }
}
