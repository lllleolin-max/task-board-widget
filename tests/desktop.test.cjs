const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const rect = (left = 10, top = 10, width = 100, height = 100, other = {}) => ({ left, top, width, height, ...other });
const plain = (value) => JSON.parse(JSON.stringify(value));

async function desktop({ lock = true, platform = 'win32', packaged = true, floatingPinFails = false } = {}) {
  const windows = [], trays = [], intervals = new Map(), handlers = new Map(), opened = [];
  let nextTimer = 0, cursor = { x: 30, y: 30 }, cursorReads = 0;
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = {}; this.messages = []; }
    isDestroyed() { return false; }
    send(channel, value) { this.messages.push([channel, plain(value)]); }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.visible = false; this.destroyed = false; this.webContents = new Contents(); this.mouseChanges = 0; windows.push(this);
    }
    loadFile(file, { query }) { this.file = file; this.panel = query.panel; this.webContents.emit('did-start-loading'); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    showInactive() { this.raised = (this.raised || 0) + 1; if (!this.visible) { this.visible = true; this.emit('show'); } }
    hide() { if (this.visible) { this.visible = false; this.emit('hide'); } }
    focus() { this.focused = true; }
    getBounds() { return this.bounds; }
    setBounds(value) { this.bounds = { ...value }; }
    setIgnoreMouseEvents(ignore) { this.ignoreMouse = ignore; this.mouseChanges++; }
    setAlwaysOnTop(value, level) { this.pinned = value && !(floatingPinFails && level === 'floating'); this.level = level; }
    isAlwaysOnTop() { return !!this.pinned; }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault() { prevented = true; } });
      if (!prevented) { this.destroyed = true; this.visible = false; this.emit('closed'); }
      return prevented;
    }
  }
  class Tray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; trays.push(this); }
    setContextMenu(menu) { this.menu = menu; }
    setToolTip(text) { this.tooltip = text; }
    popUpContextMenu() { this.popup = true; }
  }
  const app = Object.assign(new EventEmitter(), {
    name: 'Taskboard', quits: 0, login: false, isPackaged: packaged,
    getAppPath: () => 'D:/My Apps/Taskboard',
    requestSingleInstanceLock: () => lock,
    whenReady: () => Promise.resolve(),
    quit() { this.quits++; this.emit('before-quit'); },
    setAppUserModelId(id) { this.appId = id; },
    getLoginItemSettings(options) { this.readLoginOptions = options; return { openAtLogin: this.login }; },
    setLoginItemSettings(value) { this.loginOptions = value; this.login = value.openAtLogin; },
    dock: { hide() { app.dockHidden = true; } },
  });
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => display,
    getCursorScreenPoint: () => { cursorReads++; return cursor; },
  });
  const Menu = { buildFromTemplate: (value) => value, setApplicationMenu(value) { this.application = value; } };
  const electron = { app, BrowserWindow: Window, ipcMain, Menu, Tray, screen,
    nativeImage: { createFromPath: (value) => value },
    shell: { openExternal: (url) => { opened.push(url); return Promise.resolve(); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8'), {
    require: (name) => name === 'electron' ? electron : require(name),
    __dirname: root, process: { platform, execPath: 'C:/Taskboard/Taskboard.exe' },
    setInterval: (callback, delay) => { intervals.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearInterval: (id) => intervals.delete(id),
  }, { filename: 'main.cjs' });
  await Promise.resolve();
  const event = (panel = 'widget') => {
    const sender = windows.find((win) => win.panel === panel)?.webContents;
    return { sender, senderFrame: sender?.mainFrame };
  };
  const send = (channel, ...args) => ipcMain.emit(`desktop:${channel}`, event(channel === 'report-schedule-bounds' ? 'schedule' : 'widget'), ...args);
  return { app, windows, trays, intervals, handlers, ipcMain, event, send, screen, display, opened, Menu,
    readCount: () => cursorReads,
    cursor: (x, y) => { cursor = { x, y }; for (const timer of intervals.values()) timer.callback(); },
    load: () => windows.forEach((win) => win.webContents.emit('did-finish-load')),
    invoke: (channel, ...args) => handlers.get(`desktop:${channel}`)(event(), ...args),
  };
}

test('creates two sandboxed transparent panels, starting polling only when a panel is shown', async () => {
  const env = await desktop();
  assert.equal(env.windows.length, 2);
  assert.equal(env.intervals.size, 0);
  for (const win of env.windows) {
    assert.equal(win.options.transparent, true);
    assert.equal(win.options.webPreferences.contextIsolation, true);
    assert.equal(win.options.webPreferences.nodeIntegration, false);
    assert.equal(win.options.webPreferences.sandbox, true);
    assert.equal(win.ignoreMouse, true);
  }
  env.load();
  assert.equal(env.windows[0].visible, true);
  assert.equal(env.windows[1].visible, false, 'disabled schedule has no visible native window');
  assert.deepEqual([...env.intervals.values()].map((timer) => timer.delay), [16]);
});

test('routes normal, overlapping, modal and pinned regions, leaving the desktop clickable elsewhere', async () => {
  const env = await desktop(); env.load();
  const [widget, schedule] = env.windows;
  env.send('report-widget-bounds', rect());
  env.send('report-schedule-bounds', rect(80, 80));
  env.cursor(30, 30);
  assert.equal(widget.ignoreMouse, false); assert.equal(schedule.ignoreMouse, true);
  env.cursor(100, 100);
  assert.equal(widget.ignoreMouse, true); assert.equal(schedule.ignoreMouse, false);
  env.send('report-widget-bounds', rect(10, 10, 100, 100, { modal: true }));
  assert.equal(widget.ignoreMouse, false); assert.equal(schedule.ignoreMouse, true, 'widget modal owns overlap');
  env.cursor(600, 600); assert.equal(widget.ignoreMouse, false, 'modal scrim captures outside card');
  env.send('report-widget-bounds', rect());
  env.cursor(100, 100);
  assert.deepEqual(plain(env.invoke('set-pin', 'widget', true)), { widget: true, schedule: false });
  assert.equal(widget.pinned, true); assert.equal(widget.level, 'floating');
  assert.equal(widget.ignoreMouse, false);
  env.send('report-schedule-bounds', rect(80, 80, 100, 100, { modal: true }));
  assert.equal(schedule.ignoreMouse, false, 'schedule modal owns overlap even with pinned widget');
  env.send('report-schedule-bounds', rect(80, 80));
  env.invoke('set-pin', 'widget', false);
  assert.equal(schedule.ignoreMouse, false);
  env.cursor(600, 600);
  assert.equal(widget.ignoreMouse, true); assert.equal(schedule.ignoreMouse, true);
});

test('DOM pointer capture keeps a drag in its panel until released, and resets on hide or reload', async () => {
  const env = await desktop(); env.load();
  const [widget, schedule] = env.windows;
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(80, 80));
  env.send('pointer-capture', true); env.cursor(160, 160);
  assert.equal(widget.ignoreMouse, false); assert.equal(schedule.ignoreMouse, true);
  env.ipcMain.emit('desktop:pointer-capture', env.event('schedule'), false);
  env.cursor(500, 500); assert.equal(widget.ignoreMouse, false, 'other panel cannot release capture');
  env.send('pointer-capture', false); env.cursor(160, 160);
  assert.equal(schedule.ignoreMouse, false);
  env.send('pointer-capture', true); env.trays[0].emit('click'); env.trays[0].emit('click');
  assert.equal(schedule.ignoreMouse, false, 'hidden capture does not stick after restoring');
  env.send('pointer-capture', true); widget.webContents.emit('did-start-loading');
  assert.equal(schedule.ignoreMouse, false);
});

test('Windows pinning recovers when the floating level silently loses native topmost state', async () => {
  const env = await desktop({ floatingPinFails: true }); env.load();
  assert.deepEqual(plain(env.invoke('set-pin', 'widget', true)), { widget: true, schedule: false });
  assert.equal(env.windows[0].level, 'pop-up-menu');
  assert.equal(env.windows[0].isAlwaysOnTop(), true);
  assert.deepEqual(plain(env.invoke('set-pin', 'widget', false)), { widget: false, schedule: false });
});

test('tray hide stops polling and late page loads/bounds do not reopen hidden windows', async () => {
  const env = await desktop(); env.load();
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(80, 80));
  env.trays[0].emit('click');
  assert.equal(env.intervals.size, 0);
  assert.ok(env.windows.every((win) => !win.visible && win.ignoreMouse));
  const reads = env.readCount();
  env.send('report-schedule-bounds', rect(100, 100)); env.load();
  assert.equal(env.readCount(), reads); assert.ok(env.windows.every((win) => !win.visible));
  env.app.emit('second-instance');
  assert.ok(env.windows.every((win) => win.visible));
  assert.equal(env.windows[0].focused, true); assert.equal(env.intervals.size, 1);
});

test('schedule enable/disable propagates to its renderer and hides only its native window', async () => {
  const env = await desktop(); env.load();
  env.send('set-course-enabled', true);
  assert.deepEqual(env.windows[1].webContents.messages.at(-1), ['desktop:course-enabled', true]);
  env.send('report-schedule-bounds', rect()); assert.equal(env.windows[1].visible, true);
  env.send('report-schedule-bounds', rect(0, 0, 0, 0, { visible: false }));
  assert.equal(env.windows[1].visible, false); assert.equal(env.windows[0].visible, true);
  env.trays[0].emit('click'); env.trays[0].emit('click');
  assert.equal(env.windows[1].visible, false, 'restoring does not resurrect a disabled schedule');
});

test('bounds are authenticated, sanitized and deduplicated; draft extra regions remain interactive', async () => {
  const env = await desktop(); env.load();
  const bounds = rect(10, 10, 100, 100, { injected: 'drop', extraRects: [rect(300, 300), rect(0, 0, -10, -20), rect(NaN)] });
  env.send('report-widget-bounds', bounds);
  const saved = plain(env.invoke('get-widget-bounds'));
  assert.equal(saved.injected, undefined); assert.equal(saved.extraRects.length, 2);
  assert.equal(saved.extraRects[1].width, 0); assert.equal(saved.extraRects[1].height, 0);
  assert.deepEqual(env.windows[1].webContents.messages.at(-1), ['desktop:widget-bounds', saved]);
  const count = env.windows[1].webContents.messages.length;
  env.send('report-widget-bounds', bounds);
  env.send('report-widget-bounds', rect(Infinity));
  env.ipcMain.emit('desktop:report-widget-bounds', env.event('schedule'), rect(500, 500));
  env.ipcMain.emit('desktop:report-widget-bounds', { ...env.event(), senderFrame: {} }, rect(500, 500));
  assert.equal(env.windows[1].webContents.messages.length, count);
  assert.deepEqual(plain(env.invoke('get-widget-bounds')), saved);
  env.cursor(350, 350); assert.equal(env.windows[0].ignoreMouse, false);
});

test('unchanged routing does not repeatedly re-stack windows or toggle click-through', async () => {
  const env = await desktop(); env.load(); env.send('report-widget-bounds', rect());
  const win = env.windows[0], changes = win.mouseChanges, raised = win.raised;
  for (let i = 0; i < 50; i++) env.cursor(30, 30);
  assert.equal(win.mouseChanges, changes); assert.equal(win.raised, raised);
});

test('display changes resize both native windows and hit-testing uses their actual screen origin', async () => {
  const env = await desktop(); env.load(); env.send('report-widget-bounds', rect());
  env.display.bounds = { x: -1920, y: 80, width: 1920, height: 1080 };
  env.screen.emit('display-metrics-changed');
  assert.ok(env.windows.every((win) => win.bounds.x === -1920));
  env.cursor(-1890, 110); assert.equal(env.windows[0].ignoreMouse, false);
  env.cursor(30, 30); assert.equal(env.windows[0].ignoreMouse, true);
});

test('startup setting returns the OS result and ignores foreign renderer requests', async () => {
  const env = await desktop();
  assert.equal(env.invoke('get-startup'), false);
  assert.equal(env.invoke('set-startup', true), true);
  assert.deepEqual(plain(env.app.loginOptions), { openAtLogin: true, path: 'C:/Taskboard/Taskboard.exe' });
  env.handlers.get('desktop:set-startup')({ sender: {} }, false);
  assert.equal(env.app.login, true);
  env.app.setLoginItemSettings = () => {};
  assert.equal(env.invoke('set-startup', false), true, 'renderer must receive actual state when OS refuses change');
});

test('tray localizes supported languages and rejects invalid/prototype/foreign values', async () => {
  const env = await desktop(); env.load();
  env.send('set-locale', 'en'); assert.equal(env.trays[0].menu[0].label, 'Hide window');
  env.send('set-locale', '__proto__'); env.send('set-locale', 'unsupported');
  env.ipcMain.emit('desktop:set-locale', { sender: {} }, 'ja');
  assert.equal(env.trays[0].tooltip, 'Show Main · Side');
  env.trays[0].emit('click'); assert.equal(env.trays[0].menu[0].label, 'Show Main · Side');
  env.trays[0].emit('right-click'); assert.equal(env.trays[0].popup, true);
});

test('Windows development autostart includes the project path and reads back matching arguments', async () => {
  const env = await desktop({ packaged: false });
  env.invoke('set-startup', true);
  assert.deepEqual(plain(env.app.loginOptions.args), ['"D:/My Apps/Taskboard"']);
  assert.deepEqual(plain(env.app.readLoginOptions), { path: env.app.loginOptions.path, args: ['"D:/My Apps/Taskboard"'] });
  env.invoke('get-startup');
  assert.deepEqual(plain(env.app.readLoginOptions.args), ['"D:/My Apps/Taskboard"']);
});

test('external links cannot navigate an app renderer and only HTTPS opens externally', async () => {
  const env = await desktop(), contents = env.windows[0].webContents;
  for (const url of ['https://example.com', 'http://example.com', 'file:///tmp/other.html', 'javascript:alert(1)']) {
    assert.equal(contents.openHandler({ url }).action, 'deny');
  }
  assert.deepEqual(env.opened, ['https://example.com']);
  let blocked = false;
  contents.emit('will-navigate', { preventDefault() { blocked = true; } });
  assert.equal(blocked, true);
});

test('close hides panels until explicit quit, then releases windows and stops timers', async () => {
  const env = await desktop(); env.load(); env.send('report-widget-bounds', rect());
  assert.equal(env.windows[0].close(), true); assert.equal(env.intervals.size, 0);
  env.app.emit('activate'); assert.equal(env.windows[0].visible, true);
  env.trays[0].menu[2].click();
  assert.equal(env.app.quits, 1); assert.equal(env.intervals.size, 0);
  assert.equal(env.windows[0].close(), false); assert.equal(env.windows[1].close(), false);
  assert.equal(env.intervals.size, 0);
  assert.deepEqual(plain(env.invoke('get-pins')), { widget: false, schedule: false });
});

test('second instance exits without creating windows, tray, IPC handlers or timers', async () => {
  const env = await desktop({ lock: false });
  assert.equal(env.app.quits, 1); assert.equal(env.windows.length, 0); assert.equal(env.trays.length, 0);
  assert.equal(env.handlers.size, 0); assert.equal(env.intervals.size, 0);
});

test('macOS keeps editing menu roles and hides the Dock icon', async () => {
  const env = await desktop({ platform: 'darwin' });
  assert.equal(env.app.dockHidden, true);
  assert.ok(env.Menu.application.some((menu) => menu.submenu.some((item) => item.role === 'paste')));
});

test('preload exposes narrow IPC methods and removable subscriptions without Electron event objects', () => {
  const ipcRenderer = new EventEmitter(), sent = [], invoked = [], documentEvents = new Map();
  let bridge;
  ipcRenderer.send = (...args) => sent.push(args);
  ipcRenderer.invoke = (...args) => { invoked.push(args); return Promise.resolve(); };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8'), {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'desktopBridge'); bridge = value; } } }),
    document: { addEventListener: (name, callback) => documentEvents.set(name, callback) },
  });
  bridge.setPin('widget', 1); bridge.setStartup(0); bridge.setCourseEnabled(1);
  assert.deepEqual(invoked, [['desktop:set-pin', 'widget', true], ['desktop:set-startup', false]]);
  assert.deepEqual(sent, [['desktop:set-course-enabled', true]]);
  let received;
  const unsubscribe = bridge.onWidgetBounds((...args) => { received = args; });
  ipcRenderer.emit('desktop:widget-bounds', { secret: 'not for the page' }, rect());
  assert.deepEqual(received, [rect()]); unsubscribe();
  assert.equal(ipcRenderer.listenerCount('desktop:widget-bounds'), 0);
  documentEvents.get('gotpointercapture')(); documentEvents.get('lostpointercapture')();
  assert.deepEqual(sent.slice(-2), [['desktop:pointer-capture', true], ['desktop:pointer-capture', false]]);
});
