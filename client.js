/**
 * dsh-island · 浏览器半身
 * =======================================================================================
 * 手写的 ModuleLoader bundle：无构建步骤、无外部依赖，只用 shell 已经提供的 react。
 *
 * 这里**只负责设置页**。灵动岛本体（状态机 / 动画 / 视图）跑在桌面悬浮窗那个独立进程里，
 * 复用 Harness 自带的 Electron 运行时，加载 `/api/dsh-island/ui/island.js`。
 *
 * 曾经还有一份「窗口内叠加层」：挂在 shell.overlay 槽位、只显示在 Harness 窗口内部。
 * 那套要额外维护窗口可见性上报 + 模式切换，而玻璃又折射不出窗口背后的内容
 * （透明窗口里 backdrop-filter 是无效的），效果并不比桌面窗好 —— 已经整体移除。
 * =======================================================================================
 */

window.__ModuleLoader__.load({
  id: 'dsh-island',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    const API = '/api/dsh-island'

    /* ===================================================================================
       设置页
       =================================================================================== */

    const CSS = [
      '.dsh-island-page{display:flex;flex-direction:column;gap:18px;color:var(--dsw-alias-label-primary);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",system-ui,sans-serif;}',
      '.dsh-island-lead{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.75;margin:0;}',
      '.dsh-island-foot{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.7;margin:0;}',
      '.dsh-island-foot code{font-family:ui-monospace,Consolas,"SF Mono",Menlo,monospace;font-size:11px;}',
      '.dsh-island-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,0.06);}',
      '.dsh-island-card>h4{margin:0;padding:11px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);',
      '  font-size:12px;font-weight:600;letter-spacing:.02em;}',
      '.dsh-island-body{padding:6px 16px;}',
      '.dsh-island-row{display:flex;align-items:center;gap:14px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dsh-island-row:first-child{border-top:0;}',
      '.dsh-island-row>.k{flex:0 0 190px;min-width:0;}',
      '.dsh-island-row>.k>b{display:block;font-weight:550;font-size:12.5px;}',
      '.dsh-island-row>.k>i{display:block;font-style:normal;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;line-height:1.5;}',
      '.dsh-island-row>.v{flex:1;min-width:0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.dsh-island-range{-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;',
      '  background:var(--dsw-alias-border-l1);flex:1;min-width:80px;margin:0;}',
      '.dsh-island-range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;',
      '  background:var(--dsw-alias-brand-primary);cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.3);}',
      '.dsh-island-num{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);',
      '  border-radius:6px;color:var(--dsw-alias-label-primary);padding:4px 6px;font:inherit;font-size:12px;',
      '  width:84px;box-sizing:border-box;text-align:right;}',
      '.dsh-island-tag{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:0 0 auto;}',
      '.dsh-island-switch{flex:0 0 auto;width:38px;height:22px;border-radius:11px;border:1px solid var(--dsw-alias-border-l2);',
      '  background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;padding:0;}',
      '.dsh-island-switch>span{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
      // 开关滑块：跟灵动岛本体用同一条 Apple 主 UI 曲线（快起步 + 柔和落点）。
      '  background:var(--dsw-alias-bg-base);box-shadow:0 1px 2px rgba(0,0,0,0.25);transition:left 220ms cubic-bezier(.32,.72,0,1);}',
      '.dsh-island-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
      '.dsh-island-switch[aria-checked="true"]>span{left:18px;}',
      '.dsh-island-actions-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.dsh-island-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);',
      '  color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:12px;cursor:pointer;',
      '  transition:transform 140ms ease, background 140ms ease, border-color 140ms ease;}',
      '.dsh-island-btn:hover{border-color:var(--dsw-alias-brand-primary);transform:translateY(-1px);}',
      '.dsh-island-btn:active{transform:scale(0.97);}',
      '.dsh-island-btn[disabled]{opacity:.5;cursor:default;transform:none;}',
      '.dsh-island-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;box-shadow:0 2px 8px -1px rgba(77,107,254,0.4);}',
      '.dsh-island-sep{width:1px;height:18px;background:var(--dsw-alias-border-l1);}',
      '.dsh-island-status{font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
      '.dsh-island-note{font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);margin:8px 0 0;}',
      '.dsh-island-note b{color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.dsh-island-select{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;',
      '  color:var(--dsw-alias-label-primary);padding:4px 8px;font:inherit;font-size:12px;outline:none;cursor:pointer;}',
    ].join('\n')

    function Style() {
      return h('style', { 'data-dsh-island': 'style' }, CSS)
    }

    function Switch({ checked, onChange, label }) {
      return h('button', {
        type: 'button',
        className: 'dsh-island-switch',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        onClick: () => onChange(checked !== true),
      }, h('span', null))
    }

    function Row({ title, hint, children }) {
      return h('div', { className: 'dsh-island-row' },
        h('div', { className: 'k' }, h('b', null, title), hint === undefined ? null : h('i', null, hint)),
        h('div', { className: 'v' }, children),
      )
    }

    function Slider({ value, min, max, step, onChange, format }) {
      return h(React.Fragment, null,
        h('input', {
          className: 'dsh-island-range', type: 'range', min, max, step, value,
          onChange: (event) => onChange(Number(event.target.value)),
        }),
        h('input', {
          className: 'dsh-island-num', type: 'number', min, max, step, value,
          onChange: (event) => onChange(Number(event.target.value)),
        }),
        format === undefined ? null : h('span', { className: 'dsh-island-tag' }, format(value)),
      )
    }

    function useConfigDraft(runtime) {
      const config = useSyncExternalStore(runtime.subscribeConfig, runtime.getConfig, runtime.getConfig)
      const [draft, setDraft] = useState(config)
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)
      const previewTimerRef = useRef(null)

      useEffect(() => { setDraft(config) }, [config])

      const patch = useCallback((key, value) => {
        setDraft((previous) => {
          const next = { ...previous, [key]: value }
          if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current)
          previewTimerRef.current = setTimeout(() => {
            previewTimerRef.current = null
            runtime.previewConfig({ config: next }).catch(() => {})
            // 若正在调节卡片尺寸、文字缩放、材质或高光，若悬浮窗无消息则联动触发预览方便对照
            if (['maxWidth', 'textScale', 'materialTheme', 'specular', 'bounce', 'sound'].includes(key)) {
              runtime.demo('question').catch(() => {})
            }
          }, 50)
          return next
        })
      }, [runtime])

      const save = useCallback(async () => {
        setBusy(true)
        try {
          const result = await runtime.writeConfig({ config: draft })
          if (result?.ok === true) {
            runtime.applyConfig(result.config)
            setStatus('已保存')
          } else {
            setStatus(`保存失败：${result?.error ?? '未知错误'}`)
          }
        } catch (error) {
          setStatus(`保存失败：${String(error?.message ?? error)}`)
        } finally {
          setBusy(false)
        }
      }, [draft, runtime])

      const reset = useCallback(async () => {
        setBusy(true)
        try {
          const result = await runtime.writeConfig({ reset: true })
          if (result?.ok === true) {
            runtime.applyConfig(result.config)
            setStatus('已恢复出厂默认')
          } else {
            setStatus(`恢复失败：${result?.error ?? '未知错误'}`)
          }
        } catch (error) {
          setStatus(`恢复失败：${String(error?.message ?? error)}`)
        } finally {
          setBusy(false)
        }
      }, [runtime])

      return { draft, patch, save, reset, status, busy }
    }

    function SettingsPage({ runtime }) {
      const { draft, patch, save, reset, status, busy } = useConfigDraft(runtime)
      const [demoStatus, setDemoStatus] = useState('')

      const demo = useCallback(async (kind) => {
        try {
          await runtime.demo(kind)
          setDemoStatus('已发送预览')
        } catch (error) {
          setDemoStatus(`预览失败：${String(error?.message ?? error)}`)
        }
      }, [runtime])

      return h('div', { className: 'dsh-island-page' },
        h('p', { className: 'dsh-island-lead' },
          '灵动岛固定在屏幕顶部中央、永远置顶 —— Harness 窗口最小化、最大化、全屏都不影响它。',
          '没有消息时保持最小圆形（DeepSeek Logo），任务完成 / 执行失败 / 需要选择方案时以液态形变展开；',
          '需要你选择的消息会一直等待，其余消息显示一段时间后自动收缩。'),

        h('div', { className: 'dsh-island-card' },
          h('h4', null, '显示'),
          h('div', { className: 'dsh-island-body' },
            h(Row, {
              title: '桌面悬浮窗',
              hint: '独立置顶窗口（另起一个 Electron 进程），关掉后完全不再出现',
            }, h(Switch, {
              checked: draft.desktopWindow,
              label: '桌面悬浮窗',
              onChange: (v) => patch('desktopWindow', v),
            })),
            h('p', { className: 'dsh-island-note' },
              draft.desktopWindow === true ? '当前：桌面悬浮窗已启用' : '当前：已关闭，不会有任何灵动岛'),
          ),
        ),

        h('div', { className: 'dsh-island-card' },
          h('h4', null, '形态'),
          h('div', { className: 'dsh-island-body' },
            h(Row, { title: '功能总开关', hint: '关闭后不再监听任务事件与产生通知' },
              h(Switch, { checked: draft.enabled, label: '功能总开关', onChange: (v) => patch('enabled', v) })),
            h(Row, {
              title: '常驻屏幕',
              hint: draft.persistent ? '始终显示最小圆形，有消息时自然展开' : '无消息时完全隐藏，有新消息才滑入',
            }, h(Switch, { checked: draft.persistent, label: '常驻屏幕', onChange: (v) => patch('persistent', v) })),
            h(Row, { title: '圆形直径', hint: '最小态那个圆的大小，Logo 会等比跟着缩放' },
              // ?? 30：宿主还没重启时配置里可能没有 minSize（旧版 normalizeConfig 会丢掉未知字段），
              // 没有兜底的话滑杆会拿到 undefined 变成非受控组件。
              h(Slider, { value: draft.minSize ?? 30, min: 26, max: 56, step: 1, onChange: (v) => patch('minSize', v), format: (v) => `${v} px` })),
            // 只有在宿主认识 textScale 时才显示这个滑杆：旧宿主会静默丢掉未知字段，
            // 那样拖了完全没反应 —— 一个假控件比没有控件更糟。
            draft.textScale === undefined ? null : h(Row, { title: '文字大小', hint: '标题 / 正文 / 选项一起缩放，卡片尺寸会跟着重算' },
              h(Slider, { value: draft.textScale, min: 0.8, max: 1.35, step: 0.01, onChange: (v) => patch('textScale', v), format: (v) => `${v.toFixed(2)}×` })),
            h(Row, { title: '展开最大宽度', hint: '圆角矩形形态的上限；内容窄时不会硬撑到这个值' },
              h(Slider, { value: draft.maxWidth, min: 280, max: 760, step: 10, onChange: (v) => patch('maxWidth', v), format: (v) => `${v} px` })),
          ),
        ),

        h('div', { className: 'dsh-island-card' },
          h('h4', null, '液态形变与材质'),
          h('div', { className: 'dsh-island-body' },
            h(Row, { title: '材质风格预设', hint: '定制 Liquid Glass 次时代液态玻璃光泽与基底' },
              h('select', {
                className: 'dsh-island-select',
                value: draft.materialTheme ?? 'auto',
                onChange: (event) => patch('materialTheme', event.target.value),
              },
                h('option', { value: 'auto' }, '跟随系统 (auto)'),
                h('option', { value: 'midnight' }, '深空曜石 (Midnight Crystal)'),
                h('option', { value: 'pure-crystal' }, '超白水晶 (Pure Crystal)'),
                h('option', { value: 'aurora' }, '极光幻彩 (Nebula Aurora)'),
                h('option', { value: 'frosted' }, '微晶雾面 (Frosted Obsidian)'),
              )),
            h(Row, { title: '触感音效', hint: '弹出、展开、收起与点击时合成播放晶莹水滴微音效' },
              h(Switch, { checked: draft.sound ?? true, label: '触感音效', onChange: (v) => patch('sound', v) })),
            draft.sound !== false ? h(Row, { title: '音效音量', hint: '调整水滴与轻触音量' },
              h(Slider, { value: draft.soundVolume ?? 0.6, min: 0.1, max: 1, step: 0.05, onChange: (v) => patch('soundVolume', v), format: (v) => `${Math.round(v * 100)}%` })) : null,
            h(Row, { title: '弹性', hint: '0 = 干脆利落，1 = 明显 Q 弹' },
              h(Slider, { value: draft.bounce, min: 0, max: 1, step: 0.02, onChange: (v) => patch('bounce', v), format: (v) => v.toFixed(2) })),
            h(Row, { title: '横向先行', hint: '越大，宽度越明显领先于高度' },
              h(Slider, { value: draft.liquidLead, min: 0, max: 1, step: 0.02, onChange: (v) => patch('liquidLead', v), format: (v) => v.toFixed(2) })),
            h(Row, { title: '动画速度', hint: '时长倍率：往左更快、往右更慢更从容（形变 / 渐隐 / 图标位移会一起变）' },
              h(Slider, { value: draft.durationScale, min: 0.4, max: 3, step: 0.05, onChange: (v) => patch('durationScale', v), format: (v) => `${v.toFixed(2)}× 时长` })),
            // 只在宿主认识这个字段时才显示，避免出现拖了没反应的假控件。
            draft.settlePauseMs === undefined ? null : h(Row, { title: '弹出后停顿', hint: '仅非常驻模式：小球弹出后停多久才展开（绝对时长，不受「动画速度」影响）' },
              h(Slider, { value: draft.settlePauseMs, min: 0, max: 1200, step: 20, onChange: (v) => patch('settlePauseMs', v), format: (v) => `${v} ms` })),
            h(Row, { title: '镜面高光', hint: '形变过程中的液态高光与微噪点' },
              h(Switch, { checked: draft.specular, label: '镜面高光', onChange: (v) => patch('specular', v) })),
          ),
        ),

        h('div', { className: 'dsh-island-card' },
          h('h4', null, '消息策略'),
          h('div', { className: 'dsh-island-body' },
            h(Row, { title: '自动消失时长倍率', hint: '只影响不需要操作的消息' },
              h(Slider, { value: draft.autoDismissScale, min: 0.4, max: 3, step: 0.1, onChange: (v) => patch('autoDismissScale', v), format: (v) => `${v.toFixed(1)}×` })),
            h(Row, { title: '任务开始也提示', hint: '每轮任务开始时显示一条「执行中」' },
              h(Switch, { checked: draft.notifyOnTaskStart, label: '任务开始也提示', onChange: (v) => patch('notifyOnTaskStart', v) })),
            h(Row, { title: '同会话合并窗口', hint: '窗口内的连续状态变化合并为一条' },
              h(Slider, { value: draft.coalesceWindowMs, min: 0, max: 10000, step: 100, onChange: (v) => patch('coalesceWindowMs', v), format: (v) => `${v} ms` })),
          ),
        ),

        h('div', { className: 'dsh-island-card' },
          h('h4', null, '需要选择方案（ACTION_REQUIRED）'),
          h('div', { className: 'dsh-island-body' },
            h(Row, { title: '在灵动岛上直接选择', hint: '开启后岛与 Harness 自带界面同时可用，谁先答谁生效' },
              h(Switch, { checked: draft.interceptQuestions, label: '在灵动岛上直接选择', onChange: (v) => patch('interceptQuestions', v) })),
            h(Row, { title: '等待上限', hint: '超时后交回自带界面继续等待，不会卡住任务' },
              h(Slider, { value: draft.questionWaitMs, min: 10000, max: 900000, step: 5000, onChange: (v) => patch('questionWaitMs', v), format: (v) => `${Math.round(v / 1000)} s` })),
            h(Row, { title: '最多显示选项数', hint: '超出部分请在主界面选择' },
              h(Slider, { value: draft.maxOptions, min: 1, max: 8, step: 1, onChange: (v) => patch('maxOptions', v), format: (v) => `${v} 个` })),
          ),
        ),

        h('div', { className: 'dsh-island-card' },
          h('h4', null, '操作审批（APPROVAL）'),
          h('div', { className: 'dsh-island-body' },
            h(Row, { title: '在灵动岛上审批操作', hint: '工具调用、高权限操作需确认时直接在岛上一键「允许一次」或「拒绝」' },
              h(Switch, { checked: draft.interceptApprovals ?? true, label: '在灵动岛上审批操作', onChange: (v) => patch('interceptApprovals', v) })),
          ),
        ),

        h('div', { className: 'dsh-island-actions-row' },
          h('button', { type: 'button', className: 'dsh-island-btn primary', disabled: busy, onClick: save }, '保存'),
          h('button', { type: 'button', className: 'dsh-island-btn', disabled: busy, onClick: reset }, '恢复出厂默认'),
          h('span', { className: 'dsh-island-sep' }),
          h('button', { type: 'button', className: 'dsh-island-btn', onClick: () => demo('success') }, '预览成功'),
          h('button', { type: 'button', className: 'dsh-island-btn', onClick: () => demo('error') }, '预览失败'),
          h('button', { type: 'button', className: 'dsh-island-btn', onClick: () => demo('progress') }, '预览进行中'),
          h('button', { type: 'button', className: 'dsh-island-btn', onClick: () => demo('warning') }, '预览警告'),
          h('button', { type: 'button', className: 'dsh-island-btn', onClick: () => demo('question') }, '预览选择方案'),
          h('button', { type: 'button', className: 'dsh-island-btn', onClick: () => demo('approval') }, '预览操作审批'),
          h('button', { type: 'button', className: 'dsh-island-btn', onClick: () => demo('live-stream') }, '预览实时会话流'),
          h('button', { type: 'button', className: 'dsh-island-btn', onClick: () => demo('sequence') }, '连播完整流程'),
          h('span', { className: 'dsh-island-status' }, status === '' ? demoStatus : status),
        ),

        h('p', { className: 'dsh-island-foot' },
          'Host 侧事件：agent/status（任务开始/结束）、agent/error、api-session/error、user-questions/request（选择方案）。',
          '配置写在 ', h('code', null, '<DSH_HOME>/dsh-island/config.json'), '；桌面悬浮窗运行时在 ',
          h('code', null, '<DSH_HOME>/dsh-island/desktop-runtime/'), '。'),
      )
    }

    /** 兜底：任何一个槽位条目渲染抛错，都不该把整个槽位打空。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error, info) {
        console.error('[dsh-island] slot entry crashed', error, info)
      }
      render() {
        if (this.state.error === null) return this.props.children
        if (this.props.verbose === true) {
          return h('div', { className: 'dsh-island-page' },
            h('p', { className: 'dsh-island-lead' },
              '灵动岛设置页渲染失败：',
              String(this.state.error?.message ?? this.state.error)))
        }
        return null
      }
    }

    /* ===================================================================================
       装配
       =================================================================================== */

    const inject = ['slots']

    function apply(ctx) {
      const configCache = { value: null }
      const configListeners = new Set()

      const runtimeFace = {
        getConfig: () => configCache.value ?? {},
        subscribeConfig(listener) {
          configListeners.add(listener)
          return () => configListeners.delete(listener)
        },
        applyConfig(next) {
          if (next === null || typeof next !== 'object') return
          configCache.value = next
          for (const listener of [...configListeners]) listener()
        },
        demo: (kind) => fetch(API + '/demo', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind }),
        }).then((response) => response.json()),
        writeConfig: (body) => fetch(API + '/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then((response) => response.json()),
        previewConfig: (body) => fetch(API + '/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, preview: true }),
        }).then((response) => response.json()),
      }

      // 配置先拉一次，设置页才有初始值。
      fetch(API + '/config', { headers: { accept: 'application/json' }, cache: 'no-store' })
        .then((response) => response.json())
        .then((snapshot) => { if (snapshot?.ok === true) runtimeFace.applyConfig(snapshot.config) })
        .catch(() => {})

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-island',
        order: 56,
        label: () => '灵动岛',
      }, () => h(React.Fragment, null, h(Style, null), h(Boundary, { verbose: true }, h(SettingsPage, { runtime: runtimeFace })))))
    }

    return { name: 'dsh-island', inject, apply }
  },
})
