const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const KEYS = {
  tasks: 'minimal-task-widget-v1',
  courses: 'minimal-task-widget-schedule-v1',
  draft: 'minimal-task-widget-draft-html-v1',
  draftTitle: 'minimal-task-widget-draft-title-v1',
  settings: 'minimal-task-widget-settings-v1',
  collapsed: 'minimal-task-widget-collapsed-v1',
  locked: 'minimal-task-widget-locked-v1',
  scheduleLocked: 'minimal-task-widget-schedule-locked-v1',
  scheduleCollapsed: 'minimal-task-widget-schedule-collapsed-v1',
  layout: 'minimal-task-widget-schedule-layout-v1',
  unknown: 'taskboard-legacy-extension-data',
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const DAY = '2026-09-20';
const PERIOD = { mode: 'day', start: DAY, end: DAY };

function fixture() {
  const records = [
    {
      id: 'history-main-done', type: 'main', title: '原有已完成主线',
      date: '2026-09-18', dateStart: '2026-09-18', dateEnd: DAY,
      period: { mode: 'custom', start: '2026-09-18', end: DAY },
      done: true, pinned: true, time: '09:15',
      // A pre-completedOn record must remain available on its original dates.
      items: [{ text: '旧版图片说明', done: true, image: PNG, legacyNote: { source: 'import' } }],
      memos: [{ title: '历史备忘', html: `<p><b>完整历史内容</b><img src="${PNG}"></p>`, legacyMemo: ['keep', 1] }],
      extension: { revision: 7, tags: ['中文', 'keep'], nullable: null },
    },
    {
      id: 'history-main-open', type: 'main', title: '原有未完成主线',
      date: DAY, dateStart: '', dateEnd: DAY, period: PERIOD,
      done: false, pinned: false, time: '', items: [], memos: [],
      legacyPriority: 3,
    },
    {
      id: 'history-side-done', type: 'side', title: '原有已完成支线',
      date: '', dateStart: '', dateEnd: '', period: PERIOD,
      done: true, completedOn: DAY, pinned: false, time: '14:15',
      items: [{ text: '原有检查项', done: true, extension: { retained: true } }], memos: [],
    },
    {
      id: 'history-side-open', type: 'side', title: '原有未完成支线',
      date: '', dateStart: '', dateEnd: '', period: PERIOD,
      done: false, pinned: true, time: '20:30', items: [], memos: [],
      extension: { untouched: '保留未操作记录' },
    },
  ];
  const courses = [
    { id: 'course-one', name: '原有线性代数', day: 1, start: 540, end: 600, teacher: '王老师', room: '旧教室 A203', extension: { semester: '2026 秋' } },
    { id: 'course-two', name: '原有实验课', day: 4, start: 1110, end: 1200, teacher: '陈老师', room: '实验楼 405', extension: ['保留', 42] },
  ];
  const raw = {
    [KEYS.tasks]: JSON.stringify(records, null, 2) + '\n',
    [KEYS.courses]: JSON.stringify(courses, null, 2) + '\n',
    [KEYS.draft]: `<div><b>尚未提交的原有草稿</b><p>第二段正文</p><img src="${PNG}" alt="旧图片"></div>`,
    [KEYS.draftTitle]: '原有草稿标题',
    [KEYS.settings]: JSON.stringify({
      timezone: 'Asia/Tokyo', fontSize: 16, theme: 'mo', language: 'zh-CN',
      periodMode: 'day', periodStart: '2026-09-29', periodEnd: '2026-09-29',
      followSystemDate: false, courseEnabled: true,
      manualTime: Date.parse('2026-09-30T04:00:00Z'),
      manualTimeSavedAt: Date.parse('2026-09-30T04:00:00Z'),
      legacyPreference: { retained: true },
    }),
    [KEYS.collapsed]: '1', [KEYS.locked]: '1',
    [KEYS.scheduleLocked]: '1', [KEYS.scheduleCollapsed]: '1',
    [KEYS.layout]: JSON.stringify({
      floating: true, left: 90, top: 520, width: 430, height: 350,
      customSize: true, dockEdge: 'left', legacyLayout: { retained: true },
    }),
    [KEYS.unknown]: '  {"保留未知数据": [1, null, "unchanged"]}\n',
  };
  return { records, courses, raw };
}

async function snapshot(page, keys) {
  return page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), keys);
}

test('replacing the app preserves prior raw data across a persistent-profile restart and later user edits', async ({}, testInfo) => {
  test.setTimeout(60000);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskboard-upgrade-'));
  const appDir = path.join(tempRoot, 'app');
  const profile = path.join(tempRoot, 'profile');
  const appFile = path.join(appDir, 'index.html');
  const appUrl = pathToFileURL(appFile).href;
  const { records, courses, raw } = fixture();
  const errors = [];
  let context, page;
  async function launch() {
    context = await chromium.launchPersistentContext(profile, {
      headless: true, viewport: { width: 1600, height: 1100 },
      timezoneId: 'Asia/Shanghai', locale: 'zh-CN',
    });
    page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-09-30T04:00:00Z'));
    await page.goto(appUrl);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  try {
    await fs.mkdir(appDir, { recursive: true });
    await fs.cp(path.join(ROOT, 'themes'), path.join(appDir, 'themes'), { recursive: true });
    const currentSource = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
    const oldSource = process.env.TASKBOARD_UPGRADE_FROM
      ? await fs.readFile(path.resolve(process.env.TASKBOARD_UPGRADE_FROM), 'utf8')
      : '<!doctype html><html lang="zh-CN"><title>旧格式存储写入端</title><body>仅用于旧数据格式升级验证</body></html>';
    // The default is deliberately a storage writer, not an asserted historical
    // application build. An optional actual older HTML also loads the fixture.
    testInfo.annotations.push({ type: 'upgrade-source', description: process.env.TASKBOARD_UPGRADE_FROM ? 'Provided older HTML; same isolated file URL and profile' : 'Minimal legacy-format storage writer; not a historical app build' });
    await fs.writeFile(appFile, oldSource);
    await launch();
    await page.evaluate(raw => {
      localStorage.clear();
      for (const [key, value] of Object.entries(raw)) localStorage.setItem(key, value);
    }, raw);
    await page.reload();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await snapshot(page, Object.keys(raw)), 'The source profile contains the exact prior data').toEqual(raw);
    await context.close();
    context = null;

    await fs.writeFile(appFile, currentSource);
    await launch();
    await expect(page.locator('#widget')).toBeVisible();
    await expect(page.locator('.schedule-slot')).toHaveCount(210);
    expect(await snapshot(page, Object.keys(raw)), 'Starting the updated app must not rewrite any stored fixture value').toEqual(raw);
    await expect(page.locator('#widget')).toHaveClass(/collapsed/);
    await expect(page.locator('#widget')).toHaveClass(/locked/);
    await expect(page.locator('#widget')).toHaveAttribute('data-theme', 'mo');
    await expect(page.locator('#font-size-range')).toHaveValue('16');
    await expect(page.locator('#timezone-select')).toHaveValue('Asia/Tokyo');
    await expect(page.locator('#course-toggle')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#schedule-card')).toHaveClass(/schedule-collapsed/);
    await expect(page.locator('#schedule-lock-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#app-stack')).toHaveClass(/schedule-floating/);

    await page.locator('#collapse-toggle').click();
    await page.locator('#today-date').click();
    await page.locator('#period-range input').fill(DAY);
    await page.locator('#period-apply').click();
    for (const record of records) {
      const task = page.locator(`.task[data-id="${record.id}"]`);
      await expect(task.locator('.task-title')).toHaveText(record.title);
      if (record.done) await expect(task).toHaveClass(/done/);
      else await expect(task).not.toHaveClass(/done/);
    }
    const originalTask = page.locator('.task[data-id="history-main-done"]');
    await originalTask.locator('.expand').click();
    await expect(originalTask.locator('.memo-body b')).toHaveText('完整历史内容');
    await expect(originalTask.locator('.memo-body img')).toHaveAttribute('src', PNG);
    await expect(originalTask.locator('.note-text img')).toHaveAttribute('src', PNG);
    await originalTask.locator('.expand').click();

    await page.locator('#draft-open').click();
    await expect(page.locator('#draft-title')).toHaveValue('原有草稿标题');
    await expect(page.locator('#draft-editor')).toContainText('尚未提交的原有草稿');
    await expect(page.locator('#draft-editor')).toContainText('第二段正文');
    await expect(page.locator('#draft-editor img')).toHaveAttribute('src', PNG);
    await page.locator('#draft-minimize').click();
    await page.locator('#schedule-collapse').click();
    await page.locator('.schedule-course', { hasText: '原有线性代数' }).click();
    for (const [selector, value] of Object.entries({
      '#course-name': courses[0].name, '#course-teacher': courses[0].teacher,
      '#course-room': courses[0].room, '#course-day': '1', '#course-start': '540', '#course-end': '600',
    })) await expect(page.locator(selector)).toHaveValue(value);
    await page.locator('#schedule-cancel').click();
    const untouchedKeys = [KEYS.tasks, KEYS.courses, KEYS.draft, KEYS.draftTitle, KEYS.unknown];
    expect(await snapshot(page, untouchedKeys), 'Reading history and opening editors must not rewrite user content')
      .toEqual(Object.fromEntries(untouchedKeys.map(key => [key, raw[key]])));

    await page.locator('[data-add="side"]').click();
    await page.locator('#task-input').fill('升级后新增任务');
    await page.locator('#form button[type="submit"]').click();
    const afterTasks = JSON.parse((await snapshot(page, [KEYS.tasks]))[KEYS.tasks]);
    expect(afterTasks).toHaveLength(records.length + 1);
    for (const record of records) expect(afterTasks.find(task => task.id === record.id)).toMatchObject(record);
    await page.locator('.schedule-course', { hasText: '原有线性代数' }).click();
    await page.locator('#course-room').fill('升级后新教室 B204');
    await page.locator('#schedule-save').click();
    const afterCourses = JSON.parse((await snapshot(page, [KEYS.courses]))[KEYS.courses]);
    expect(afterCourses).toHaveLength(courses.length);
    expect(afterCourses.find(course => course.id === courses[0].id)).toEqual({ ...courses[0], room: '升级后新教室 B204' });
    expect(afterCourses.find(course => course.id === courses[1].id)).toEqual(courses[1]);
    const unchangedKeys = [KEYS.draft, KEYS.draftTitle, KEYS.unknown, KEYS.locked, KEYS.scheduleLocked, KEYS.layout];
    expect(await snapshot(page, unchangedKeys)).toEqual(Object.fromEntries(unchangedKeys.map(key => [key, raw[key]])));
    await page.reload();
    for (const record of records) await expect(page.locator(`.task[data-id="${record.id}"] .task-title`)).toHaveText(record.title);
    await expect(page.locator('.task-title', { hasText: '升级后新增任务' })).toBeVisible();
    expect(errors, 'Both storage startup and the upgraded renderer remain usable').toEqual([]);
  } finally {
    try {
      if (context) await context.close();
    } finally {
      // Only remove the unique directory allocated for this test, never a real profile.
      expect(path.dirname(path.resolve(tempRoot))).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(tempRoot)).toMatch(/^taskboard-upgrade-/);
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});
