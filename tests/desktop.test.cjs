const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const rect = (left = 10, top = 10, width = 100, height = 100, other = {}) => ({ left, top, width, height, ...other });
const plain = (value) => JSON.parse(JSON.stringify(value));

async function desktop({ lock = true, platform = 'darwin', packaged = true, floatingPinFails = false } = {}) {
  const windows = [], trays = [], intervals = new Map(), handlers = new Map(), opened = [], covered = new Set();
  let nextTimer = 0, cursor = { x: 30, y: 30 }, cursorReads = 0, desktopForeground = false, topSequence = 0;
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = {}; this.messages = []; }
    isDestroyed() { return false; }
    send(channel, value) { this.messages.push([channel, plain(value)]); }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    reload() { this.reloads = (this.reloads || 0) + 1; this.emit('did-start-loading'); }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.visible = false; this.destroyed = false; this.webContents = new Contents(); this.mouseChanges = 0; windows.push(this);
    }
    loadFile(file, { query }) { this.file = file; this.panel = query.panel; this.webContents.emit('did-start-loading'); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    showInactive() { this.raised = (this.raised || 0) + 1; this.topOrder = ++topSequence; if (!this.visible) { this.visible = true; this.emit('show'); } }
    hide() { if (this.visible) { this.visible = false; this.emit('hide'); } }
    focus() { this.focused = true; }
    moveTop() { this.topMoves = (this.topMoves || 0) + 1; this.topOrder = ++topSequence; covered.delete(this); }
    getNativeWindowHandle() { return this; }
    getBounds() { return this.bounds; }
    setBounds(value) { this.bounds = { ...value }; }
    setIgnoreMouseEvents(ignore) { this.ignoreMouse = ignore; this.mouseChanges++; }
    setShape(rects) { this.shape = plain(rects); this.shapeChanges = (this.shapeChanges || 0) + 1; }
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
    require: (name) => name === 'electron' ? electron : name === './windows-desktop.cjs' ? {
      isDesktopForeground: () => desktopForeground,
      isDesktopAbove: (win) => covered.has(win),
    } : require(name),
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
    foreground: (value) => { desktopForeground = value; for (const timer of intervals.values()) timer.callback(); },
    cover: (panel) => covered.add(windows.find((win) => win.panel === panel)),
    cursor: (x, y) => { cursor = { x, y }; for (const timer of intervals.values()) timer.callback(); },
    load: () => windows.forEach((win) => win.webContents.emit('did-finish-load')),
    invoke: (channel, ...args) => handlers.get(`desktop:${channel}`)(event(), ...args),
  };
}

test('creates two sandboxed transparent panels, using polling on macOS only while shown', async () => {
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

test('Windows keeps both panel regions immediately clickable without cursor polling or hover focus', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  const [widget, schedule] = env.windows;
  env.send('report-widget-bounds', rect(10.4, 10.4, 100, 100, { extraRects: [rect(400, 400, 200, 100)] }));
  env.send('report-schedule-bounds', rect(134, 10));
  assert.deepEqual(widget.shape, [{ x: 6, y: 6, width: 109, height: 109 }, { x: 396, y: 396, width: 208, height: 108 }]);
  assert.deepEqual(schedule.shape, [{ x: 130, y: 6, width: 108, height: 108 }]);
  assert.equal(widget.ignoreMouse, false); assert.equal(schedule.ignoreMouse, false);
  assert.deepEqual([...env.intervals.values()].map((timer) => timer.delay), [250]);
  assert.equal(env.readCount(), 0, 'native hit regions do not depend on a stale cursor position');
  assert.ok(env.windows.every((win) => !win.focused));
  const changes = widget.shapeChanges;
  env.send('report-widget-bounds', rect(10.4, 10.4, 100, 100, { extraRects: [rect(400, 400, 200, 100)] }));
  env.invoke('set-pin', 'widget', true);
  assert.equal(widget.shapeChanges, changes, 'unchanged regions and pin changes do not redraw the region');
  assert.equal(schedule.ignoreMouse, false, 'pinning does not disable the separate schedule');
});

test('Windows modals and pointer capture own the full input surface and release the other panel', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  const [widget, schedule] = env.windows;
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.send('pointer-capture', true);
  assert.deepEqual(widget.shape, []); assert.equal(schedule.ignoreMouse, true);
  env.send('pointer-capture', false);
  assert.equal(widget.shape.length, 1); assert.equal(schedule.ignoreMouse, false);
  env.invoke('set-pin', 'widget', true);
  env.send('report-schedule-bounds', rect(200, 10, 100, 100, { modal: true }));
  assert.deepEqual(schedule.shape, []); assert.equal(widget.ignoreMouse, true);
  assert.equal(schedule.topMoves, 1);
  assert.equal(schedule.isAlwaysOnTop(), true, 'the modal is visible above a pinned sibling');
  assert.deepEqual(plain(env.invoke('get-pins')), { widget: true, schedule: false }, 'temporary modal elevation preserves user choices');
  env.send('report-schedule-bounds', rect(200, 10));
  assert.equal(schedule.shape.length, 1); assert.equal(widget.ignoreMouse, false);
  assert.equal(schedule.isAlwaysOnTop(), false, 'closing the modal restores the original topmost state');
  env.trays[0].emit('click');
  assert.ok(env.windows.every((win) => !win.visible && win.ignoreMouse));
  env.trays[0].emit('click');
  assert.ok(env.windows.every((win) => win.visible && !win.ignoreMouse));
});

test('Windows renderer crash drops its input region until explicit recovery and fresh bounds', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  const [widget, schedule] = env.windows;
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.send('pointer-capture', true);
  widget.webContents.emit('render-process-gone');
  assert.equal(widget.visible, false); assert.equal(widget.ignoreMouse, true);
  assert.equal(schedule.ignoreMouse, false);
  assert.deepEqual([...env.intervals.values()].map((timer) => timer.delay), [250]);
  env.app.emit('second-instance'); widget.webContents.emit('did-finish-load');
  assert.equal(widget.ignoreMouse, true, 'a recovered page has no input until its fresh bounds arrive');
  env.send('report-widget-bounds', rect(40, 40));
  assert.equal(widget.ignoreMouse, false); assert.deepEqual(widget.shape, [{ x: 36, y: 36, width: 108, height: 108 }]);
});

test('Windows desktop reveal raises visible panels once without changing focus or pin choices', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  const [widget, schedule] = env.windows;
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.invoke('set-pin', 'schedule', true);
  env.foreground(true);
  assert.equal(widget.topMoves, 1); assert.equal(schedule.topMoves, 1);
  assert.ok(env.windows.every((win) => !win.focused));
  assert.deepEqual(plain(env.invoke('get-pins')), { widget: false, schedule: true });
  env.foreground(true); env.foreground(true);
  assert.equal(widget.topMoves, 1, 'remaining on the desktop must not fight normal window stacking');
  env.foreground(false);
  assert.equal(widget.topMoves, 1, 'ordinary foreground applications must not be covered');
  env.foreground(true);
  assert.equal(widget.topMoves, 2);
  env.foreground(false);
  env.send('report-widget-bounds', rect(10, 10, 100, 100, { modal: true }));
  env.foreground(true);
  assert.ok(widget.topOrder > schedule.topOrder, 'desktop reveal keeps the modal above its pinned sibling');
  env.trays[0].emit('click');
  assert.equal(env.intervals.size, 0);
  env.foreground(true);
  assert.ok(env.windows.every((win) => !win.visible));
  env.trays[0].emit('click');
  assert.ok(widget.topOrder > schedule.topOrder, 'tray restore also shows the modal last');
  env.app.emit('before-quit');
  assert.equal(env.intervals.size, 0);
});

test('Windows restores system minimization without reviving disabled, crashed or deliberately hidden panels', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  const [widget, schedule] = env.windows;
  env.send('report-widget-bounds', rect());
  widget.visible = false; widget.emit('minimize');
  assert.equal(widget.visible, true); assert.ok(!widget.focused);
  schedule.emit('minimize'); assert.equal(schedule.visible, false);
  widget.webContents.emit('render-process-gone');
  env.foreground(true); widget.emit('minimize');
  assert.equal(widget.visible, false); assert.equal(env.intervals.size, 0);
  env.app.emit('second-instance'); widget.webContents.emit('did-finish-load');
  env.trays[0].emit('click'); widget.emit('minimize'); env.foreground(true);
  assert.equal(widget.visible, false); assert.equal(env.intervals.size, 0);
});

test('Windows restores repeated desktop reveals only when the desktop actually covers a panel', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  const [widget, schedule] = env.windows;
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.foreground(true);
  assert.equal(widget.topMoves, 1);
  env.cover('schedule');
  env.foreground(true);
  assert.equal(widget.topMoves, 2); assert.equal(schedule.topMoves, 2, 'same foreground desktop can cover panels again');
  env.foreground(true);
  assert.equal(widget.topMoves, 2, 'visible panels are not re-stacked every timer tick');
  env.cover('widget');
  env.foreground(false);
  assert.equal(widget.topMoves, 2, 'a foreground ordinary app must remain above an unpinned panel');
});

test('Windows restores hidden panels while the desktop stays foreground without a minimize event', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.foreground(true);
  const shown = env.windows.map(win => win.raised);
  for (const win of env.windows) {
    win.visible = false;
    win.emit('hide');
  }
  env.foreground(true);
  for (const [index, win] of env.windows.entries()) {
    assert.equal(win.visible, true, `${win.panel} must return after a native hide on the desktop`);
    assert.equal(win.raised, shown[index] + 1, `${win.panel} must be shown again, not only moved in the Z-order`);
    assert.ok(!win.focused, 'restoring a hidden panel must not take keyboard focus');
  }
  env.foreground(true);
  assert.deepEqual(env.windows.map(win => win.raised), shown.map(count => count + 1),
    'already visible panels must not be re-shown every tick');
});

test('Windows persistent-desktop recovery does not revive disabled, crashed or tray-hidden panels', async () => {
  for (const reason of ['disabled', 'crashed', 'tray-hidden']) {
    const env = await desktop({ platform: 'win32' }); env.load();
    const [widget, schedule] = env.windows;
    env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
    env.foreground(true);
    if (reason === 'disabled') env.send('report-schedule-bounds', rect(0, 0, 0, 0, { visible: false }));
    else if (reason === 'crashed') schedule.webContents.emit('render-process-gone');
    else env.trays[0].emit('click');
    const shown = schedule.raised;
    env.cover('widget'); env.foreground(true);
    assert.equal(schedule.visible, false, `${reason} schedule must stay hidden`);
    assert.equal(schedule.raised, shown, `${reason} schedule must not be re-shown`);
    assert.equal(schedule.webContents.reloads || 0, 0, 'desktop recovery must not reload a crashed renderer');
    assert.equal(widget.visible, reason !== 'tray-hidden', 'an explicit tray hide applies to both panels');
  }
});

for (const pins of [
  { widget: false, schedule: false },
  { widget: true, schedule: false },
  { widget: false, schedule: true },
  { widget: true, schedule: true },
]) {
  test(`Windows desktop persistence preserves independent pins ${JSON.stringify(pins)}`, async () => {
    const env = await desktop({ platform: 'win32' }); env.load();
    env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
    for (const [panel, pinned] of Object.entries(pins)) env.invoke('set-pin', panel, pinned);
    const verify = () => {
      assert.deepEqual(plain(env.invoke('get-pins')), pins);
      for (const win of env.windows) {
        assert.equal(win.isVisible(), true, `${win.panel} remains available on the desktop`);
        assert.equal(win.isAlwaysOnTop(), pins[win.panel], `${win.panel} keeps its native topmost choice`);
        assert.ok(!win.focused, 'desktop recovery must not take keyboard focus');
      }
    };
    env.foreground(true);
    verify();
    env.cover('widget'); env.cover('schedule'); env.foreground(true);
    assert.ok(env.windows.every((win) => win.topMoves === 2), 'repeated desktop reveal restores both panels');
    verify();
    for (const win of env.windows) { win.visible = false; win.emit('minimize'); }
    verify();
    const stacking = env.windows.map((win) => [win.topMoves, win.raised]);
    env.foreground(false);
    env.cover('widget'); env.cover('schedule'); env.foreground(false);
    assert.deepEqual(env.windows.map((win) => [win.topMoves, win.raised]), stacking,
      'an ordinary foreground app does not trigger panel raising or re-showing');
    verify();
  });
}

function nativeDesktop() {
  const module = { exports: {} };
  let front = 3, visits = 0;
  const above = new Map([[1, 2], [2, 3], [3, 0]]);
  const classes = new Map([[2, 'WorkerW'], [3, 'OrdinaryApp']]);
  const visible = new Set([3]);
  const native = {
    GetForegroundWindow: () => front,
    GetWindow: (hwnd, command) => {
      assert.equal(command, 3);
      assert.ok(++visits <= 4096, 'cyclic native window order must not hang the app');
      return above.get(Number(hwnd)) || 0;
    },
    IsWindowVisible: (hwnd) => Number(visible.has(Number(hwnd))),
    GetClassNameW: (hwnd, buffer) => {
      const name = classes.get(Number(hwnd)) || '';
      buffer.write(name, 'utf16le');
      return name.length;
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'windows-desktop.cjs'), 'utf8'), {
    module, Buffer,
    require: () => ({ load: () => ({ func: (declaration) => native[declaration.match(/(GetForegroundWindow|GetWindow|IsWindowVisible|GetClassNameW)\(/)[1]] }) }),
  });
  const api = module.exports, handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(1n);
  return { api, handle, above, classes, visible,
    foreground: value => { front = value; },
    resetVisits: () => { visits = 0; }, visits: () => visits,
  };
}

test('Windows desktop Z-order checks visible shell windows and bounds traversal during changes', () => {
  const env = nativeDesktop();
  const { api, handle, above, classes, visible } = env;
  assert.equal(api.isDesktopForeground(), false);
  assert.equal(api.isDesktopAbove(handle), false, 'invisible desktop workers do not count as occlusion');
  visible.add(2); env.foreground(2);
  assert.equal(api.isDesktopForeground(), true);
  assert.equal(api.isDesktopAbove(handle), true);
  visible.delete(2); classes.set(3, 'Progman');
  assert.equal(api.isDesktopAbove(handle), true, 'visible Progman is detected farther up the Z-order');
  classes.set(3, 'OrdinaryApp'); above.set(3, 2); env.resetVisits();
  assert.equal(api.isDesktopAbove(handle), false);
  assert.ok(env.visits() <= 4096, 'changing or cyclic native window order cannot hang the app');
});

test('Windows desktop Z-order detects the desktop beyond 600 intervening windows', () => {
  const { api, handle, above, classes, visible } = nativeDesktop();
  above.clear(); classes.clear(); visible.clear();
  for (let hwnd = 1; hwnd < 702; hwnd++) above.set(hwnd, hwnd + 1);
  classes.set(702, 'WorkerW');
  visible.add(702);
  assert.equal(api.isDesktopAbove(handle), true, 'a desktop 701 steps above the panel must be detected');
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

test('a crashed renderer releases its transparent surface and recovers only on an explicit show', async () => {
  const env = await desktop(); env.load();
  const widget = env.windows[0];
  env.send('report-widget-bounds', rect(10, 10, 100, 100, { modal: true }));
  env.send('pointer-capture', true);
  env.invoke('set-pin', 'widget', true);
  env.cursor(600, 600);
  assert.equal(widget.ignoreMouse, false);

  widget.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(widget.visible, false);
  assert.equal(widget.ignoreMouse, true);
  assert.equal(env.invoke('get-widget-bounds'), null);
  assert.equal(env.intervals.size, 0);
  assert.equal(widget.webContents.reloads || 0, 0, 'a crash must not start a reload loop');
  env.send('report-schedule-bounds', rect(0, 0, 0, 0, { visible: false }));
  assert.equal(widget.visible, false, 'other panel updates cannot show the crashed panel');

  env.app.emit('second-instance');
  assert.equal(widget.webContents.reloads, 1);
  assert.equal(widget.visible, false, 'recovery waits for the page to finish loading');
  env.app.emit('second-instance');
  assert.equal(widget.webContents.reloads, 1, 'repeated show requests do not restart an in-flight recovery');
  env.send('report-widget-bounds', rect());
  widget.webContents.emit('did-finish-load');
  assert.equal(widget.visible, true);
  assert.equal(widget.pinned, true);
  env.cursor(600, 600);
  assert.equal(widget.ignoreMouse, true, 'neither old capture nor old modal bounds survive recovery');

  widget.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  env.trays[0].emit('click');
  assert.equal(widget.webContents.reloads, 2, 'tray show also recovers the failed panel');
});

test('a crashed schedule stays hidden until recovery and fresh visible bounds arrive', async () => {
  const env = await desktop(); env.load();
  const [widget, schedule] = env.windows;
  env.send('report-widget-bounds', rect());
  env.send('report-schedule-bounds', rect(80, 80, 100, 100, { modal: true }));
  env.ipcMain.emit('desktop:pointer-capture', env.event('schedule'), true);
  schedule.webContents.emit('render-process-gone', {}, { reason: 'killed' });
  assert.equal(schedule.visible, false);
  assert.equal(schedule.ignoreMouse, true);
  assert.equal(widget.visible, true);
  env.cursor(30, 30);
  assert.equal(widget.ignoreMouse, false);

  env.app.emit('activate');
  assert.equal(schedule.webContents.reloads, 1);
  schedule.webContents.emit('did-finish-load');
  assert.equal(schedule.visible, false, 'stale schedule visibility cannot resurrect the failed surface');
  env.send('report-schedule-bounds', rect(80, 80));
  assert.equal(schedule.visible, true);
});

test('Windows pinning recovers when the floating level silently loses native topmost state', async () => {
  const env = await desktop({ platform: 'win32', floatingPinFails: true }); env.load();
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
  const env = await desktop({ platform: 'win32', packaged: false });
  assert.equal(env.app.appId, require('../package.json').build.appId, 'Electron and the installer must share the startup value name');
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

function preload() {
  const ipcRenderer = new EventEmitter(), sent = [], invoked = [], documentEvents = new Map(), windowEvents = new Map();
  let bridge;
  ipcRenderer.send = (...args) => sent.push(args);
  ipcRenderer.invoke = (...args) => { invoked.push(args); return Promise.resolve(); };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8'), {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'desktopBridge'); bridge = value; } } }),
    document: { addEventListener: (name, callback) => documentEvents.set(name, callback) },
    window: { addEventListener: (name, callback) => windowEvents.set(name, callback) },
  });
  return { ipcRenderer, sent, invoked, documentEvents, windowEvents, bridge };
}

test('preload exposes narrow IPC methods and removable subscriptions without Electron event objects', () => {
  const { ipcRenderer, sent, invoked, documentEvents, bridge } = preload();
  bridge.setPin('widget', 1); bridge.setStartup(0); bridge.setCourseEnabled(1);
  assert.deepEqual(invoked, [['desktop:set-pin', 'widget', true], ['desktop:set-startup', false]]);
  assert.deepEqual(sent, [['desktop:set-course-enabled', true]]);
  let received;
  const unsubscribe = bridge.onWidgetBounds((...args) => { received = args; });
  ipcRenderer.emit('desktop:widget-bounds', { secret: 'not for the page' }, rect());
  assert.deepEqual(received, [rect()]); unsubscribe();
  assert.equal(ipcRenderer.listenerCount('desktop:widget-bounds'), 0);
  documentEvents.get('gotpointercapture')({ pointerId: 1 }); documentEvents.get('lostpointercapture')({ pointerId: 1 });
  assert.deepEqual(sent.slice(-2), [['desktop:pointer-capture', true], ['desktop:pointer-capture', false]]);
});

test('preload retains capture until the final pointer leaves and releases it on blur or pagehide', () => {
  const { sent, documentEvents, windowEvents } = preload();
  const capture = pointerId => documentEvents.get('gotpointercapture')({ pointerId });
  const release = pointerId => documentEvents.get('lostpointercapture')({ pointerId });
  capture(1); capture(1); capture(2); release(2); release(99);
  assert.deepEqual(sent, [['desktop:pointer-capture', true]], 'one pointer leaving must not cancel another active drag');
  release(1); release(1);
  assert.deepEqual(sent.at(-1), ['desktop:pointer-capture', false]);
  assert.equal(sent.length, 2, 'duplicate capture and release events do not add IPC messages');

  capture(3); capture(4); windowEvents.get('blur')(); release(3); release(4);
  assert.deepEqual(sent.slice(2), [['desktop:pointer-capture', true], ['desktop:pointer-capture', false]]);
  capture(5); windowEvents.get('pagehide')(); windowEvents.get('pagehide')();
  assert.deepEqual(sent.slice(4), [['desktop:pointer-capture', true], ['desktop:pointer-capture', false]]);
});
