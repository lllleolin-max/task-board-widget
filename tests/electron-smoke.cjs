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
  await fs.mkdir(profile);
  await fs.writeFile(entry, `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(profile)});\nrequire(${JSON.stringify(path.join(appRoot, 'main.cjs'))});\n`);
  let app;
  const errors = [];
  try {
    // Avoid inheriting Electron's Node-only mode from terminal integrations.
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: require('electron'), args: [entry], cwd: root, env, timeout: 30000 });
    app.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    await expect.poll(() => app.windows().length).toBe(2);
    const widget = app.windows().find((page) => page.url().includes('panel=widget'));
    const schedule = app.windows().find((page) => page.url().includes('panel=schedule'));
    assert.ok(widget && schedule, 'both panel pages loaded');
    for (const page of [widget, schedule]) await page.waitForFunction(() => window.desktopBridge && document.getElementById('schedule-grid').children.length > 0);
    const nativeWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => ({
      panel: new URL(win.webContents.getURL()).searchParams.get('panel'), visible: win.isVisible(), pinned: win.isAlwaysOnTop(),
    })).sort((a, b) => a.panel.localeCompare(b.panel)));
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

    await schedule.locator('#schedule-edit').click();
    await schedule.locator('#course-name').fill('Electron smoke course');
    await schedule.locator('#course-end').selectOption('450');
    await schedule.locator('#schedule-save').click();
    await expect(schedule.locator('#toast')).toBeVisible();
    await expect(schedule.locator('#toast')).toHaveText('End time must be after start time');
    await schedule.locator('#course-end').selectOption('540');
    await schedule.locator('#schedule-save').click();
    await expect.poll(() => widget.evaluate(() => JSON.parse(localStorage.getItem('minimal-task-widget-schedule-v1') || '[]').map((course) => course.name))).toContain('Electron smoke course');

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
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('panel=schedule')).focus());
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('panel=schedule')).isFocused())).toBe(true);
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('panel=widget'));
        win.minimize();
      });
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('panel=widget'));
        return { visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(), pinned: win.isAlwaysOnTop() };
      })).toEqual({ visible: true, minimized: false, focused: false, pinned: false });
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
    console.log('Electron smoke passed: isolated profile, preload/IPC, tasks/courses, settings sync, docking, independent pins, native visibility, minimize recovery, hidden reload and restore.');
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
