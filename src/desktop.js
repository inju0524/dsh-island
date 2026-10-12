/**
 * dsh-island · 桌面悬浮窗的供给与生命周期
 * ---------------------------------------------------------------------------------------
 * 目标：Harness 窗口最小化时，灵动岛依然留在屏幕顶部中央提醒用户。
 *
 * 为什么必须另起一个 Electron 进程（而不是像别的插件那样开个 BrowserWindow）：
 *   · Host 半身跑在 `ELECTRON_RUN_AS_NODE=1` 起的独立 Node 进程里，没有 Electron API；
 *   · Electron 主进程（app.asar/lib/main.js）对插件只开放了设备信息 / 更新 / 快捷键 /
 *     `dshPlatform.open('usage'|'top-up')`，**没有任何创建窗口的通道**。
 * 所以这里复用 Harness 自带的 Electron 运行时，另起一个进程跑我们自己的 app：
 *
 *   <DSH_HOME>/dsh-island/desktop-runtime/
 *     DeepSeek Harness.exe      ← 硬链接（同卷，0 额外磁盘）
 *     *.dll / *.pak / *.dat ... ← 硬链接
 *     locales/                  ← 目录联接
 *     resources/app/            ← desktop/{main.js,preload.js,package.json}
 *
 * 实测确认过的三个关键点：
 *   1. Electron 只认 `resources/app.asar`；本机实测把我们的目录作为 argv[1] 传进去最稳。
 *   2. 子进程会继承 `ELECTRON_RUN_AS_NODE=1`，必须显式删除，否则 Electron 以 Node 模式
 *      启动、`require('electron')` 直接报 MODULE_NOT_FOUND。
 *   3. `transparent: true` + `win.setBackgroundMaterial('acrylic')` 同时拿到
 *      胶囊形状（CSS 圆角 + 逐像素 alpha）与真实的桌面模糊；
 *      只靠 CSS `backdrop-filter` 在独立窗口里采样不到窗口后面的桌面。
 */

import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome } from './config.js'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const DESKTOP_SOURCE = join(PACKAGE_DIR, 'desktop')

/** 启动器目录。 */
export function runtimeDir() {
  return join(dshHome(), 'dsh-island', 'desktop-runtime')
}

/**
 * 这个目录看起来是不是一份 Electron 发行版。
 * 只认「同目录下同时有 resources.pak 和 icudtl.dat」——
 * 这是 Electron 发行版独有的，`node.exe` 所在目录不会有。
 * （不加这个校验的话，在纯 Node 里跑自检时 process.execPath 就是 node.exe，
 *   供给出来的启动器会直接以 Node 模式启动、静默退出。）
 */
function looksLikeElectron(dir) {
  try {
    return existsSync(join(dir, 'resources.pak')) && existsSync(join(dir, 'icudtl.dat'))
  } catch {
    return false
  }
}

/** Harness 自带的 Electron 可执行文件。 */
function electronExecutable() {
  const candidates = [
    process.env.DSH_DESKTOP_NODE_EXECUTABLE,
    process.execPath,
  ].filter((value) => typeof value === 'string' && value.trim() !== '')
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue
      if (!looksLikeElectron(dirname(candidate))) continue
      return candidate
    } catch {
      /* 继续试下一个 */
    }
  }
  return null
}

function stampOf(exePath) {
  try {
    const stat = statSync(exePath)
    // 除了运行时本身，还要把我们的 desktop/ 源码算进去：
    // 否则插件升级后启动器目录会一直命中缓存，跑的还是旧 main.js。
    const app = readdirSync(DESKTOP_SOURCE)
      .sort()
      .map((name) => {
        try {
          const info = statSync(join(DESKTOP_SOURCE, name))
          return `${name}:${info.size}:${Math.round(info.mtimeMs)}`
        } catch {
          return `${name}:?`
        }
      })
      .join(',')
    return `${exePath}|${stat.size}|${Math.round(stat.mtimeMs)}|${app}`
  } catch {
    return null
  }
}

function readStamp(file) {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed?.stamp === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 清空启动器目录。
 * ---------------------------------------------------------------------------------------
 * 不能用 `rmSync(dir, {recursive:true})`：目录里有 `locales` **目录联接**，
 * Node 的递归删除会在 junction 上抛 EPERM（实测把整个重建流程打死，
 * 于是桌面窗再也起不来）。所以这里自己走一遍：junction 用 rmdir（只摘链接、不动目标），
 * 普通目录递归删，文件 unlink；任何一项被占用就跳过，让后面的「原地覆盖」接手。
 */
function clearRuntimeDir(dir) {
  if (!existsSync(dir)) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const target = join(dir, entry.name)
    try {
      if (entry.isSymbolicLink()) rmdirSync(target)
      else if (entry.isDirectory()) rmSync(target, { recursive: true, force: true })
      else unlinkSync(target)
    } catch {
      /* 被占用：留着，后面原地覆盖 */
    }
  }
  try {
    rmdirSync(dir)
  } catch {
    /* 还有残留也无所谓 */
  }
}

/** 把运行时文件硬链接进启动器目录（同卷 → 0 额外磁盘）。 */
function linkRuntime(installDir, dir) {
  for (const entry of readdirSync(installDir, { withFileTypes: true })) {
    if (entry.name === 'resources') continue
    if (entry.name.startsWith('Uninstall')) continue
    const from = join(installDir, entry.name)
    const to = join(dir, entry.name)
    if (existsSync(to)) continue
    try {
      if (entry.isDirectory()) {
        // locales/ 之类：目录联接
        symlinkSync(from, to, 'junction')
        continue
      }
      if (!entry.isFile()) continue
      try {
        linkSync(from, to)
      } catch {
        // 某些文件系统不支持硬链接；退化成复制
        writeFileSync(to, readFileSync(from))
      }
    } catch {
      /* 单项失败不影响其它 */
    }
  }
}

/** 把 desktop/ 下的 Electron app 写进启动器目录。 */
function writeApp(appDir) {
  mkdirSync(appDir, { recursive: true })
  for (const name of readdirSync(DESKTOP_SOURCE)) {
    if (!name.endsWith('.js') && name !== 'package.json') continue
    writeFileSync(join(appDir, name), readFileSync(join(DESKTOP_SOURCE, name)))
  }
}

/**
 * 建立（或刷新）启动器目录。
 * ---------------------------------------------------------------------------------------
 * 幂等，而且**默认走「原地刷新」而不是整目录重建**：
 *   · 运行时没变（绝大多数情况：只是插件升级）→ 只重写 resources/app 下的几个文件，
 *     完全不删目录 —— 不怕文件被占用，也不怕 junction；
 *   · 运行时变了（Harness 升级）→ 才重建目录，且删不掉的部分会原地覆盖。
 * @returns `{ ok, appDir, exe, reason }`
 */
export function provisionRuntime() {
  const exe = electronExecutable()
  if (exe === null) {
    return { ok: false, reason: '找不到 Harness 自带的 Electron 运行时（需要 resources.pak + icudtl.dat 同目录）' }
  }

  const installDir = dirname(exe)
  const dir = runtimeDir()
  const appDir = join(dir, 'resources', 'app')
  const stampFile = join(dir, 'stamp.json')
  const stamp = stampOf(exe)
  const launcherExe = join(dir, basenameOf(exe))

  const existing = readStamp(stampFile)
  const runtimeMatches = existing !== null && existing.stamp === stamp && existsSync(launcherExe)

  try {
    if (runtimeMatches) {
      // 快路径：只刷新我们自己的 app 文件。
      writeApp(appDir)
      writeStamp(stampFile, stamp, exe, existing)
      return { ok: true, appDir, exe: launcherExe, reason: 'app-refreshed' }
    }

    clearRuntimeDir(dir)
    mkdirSync(dir, { recursive: true })
    linkRuntime(installDir, dir)
    writeApp(appDir)
    // 运行时兜底 app：Electron 找不到 app.asar 时不会静默退出。
    const defaultApp = join(installDir, 'resources', 'default_app.asar')
    if (existsSync(defaultApp) && !existsSync(join(dir, 'resources', 'default_app.asar'))) {
      try {
        linkSync(defaultApp, join(dir, 'resources', 'default_app.asar'))
      } catch {
        /* 没有也无所谓 */
      }
    }
    writeStamp(stampFile, stamp, exe, null)
    return { ok: true, appDir, exe: launcherExe, reason: 'provisioned' }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function writeStamp(stampFile, stamp, exe, previous) {
  const previousStamp = previous === null ? stamp : previous.stamp
  try {
    writeFileSync(stampFile, JSON.stringify({ stamp, exe, at: Date.now(), previousStamp }, null, 2), 'utf8')
  } catch {
    /* 写不了也无所谓，下次重建 */
  }
}

function basenameOf(path) {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index === -1 ? path : path.slice(index + 1)
}

/**
 * 桌面悬浮窗的进程生命周期。
 * @param deps - `{ log }`（可选）
 */
export function createDesktopWindow(deps = {}) {
  let child = null
  let started = false
  let lastError = null
  let provisioned = null

  const log = (message) => {
    try {
      deps.log?.(message)
    } catch {
      /* 日志失败无所谓 */
    }
  }

  const alive = () => child !== null && child.exitCode === null && child.signalCode === null

  return {
    get running() {
      return alive()
    },
    get status() {
      return {
        running: alive(),
        pid: alive() ? child.pid : null,
        provisioned: provisioned === null ? null : { ok: provisioned.ok, appDir: provisioned.appDir ?? null, reason: provisioned.reason },
        lastError,
      }
    },

    /** 按需启动。重复调用是幂等的。 */
    start(pageUrl) {
      if (alive()) return { ok: true, pid: child.pid }
      provisioned = provisionRuntime()
      if (provisioned.ok !== true) {
        lastError = provisioned.reason
        log(`desktop window unavailable: ${provisioned.reason}`)
        return { ok: false, error: provisioned.reason }
      }

      // ⚠ 关键：删掉继承来的 ELECTRON_RUN_AS_NODE，否则 Electron 会以 Node 模式启动。
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_FORCE_IS_PACKAGED

      try {
        child = spawn(provisioned.exe, [provisioned.appDir, pageUrl], {
          env,
          detached: false,
          stdio: 'ignore',
          windowsHide: true,
        })
        started = true
        lastError = null
        child.on('exit', (code) => {
          log(`desktop window exited with code ${String(code)}`)
          child = null
        })
        child.on('error', (error) => {
          lastError = error.message
          log(`desktop window failed: ${error.message}`)
          child = null
        })
        return { ok: true, pid: child.pid }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        log(`desktop window spawn failed: ${lastError}`)
        child = null
        return { ok: false, error: lastError }
      }
    },

    /** 已经启动过就不要再反复冷启动；这里只用于诊断。 */
    get everStarted() {
      return started
    },

    stop() {
      if (!alive()) return
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      child = null
    },
  }
}

/**
 * 桌面悬浮窗的启停开关。
 * ---------------------------------------------------------------------------------------
 * 灵动岛**只有这一种形态**：屏幕顶部居中、永远置顶的独立窗口，跟 Harness 窗口状态无关。
 * 所以这里没有「模式仲裁」——只判断配置要不要它，要就拉起来（没有就冷启动），不要就停掉。
 *
 * 冷启动一个 Electron 要 1~2 秒，所以插件挂载时就会预热它（见 index.js 里的首次 sync），
 * 而不是等第一条消息到了才起。
 */
export function createPresence({ config, desktop, pageUrl, log }) {
  let lastShouldRun = null
  let lastSyncError = null

  function shouldRun() {
    const settings = config.get()
    return settings.enabled === true && settings.desktopWindow === true
  }

  /** 把「该不该跑」落到进程上。配置变化后调用即可。 */
  function sync() {
    const next = shouldRun()
    if (next === lastShouldRun) return next
    lastShouldRun = next
    if (next === true) {
      log?.('island → 启动桌面悬浮窗')
      const result = desktop.start(pageUrl())
      if (result.ok !== true) lastSyncError = result.error
    } else {
      log?.('island → 停止桌面悬浮窗')
      desktop.stop()
    }
    return next
  }

  /**
   * 看门狗。
   * ---------------------------------------------------------------------------------------
   * 没有它的话，桌面窗进程一旦意外退出就**再也回不来** —— sync() 只在收到 HTTP 请求
   * （/stream、/config、/demo）时被调用，而那些请求本身要靠灵动岛存在才有。
   * 实测就撞上过：手动杀掉进程后 running=false 一直挂着，直到有人访问一次 /config。
   * 每 20 秒对一下状态，代价可以忽略。
   */
  const watchdog = setInterval(() => {
    if (desktop.running !== shouldRun()) {
      lastShouldRun = null
      try {
        sync()
      } catch (error) {
        lastSyncError = error instanceof Error ? error.message : String(error)
      }
    }
  }, 20000)
  if (typeof watchdog.unref === 'function') watchdog.unref()

  return {
    shouldRun,
    sync,
    stop() {
      clearInterval(watchdog)
    },
    status() {
      return { shouldRun: shouldRun(), lastSyncError, desktop: desktop.status }
    },
  }
}

export { resolve as resolvePath }
