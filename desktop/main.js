/**
 * dsh-island · 桌面悬浮窗 Electron 主进程
 * =======================================================================================
 * 这个文件**不随插件包安装**，而是由 Host 半身在 Provision 阶段写进一个「启动器目录」：
 *
 *   <DSH_HOME>/dsh-island/desktop-runtime/
 *     DeepSeek Harness.exe      ← 硬链接自 Harness 自带的 Electron 运行时
 *     *.dll / *.pak / *.dat ... ← 同上（硬链接，不占额外磁盘）
 *     locales/                  ← 目录联接
 *     resources/app/            ← 本文件 + preload.js + package.json
 *
 * 为什么这么做：Harness 的 Host 半身跑在一个独立的 Node 进程里（没有 Electron API），
 * Electron 主进程也没有对插件开放任何「创建窗口」的通道。所以在不伪造 API 的前提下，
 * 唯一能做到真·置顶桌面窗口的办法，就是复用 Harness 自带的 Electron 运行时另起一个进程。
 *
 * 关键坑：宿主进程带着 ELECTRON_RUN_AS_NODE=1，子进程会继承它，
 * 于是 Electron 以 Node 模式启动、`require('electron')` 直接失败。
 * 启动器必须显式删掉这个变量（见 src/desktop.js）。
 * =======================================================================================
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron')

/** 窗口比灵动岛本身大一圈，给形变、阴影和展开后的圆角矩形留位置。 */
const WINDOW_WIDTH = 960
const WINDOW_HEIGHT = 380
/** 窗口贴齐屏幕顶端；灵动岛上边缘留白（14px）由渲染层保留，让顶部阴影与高光自然衰减，防止被窗口硬裁切。 */
const SCREEN_TOP_GAP = 0

let win = null

app.setName('dsh-island-window')
// 单实例：重复启动时把请求转交给已有实例，避免叠出两个灵动岛。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win !== null && !win.isDestroyed()) win.showInactive()
  })
  app.whenReady().then(start).catch((error) => {
    console.error('[dsh-island] desktop window failed:', error)
    app.exit(1)
  })
}

/**
 * 规范化 Host 传进来的页面地址。
 * ---------------------------------------------------------------------------------------
 * Host 曾经把地址写成 `/api/dsh-island/window.html`（少了一层 `/ui/`），
 * 结果桌面窗整个窗口显示一页 `{"ok":false,"error":"not found: ..."}`。
 * 宿主那边的拼法已经修好（改成从 routes.js 的 ISLAND_UI_BASE 拼），
 * 但桌面窗这边也做一次自愈：路径以 `/window.html` 结尾却不是 `/ui/window.html` 就补上。
 * 宿主修好之后这里是空操作。
 */
function normalizePageUrl(raw) {
  try {
    const url = new URL(raw)
    if (url.pathname.endsWith('/window.html') && !url.pathname.endsWith('/ui/window.html')) {
      url.pathname = url.pathname.replace(/\/window\.html$/, '/ui/window.html')
    }
    return url.href
  } catch {
    return raw
  }
}

function start() {
  const pageUrl = normalizePageUrl(String(process.argv[2] ?? ''))
  if (!/^https?:\/\//.test(pageUrl)) {
    console.error('[dsh-island] desktop window needs the page URL as its first argument')
    app.exit(2)
    return
  }

  const workArea = screen.getPrimaryDisplay().workArea
  const width = Math.min(WINDOW_WIDTH, workArea.width)
  const x = Math.round(workArea.x + (workArea.width - width) / 2)
  const y = workArea.y + SCREEN_TOP_GAP

  win = new BrowserWindow({
    width,
    height: WINDOW_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: require('node:path').join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  // 关于玻璃：实测下来 **不用** `setBackgroundMaterial('acrylic')`。
  // 系统亚克力只能铺满整个窗口矩形（setShape 硬裁出来的胶囊边缘有锯齿），
  // 一个 920×360 的灰框比没有模糊更难看。所以这里保持完全透明，
  // 由 ui/island.js 用更不透明的液态玻璃配方自己画 —— 这也正是 iPhone 灵动岛的做法
  // （它本体就是不透明深色，因为要压在任意背景上都清晰可读）。

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 默认整窗穿透：只有鼠标真的落在灵动岛上时才接管点击。
  win.setIgnoreMouseEvents(true, { forward: true })

  // 屏幕分辨率或工作区变化时重新居中
  const updatePosition = () => {
    if (win === null || win.isDestroyed()) return
    const primary = screen.getPrimaryDisplay().workArea
    const w = Math.min(WINDOW_WIDTH, primary.width)
    const px = Math.round(primary.x + (primary.width - w) / 2)
    const py = primary.y + SCREEN_TOP_GAP
    win.setBounds({ x: px, y: py, width: w, height: WINDOW_HEIGHT })
  }
  screen.on('display-metrics-changed', updatePosition)

  win.webContents.on('did-fail-load', (_event, errorCode) => {
    if (errorCode === -3) return // ERR_ABORTED
    setTimeout(() => {
      if (win !== null && !win.isDestroyed()) win.loadURL(pageUrl)
    }, 1200)
  })

  win.loadURL(pageUrl)

  // ⚠ 窗口**常显**，不做 hide/show。
  // 踩过的坑：曾经让渲染进程调 win.hide() 来「收起灵动岛」，窗口一藏起来 Chromium 就把它当后台页面
  // 冻结/节流（实测渲染进程 CPU 归零、长轮询彻底停摆），于是它再也收不到「该显示」这条消息 —— 直接死锁。
  // 现在窗口始终存在且可见（完全透明 + 整窗点击穿透，用户看不见也点不到），
  // 由渲染进程用 CSS 决定灵动岛本身显不显示，渲染进程因此永远活着。
  win.once('ready-to-show', () => win.showInactive())
  win.webContents.once('did-finish-load', () => win.showInactive())

  win.on('closed', () => {
    screen.removeListener('display-metrics-changed', updatePosition)
    win = null
    app.quit()
  })
}

/* ------------------------------------------------------------------ 渲染进程 → 主进程 */

ipcMain.on('island:interactive', (_event, interactive) => {
  if (win === null || win.isDestroyed()) return
  win.setIgnoreMouseEvents(interactive !== true, { forward: true })
})

ipcMain.on('island:quit', () => {
  app.quit()
})

app.on('window-all-closed', () => app.quit())
