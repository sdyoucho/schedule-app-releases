const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let tray = null;

// ---------------- 창 상태 저장 (모드 / 위치 / 크기) ----------------
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  const s = Object.assign(loadState(), patch);
  try { fs.writeFileSync(stateFile(), JSON.stringify(s)); } catch {}
  return s;
}

// ---------------- Windows: 바탕화면 고정 (창을 항상 맨 아래로) ----------------
// koffi(N-API, 재빌드 불필요)로 user32.SetWindowPos(HWND_BOTTOM) 호출.
// koffi가 없거나 실패하면 창 스타일(테두리 없음/작업표시줄 숨김)만 적용됩니다.
let SetWindowPos = null;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    SetWindowPos = user32.func(
      'bool __stdcall SetWindowPos(intptr hwnd, intptr hwndAfter, int x, int y, int cx, int cy, uint flags)'
    );
  } catch (e) {
    console.warn('[widget] koffi 로드 실패:', e.message);
  }
}
const HWND_BOTTOM = 1;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;

function sendToBottom(w) {
  if (!SetWindowPos || !w || w.isDestroyed()) return;
  try {
    const buf = w.getNativeWindowHandle();
    const hwnd = buf.length === 8 ? buf.readBigInt64LE(0) : BigInt(buf.readInt32LE(0));
    SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
  } catch {}
}

// ---------------- 창 생성 ----------------
function createWindow() {
  const state = loadState();
  const widget = state.mode === 'widget';
  const bounds = widget ? state.widgetBounds : state.normalBounds;

  win = new BrowserWindow({
    width: bounds?.width || (widget ? 1280 : 1680),
    height: bounds?.height || (widget ? 860 : 1000),
    x: bounds?.x, y: bounds?.y,
    minWidth: 900, minHeight: 640,
    backgroundColor: '#ECECEE',
    autoHideMenuBar: true,
    title: '회사 스케줄 관리',
    frame: !widget,
    skipTaskbar: widget,
    minimizable: !widget,
    maximizable: !widget,
    fullscreenable: !widget,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 위치/크기 저장
  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    const key = loadState().mode === 'widget' ? 'widgetBounds' : 'normalBounds';
    saveState({ [key]: win.getBounds() });
  };
  win.on('moved', persistBounds);
  win.on('resized', persistBounds);

  // 위젯 모드: 항상 바탕화면 레이어(맨 아래)에 고정.
  // 클릭해서 조작해도 다른 창 위로 올라오지 않습니다.
  if (widget) {
    const pin = () => sendToBottom(win);
    win.on('focus', pin);
    win.on('show', pin);
    win.once('ready-to-show', pin);
    setTimeout(pin, 400);
  }

  win.on('closed', () => { win = null; });
}

function toggleWidgetMode() {
  const cur = loadState().mode === 'widget' ? 'widget' : 'normal';
  const next = cur === 'widget' ? 'normal' : 'widget';
  if (win && !win.isDestroyed()) {
    const key = cur === 'widget' ? 'widgetBounds' : 'normalBounds';
    saveState({ [key]: win.getBounds() });
    win.destroy();
  }
  saveState({ mode: next });
  createWindow();
  updateTrayMenu();
  return next;
}

// ---------------- 트레이 (위젯 모드에서 작업표시줄이 숨겨지므로 필수) ----------------
function updateTrayMenu() {
  if (!tray) return;
  const widget = loadState().mode === 'widget';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: widget ? '일반 창으로 전환' : '바탕화면 위젯으로 전환', click: () => toggleWidgetMode() },
    { label: '창 보이기', click: () => { if (win) { win.show(); if (widget) sendToBottom(win); } } },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() }
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('회사 스케줄 관리');
  tray.on('double-click', () => { if (win) win.show(); });
  updateTrayMenu();
}

// ---------------- IPC ----------------
ipcMain.handle('widget:get-mode', () => (loadState().mode === 'widget' ? 'widget' : 'normal'));
ipcMain.handle('widget:toggle', () => toggleWidgetMode());
ipcMain.handle('app:quit', () => app.quit());

// ---------------- 앱 라이프사이클 ----------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    createWindow();
    createTray();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  // 위젯 모드에서는 트레이에 상주. 일반 모드에서는 종료.
  if (loadState().mode !== 'widget' && process.platform !== 'darwin') app.quit();
});
