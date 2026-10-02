const path = require('node:path');
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell } = require('electron');

let mainWindow;
let scheduleWindow;
let tray;
let trayMenuKey;
let lastWidgetBounds = null;
let lastScheduleBounds = null;
const pinned = { widget: false, schedule: false };
let interactivePanel = null;
let capturedPanel = null;
let interactionTimer = null;
let isQuitting = false;
let locale = 'zh-CN';
let windowsShown = true;
const readyPanels = new Set();
const failedPanels = new Set();
const panels = ['widget', 'schedule'];
const nativeHitTesting = process.platform === 'win32';
const inputRegions = new WeakMap();
const windowsDesktop = nativeHitTesting ? require('./windows-desktop.cjs') : null;
let desktopTimer = null;
let stopDesktopWatch = null;
let desktopActive = false;
let modalPanel = null;

const trayText = {
  'zh-CN': { show: '显示主线 · 支线', hide: '隐藏窗口', quit: '退出' },
  en: { show: 'Show Main · Side', hide: 'Hide window', quit: 'Quit' },
  ja: { show: 'メイン・サブを表示', hide: 'ウィンドウを非表示', quit: '終了' },
  ko: { show: '메인 · 보조 표시', hide: '창 숨기기', quit: '종료' },
  'zh-TW': { show: '顯示主線 · 支線', hide: '隱藏視窗', quit: '結束' },
};

function updateTrayMenu() {
  if (!tray) return;
  const visible = isVisible(mainWindow) || isVisible(scheduleWindow);
  const key = `${locale}:${visible}`;
  if (key === trayMenuKey) return;
  trayMenuKey = key;
  const text = trayText[locale] || trayText['zh-CN'];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? text.hide : text.show, click: toggleWindow },
    { type: 'separator' },
    { label: text.quit, click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.setToolTip(text.show);
}

function showWindow() {
  windowsShown = true;
  for (const panel of failedPanels) {
    const win = panelWindow(panel);
    if (win && !win.isDestroyed()) {
      failedPanels.delete(panel);
      win.webContents.reload();
    }
  }
  syncWindowVisibility();
  if (isVisible(mainWindow)) mainWindow.focus();
  if (nativeHitTesting) {
    syncDesktopStacking();
    const modal = panelWindow(modalPanel);
    if (isVisible(modal)) modal.moveTop();
  }
}

function toggleWindow() {
  if (isVisible(mainWindow) || isVisible(scheduleWindow)) hideWindows();
  else showWindow();
}

function hideWindows() {
  windowsShown = false;
  syncWindowVisibility();
}

function isVisible(win) {
  return !!win && !win.isDestroyed() && win.isVisible();
}

function panelStackingOrder() {
  return lastWidgetBounds?.modal ? ['schedule', 'widget'] : panels;
}

function syncWindowVisibility() {
  for (const panel of panelStackingOrder()) {
    const win = panelWindow(panel);
    if (!win || win.isDestroyed() || !readyPanels.has(panel)) continue;
    const visible = windowsShown && (panel === 'widget' || lastScheduleBounds?.visible);
    if (visible && !win.isVisible()) win.showInactive();
    else if (!visible && win.isVisible()) win.hide();
  }
  updateWindowState();
}

function updateWindowState() {
  if (!isVisible(panelWindow(capturedPanel))) capturedPanel = null;
  const visible = !isQuitting && (isVisible(mainWindow) || isVisible(scheduleWindow));
  if (visible && !nativeHitTesting && interactionTimer === null) interactionTimer = setInterval(routePointerToPanel, 16);
  else if (!visible && interactionTimer !== null) {
    clearInterval(interactionTimer);
    interactionTimer = null;
  }
  const watchDesktop = nativeHitTesting && !isQuitting && windowsShown &&
    (readyPanels.has('widget') || (readyPanels.has('schedule') && lastScheduleBounds?.visible));
  if (watchDesktop && desktopTimer === null) {
    stopDesktopWatch = windowsDesktop.watchChanges(syncDesktopStacking);
    // Native events handle normal desktop transitions immediately. Poll only
    // as a recovery fallback, or at the old rate if hooks are unavailable.
    desktopTimer = setInterval(syncDesktopStacking, stopDesktopWatch ? 1000 : 250);
    syncDesktopStacking();
  }
  else if (!watchDesktop && desktopTimer !== null) {
    clearInterval(desktopTimer);
    desktopTimer = null;
    stopDesktopWatch?.();
    stopDesktopWatch = null;
    desktopActive = false;
  }
  updateTrayMenu();
  routePointerToPanel();
}

function nativePanelHandles() {
  return panels.map(panelWindow).filter(win => win && !win.isDestroyed()).map(win => win.getNativeWindowHandle());
}

function syncDesktopStacking() {
  if (isQuitting || !windowsShown) return;
  const context = windowsDesktop.foregroundContext(nativePanelHandles());
  // Retain the previous state during the brief NULL foreground in activation.
  if (context !== null) desktopActive = context === 'desktop' || context === 'panel';
  syncNativeTopmost();
  const hidden = context === 'desktop' && panels.some((panel) => {
    const win = panelWindow(panel);
    return win && !win.isDestroyed() && readyPanels.has(panel) &&
      (panel === 'widget' || lastScheduleBounds?.visible) && !win.isVisible();
  });
  if (hidden) syncWindowVisibility();
}

function syncNativeTopmost() {
  let raised = false;
  for (const panel of panelStackingOrder()) {
    const win = panelWindow(panel);
    if (!win || win.isDestroyed()) continue;
    const modalBoost = modalPanel === panel && panels.some(name => name !== panel && pinned[name] && isVisible(panelWindow(name)));
    const wanted = pinned[panel] || (windowsShown && isVisible(win) && (desktopActive || modalBoost));
    const handle = win.getNativeWindowHandle();
    if (win.isAlwaysOnTop() === wanted && windowsDesktop.isTopmost(handle) === wanted) continue;
    win.setAlwaysOnTop(wanted, 'pop-up-menu');
    const actual = windowsDesktop.ensureTopmost(handle, wanted);
    raised ||= wanted && actual;
    if (!wanted) windowsDesktop.placeBelowForeground(handle, nativePanelHandles());
  }
  const modal = panelWindow(modalPanel);
  if (raised && isVisible(modal) && modal.isAlwaysOnTop()) modal.moveTop();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  tray = new Tray(icon);
  tray.on('click', toggleWindow);
  tray.on('right-click', () => tray.popUpContextMenu());
  updateTrayMenu();
}

function panelWindow(panel) {
  return panel === 'widget' ? mainWindow : panel === 'schedule' ? scheduleWindow : null;
}

function ownsEvent(event, panel) {
  return (panel ? [panel] : panels).some((name) => {
    const contents = panelWindow(name)?.webContents;
    return contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame;
  });
}

function startupOptions() {
  const options = { path: process.execPath };
  if (process.platform === 'win32' && !app.isPackaged) options.args = [`"${app.getAppPath()}"`];
  return options;
}

function containsPoint(bounds, point) {
  if (!bounds || bounds.visible === false) return false;
  if (bounds.modal) return true;
  const within = (rect) => rect && point.x >= rect.left && point.x <= rect.left + rect.width &&
    point.y >= rect.top && point.y <= rect.top + rect.height;
  return within(bounds) || (bounds.extraRects || []).some(within);
}

function setInteractivePanel(panel) {
  if (panel === interactivePanel) return;
  for (const name of panels) {
    const win = panelWindow(name);
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(name !== panel, { forward: true });
  }
  interactivePanel = panel;
  const active = panelWindow(panel);
  if (active && !active.isDestroyed() && active.isVisible()) active.showInactive();
}

function routePointerToPanel() {
  if (nativeHitTesting) {
    updateInputRegions();
    return;
  }
  if (isQuitting || (!isVisible(mainWindow) && !isVisible(scheduleWindow))) {
    setInteractivePanel(null);
    return;
  }
  if (capturedPanel && isVisible(panelWindow(capturedPanel))) {
    setInteractivePanel(capturedPanel);
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const bounds = { widget: lastWidgetBounds, schedule: lastScheduleBounds };
  // Modals own the whole surface; otherwise respect each panel's topmost band.
  const order = lastWidgetBounds?.modal && isVisible(mainWindow) ? ['widget', 'schedule'] :
    lastScheduleBounds?.modal && isVisible(scheduleWindow) ? ['schedule', 'widget'] :
    pinned.widget && !pinned.schedule ? ['widget', 'schedule'] : ['schedule', 'widget'];
  const panel = order.find((name) => {
    const win = panelWindow(name);
    if (!isVisible(win)) return false;
    const origin = win.getBounds();
    return containsPoint(bounds[name], { x: cursor.x - origin.x, y: cursor.y - origin.y });
  });
  setInteractivePanel(panel || null);
}

function updateInputRegions() {
  const bounds = { widget: lastWidgetBounds, schedule: lastScheduleBounds };
  const modal = panels.find((name) => bounds[name]?.modal && isVisible(panelWindow(name))) || null;
  if (modal !== modalPanel) {
    modalPanel = modal;
    syncNativeTopmost();
    if (modal) panelWindow(modal).moveTop();
  }
  else syncNativeTopmost();
  const owner = capturedPanel || modal;
  const repaint = [];
  for (const panel of panels) {
    const win = panelWindow(panel);
    if (!win || win.isDestroyed()) continue;
    const box = bounds[panel];
    const enabled = !isQuitting && isVisible(win) && !!box && box.visible !== false && (!owner || owner === panel);
    // Windows routes the very first click using this native region, without
    // waiting for a cursor poll. A small edge keeps resize handles reachable
    // without letting a wide transparent shadow block the other panel.
    // A docked sibling follows through asynchronous renderer IPC. Keep both
    // surfaces unclipped during capture so its previous region cannot cut off
    // the new frame; the non-owner still ignores mouse input below.
    const shape = box && !box.modal && !capturedPanel ? [box, ...box.extraRects].map((rect) => ({
      x: Math.floor(rect.left) - 4,
      y: Math.floor(rect.top) - 4,
      width: Math.ceil(rect.left + rect.width) - Math.floor(rect.left) + 8,
      height: Math.ceil(rect.top + rect.height) - Math.floor(rect.top) + 8,
    })) : [];
    const key = JSON.stringify(shape);
    const previous = inputRegions.get(win);
    if (previous?.shape !== key) win.setShape(shape);
    if (previous?.enabled !== enabled) win.setIgnoreMouseEvents(!enabled, { forward: true });
    inputRegions.set(win, { shape: key, enabled });
    if (previous?.enabled === false && enabled) repaint.push(win);
  }
  // Restoring mouse input removes WS_EX_LAYERED on Windows. Repaint after
  // both surfaces have their final styles and regions, even if bounds match.
  for (const win of repaint) {
    if (windowsShown && isVisible(win)) win.webContents.invalidate();
  }
}

function sanitizePanelBounds(bounds) {
  if (!bounds || !['left', 'top', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))) return null;
  const rects = Array.isArray(bounds.extraRects) ? bounds.extraRects
    .filter((rect) => rect && ['left', 'top', 'width', 'height'].every((key) => Number.isFinite(rect[key])))
    .slice(0, 4)
    .map(({ left, top, width, height }) => ({ left, top, width: Math.max(0, width), height: Math.max(0, height) })) : [];
  return {
    left: bounds.left,
    top: bounds.top,
    width: Math.max(0, bounds.width),
    height: Math.max(0, bounds.height),
    visible: bounds.visible !== false,
    modal: !!bounds.modal,
    extraRects: rects,
  };
}

function createWindow(panel) {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
  const win = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    title: panel === 'widget' ? 'Main · Side' : 'Weekly Schedule',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (panel === 'widget') mainWindow = win;
  else scheduleWindow = win;
  win.setIgnoreMouseEvents(true, { forward: true });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  // App renderers keep their preload bridge only on the bundled page.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('did-start-loading', () => {
    if (capturedPanel === panel) capturedPanel = null;
    if (panel === 'widget') lastWidgetBounds = null;
    else lastScheduleBounds = null;
    routePointerToPanel();
  });
  win.webContents.on('did-finish-load', () => {
    readyPanels.add(panel);
    failedPanels.delete(panel);
    if (panel === 'schedule' && lastWidgetBounds) win.webContents.send('desktop:widget-bounds', lastWidgetBounds);
    syncWindowVisibility();
  });
  win.webContents.on('render-process-gone', () => {
    if (isQuitting || win.isDestroyed()) return;
    readyPanels.delete(panel);
    failedPanels.add(panel);
    if (capturedPanel === panel) capturedPanel = null;
    if (panel === 'widget') lastWidgetBounds = null;
    else lastScheduleBounds = null;
    win.setIgnoreMouseEvents(true, { forward: true });
    win.hide();
    updateWindowState();
  });
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideWindows();
    }
  });
  win.on('closed', () => {
    if (panel === 'widget') mainWindow = null;
    else scheduleWindow = null;
    if (panel === 'widget') lastWidgetBounds = null;
    else lastScheduleBounds = null;
    if (interactivePanel === panel) interactivePanel = null;
    if (capturedPanel === panel) capturedPanel = null;
    readyPanels.delete(panel);
    failedPanels.delete(panel);
    pinned[panel] = false;
    updateWindowState();
  });
  win.on('show', updateWindowState);
  win.on('hide', updateWindowState);
  if (nativeHitTesting) win.on('minimize', syncWindowVisibility);
  win.loadFile(path.join(__dirname, 'index.html'), { query: { panel } });
}

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) app.quit();
else {
  app.on('second-instance', showWindow);

  ipcMain.handle('desktop:set-pin', (event, panel, enabled) => {
    const win = panelWindow(panel);
    if (!ownsEvent(event) || !win || win.isDestroyed()) return { ...pinned };
    if (nativeHitTesting) {
      // User Pin is independent of the temporary desktop/modal topmost band.
      pinned[panel] = !!enabled;
      syncNativeTopmost();
      if (enabled && !windowsDesktop.isTopmost(win.getNativeWindowHandle())) pinned[panel] = false;
    } else {
      win.setAlwaysOnTop(!!enabled, 'floating');
      pinned[panel] = win.isAlwaysOnTop();
    }
    // Re-stack each transparent panel after removing its topmost band without taking focus.
    if (!nativeHitTesting && !pinned[panel] && win.isVisible()) win.showInactive();
    routePointerToPanel();
    return { ...pinned };
  });
  ipcMain.handle('desktop:get-pins', () => ({ ...pinned }));
  ipcMain.on('desktop:set-course-enabled', (event, enabled) => {
    if (!ownsEvent(event, 'widget')) return;
    const target = scheduleWindow?.webContents;
    if (target && !target.isDestroyed() && target !== event.sender) target.send('desktop:course-enabled', !!enabled);
  });
  ipcMain.on('desktop:pointer-capture', (event, captured) => {
    const panel = panels.find((name) => ownsEvent(event, name));
    if (!panel) return;
    if (captured) capturedPanel = panel;
    else if (capturedPanel === panel) capturedPanel = null;
    routePointerToPanel();
  });
  ipcMain.on('desktop:report-widget-bounds', (event, bounds) => {
    if (!ownsEvent(event, 'widget')) return;
    const next = sanitizePanelBounds(bounds);
    if (!next || JSON.stringify(next) === JSON.stringify(lastWidgetBounds)) return;
    lastWidgetBounds = next;
    if (scheduleWindow && !scheduleWindow.isDestroyed()) scheduleWindow.webContents.send('desktop:widget-bounds', next);
    routePointerToPanel();
  });
  ipcMain.on('desktop:report-schedule-bounds', (event, bounds) => {
    if (!ownsEvent(event, 'schedule')) return;
    const next = sanitizePanelBounds(bounds);
    if (!next || JSON.stringify(next) === JSON.stringify(lastScheduleBounds)) return;
    lastScheduleBounds = next;
    syncWindowVisibility();
  });
  ipcMain.handle('desktop:get-widget-bounds', () => lastWidgetBounds);
  ipcMain.handle('desktop:get-startup', () => app.getLoginItemSettings(startupOptions()).openAtLogin);
  ipcMain.handle('desktop:set-startup', (event, enabled) => {
    const options = startupOptions();
    if (ownsEvent(event)) app.setLoginItemSettings({ ...options, openAtLogin: !!enabled });
    return app.getLoginItemSettings(options).openAtLogin;
  });
  ipcMain.on('desktop:set-locale', (event, value) => {
    if (!ownsEvent(event) || !Object.hasOwn(trayText, value) || value === locale) return;
    locale = value;
    updateTrayMenu();
  });

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  app.whenReady().then(() => {
    app.setAppUserModelId('com.lllleolin.taskboard');
    if (process.platform === 'darwin') app.dock?.hide();
    createTray();
    createWindow('widget');
    createWindow('schedule');
    const fitWindowsToDisplay = () => {
      const bounds = screen.getPrimaryDisplay().bounds;
      for (const panel of panels) {
        const win = panelWindow(panel);
        if (win && !win.isDestroyed()) win.setBounds(bounds);
      }
      routePointerToPanel();
    };
    screen.on('display-metrics-changed', fitWindowsToDisplay);
    screen.on('display-added', fitWindowsToDisplay);
    screen.on('display-removed', fitWindowsToDisplay);
    app.on('activate', showWindow);
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (interactionTimer !== null) clearInterval(interactionTimer);
    interactionTimer = null;
    if (desktopTimer !== null) clearInterval(desktopTimer);
    desktopTimer = null;
    stopDesktopWatch?.();
    stopDesktopWatch = null;
  });
  app.on('window-all-closed', () => {});
}
