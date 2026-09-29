const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const rect = (left = 10, top = 10, width = 100, height = 100, other = {}) => ({ left, top, width, height, ...other });
const plain = (value) => JSON.parse(JSON.stringify(value));

async function desktop({ lock = true, platform = 'darwin', packaged = true, floatingPinFails = false, nativeTopmostFails = false, watchFails = false } = {}) {
  const windows = [], trays = [], intervals = new Map(), handlers = new Map(), opened = [], covered = new Set(), watchers = [], belowCalls = [];
  let nextTimer = 0, cursor = { x: 30, y: 30 }, cursorReads = 0, foregroundContext = 'other', topSequence = 0;
  const setContext = value => { foregroundContext = value === true ? 'desktop' : value === false ? 'other' : value; };
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
      this.visible = false; this.destroyed = false; this.webContents = new Contents(); this.mouseChanges = 0; this.pinCalls = [];
      this.nativeTopmost = false; this.nativePinCalls = []; windows.push(this);
    }
    loadFile(file, { query }) { this.file = file; this.panel = query.panel; this.webContents.emit('did-start-loading'); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    showInactive() { this.raised = (this.raised || 0) + 1; this.topOrder = ++topSequence; if (!this.visible) { this.visible = true; this.emit('show'); } }
    hide() { if (this.visible) { this.visible = false; this.emit('hide'); } }
    focus() { this.focused = true; foregroundContext = 'panel'; this.topOrder = ++topSequence; }
    moveTop() { this.topMoves = (this.topMoves || 0) + 1; this.topOrder = ++topSequence; covered.delete(this); }
    getNativeWindowHandle() { return this; }
    getBounds() { return this.bounds; }
    setBounds(value) { this.bounds = { ...value }; }
    setIgnoreMouseEvents(ignore) { this.ignoreMouse = ignore; this.mouseChanges++; }
    setShape(rects) { this.shape = plain(rects); this.shapeChanges = (this.shapeChanges || 0) + 1; }
    setAlwaysOnTop(value, level) {
      this.pinCalls.push({ value, level });
      if (this.isAlwaysOnTop() === value && this.level === level) return;
      this.pinned = value && !(floatingPinFails && level === 'floating'); this.level = level;
      this.applyNativeTopmost(this.pinned);
    }
    applyNativeTopmost(value) {
      if (value && nativeTopmostFails) return;
      this.nativeTopmost = value;
      if (value) { covered.delete(this); this.belowForeground = false; this.topOrder = ++topSequence; }
    }
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
      isDesktopForeground: () => foregroundContext === 'desktop',
      isDesktopAbove: (win) => covered.has(win),
      foregroundContext: () => foregroundContext,
      isTopmost: win => win.nativeTopmost,
      ensureTopmost: (win, enabled) => {
        if (win.nativeTopmost !== enabled) { win.nativePinCalls.push(enabled); win.applyNativeTopmost(enabled); }
        return win.nativeTopmost;
      },
      placeBelowForeground: win => {
        if (foregroundContext !== 'other') return;
        assert.equal(win.isAlwaysOnTop(), false, 'the panel must be demoted before positioning below a normal foreground app');
        assert.equal(win.nativeTopmost, false, 'the actual native band must also be demoted');
        win.belowForeground = true; belowCalls.push(win);
      },
      watchChanges: (callback) => {
        const watcher = { callback, active: !watchFails, disposals: 0 };
        watchers.push(watcher);
        return watchFails ? null : () => { watcher.active = false; watcher.disposals++; };
      },
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
  return { app, windows, trays, intervals, handlers, ipcMain, event, send, screen, display, opened, Menu, watchers, belowCalls,
    readCount: () => cursorReads,
    foreground: (value) => { setContext(value); for (const timer of intervals.values()) timer.callback(); },
    desktopEvent: (value) => { setContext(value); for (const watcher of watchers) if (watcher.active) watcher.callback(); },
    cover: (panel) => { const win = windows.find(win => win.panel === panel); if (!win.nativeTopmost) covered.add(win); },
    isCovered: (win) => covered.has(win),
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
  assert.deepEqual([...env.intervals.values()].map((timer) => timer.delay), [1000]);
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
  assert.ok(schedule.topOrder > widget.topOrder, 'the modal must be above its pinned sibling');
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
  assert.deepEqual([...env.intervals.values()].map((timer) => timer.delay), [1000]);
  env.app.emit('second-instance'); widget.webContents.emit('did-finish-load');
  assert.equal(widget.ignoreMouse, true, 'a recovered page has no input until its fresh bounds arrive');
  env.send('report-widget-bounds', rect(40, 40));
  assert.equal(widget.ignoreMouse, false); assert.deepEqual(widget.shape, [{ x: 36, y: 36, width: 108, height: 108 }]);
});

test('Windows desktop context keeps panels above the desktop while preserving modal order and pins', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  const [widget, schedule] = env.windows;
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.invoke('set-pin', 'schedule', true);
  env.foreground('desktop');
  assert.ok(env.windows.every(win => win.isAlwaysOnTop() && !win.focused));
  assert.deepEqual(plain(env.invoke('get-pins')), { widget: false, schedule: true });
  env.foreground('other');
  assert.equal(widget.isAlwaysOnTop(), false);
  assert.equal(widget.belowForeground, true);
  assert.equal(schedule.isAlwaysOnTop(), true, 'the user-pinned panel stays above normal applications');
  env.send('report-widget-bounds', rect(10, 10, 100, 100, { modal: true }));
  env.foreground('desktop');
  assert.ok(widget.topOrder > schedule.topOrder, 'the modal stays above its pinned sibling');
  env.trays[0].emit('click');
  assert.equal(env.intervals.size, 0);
  assert.ok(env.windows.every(win => !win.visible));
  env.trays[0].emit('click');
  assert.ok(widget.topOrder > schedule.topOrder, 'tray restore also keeps the modal last');
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

test('Windows panel to NULL to desktop transitions retain the native band without repeated positioning', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.desktopEvent('panel');
  const calls = env.windows.map(win => win.pinCalls.length);
  const stacking = env.windows.map(win => [win.topMoves, win.raised, win.topOrder]);
  for (const context of [null, 'desktop', 'panel', null, 'desktop']) {
    env.cover('widget'); env.cover('schedule');
    env.desktopEvent(context);
    assert.ok(env.windows.every(win => win.isAlwaysOnTop() && !env.isCovered(win) && !win.focused));
  }
  assert.deepEqual(env.windows.map(win => win.pinCalls.length), calls, 'stable desktop/panel context needs no native band round trips');
  assert.deepEqual(env.windows.map(win => [win.topMoves, win.raised, win.topOrder]), stacking);
  assert.deepEqual(plain(env.invoke('get-pins')), { widget: false, schedule: false });
});
test('Windows native context events restore visibility immediately and repeated events do not restack panels', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  assert.equal(env.watchers.length, 1, 'both panels share one shell subscription');
  assert.deepEqual([...env.intervals.values()].map(timer => timer.delay), [1000]);
  env.cover('widget'); env.cover('schedule');
  env.desktopEvent('desktop');
  assert.ok(env.windows.every(win => !env.isCovered(win) && win.isAlwaysOnTop() && !win.focused),
    'the native callback restores both panels without advancing any timer');
  const calls = env.windows.map(win => win.pinCalls.length);
  env.desktopEvent('desktop'); env.desktopEvent('desktop');
  assert.deepEqual(env.windows.map(win => win.pinCalls.length), calls);
  assert.ok(env.windows.every(win => !win.topMoves), 'context handling never calls moveTop');
  env.desktopEvent('other');
  assert.ok(env.windows.every(win => !win.isAlwaysOnTop() && win.belowForeground && !win.topMoves));
});

test('Windows repairs a lost native topmost flag even when Electron still caches true', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.desktopEvent('desktop');
  const calls = env.windows.map(win => win.pinCalls.length);
  const shown = env.windows.map(win => win.raised);
  for (const win of env.windows) {
    win.nativeTopmost = false;
    env.cover(win.panel);
    assert.equal(win.isAlwaysOnTop(), true, 'the Electron cache survives native flag loss');
  }
  env.desktopEvent('desktop');
  for (const [index, win] of env.windows.entries()) {
    assert.equal(win.nativeTopmost, true, 'native fallback repairs the ineffective cached setter');
    assert.equal(env.isCovered(win), false);
    assert.deepEqual(win.nativePinCalls, [true], 'repair does not pulse back to the non-topmost band');
    assert.deepEqual(win.pinCalls.slice(calls[index]), [{ value: true, level: 'pop-up-menu' }]);
    assert.ok(!win.focused && !win.topMoves);
  }
  env.desktopEvent('desktop');
  assert.deepEqual(env.windows.map(win => win.pinCalls.length), calls.map(count => count + 1), 'the repaired state needs no repeated setter');
  assert.deepEqual(env.windows.map(win => win.raised), shown, 'repair does not re-show panels');
  assert.deepEqual(plain(env.invoke('get-pins')), { widget: false, schedule: false });
  env.desktopEvent('other');
  assert.ok(env.windows.every(win => !win.isAlwaysOnTop() && !win.nativeTopmost && win.belowForeground && !win.focused));
  for (const win of env.windows) win.nativeTopmost = true;
  env.desktopEvent('other');
  assert.ok(env.windows.every(win => !win.nativeTopmost && win.belowForeground && !win.focused && !win.topMoves),
    'a stale false cache also cannot leave an unpinned panel above ordinary apps');
  assert.deepEqual(env.windows.map(win => win.nativePinCalls), [[true, false], [true, false]]);
  assert.deepEqual(env.windows.map(win => win.raised), shown);
});

test('Windows Pin reports native refusal instead of the Electron cached request', async () => {
  const env = await desktop({ platform: 'win32', nativeTopmostFails: true }); env.load();
  env.send('report-widget-bounds', rect());
  const [widget] = env.windows;
  assert.deepEqual(plain(env.invoke('set-pin', 'widget', true)), { widget: false, schedule: false });
  assert.equal(widget.nativeTopmost, false);
  assert.deepEqual(widget.nativePinCalls, [true], 'the direct native fallback was attempted');
  assert.deepEqual(plain(env.invoke('get-pins')), { widget: false, schedule: false });
  assert.ok(!widget.focused);
});
test('Windows stops shell subscriptions on hide, quit or all renderer crashes and ignores stale callbacks', async () => {
  for (const reason of ['hide', 'quit', 'crash']) {
    const env = await desktop({ platform: 'win32' }); env.load();
    env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
    env.desktopEvent(true);
    const watcher = env.watchers[0];
    if (reason === 'hide') env.trays[0].emit('click');
    else if (reason === 'quit') env.app.emit('before-quit');
    else env.windows.forEach(win => win.webContents.emit('render-process-gone'));
    assert.equal(watcher.disposals, 1, `${reason} releases the shell subscription exactly once`);
    assert.equal(watcher.active, false);
    assert.equal(env.intervals.size, 0);
    const state = env.windows.map(win => [win.visible, win.topMoves, win.raised, win.pinCalls.length]);
    env.cover('widget'); env.cover('schedule'); watcher.callback();
    assert.deepEqual(env.windows.map(win => [win.visible, win.topMoves, win.raised, win.pinCalls.length]), state,
      `${reason} must make a late native callback harmless`);
    if (reason === 'hide') {
      env.trays[0].emit('click');
      assert.equal(env.watchers.length, 2, 'an explicit show installs a fresh subscription');
      assert.equal(env.watchers.filter(item => item.active).length, 1);
    }
  }
});

test('Windows keeps the 250ms recovery timer when native shell hooks are unavailable', async () => {
  const env = await desktop({ platform: 'win32', watchFails: true }); env.load();
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  assert.equal(env.watchers.length, 1);
  assert.deepEqual([...env.intervals.values()].map(timer => timer.delay), [250]);
  env.cover('widget'); env.cover('schedule'); env.desktopEvent(true);
  assert.ok(env.windows.every(win => env.isCovered(win)), 'a failed subscription cannot emit events');
  env.foreground(true);
  assert.ok(env.windows.every(win => !env.isCovered(win) && !win.focused), 'fallback polling still restores panels');
  env.trays[0].emit('click');
  assert.equal(env.intervals.size, 0);
});

test('Windows unpin during desktop context changes the user choice without dropping desktop visibility', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  const [widget] = env.windows;
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.desktopEvent('desktop');
  const calls = widget.pinCalls.length;
  env.invoke('set-pin', 'widget', true);
  assert.deepEqual(plain(env.invoke('get-pins')), { widget: true, schedule: false });
  env.invoke('set-pin', 'widget', false);
  assert.deepEqual(plain(env.invoke('get-pins')), { widget: false, schedule: false });
  assert.equal(widget.isAlwaysOnTop(), true, 'native desktop boost must not be mistaken for user Pin');
  assert.equal(widget.pinCalls.length, calls, 'unpinning cannot introduce a transient desktop occlusion');
  env.desktopEvent('other');
  assert.ok(env.windows.every(win => !win.isAlwaysOnTop() && win.belowForeground && !win.focused));
});
test('Windows leaving desktop context preserves real pins and modal boosts until the modal closes', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  const [widget, schedule] = env.windows;
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.invoke('set-pin', 'schedule', true);
  env.send('report-widget-bounds', rect(10, 10, 100, 100, { modal: true }));
  env.desktopEvent('desktop');
  const calls = env.windows.map(win => win.pinCalls.length);
  env.desktopEvent('other');
  assert.ok(env.windows.every(win => win.isAlwaysOnTop() && !win.focused));
  assert.deepEqual(env.windows.map(win => win.pinCalls.length), calls, 'leaving desktop must not cancel another source of topmost');
  assert.deepEqual(plain(env.invoke('get-pins')), { widget: false, schedule: true });
  assert.equal(env.belowCalls.length, 0);
  env.send('report-widget-bounds', rect());
  assert.equal(widget.isAlwaysOnTop(), false);
  assert.equal(widget.belowForeground, true, 'the closed modal returns below the ordinary foreground app');
  assert.equal(schedule.isAlwaysOnTop(), true);
});

test('Windows desktop boost keeps an already-pinned modal above a newly boosted sibling', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  const [widget, schedule] = env.windows;
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.invoke('set-pin', 'widget', true);
  env.send('report-widget-bounds', rect(10, 10, 100, 100, { modal: true }));
  assert.equal(widget.isAlwaysOnTop(), true);
  assert.equal(schedule.isAlwaysOnTop(), false);
  env.desktopEvent('desktop');
  assert.ok(widget.isAlwaysOnTop() && schedule.isAlwaysOnTop());
  assert.ok(widget.topOrder > schedule.topOrder, 'boosting the sibling must not cover the existing modal');
  const order = env.windows.map(win => [win.topOrder, win.topMoves, win.pinCalls.length]);
  env.desktopEvent('desktop'); env.desktopEvent('panel');
  assert.deepEqual(env.windows.map(win => [win.topOrder, win.topMoves, win.pinCalls.length]), order,
    'stable context events must not raise the modal again');
  assert.deepEqual(plain(env.invoke('get-pins')), { widget: true, schedule: false });
});

test('Windows explicit show keeps an already-topmost schedule modal above the focused main panel', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  const [widget, schedule] = env.windows;
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.invoke('set-pin', 'schedule', true);
  env.desktopEvent('desktop');
  env.send('report-schedule-bounds', rect(200, 10, 100, 100, { modal: true }));
  assert.ok(schedule.topOrder > widget.topOrder);
  const pins = env.windows.map(win => win.pinCalls.length);
  env.app.emit('second-instance');
  assert.ok(widget.focused, 'explicit show focuses the main panel');
  assert.ok(schedule.topOrder > widget.topOrder, 'focusing the main panel must not cover the open schedule modal');
  assert.deepEqual(env.windows.map(win => win.pinCalls.length), pins, 'restoring modal order must not toggle native bands');
  assert.deepEqual(plain(env.invoke('get-pins')), { widget: false, schedule: true });
});
test('Windows ordinary foreground context demotes unpinned panels below it without activating or re-showing them', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.desktopEvent('desktop');
  const shown = env.windows.map(win => win.raised);
  env.desktopEvent('other');
  assert.deepEqual(env.windows.map(win => win.raised), shown);
  assert.ok(env.windows.every(win => !win.isAlwaysOnTop() && win.belowForeground && !win.focused && !win.topMoves));
  assert.equal(env.belowCalls.length, 2);
  const calls = env.windows.map(win => win.pinCalls.length);
  env.desktopEvent('other'); env.desktopEvent(null);
  assert.deepEqual(env.windows.map(win => win.pinCalls.length), calls);
  assert.equal(env.belowCalls.length, 2, 'ordinary app and NULL events cannot repeatedly reposition panels');
});
test('Windows hiding, crashing or disabling a panel releases its desktop boost', async () => {
  for (const reason of ['hide', 'crash', 'disable']) {
    const env = await desktop({ platform: 'win32' }); env.load();
    const [widget, schedule] = env.windows;
    env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
    env.desktopEvent('desktop');
    assert.ok(env.windows.every(win => win.isAlwaysOnTop()));
    if (reason === 'hide') env.trays[0].emit('click');
    else if (reason === 'crash') schedule.webContents.emit('render-process-gone');
    else env.send('report-schedule-bounds', rect(0, 0, 0, 0, { visible: false }));
    assert.equal(schedule.visible, false);
    assert.equal(schedule.isAlwaysOnTop(), false, reason + ' must release the now-hidden panel boost');
    assert.equal(widget.isAlwaysOnTop(), reason !== 'hide');
    assert.deepEqual(plain(env.invoke('get-pins')), { widget: false, schedule: false });
  }
});
test('Windows explicit show restores both panel layers after focusing the main window', async () => {
  const env = await desktop({ platform: 'win32' }); env.load();
  env.send('report-widget-bounds', rect()); env.send('report-schedule-bounds', rect(200, 10));
  env.trays[0].emit('click');
  env.cover('widget'); env.cover('schedule');
  env.app.emit('second-instance');
  assert.ok(env.windows.every(win => win.visible && !env.isCovered(win)), 'the unfocused schedule must also rise above the desktop');
  assert.ok(env.windows[0].focused);
  assert.ok(!env.windows[1].focused);
  assert.deepEqual(plain(env.invoke('get-pins')), { widget: false, schedule: false }, 'explicit show leaves user Pin choices unchanged');
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
    const verify = (desktopBoost) => {
      assert.deepEqual(plain(env.invoke('get-pins')), pins);
      for (const win of env.windows) {
        assert.equal(win.isVisible(), true, `${win.panel} remains available on the desktop`);
        assert.equal(win.isAlwaysOnTop(), pins[win.panel] || desktopBoost, `${win.panel} applies user Pin separately from desktop boost`);
        assert.ok(!win.focused, 'desktop recovery must not take keyboard focus');
      }
    };
    env.foreground(true);
    verify(true);
    const bandChanges = env.windows.map(win => win.pinCalls.length);
    env.cover('widget'); env.cover('schedule'); env.foreground(true);
    assert.ok(env.windows.every(win => !env.isCovered(win) && !win.topMoves), 'the continuous desktop band prevents repeat coverage');
    assert.deepEqual(env.windows.map(win => win.pinCalls.length), bandChanges);
    verify(true);
    for (const win of env.windows) { win.visible = false; win.emit('minimize'); }
    verify(true);
    const stacking = env.windows.map((win) => [win.topMoves, win.raised]);
    env.foreground(false);
    env.cover('widget'); env.cover('schedule'); env.foreground(false);
    assert.deepEqual(env.windows.map((win) => [win.topMoves, win.raised]), stacking,
      'an ordinary foreground app does not trigger panel raising or re-showing');
    verify(false);
    for (const win of env.windows) if (!pins[win.panel]) assert.equal(win.belowForeground, true);
  });
}

function nativeDesktop({ failHook = 0, unhookFails = false, positionFails = false, positionIgnored = false } = {}) {
  const module = { exports: {} };
  let front = 3, visits = 0, nextImmediate = 0;
  const above = new Map([[1, 2], [2, 3], [3, 0]]);
  const classes = new Map([[2, 'WorkerW'], [3, 'OrdinaryApp']]);
  const visible = new Set([3]), styles = new Map(), positions = [];
  const hooks = [], unhooked = [], registered = new Set(), released = [], immediate = new Map();
  const native = {
    GetForegroundWindow: () => front,
    GetDesktopWindow: () => 100,
    GetWindowLongPtrW: (hwnd, index) => { assert.equal(index, -20); return styles.get(Number(hwnd)) || 0; },
    SetWindowPos: (...args) => {
      positions.push(args);
      if (positionFails) return 0;
      const [hwnd, after] = args, style = styles.get(Number(hwnd)) || 0;
      if (!positionIgnored && (after === -1 || after === -2)) styles.set(Number(hwnd), after === -1 ? style | 8 : style & ~8);
      return 1;
    },
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
    SetWinEventHook: (first, last, _module, callback, processId, threadId, flags) => {
      assert.equal(processId, 0); assert.equal(threadId, 0);
      assert.equal(flags & 4, 0, 'the JavaScript callback must remain out of process');
      const handle = hooks.length + 1 === failHook ? 0 : hooks.length + 10;
      hooks.push({ first, last, callback, handle });
      return handle;
    },
    UnhookWinEvent: handle => { unhooked.push(handle); return Number(!unhookFails); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'windows-desktop.cjs'), 'utf8'), {
    module, Buffer,
    setImmediate: callback => { immediate.set(++nextImmediate, callback); return nextImmediate; },
    clearImmediate: handle => immediate.delete(handle),
    require: () => ({
      load: () => ({ func: declaration => {
        const name = declaration.match(/(\w+)\s*\(/)[1];
        assert.ok(native[name], `unexpected native API ${name}`);
        if (name === 'SetWindowPos') assert.match(declaration, /\bintptr_t after\b/, 'HWND_TOPMOST and HWND_NOTOPMOST require signed pointer sentinels');
        return native[name];
      } }),
      proto: declaration => declaration,
      pointer: type => type,
      register: callback => { registered.add(callback); return callback; },
      unregister: callback => { assert.ok(registered.delete(callback), 'a native callback is released only once'); released.push(callback); },
    }),
  });
  const api = module.exports, handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(1n);
  return { api, handle, above, classes, visible, styles, positions, hooks, unhooked, registered, released, immediate,
    foreground: value => { front = value; },
    resetVisits: () => { visits = 0; }, visits: () => visits,
    emit: (event, hwnd = 100, object = 0, child = 0) => hooks[0].callback(hooks[0].handle, event, hwnd, object, child, 1, 0),
    flush: () => { const pending = [...immediate.values()]; immediate.clear(); pending.forEach(callback => callback()); },
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

test('Windows foreground context distinguishes desktop, own panels, ordinary apps and activation gaps', () => {
  const env = nativeDesktop();
  const handle32 = Buffer.alloc(4); handle32.writeUInt32LE(7);
  const handles = [env.handle, handle32];
  env.foreground(0);
  assert.equal(env.api.foregroundContext(handles), null, 'no foreground must preserve the caller state');
  for (const own of [1, 1n, 7]) {
    env.foreground(own);
    assert.equal(env.api.foregroundContext(handles), 'panel');
  }
  env.foreground(2);
  assert.equal(env.api.foregroundContext(handles), 'desktop');
  env.classes.set(4, 'Progman'); env.foreground(4);
  assert.equal(env.api.foregroundContext(handles), 'desktop');
  env.foreground(3);
  assert.equal(env.api.foregroundContext(handles), 'other');
});

test('Windows positions below only an ordinary non-topmost foreground without activating or moving windows', () => {
  const env = nativeDesktop();
  const panel = Buffer.alloc(8); panel.writeBigUInt64LE(0x100000001n);
  const handles = [panel, env.handle];
  env.classes.set(4, 'Progman');
  for (const foreground of [0, 2, 4, 1, 0x100000001n]) {
    env.foreground(foreground);
    env.api.placeBelowForeground(panel, handles);
  }
  env.foreground(3); env.styles.set(3, 8);
  env.api.placeBelowForeground(panel, handles);
  assert.equal(env.positions.length, 0, 'NULL, shell, own panels and topmost foreground apps must not be used as positioning targets');
  env.styles.set(3, 0);
  env.api.placeBelowForeground(panel, handles);
  assert.equal(env.positions.length, 1);
  assert.equal(env.positions[0][0], 0x100000001n, '64-bit HWNDs must not be truncated');
  assert.equal(env.positions[0][1], 3, 'the ordinary foreground window is the insertion target');
  assert.deepEqual(env.positions[0].slice(2), [0, 0, 0, 0, 0x213],
    'positioning keeps size, location, activation and owner Z-order unchanged');
});

test('Windows native topmost reads the actual style and avoids positioning when it already matches', () => {
  const { api, handle, styles, positions } = nativeDesktop();
  styles.set(1, 0x80);
  assert.equal(api.isTopmost(handle), false, 'other extended style bits do not imply topmost');
  assert.equal(api.ensureTopmost(handle, false), false);
  styles.set(1, 0x88);
  assert.equal(api.isTopmost(handle), true);
  assert.equal(api.ensureTopmost(handle, true), true);
  assert.equal(positions.length, 0, 'matching native bands are not restacked');
});

test('Windows native topmost fallback uses signed sentinels and preserves activation, bounds and unrelated styles', () => {
  const { api, handle, styles, positions } = nativeDesktop();
  styles.set(1, 0x80);
  assert.equal(api.ensureTopmost(handle, true), true);
  assert.equal(styles.get(1), 0x88);
  assert.equal(api.ensureTopmost(handle, false), false);
  assert.equal(styles.get(1), 0x80);
  assert.deepEqual(positions, [
    [1n, -1, 0, 0, 0, 0, 0x213],
    [1n, -2, 0, 0, 0, 0, 0x213],
  ]);
});

test('Windows native topmost fallback returns readback when the OS rejects or ignores positioning', () => {
  for (const options of [{ positionFails: true }, { positionIgnored: true }]) {
    const { api, handle, styles, positions } = nativeDesktop(options);
    assert.equal(api.ensureTopmost(handle, true), false, 'unsuccessful elevation cannot report the requested value');
    styles.set(1, 8);
    assert.equal(api.ensureTopmost(handle, false), true, 'unsuccessful demotion reports the band that remains');
    assert.equal(positions.length, 2);
  }
});

test('Windows native watcher filters shell events and releases both hooks on disposal', () => {
  const env = nativeDesktop();
  let notifications = 0;
  const stop = env.api.watchChanges(() => notifications++);
  assert.equal(typeof stop, 'function');
  assert.deepEqual(env.hooks.map(hook => [hook.first, hook.last]), [[3, 3], [0x8002, 0x8004]]);
  env.classes.set(4, 'Progman');
  env.emit(3, 3); // Any foreground change must let the caller inspect current state.
  env.emit(0x8002, 100);
  env.emit(0x8004, 100, -4);
  env.emit(0x8002, 2);
  env.emit(0x8004, 4);
  assert.equal(notifications, 5);
  for (const event of [[0x8003, 100], [0x8001, 100], [0x8002, 3], [0x8004, 100, -1], [0x8002, 2, 0, 1], [0x8004, 0]]) {
    env.emit(...event);
  }
  assert.equal(notifications, 5, 'non-shell windows, hide events and child objects do not trigger restoration');
  stop(); stop();
  assert.deepEqual(env.unhooked, env.hooks.map(hook => hook.handle));
  assert.equal(env.registered.size, 0);
  assert.equal(env.released.length, 1);
  env.emit(3, 2); env.flush();
  assert.equal(notifications, 5, 'a queued callback after disposal is harmless');
});

test('Windows native watcher coalesces reentrant events and defers release inside a callback', () => {
  const env = nativeDesktop();
  let notifications = 0;
  const stop = env.api.watchChanges(() => {
    notifications++;
    if (notifications === 1) { env.emit(3, 2); env.emit(0x8004, 100); }
  });
  env.emit(3, 2);
  assert.equal(notifications, 1, 'nested native events do not recursively restore windows');
  assert.equal(env.immediate.size, 1, 'nested events share one pending follow-up');
  env.flush();
  assert.equal(notifications, 2);
  stop();

  const disposedInside = nativeDesktop();
  let calls = 0;
  const stopInside = disposedInside.api.watchChanges(() => {
    calls++;
    disposedInside.emit(3, 2);
    stopInside();
    assert.equal(disposedInside.registered.size, 1, 'the executing callback must not be freed while still on its stack');
  });
  disposedInside.emit(3, 2);
  disposedInside.flush();
  assert.equal(calls, 1, 'disposal cancels the queued nested restoration');
  assert.equal(disposedInside.registered.size, 0, 'callback storage is released after the native invocation returns');
  assert.equal(disposedInside.released.length, 1);
});

test('Windows native watcher rolls back partial registration and preserves callback storage if unhook fails', () => {
  for (const failHook of [1, 2]) {
    const env = nativeDesktop({ failHook });
    assert.equal(env.api.watchChanges(() => assert.fail('failed subscriptions must never notify')), null);
    assert.deepEqual(env.unhooked, env.hooks.filter(hook => hook.handle).map(hook => hook.handle));
    assert.equal(env.registered.size, 0);
    assert.equal(env.released.length, 1);
    env.emit(3, 2);
  }
  const env = nativeDesktop({ unhookFails: true });
  const stop = env.api.watchChanges(() => assert.fail('disposed subscriptions must never notify'));
  stop();
  assert.deepEqual(env.unhooked, env.hooks.map(hook => hook.handle), 'both hooks get an unhook attempt');
  assert.equal(env.registered.size, 1, 'a callback Windows may still invoke cannot be freed');
  assert.equal(env.released.length, 0);
  env.emit(3, 2);
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

test('Windows pinning directly uses the native level that preserves topmost state', async () => {
  const env = await desktop({ platform: 'win32', floatingPinFails: true }); env.load();
  assert.deepEqual(plain(env.invoke('set-pin', 'widget', true)), { widget: true, schedule: false });
  assert.equal(env.windows[0].level, 'pop-up-menu');
  assert.equal(env.windows[0].isAlwaysOnTop(), true);
  assert.deepEqual(env.windows[0].pinCalls, [{ value: true, level: 'pop-up-menu' }], 'pinning never enters the problematic floating level');
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
