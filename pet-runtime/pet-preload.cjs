// pet-preload.cjs — 渲染进程与主进程之间唯一的桥。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petBridge', {
  // 手动拖动：CSS -webkit-app-region:drag 会吞掉指针事件，桌宠需要点头部互动，
  // 所以拖动改由主进程按「光标屏幕坐标 - 抓取偏移」逐帧移动窗口。
  startDrag: () => ipcRenderer.send('pet:drag-start'),
  dragMove: () => ipcRenderer.send('pet:drag-move'),
  endDrag: () => ipcRenderer.send('pet:drag-end'),
  // 键盘微调或无鼠标场景。
  moveBy: (dx, dy) => ipcRenderer.send('pet:move-by', Number(dx) || 0, Number(dy) || 0),
  savePosition: () => ipcRenderer.send('pet:save-position'),
  setAlwaysOnTop: (on) => ipcRenderer.send('pet:always-on-top', !!on),
  quit: () => ipcRenderer.send('pet:quit'),
  onState: (handler) => ipcRenderer.on('pet:state', (_event, state) => handler(state)),
  // 全局光标位置（主进程 screen.getCursorScreenPoint 轮询发过来）。
  // 桌宠窗口很小，鼠标大多时候在窗口外，所以必须主进程取坐标，渲染层收不到 mousemove。
  onCursor: (handler) => ipcRenderer.on('pet:cursor', (_event, pt) => handler(pt)),
  onMenu: (handler) => ipcRenderer.on('pet:menu', (_event, payload) => handler(payload)),
});
