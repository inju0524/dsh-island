/**
 * dsh-island · ACTION_REQUIRED 桥（Harness 提问 ↔ 灵动岛选择）
 * ---------------------------------------------------------------------------------------
 * 这是本插件唯一一处「强介入」Harness 的地方，所以策略上刻意保守：
 *
 *   1. 用 `{ prepend: true }` 注册在 `user-questions/request` 瀑布的最前面。
 *      （`dsh-api-remotes` 把这条瀑布转发给浏览器，它本身不带 prepend，所以我们稳定在前。）
 *   2. 只接管「单个问题 + 有选项」这种真正的「选择方案」形态；
 *      多问题、自由文本、无选项一律 `next()` 交回自带界面。
 *   3. 接管时**同时**调用 `next()`，让 Harness 自带的问题界面照常出现。
 *      两边谁先给出答案谁生效——岛上答了就用岛上的，用户在主界面答了就用主界面的。
 *      这样即使灵动岛不可见（窗口最小化等），用户也不会被卡住。
 *   4. 岛上的等待有独立超时；超时/被关闭只是退出竞争，不打断自带界面。
 *
 * 因此：不存在「伪造 API」，也不存在把用户锁死的路径。
 */

import { actionRequired } from './notification.js'

/** 只接管这种形态：单问题、单选、带选项。多选交回自带界面（需要复选框与确认按钮）。 */
function pickQuestion(request, maxOptions) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  if (questions.length !== 1) return null
  const question = questions[0]
  if (question === null || typeof question !== 'object') return null
  if (question.multiSelect === true) return null
  const options = Array.isArray(question.options) ? question.options : []
  if (options.length === 0) return null
  if (typeof question.id !== 'string' || question.id === '') return null
  return {
    id: question.id,
    question: typeof question.question === 'string' ? question.question : '请选择',
    detail: typeof question.detail === 'string' ? question.detail : undefined,
    header: typeof question.header === 'string' ? question.header : undefined,
    multiSelect: false,
    approve: question.intent?.kind === 'plan-review' ? question.intent.approve : undefined,
    options: options
      .filter((option) => option !== null && typeof option === 'object' && typeof option.label === 'string')
      .slice(0, maxOptions)
      .map((option) => ({
        label: option.label,
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
      })),
  }
}

/** 第一个成功的答案胜出；全部失败才失败。 */
function firstSuccess(promises) {
  return new Promise((resolve, reject) => {
    if (promises.length === 0) {
      reject(new Error('no answerer accepted the request'))
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

export function createQuestionBridge({ ctx, store, config }) {
  /** notificationId → 等待句柄。 */
  const waiting = new Map()

  /**
   * 把一次 Harness 提问发布到灵动岛，并返回「岛上给出的答案」这个 Promise。
   * 岛上答了 → resolve；超时 / 被收起 / 请求被取消 → reject（随后由自带界面接手）。
   */
  function askIsland(request, question) {
    const planReview = question.approve !== undefined
    const actions = question.options.map((option, index) => ({
      id: `opt-${index}`,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
      style: planReview && option.label === question.approve ? 'primary' : 'default',
      value: option.label,
    }))

    const notification = store.publish(actionRequired(
      question.header !== undefined && question.header !== ''
        ? question.header
        : (planReview ? '请确认执行方案' : '需要你选择方案'),
      actions,
      {
        message: question.question,
        ...(question.detail === undefined ? {} : { detail: question.detail }),
        metadata: {
          sessionId: typeof request.agent?.id === 'string' ? request.agent.id : undefined,
          callId: request.wait?.callId,
          questionId: question.id,
          planReview,
          timed: request.wait?.timed === true,
          kind: 'question',
        },
      },
    ))

    const waitMs = config.get().questionWaitMs
    return new Promise((resolve, reject) => {
      let settled = false
      const signal = request.signal

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
      const succeed = (label) => {
        if (settled) return
        settled = true
        cleanup()
        store.dismiss(notification.id)
        resolve({ answers: [{ id: question.id, selected: [label] }] })
      }
      const onAbort = () => fail(signal?.reason ?? new Error('the question was cancelled'))
      const timer = setTimeout(() => fail(new Error('island question wait timed out')), waitMs)

      signal?.addEventListener?.('abort', onAbort, { once: true })

      waiting.set(notification.id, {
        succeed,
        fail,
        questionId: question.id,
        options: question.options.map((option) => option.label),
      })
    })
  }

  /**
   * 瀑布监听体。`prepend: true` 由 index.js 传入。
   * 返回值就是 `AskUserQuestionAnswer`；`next()` 表示交回下游（自带界面）。
   */
  async function handler(request, next) {
    const settings = config.get()
    if (!settings.enabled || !settings.interceptQuestions) return next()
    if (request === null || typeof request !== 'object') return next()
    if (request.agent === undefined || request.agent === null) return next()

    const question = pickQuestion(request, settings.maxOptions)
    if (question === null) return next()

    const islandAnswer = askIsland(request, question)
    const upstream = next()

    try {
      return await firstSuccess([islandAnswer, upstream])
    } finally {
      // 无论谁赢，岛上那张卡片都不该继续挂着。
      for (const [id, handle] of [...waiting]) {
        if (handle.questionId === question.id) handle.fail(new Error('the question settled elsewhere'))
      }
    }
  }

  return {
    handler,

    /** HTTP 路由调用：用户在岛上点了某个选项。 */
    answer(notificationId, actionId) {
      const handle = waiting.get(notificationId)
      if (handle === undefined) return { ok: false, error: 'this question is no longer waiting' }
      let label
      if (typeof actionId === 'string' && actionId.startsWith('opt-')) {
        const index = Number.parseInt(actionId.slice(4), 10)
        label = Number.isInteger(index) ? handle.options[index] : undefined
      }
      if (typeof label !== 'string') label = actionId
      if (typeof label !== 'string' || label === '') return { ok: false, error: 'unknown option' }
      handle.succeed(label)
      return { ok: true, selected: label }
    },

    /** HTTP 路由调用：用户把卡片划走 / 点了关闭。 */
    abandon(notificationId) {
      const handle = waiting.get(notificationId)
      if (handle === undefined) return { ok: true, already: true }
      handle.fail(new Error('the user dismissed the island question'))
      return { ok: true }
    },

    /** 诊断用。 */
    stats() {
      return { waiting: waiting.size }
    },

    /** 插件卸载或停止时清理所有等待句柄。 */
    stop() {
      for (const [, handle] of [...waiting]) {
        try {
          handle.fail(new Error('dsh-island bridge was stopped'))
        } catch {
          /* 忽略已结算句柄 */
        }
      }
      waiting.clear()
    },
  }
}
