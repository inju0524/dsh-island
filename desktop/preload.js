/**
 * dsh-island · 桌面悬浮窗 preload
 * ---------------------------------------------------------------------------------------
 * 只暴露两个动作，渲染进程拿不到任何 Node 能力。
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('islandHost', {
  /**
   * 鼠标是否落在灵动岛上；只有这时窗口才接管点击。
   * 窗口本身**常显**（见 main.js 里那段注释），所以这里不需要显隐接口。
   */
  setInteractive: (interactive) => ipcRenderer.send('island:interactive', interactive === true),
  quit: () => ipcRenderer.send('island:quit'),
})
