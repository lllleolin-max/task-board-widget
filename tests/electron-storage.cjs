// Separate desktop integration test: npm run test:electron-storage.
// All database replacement happens inside the directory created by mkdtemp.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron, expect } = require('@playwright/test');

const KEYS = {
  tasks: 'minimal-task-widget-v1',
  courses: 'minimal-task-widget-schedule-v1',
  settings: 'minimal-task-widget-settings-v1',
  layout: 'minimal-task-widget-schedule-layout-v1',
  draft: 'minimal-task-widget-draft-html-v1',
  draftTitle: 'minimal-task-widget-draft-title-v1',
  unknown: 'taskboard-legacy-extension-data',
  removed: 'taskboard-deleted-extension-data',
};
const DAY = '2026-09-20';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const PERIOD = { mode: 'day', start: DAY, end: DAY };
const encode = value => JSON.stringify(value, null, 2) + '\n';
const task = (id, title) => ({
  id, title, type: 'main', date: DAY, dateStart: DAY, dateEnd: DAY,
  period: PERIOD, done: false, pinned: false, items: [], memos: [],
});

async function main() {
  const root = path.resolve(__dirname, '..');
  const appRoot = process.env.TASKBOARD_SMOKE_APP ? path.resolve(process.env.TASKBOARD_SMOKE_APP) : root;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'taskboard-storage-'));
  const profile = path.join(temporary, 'profile');
  const localStoragePath = path.join(profile, 'Local Storage');
  const entry = path.join(temporary, 'entry.cjs');
  const oldDatabase = path.join(temporary, 'old-local-storage');
  await fs.mkdir(profile);
  await fs.writeFile(entry, `const { app } = require('electron');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
app.setPath('userData', ${JSON.stringify(profile)});
app.setPath('sessionData', ${JSON.stringify(profile)});
require(${JSON.stringify(path.join(appRoot, 'main.cjs'))});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, widget, schedule, passed = false;
  const errors = [];

  function isolated(target) {
    const resolved = path.resolve(target);
    assert.ok(resolved.startsWith(temporary + path.sep), 'File operations must stay inside this test profile');
    return resolved;
  }
  const snapshot = page => page.evaluate(() => Object.fromEntries(
    Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]),
  ));
  async function launch() {
    app = await _electron.launch({ executablePath: require('electron'), args: [entry], cwd: root, env, timeout: 30000 });
    await expect.poll(() => app.windows().length).toBe(2);
    widget = app.windows().find(page => page.url().includes('panel=widget'));
    schedule = app.windows().find(page => page.url().includes('panel=schedule'));
    assert.ok(widget && schedule, 'Both production panel pages must load');
    assert.deepEqual(await app.evaluate(({ app }) => ({
      userData: app.getPath('userData'), sessionData: app.getPath('sessionData'),
    })), { userData: profile, sessionData: profile });
    for (const page of [widget, schedule]) {
      page.on('pageerror', error => errors.push(error.message));
      await page.waitForFunction(() => !!window.desktopBridge);
      assert.equal(await page.evaluate(() => window.desktopBridge.isStorageReady()), true,
        `Storage bootstrap must succeed in ${new URL(page.url()).searchParams.get('panel')}`);
      await page.waitForFunction(() => document.getElementById('schedule-grid').children.length > 0);
    }
  }
  async function close() {
    if (!app) return;
    await app.evaluate(({ session }) => session.defaultSession.flushStorageData());
    await app.close();
    app = null;
  }
  async function write(key, value, page = widget) {
    assert.equal(await page.evaluate(({ key, value }) => window.desktopBridge.writeStorage(key, value), { key, value }), true,
      `The normal safeguarded storage API must accept ${key}`);
    for (const panel of [widget, schedule]) {
      await expect.poll(() => panel.evaluate(key => localStorage.getItem(key), key)).toBe(value);
    }
  }
  async function reloadPanels() {
    for (const page of [widget, schedule]) {
      await page.reload();
      await page.waitForFunction(() => window.desktopBridge?.isStorageReady() &&
        document.getElementById('schedule-grid').children.length > 0);
    }
  }
  async function checkRaw(expected) {
    for (const panel of [widget, schedule]) await expect.poll(() => snapshot(panel)).toEqual(expected);
  }
  async function checkContent(expected) {
    await checkRaw(expected);
    await expect(widget.locator('.task[data-id="history"]')).toHaveClass(/done/);
    await expect(widget.locator('.task[data-id="history"] .task-title')).toHaveText('完整的历史任务');
    await expect(widget.locator('.task[data-id="added-later"] .task-title')).toHaveText('较新任务');
    await expect(widget.locator('.task[data-id="deleted-task"]')).toHaveCount(0);
    await expect(schedule.locator('.schedule-course')).toHaveCount(2);
    assert.equal(await widget.evaluate(key => localStorage.getItem(key), KEYS.removed), null,
      'A legitimately removed key must not be resurrected from the older database');
  }

  try {
    await launch();
    const settings = {
      timezone: 'Asia/Shanghai', language: 'zh-CN', fontSize: 14, theme: 'default',
      periodMode: 'day', periodStart: DAY, periodEnd: DAY, followSystemDate: false,
      courseEnabled: true, extension: { untouched: ['old-format', null, 7] },
    };
    const victim = task('deleted-task', '稍后合法删除');
    const history = task('history', '较早的历史标题');
    const removedCourse = { id: 'deleted-course', name: '稍后删除的课程', day: 1, start: 540, end: 600, teacher: '', room: '' };
    await write(KEYS.settings, encode(settings));
    // A floating schedule has no live dock geometry derived from changing task
    // card heights, so its persisted layout can also be compared byte for byte.
    await write(KEYS.layout, encode({ floating: true, left: 120, top: 200, width: 352, height: 260, customSize: true, dockEdge: 'bottom' }));
    await write(KEYS.tasks, encode([history, victim]));
    await write(KEYS.courses, encode([removedCourse]));
    await write(KEYS.draft, '<p>较早的草稿</p>');
    await write(KEYS.draftTitle, '较早标题');
    await write(KEYS.unknown, '  {"revision":1,"keep":"unknown"}\n');
    await write(KEYS.removed, 'old value that will be intentionally removed');
    await reloadPanels();
    await close();
    await fs.cp(isolated(localStoragePath), isolated(oldDatabase), { recursive: true, errorOnExist: true, force: false });

    // These are normal, acknowledged application writes. The older database
    // predates the additions, changes and intentional deletions below.
    await launch();
    const completed = {
      ...history, title: '完整的历史任务', done: true, completedOn: DAY, pinned: true,
      items: [{ text: '含图片的原有说明', done: true, image: PNG, unknownNote: { keep: true } }],
      memos: [{ title: '原有备注', html: `<p><b>完整正文</b><img src="${PNG}"></p>`, unknownMemo: [1, '保留'] }],
      extension: { nested: ['保留未知字段', null, { value: 42 }] },
    };
    const added = task('added-later', '较新任务');
    const courses = [
      { id: 'course-one', name: '较新线性代数', day: 2, start: 540, end: 600, teacher: '王老师', room: 'A203', extension: { semester: '2026秋' } },
      { id: 'course-two', name: '较新实验课', day: 4, start: 660, end: 720, teacher: '陈老师', room: 'B405', extension: ['完整', 2] },
    ];
    await write(KEYS.tasks, encode([completed, victim, added]));
    await write(KEYS.courses, encode([removedCourse, ...courses]), schedule);
    await write(KEYS.draft, `<p><b>未保存到任务的草稿</b><img src="${PNG}"></p>`);
    await write(KEYS.draftTitle, '较新的草稿标题');
    await write(KEYS.unknown, '  {"revision":2,"nested":[null,"原样保留"]}\n');
    await write(KEYS.tasks, encode([completed, added]));
    await write(KEYS.courses, encode(courses), schedule);
    await write(KEYS.removed, null);
    await reloadPanels();
    const expected = await snapshot(widget);
    assert.equal(expected[KEYS.tasks], encode([completed, added]));
    assert.equal(expected[KEYS.courses], encode(courses));
    assert.equal(expected[KEYS.unknown], '  {"revision":2,"nested":[null,"原样保留"]}\n');
    assert.ok(!Object.hasOwn(expected, KEYS.removed));
    await checkContent(expected);
    await close();
    assert.ok((await fs.readdir(isolated(path.join(profile, 'data-safety')))).length > 0,
      'Independent durable snapshots must exist before simulating a database rollback');

    // Replacing the whole closed database recreates a rollback without mixing
    // old and new LevelDB files. Keep the newer copy as test evidence.
    await fs.rename(isolated(localStoragePath), isolated(path.join(temporary, 'latest-local-storage')));
    await fs.cp(isolated(oldDatabase), isolated(localStoragePath), { recursive: true, errorOnExist: true, force: false });
    await launch();
    assert.ok(await widget.evaluate(() => window.desktopBridge.storageRecovered) ||
      await schedule.evaluate(() => window.desktopBridge.storageRecovered), 'The rollback must be detected at bootstrap');
    await checkContent(expected);
    await close();

    // Also cover total loss of Local Storage while its independent snapshot
    // remains. Moving it aside avoids destroying useful failure evidence.
    await fs.rename(isolated(localStoragePath), isolated(path.join(temporary, 'recovered-local-storage')));
    await launch();
    await checkContent(expected);
    await close();
    await launch();
    await checkContent(expected);
    assert.deepEqual(errors, [], 'No renderer errors during snapshot recovery');
    passed = true;
    console.log('Electron storage passed: isolated userData/sessionData, acknowledged writes from both panels, stale and missing Local Storage recovery, exact raw keys, history/images/drafts/unknown fields, and no resurrection of legitimate deletions after repeated restarts.');
  } finally {
    await close();
    if (passed && path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('taskboard-storage-')) {
      await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } else console.error(`Isolated storage test evidence retained at: ${temporary}`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
