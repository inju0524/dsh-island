# 灵动岛 · dsh-island

<p align="center">
  <img src="./icon.svg" width="96" height="96" alt="dsh-island logo" />
</p>

<p align="center">
  <strong>DeepSeek Harness 灵动岛：屏幕顶部中央的 Apple Liquid Glass 液态玻璃悬浮通知与实时交互组件。</strong>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/DSH-Plugin%20Bundle-6366f1.svg" alt="DSH Plugin" /></a>
  <a href="./tests"><img src="https://img.shields.io/badge/Tests-185%20Passed-emerald.svg" alt="Tests: 185 Passed" /></a>
  <img src="https://img.shields.io/badge/Design-iOS%2027%20Liquid%20Glass-f43f5e.svg" alt="Liquid Glass" />
</p>

---

## 一、概述与核心特性

给 **DeepSeek Harness** 装上专属于桌面的 **Apple Dynamic Island + Liquid Glass（次世代液态玻璃）** 悬浮通知与交互总线。

- **独立置顶全局悬浮窗**：贴齐屏幕顶部居中，Harness 窗口最小化、最大化或全屏切换均不影响它；平时保持优雅内敛的最小圆（DeepSeek 官方鲸鱼 Logo），无侵入感常驻；
- **实时会话流视窗（Live Activity Stream）**：当后台会话正在执行时，轻点灵动岛即可丝滑展开宽幅面板，**实时流式呈现模型的深度思考（Reasoning / CoT）、流式输出 Token、正在调度的工具与毫秒级计时**；
- **高危操作审批（Approval Bridge）**：无缝打通 Harness `'approval/request'` 瀑布事件，遇到工具调用或危险命令审批时直接在岛上一键「允许一次」或「拒绝」；
- **人机交互方案选择（ACTION_REQUIRED）**：在灵动岛上以触感胶囊直接点选决策，答案即刻送回 Harness 并继续执行任务；
- **iPhone 原生级触觉形变物理学**：
  - **触点光晕定位**：手指/光标按下瞬间，靠近触碰接触点原位绽放高透聚光束，精准锁定无漂移；
  - **原生弹性微放大**：按下瞬间产生 `scale(1.3)` 饱满微膨胀，松手利落复位；
  - **极坐标连续超椭圆阻尼**：各向同性流体张力，彻底消除传统方形死角，横向拉伸延展、垂直向下重力水滴垂拉，松手伴随果冻反冲微振颤；
- **4 套 iOS 27 / visionOS 液态玻璃材质**：深空曜石（Midnight）、超白水晶（Pure Crystal）、极光幻彩（Nebula Aurora）、微晶雾面（Frosted Obsidian）；
- **纯数学程序化触感微音效**：基于 Web Audio API 实时演算晶体水滴涌现与收缩滑音，**零音频文件、零网络延迟、零磁盘开销**；
- **调参毫秒级实时热联动预览**：设置页拖动滑杆时，50ms 内热广播至桌面悬浮窗，所见即所得。

---

## 二、效果预览

### 1. 实时会话流视窗（Live Activity Stream）
会话进行中轻点展开，思考过程、输出文本与工具调度实时跟随滚屏：
<p align="center">
  <img src="./assets/screenshot-stream.png" width="620" alt="实时会话流视窗" />
</p>

### 2. 高危操作审批卡片（Approval Bridge）
工具调用或提权操作即刻在岛上呈现盾牌安全卡片，支持一键决策：
<p align="center">
  <img src="./assets/screenshot-approval.png" width="480" alt="操作审批确认卡片" />
</p>

### 3. 按压触点局部光晕与原生放大（Touch-Down Feedback）
光标触点原位绽放微晶高光，继承 `scale(1.3)` 弹性放大与极坐标流体拉伸：
<p align="center">
  <img src="./assets/screenshot-pressed.png" width="340" alt="触点光晕与按压放大" />
</p>

---

## 三、系统架构

```
                       ┌──────────────────── Host 进程（Node） ────────────────────┐
  Harness 事件  ──▶  src/watcher.js   （事件层：状态流/会话流捕获 → Notification）
                       │
  user-questions ──▶  src/questions.js（交互层：提问瀑布 prepend + 岛上等待 + 答案回传）
  approval/req   ──▶  src/approval.js （审批层：工具权限瀑布 prepend + 允许/拒绝决议）
                       │
                       ├──▶ src/notification.js （消息层：模型 + 可扩展类型注册表）
                       ├──▶ src/store.js        （状态层：盖章/环形历史/待处理集合/订阅/唤醒）
                       ├──▶ src/config.js       （配置层：三层合并 + 实时预览广播 + 自动落盘）
                       ├──▶ src/desktop.js      （窗口层：启动器供给 + 进程生命周期 + 启停开关）
                       └──▶ src/routes.js       （传输层：/api/dsh-island/*，含 UI 与流端点）
                       └──────────────────────────────────────────────────────────┘
                                     │  HTTP（长轮询 + 实时流端点）
                                     ▼
                       独立 Electron 桌面悬浮窗（desktop/main.js 创建窗口）
                                     │
                        ui/window.html 加载 ui/island.js
```

### 关键架构保障（踩过的坑与已解决的机制）
1. **独立 Electron 运行时复用**：Host 运行于 Node 环境，不具备窗口能力。插件就地提取 Harness 自带的 Electron 二进制文件，另起独立进程管理常驻悬浮窗；
2. **窗口常显与穿透锁**：为防止 Chromium 将隐藏窗口当成后台标签页挂起节流，悬浮窗在物理上**始终常显（全透明）**，依靠 `setIgnoreMouseEvents` 实现像素级点击穿透；当鼠标处于按压拖拽时锁定接管，**100% 杜绝松手事件被操作系统偷走**；
3. **极坐标连续超椭圆阻尼**：消除传统直角长方形死角，全 360° 弧形位移严格控制在水平 $\pm 9\text{px}$、垂直 $+10\text{px}$ 内，各向同性连续拉伸；
4. **实时会话流防顶飞约束**：流视窗顶部 Header 采用硬性 Flex 锚定，超长思考链与代码块在独立内部视窗内平滑滚动，顶栏 UI 控件绝对不被顶飞。

---

## 四、形态与参数配置

在 **设置 → 灵动岛** 调整任何滑杆或开关，灵动岛均会在 **50ms 内即时响应**，无需保存即可对照微调：

| 配置项 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `desktopWindow` | `true` | 开 / 关 | **桌面悬浮窗总开关**：关掉后彻底关闭 Electron 悬浮窗进程 |
| `enabled` | `true` | 开 / 关 | **功能总开关**：关闭后不再监听任务事件与产生通知 |
| `persistent` | `true` | 开 / 关 | **常驻屏幕**：开启时闲置状态保持最小正圆，关闭时完全滑出屏幕 |
| `minSize` | **`30`** | 26 – 56 px | **最小圆直径**：Logo 与内部光环等比自动归心缩放 |
| `maxWidth` | **`460`** | 280 – 900 px | **展开最大宽度**：卡片与实时流面板的横向最大尺寸 |
| `textScale` | **`1.0`** | 0.8 – 1.35 | **文字大小倍率**：标题、正文、选项文字等比缩放，卡片尺寸自适应重测 |
| `durationScale` | **`1.2`** | 0.4 – 3.0 | **动画时长倍率**：形变、位移与收缩节奏舒缓度 |
| `bounce` | **`0.62`** | 0 – 1.0 | **弹性强度**：默认保持 Apple 干净落点，推满产生鲜明果冻感 |
| `materialTheme` | **`auto`** | 下拉预设 | **材质预设**：`auto` (跟随系统) / `midnight` (深空曜石) / `pure-crystal` (超白水晶) / `aurora` (极光幻彩) / `frosted` (微晶雾面) |
| `sound` | **`true`** | 开 / 关 | **触感音效**：弹出、展开、收起时由 Web Audio 纯数学合成微滴轻触音 |
| `soundVolume` | **`0.6`** | 0 – 100% | **音效音量** |
| `interceptQuestions` | **`true`** | 开 / 关 | **方案选择接管**：在灵动岛上直接点击选项答复任务 |
| `interceptApprovals` | **`true`** | 开 / 关 | **操作审批接管**：高危工具调用直接在岛上一键「允许一次」或「拒绝」 |
| `notifyOnTaskStart` | `false` | 开 / 关 | **任务开始提示**：每轮任务启动时是否展示「任务执行中」 |

---

## 五、安装与部署

### 方式 A：通过 DeepSeek Harness 插件管理器（推荐）
在 Harness 会话中调用 `plugin_manager` 安装即可：
```javascript
// 安装 bundle
await plugin_manager({ action: 'install_bundle', target: 'dsh-island' })
```

### 方式 B：手动挂载开发
1. 将本仓库 clone 到本地；
2. 确保 `package.json` 中的 `dsh.bundle.patch` 正确挂载 `cordis.patch.yml`；
3. 重启一次 DeepSeek Harness，插件将自动供给运行时并启动灵动岛置顶悬浮窗。

---

## 六、验证与测试体系

本项目包含 **185 项离线自动化测试** 以及基于真实 Electron 运行时的 **CDP 逐帧渲染探针**：

```powershell
# 运行全部离线单元测试（185 项全部通过）
npm test

# 分别运行核心与 Host 自检
node tests/selftest.mjs        # 92 项：运动曲线 profile、极坐标连续形变、材质光谱、CONFIRM 审批动作、倒计时重激活等
node tests/host-selftest.mjs   # 93 项：实时流事件捕获、操作审批瀑布桥接、状态仓库合并、会话生命周期释放等
```

### CDP 真机探针说明（位于 `_selftest/`）
- `island-layout-probe.mjs`：形变过程中文字不重排（scrollWidth 恒定）、上下不滑动；
- `island-enter-probe.mjs`：弹出全程高宽比 = 1.000 正圆、停顿符合配置；
- `island-answer-probe.mjs`：作答后走 COLLAPSING 收缩动画，文字被外壳自然裁切而非闪烁消失。

---

## 七、开源许可证

本项目采用 [MIT License](./LICENSE) 授权许可。
Copyright (c) 2026 inju0524 (Yin Shaokai).
