// Run separately from headless CI: npm run test:electron requires a desktop session.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron, expect } = require('@playwright/test');

async function main() {
  const root = path.resolve(__dirname, '..');
  const appRoot = process.env.TASKBOARD_SMOKE_APP ? path.resolve(process.env.TASKBOARD_SMOKE_APP) : root;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'taskboard-smoke-'));
  const profile = path.join(temporary, 'profile');
  const entry = path.join(temporary, 'entry.cjs');
  const automationBackgroundSwitches = [
    'disable-backgrounding-occluded-windows',
    'disable-background-timer-throttling',
    'disable-renderer-backgrounding',
  ];
  await fs.mkdir(profile);
  // Playwright injects these before the entry point. Keep production's native
  // occlusion/background behavior so automation cannot hide a frozen renderer.
  await fs.writeFile(entry, `const { app } = require('electron');
for (const name of ${JSON.stringify(automationBackgroundSwitches)}) app.commandLine.removeSwitch(name);
app.setPath('userData', ${JSON.stringify(profile)});
globalThis.taskboardTestRequire = require('node:module').createRequire(${JSON.stringify(path.join(appRoot, 'package.json'))});
require(${JSON.stringify(path.join(appRoot, 'main.cjs'))});
`);
  let app;
  const errors = [];
  try {
    // Avoid inheriting Electron's Node-only mode from terminal integrations.
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: require('electron'), args: [entry], cwd: root, env, timeout: 30000 });
    app.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    assert.deepEqual(await app.evaluate(({ app }, names) => names.filter(name => app.commandLine.hasSwitch(name)), automationBackgroundSwitches), [],
      'Electron smoke must not disable production background throttling through Playwright switches');
    await expect.poll(() => app.windows().length).toBe(2);
    const widget = app.windows().find((page) => page.url().includes('panel=widget'));
    const schedule = app.windows().find((page) => page.url().includes('panel=schedule'));
    assert.ok(widget && schedule, 'both panel pages loaded');
    for (const page of [widget, schedule]) await page.waitForFunction(() => window.desktopBridge && document.getElementById('schedule-grid').children.length > 0);
    const nativeWindows = async () => {
      const pins = await widget.evaluate(() => window.desktopBridge.getPins());
      const windows = await app.evaluate(({ BrowserWindow }) => {
        const desktop = process.platform === 'win32' ? globalThis.taskboardTestRequire('./windows-desktop.cjs') : null;
        return BrowserWindow.getAllWindows().map((win) => ({
          panel: new URL(win.webContents.getURL()).searchParams.get('panel'), visible: win.isVisible(),
          topmost: desktop ? desktop.isTopmost(win.getNativeWindowHandle()) : win.isAlwaysOnTop(),
        })).sort((a, b) => a.panel.localeCompare(b.panel));
      });
      for (const win of windows) if (pins[win.panel]) assert.ok(win.topmost, 'a user-pinned window must really be topmost');
      return windows.map(({ panel, visible }) => ({ panel, visible, pinned: pins[panel] }));
    };
    await expect.poll(nativeWindows).toEqual([
      { panel: 'schedule', visible: false, pinned: false }, { panel: 'widget', visible: true, pinned: false },
    ]);
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
    assert.equal(typeof await widget.evaluate(() => window.desktopBridge.getStartup()), 'boolean');
    assert.deepEqual(await widget.evaluate(() => window.desktopBridge.getPins()), { widget: false, schedule: false });

    await widget.locator('[data-add="main"]').click();
    await widget.locator('#task-input').fill('Electron smoke task');
    await widget.locator('#form button[type="submit"]').click();
    await expect(schedule.locator('.task-title').filter({ hasText: 'Electron smoke task' })).toHaveCount(1);

    await widget.locator('#settings-open').click();
    await widget.locator('#course-toggle').click();
    await widget.locator('#language-select').selectOption('en');
    await widget.locator('.theme-choice[data-value="mo"]').click();
    await widget.locator('#font-size-range').evaluate((input) => { input.value = '16'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await widget.locator('#settings-close').click();
    await expect.poll(nativeWindows).toEqual([
      { panel: 'schedule', visible: true, pinned: false }, { panel: 'widget', visible: true, pinned: false },
    ]);
    await expect.poll(async () => {
      const mainBounds = await widget.locator('#widget').boundingBox();
      const scheduleBounds = await schedule.locator('#schedule-card').boundingBox();
      return Math.abs(mainBounds.width - scheduleBounds.width);
    }).toBeLessThan(2);
    await expect.poll(() => schedule.evaluate(() => ({
      language: document.documentElement.lang,
      theme: document.getElementById('app-stack').dataset.theme,
      font: document.documentElement.style.getPropertyValue('--base-font'),
    }))).toEqual({ language: 'en', theme: 'mo', font: '16px' });

    // A locked, docked schedule still moves when the main panel is dragged.
    // Read the real Win32 region: DOM visibility misses native clipping.
    const nativeRegions = (box) => app.evaluate(({ BrowserWindow, screen }, box) => {
      const koffi = globalThis.taskboardTestRequire('koffi');
      const user32 = koffi.load('user32.dll'), gdi32 = koffi.load('gdi32.dll');
      const create = gdi32.func('uintptr_t __stdcall CreateRectRgn(int left, int top, int right, int bottom)');
      const get = user32.func('int __stdcall GetWindowRgn(uintptr_t hwnd, uintptr_t region)');
      const contains = gdi32.func('int __stdcall PtInRegion(uintptr_t region, int x, int y)');
      const release = gdi32.func('int __stdcall DeleteObject(uintptr_t object)');
      return BrowserWindow.getAllWindows().map(win => {
        const panel = new URL(win.webContents.getURL()).searchParams.get('panel');
        const region = create(0, 0, 0, 0);
        try {
          const kind = get(win.getNativeWindowHandle().readBigUInt64LE(), region);
          const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor;
          const covered = panel !== 'schedule' || !box || [8, box.width / 2, box.width - 8].every(x =>
            [8, box.height / 2, box.height - 8].every(y => contains(region, Math.round((box.x + x) * scale), Math.round((box.y + y) * scale))));
          return { panel, kind, covered: !!covered };
        } finally { release(region); }
      });
    }, box);
    await expect(schedule.locator('#schedule-lock-toggle')).toHaveAttribute('aria-pressed', 'true');
    await widget.locator('#widget .top').hover({ position: { x: 15, y: 30 } });
    const dockedBefore = await schedule.locator('#schedule-card').boundingBox();
    const mainBefore = await widget.locator('#widget').boundingBox();
    const mainHeader = await widget.locator('#widget .top').boundingBox();
    await widget.mouse.move(mainHeader.x + 15, mainHeader.y + 30);
    await widget.mouse.down();
    await widget.mouse.move(mainHeader.x - 225, mainHeader.y + 70, { steps: 12 });
    await expect.poll(async () => (await widget.locator('#widget').boundingBox()).x).toBeLessThan(mainBefore.x - 200);
    if (process.platform === 'win32') {
      await expect.poll(() => nativeRegions(null).then(windows => windows.every(win => win.kind === 0))).toBe(true);
    }
    await widget.mouse.up();
    await expect.poll(async () => {
      const main = await widget.locator('#widget').boundingBox();
      const card = await schedule.locator('#schedule-card').boundingBox();
      return Math.abs(card.x - main.x) + Math.abs(card.y - main.y - main.height - 12);
    }).toBeLessThan(2);
    // Give a delayed storage event/transition time to expose a stale mirror write.
    await schedule.waitForTimeout(400);
    const dockedAfter = await schedule.locator('#schedule-card').boundingBox();
    assert.ok(Math.abs(dockedAfter.height - dockedBefore.height) < 2, 'drag release must preserve the real locked schedule height');
    if (process.platform === 'win32') {
      await expect.poll(() => nativeRegions(dockedAfter).then(windows => windows.every(win => win.kind > 0 && win.covered))).toBe(true);
    }

    await schedule.locator('#schedule-edit').click();
    await schedule.locator('#course-name').fill('Electron smoke course');
    await schedule.locator('#course-end').selectOption('450');
    await schedule.locator('#schedule-save').click();
    await expect(schedule.locator('#toast')).toBeVisible();
    await expect(schedule.locator('#toast')).toHaveText('End time must be after start time');
    await schedule.locator('#course-end').selectOption('540');
    await schedule.locator('#schedule-save').click();
    await expect.poll(() => widget.evaluate(() => JSON.parse(localStorage.getItem('minimal-task-widget-schedule-v1') || '[]').map((course) => course.name))).toContain('Electron smoke course');

    // Reproduce the reported order: move the schedule, release the drag, then
    // activate and operate the main panel. Check native input state as well as DOM.
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      globalThis.taskboardDragCaptures = [];
      ipcMain.on('desktop:pointer-capture', (_event, value) => globalThis.taskboardDragCaptures.push(value));
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('panel=schedule')).focus();
    });
    await schedule.locator('#schedule-lock-toggle').click();
    const beforeDrag = await schedule.locator('#schedule-card').boundingBox();
    const header = await schedule.locator('.schedule-head').boundingBox();
    await schedule.mouse.move(header.x + 70, header.y + header.height / 2);
    await schedule.mouse.down();
    await schedule.mouse.move(header.x - 150, header.y + header.height / 2 + 70, { steps: 15 });
    await schedule.mouse.up();
    await expect.poll(() => app.evaluate(() => globalThis.taskboardDragCaptures)).toEqual([true, false]);
    const afterDrag = await schedule.locator('#schedule-card').boundingBox();
    assert.ok(Math.abs(afterDrag.x - beforeDrag.x) > 100, 'the native schedule was actually dragged');
    if (process.platform === 'win32') {
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
        const getStyle = globalThis.taskboardTestRequire('koffi').load('user32.dll').func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)');
        return BrowserWindow.getAllWindows().map((win) => ({
          visible: win.isVisible(),
          ignoresMouse: !!(Number(getStyle(win.getNativeWindowHandle().readBigUInt64LE(), -20)) & 0x20),
        }));
      })).toEqual([{ visible: true, ignoresMouse: false }, { visible: true, ignoresMouse: false }]);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('panel=widget')).focus());
    await widget.locator('#settings-open').click();
    await expect(widget.locator('#settings-scrim')).toHaveClass(/open/);
    await expect.poll(() => nativeWindows().then((windows) => windows.every((win) => win.visible))).toBe(true);
    await widget.locator('#settings-close').click();

    const pinResult = await widget.evaluate(() => window.desktopBridge.setPin('widget', true));
    assert.deepEqual(pinResult, { widget: true, schedule: false }, 'pin IPC accepts the owning main frame');
    await expect.poll(nativeWindows).toEqual([
      { panel: 'schedule', visible: true, pinned: false }, { panel: 'widget', visible: true, pinned: true },
    ]);
    await schedule.evaluate(() => window.desktopBridge.setPin('schedule', true));
    await expect.poll(() => nativeWindows().then((windows) => windows.every((win) => win.pinned))).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('panel=widget')).close());
    await expect.poll(() => nativeWindows().then((windows) => windows.every((win) => !win.visible && win.pinned))).toBe(true);
    await app.evaluate(({ app }) => app.emit('second-instance'));
    await expect.poll(() => nativeWindows().then((windows) => windows.every((win) => win.visible && win.pinned))).toBe(true);
    await widget.evaluate(() => window.desktopBridge.setPin('widget', false));
    await schedule.evaluate(() => window.desktopBridge.setPin('schedule', false));
    if (process.platform === 'win32') {
      // A separate ordinary window must cover both unpinned panels after the
      // desktop boost is removed. Native false alone does not prove the Z-order.
      await app.evaluate(async ({ BrowserWindow }) => {
        const win = new BrowserWindow({ width: 400, height: 240, show: false, title: 'Taskboard smoke foreground app' });
        globalThis.taskboardTestForeground = win;
        await win.loadURL('data:text/html,<title>Taskboard smoke foreground app</title><p>Temporary foreground window</p>');
        win.show();
      });
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
        const front = globalThis.taskboardTestForeground;
        const getPrevious = globalThis.taskboardTestRequire('koffi').load('user32.dll')
          .func('uintptr_t __stdcall GetWindow(uintptr_t hwnd, unsigned int command)');
        const frontHandle = String(front.getNativeWindowHandle().readBigUInt64LE());
        return BrowserWindow.getAllWindows().filter(win => win !== front).every(win => {
          if (win.isAlwaysOnTop()) return false;
          let hwnd = win.getNativeWindowHandle().readBigUInt64LE();
          const visited = new Set();
          while (hwnd && !visited.has(String(hwnd))) {
            visited.add(String(hwnd)); hwnd = getPrevious(hwnd, 3);
            if (String(hwnd) === frontHandle) return true;
          }
          return false;
        });
      })).toBe(true);
      assert.deepEqual(await widget.evaluate(() => window.desktopBridge.getPins()), { widget: false, schedule: false });
      // Hand activation back while this process still owns the foreground.
      // Destroying it first lets Windows activate an unrelated application.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .find(win => win.webContents.getURL().includes('panel=schedule')).focus());
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
        const handles = BrowserWindow.getAllWindows().filter(win => win !== globalThis.taskboardTestForeground)
          .map(win => win.getNativeWindowHandle());
        return globalThis.taskboardTestRequire('./windows-desktop.cjs').foregroundContext(handles);
      })).toBe('panel');
      await app.evaluate(() => globalThis.taskboardTestForeground.destroy());
      // Exercise persistent native callbacks in Electron's actual message loop.
      await app.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        windows.find(win => win.webContents.getURL().includes('panel=widget')).focus();
        globalThis.taskboardNativeEvents = 0;
        globalThis.taskboardStopNativeWatch = globalThis.taskboardTestRequire('./windows-desktop.cjs')
          .watchChanges(() => { globalThis.taskboardNativeEvents++; });
        if (!globalThis.taskboardStopNativeWatch) throw new Error('Native desktop event hooks were not installed');
        windows.find(win => win.webContents.getURL().includes('panel=schedule')).focus();
      });
      await expect.poll(() => app.evaluate(() => globalThis.taskboardNativeEvents)).toBeGreaterThan(0);
      assert.equal(await app.evaluate(async ({ BrowserWindow }) => {
        globalThis.taskboardStopNativeWatch();
        const count = globalThis.taskboardNativeEvents;
        BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('panel=widget')).focus();
        await new Promise(resolve => setTimeout(resolve, 100));
        return globalThis.taskboardNativeEvents === count;
      }), true, 'unhooked native callbacks must not run on subsequent foreground changes');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .find(win => win.webContents.getURL().includes('panel=schedule')).focus());
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
        const desktop = globalThis.taskboardTestRequire('./windows-desktop.cjs');
        const handles = BrowserWindow.getAllWindows().map(win => win.getNativeWindowHandle());
        return { foreground: desktop.foregroundContext(handles), topmost: handles.every(handle => desktop.isTopmost(handle)) };
      })).toEqual({ foreground: 'panel', topmost: true });
      // Simulate an OS-level demotion without changing Chromium's requested
      // level. The native state must be repaired even if its cached value differs.
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('panel=widget'));
        const setPosition = globalThis.taskboardTestRequire('koffi').load('user32.dll')
          .func('int __stdcall SetWindowPos(uintptr_t hwnd, intptr_t after, int x, int y, int width, int height, unsigned int flags)');
        if (!setPosition(win.getNativeWindowHandle().readBigUInt64LE(), -2, 0, 0, 0, 0, 0x213)) throw new Error('Cannot inject native demotion');
      });
      let recoveryState;
      try {
        await expect.poll(async () => {
          recoveryState = await app.evaluate(({ BrowserWindow }) => {
            const desktop = globalThis.taskboardTestRequire('./windows-desktop.cjs');
            const windows = BrowserWindow.getAllWindows();
            return {
              foreground: desktop.foregroundContext(windows.map(win => win.getNativeWindowHandle())),
              windows: windows.map(win => ({
                panel: new URL(win.webContents.getURL()).searchParams.get('panel'),
                native: desktop.isTopmost(win.getNativeWindowHandle()), cached: win.isAlwaysOnTop(),
                focused: win.isFocused(),
              })),
            };
          });
          return recoveryState.foreground === 'panel' && recoveryState.windows.every(win => win.native);
        }).toBe(true);
      } catch (error) {
        console.error('Native demotion recovery state:', JSON.stringify(recoveryState));
        throw error;
      }
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('panel=widget'));
        win.minimize();
      });
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('panel=widget'));
        return { visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(), pinned: win.isAlwaysOnTop() };
      })).toEqual({ visible: true, minimized: false, focused: false, pinned: true });
      assert.deepEqual(await widget.evaluate(() => window.desktopBridge.getPins()), { widget: false, schedule: false }, 'desktop boosts must not turn on user Pin');
    }
    const bounds = await widget.evaluate(() => window.desktopBridge.getWidgetBounds());
    assert.ok(bounds.width > 0 && bounds.height > 0, 'renderer bounds reach the native process');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('panel=widget')).close());
    await expect.poll(() => nativeWindows().then((windows) => windows.every((win) => !win.visible))).toBe(true);
    await schedule.reload();
    await schedule.waitForFunction(() => window.desktopBridge && document.getElementById('schedule-grid').children.length > 0);
    await expect.poll(() => nativeWindows().then((windows) => windows.every((win) => !win.visible))).toBe(true);
    await app.evaluate(({ app }) => app.emit('second-instance'));
    await expect.poll(() => nativeWindows().then((windows) => windows.every((win) => win.visible))).toBe(true);
    await expect(schedule.locator('.schedule-course')).toContainText('Electron smoke course');
    await widget.locator('#settings-open').click();
    await widget.locator('#course-toggle').click();
    await widget.locator('#settings-close').click();
    await expect.poll(nativeWindows).toEqual([
      { panel: 'schedule', visible: false, pinned: false }, { panel: 'widget', visible: true, pinned: false },
    ]);
    assert.deepEqual(errors, [], 'no uncaught errors in Electron renderers');
    console.log('Electron smoke passed: isolated profile, preload/IPC, tasks/courses, settings sync, locked docked drag and native clipping, schedule drag and native input release, independent pins, native visibility, native event subscription/unhook, minimize recovery, hidden reload and restore.');
    console.log('Physical first clicks, Win+D, login changes, reboot, tray clicks and macOS behavior require manual validation.');
  } finally {
    if (app) await app.close();
    // Only remove the disposable directory created by this invocation.
    if (path.dirname(path.resolve(temporary)) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('taskboard-smoke-')) {
      await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
