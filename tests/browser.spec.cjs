const { test: base, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const TASKS = 'minimal-task-widget-v1';
const SETTINGS = 'minimal-task-widget-settings-v1';
const COURSES = 'minimal-task-widget-schedule-v1';
const TODAY = '2026-09-29';

// Each test gets a disposable browser context, never the user's browser profile.
// Exercise file:// because direct opening is the documented, build-free entrypoint.
const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-09-29T04:00:00Z'));
    await page.goto(url);
    await use(page);
    expect(errors, 'No uncaught renderer errors during user interactions').toEqual([]);
  },
});

async function stored(page, key) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
}

async function addTask(page, title, type = 'main', time = '') {
  await page.locator(`[data-add="${type}"]`).click();
  await expect(page.locator('#task-input')).toBeFocused();
  await page.locator('#task-input').fill(title);
  if (time) await page.locator('#time-input').fill(time);
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('#scrim')).not.toHaveClass(/open/);
  return page.locator('.task').filter({ has: page.locator('.task-title', { hasText: title }) });
}

async function choosePeriod(page, mode, start = TODAY, end = start) {
  await page.locator('#period-open').click();
  await page.locator(`[data-period="${mode}"]`).click();
  await page.locator('#period-range input').first().fill(start);
  if (mode === 'custom') await page.locator('#period-range input').nth(1).fill(end);
  await page.locator('#period-apply').click();
}

async function enableSchedule(page) {
  await page.locator('#settings-open').click();
  await page.locator('#course-toggle').click();
  await page.locator('#settings-close').click();
  await expect(page.locator('#schedule-card')).toBeVisible();
}

async function addCourse(page, name = '高等数学') {
  await page.locator('#schedule-edit').click();
  await expect(page.locator('#course-name')).toBeFocused();
  await page.locator('#course-name').fill(name);
  await page.locator('#course-room').fill('教学楼 201');
  await page.locator('#course-teacher').fill('李老师');
  await page.locator('#schedule-save').click();
  return page.locator('.schedule-course').filter({ hasText: name });
}

async function dragBy(page, locator, dx, dy, position = {}) {
  await locator.hover(); // Wait for layout transitions before reading pointer coordinates.
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  const x = box.x + (position.x ?? box.width / 2);
  const y = box.y + (position.y ?? box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}

test('task creation, completion counts and persistence', async ({ page }) => {
  await expect(page.locator('.task')).toHaveCount(0);
  await expect(page.locator('#main-count')).toHaveText('0 项待办');
  await expect(page.locator('#side-count')).toHaveText('0 项待办');
  const main = await addTask(page, '提交实验报告');
  const side = await addTask(page, '预约讨论', 'side', '14:30');
  await expect(main.locator('.deadline')).toHaveText('今天');
  await expect(side.locator('.deadline')).toHaveText('14:30');
  await expect(page.locator('#main-count')).toHaveText('1 项待办');
  await main.locator('.check').click();
  await expect(main).toHaveClass(/done/);
  await expect(page.locator('#main-count')).toHaveText('0 项待办');
  await page.reload();
  await expect(main).toHaveClass(/done/);
  await expect(side).toBeVisible();
  await main.locator('.check').click();
  await expect(page.locator('#main-count')).toHaveText('1 项待办');
});

test('task dialogs reject whitespace and support cancel and Escape', async ({ page }) => {
  await page.locator('[data-add="main"]').click();
  await page.locator('#task-input').fill('   ');
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('#scrim')).toHaveClass(/open/);
  await expect(page.locator('.task')).toHaveCount(0);
  await page.locator('#cancel').click();
  await page.locator('[data-add="side"]').click();
  await page.locator('#task-input').fill('d is ordinary input');
  await expect(page.locator('#draft-window')).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#scrim')).not.toBeVisible();
});

test('task date range validates completion and appears on overlapping days', async ({ page }) => {
  await page.locator('[data-add="main"]').click();
  await page.locator('#task-input').fill('跨日任务');
  await page.locator('#task-date-range').click();
  await page.locator('.task-calendar-day:not(.outside)').filter({ hasText: /^30$/ }).click();
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('#scrim')).toHaveClass(/open/);
  await expect(page.locator('#toast')).toContainText('请选择完整的日期范围');
  await page.locator('.task-calendar-day:not(.outside)').filter({ hasText: /^28$/ }).click();
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('.task .deadline')).toHaveText('9/28–9/30');
  await choosePeriod(page, 'day', '2026-09-30');
  await expect(page.locator('.task-title')).toHaveText('跨日任务');
  await choosePeriod(page, 'day', '2026-10-01');
  await expect(page.locator('.task')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#today-date')).toContainText('10月1日');
});

test('calendar month navigation and today shortcut select correct dates', async ({ page }) => {
  await page.locator('[data-add="main"]').click();
  await page.locator('#task-calendar-next').click();
  await expect(page.locator('#task-calendar-month')).toContainText('10月');
  await page.locator('#task-calendar-prev').click();
  await expect(page.locator('#task-calendar-month')).toContainText('9月');
  await page.locator('.task-calendar-day:not(.outside)').filter({ hasText: /^1$/ }).click();
  await page.locator('#task-date-today').click();
  await expect(page.locator('#date-input')).toHaveValue(TODAY);
  await expect(page.locator('#date-end-input')).toHaveValue(TODAY);
});

test('week, month, custom and direct date filters retain their expected ranges', async ({ page }) => {
  await addTask(page, '今天的任务');
  await choosePeriod(page, 'week');
  expect(await stored(page, SETTINGS)).toMatchObject({ periodStart: '2026-09-28', periodEnd: '2026-10-04' });
  await expect(page.locator('.task-title')).toHaveText('今天的任务');
  await choosePeriod(page, 'month');
  expect(await stored(page, SETTINGS)).toMatchObject({ periodStart: '2026-09-01', periodEnd: '2026-09-30' });
  await choosePeriod(page, 'custom', '2026-09-28', '2026-09-30');
  await expect(page.locator('.task-title')).toHaveText('今天的任务');
  await page.locator('#today-date').click();
  await expect(page.locator('#period-kind')).toBeHidden();
  await page.locator('#period-range input').fill('2026-10-02');
  await page.locator('#period-apply').click();
  await expect(page.locator('.task')).toHaveCount(0);
});

test('invalid custom ranges stay open and preserve the previous filter', async ({ page }) => {
  const previous = await stored(page, SETTINGS);
  await page.locator('#period-open').click();
  await page.locator('[data-period="custom"]').click();
  await page.locator('#period-range input').first().fill('2026-09-30');
  await page.locator('#period-range input').nth(1).fill('2026-09-28');
  await page.locator('#period-apply').click();
  await expect(page.locator('#period-scrim')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('请检查自定义周期');
  expect(await stored(page, SETTINGS)).toEqual(previous);
  await expect(page.locator('#period-open')).toHaveText('日待办⌄');
});

test('inline notes support cancel, keyboard save and completion persistence', async ({ page }) => {
  const row = await addTask(page, '有步骤的任务');
  await row.locator('.task-title').click();
  await row.locator('.inline-add').click();
  await row.locator('.inline-note').fill('不保留');
  await row.locator('.inline-note').press('Escape');
  await expect(row.locator('.note-row')).toHaveCount(0);
  await row.locator('.inline-add').click();
  await row.locator('.inline-note').fill('检查数据\n完成初稿');
  await row.locator('.inline-note').press('Control+Enter');
  await expect(row.locator('.note-text')).toHaveText('检查数据\n完成初稿');
  await row.locator('.note-check').click();
  await expect(row).toHaveClass(/open/);
  await expect(row.locator('.note-row')).toHaveClass(/note-done/);
  await page.reload();
  await row.locator('.expand').click();
  await expect(row.locator('.note-row')).toHaveClass(/note-done/);
  await row.locator('.note-text').click();
  expect((await stored(page, TASKS))[0].items[0].done).toBe(false);
});

test('scratchpad shortcut, automatic saving and close controls', async ({ page }) => {
  await page.keyboard.press('d');
  await expect(page.locator('#draft-window')).toBeVisible();
  await page.locator('#draft-title').fill('实验想法');
  await page.locator('#draft-editor').fill('尝试第二种参数组合');
  await page.locator('#draft-minimize').click();
  await expect(page.locator('#draft-window')).not.toBeVisible();
  await page.reload();
  await page.locator('#draft-open').click();
  await expect(page.locator('#draft-title')).toHaveValue('实验想法');
  await expect(page.locator('#draft-editor')).toHaveText('尝试第二种参数组合');
  await page.locator('#draft-close').click();
  await expect(page.locator('#draft-window')).not.toBeVisible();
});

test('dragging a scratchpad onto a task saves its title and content', async ({ page }) => {
  const row = await addTask(page, '接收草稿');
  await page.locator('#draft-open').click();
  await expect(page.locator('#draft-editor')).toBeFocused();
  await page.locator('#draft-title').fill('草稿标题');
  await page.locator('#draft-editor').fill('草稿正文');
  await expect(page.locator('#draft-title')).toHaveValue('草稿标题');
  const target = await row.boundingBox();
  const bar = await page.locator('#draft-bar').boundingBox();
  const x = bar.x + 8, y = bar.y + 20;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 10, { steps: 12 });
  await page.mouse.up();
  await expect(row.locator('.memo-title')).toHaveText('草稿标题');
  await expect(row.locator('.memo-body')).toHaveText('草稿正文');
  await expect(page.locator('#draft-window')).not.toBeVisible();
  await page.reload();
  await row.locator('.expand').click();
  await expect(row.locator('.memo-body')).toHaveText('草稿正文');
});

test('all theme choices and font size persist after reload', async ({ page }) => {
  await page.locator('#settings-open').click();
  for (const theme of ['yun', 'mo', 'zhu', 'xia', 'anu', 'default']) {
    await page.locator(`.theme-choice[data-value="${theme}"]`).click();
    await expect(page.locator('#widget')).toHaveAttribute('data-theme', theme);
    await expect(page.locator(`.theme-choice[data-value="${theme}"]`)).toHaveAttribute('aria-pressed', 'true');
  }
  await page.locator('.theme-choice[data-value="anu"]').click();
  await page.locator('#font-size-range').fill('18');
  await page.locator('#settings-close').click();
  await page.reload();
  await expect(page.locator('#widget')).toHaveAttribute('data-theme', 'anu');
  await expect(page.locator('.anu-brand')).toBeVisible();
  await expect(page.locator('#font-size-range')).toHaveValue('18');
  expect(await page.locator('html').evaluate(el => el.style.getPropertyValue('--task-font'))).toBe('18px');
});

test('all five languages translate static and newly created UI and persist', async ({ page }) => {
  const languages = [
    ['en', 'Main / Side', 'Main tasks'], ['ja', 'メイン / サブ', 'メインタスク'],
    ['ko', '메인 / 서브', '주요 할 일'], ['zh-TW', '主線 / 支線', '主線任務'], ['zh-CN', '主线 / 支线', '主线任务'],
  ];
  for (const [locale, title, mainLabel] of languages) {
    await page.locator('#settings-open').click();
    await page.locator('#language-select').selectOption(locale);
    await page.locator('#settings-close').click();
    await expect(page).toHaveTitle(title);
    await expect(page.locator('.section-label.mainline')).toHaveText(mainLabel);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
  }
  await page.locator('#settings-open').click();
  await page.locator('#language-select').selectOption('en');
  await page.locator('#settings-close').click();
  const row = await addTask(page, 'English task');
  await expect(row.locator('.check')).toHaveAttribute('aria-label', 'Mark complete');
  await expect(page.locator('#main-count')).toHaveText('1 task');
  await page.reload();
  await expect(page).toHaveTitle('Main / Side');
  await expect(page.locator('.section-label.mainline')).toHaveText('Main tasks');
});

test('manual clock, timezone changes and system reset', async ({ page }) => {
  await page.locator('#clock').press('Enter');
  await page.locator('#manual-datetime').fill('2026-10-05T09:15');
  await page.locator('#clock-save').click();
  await expect(page.locator('#clock')).toHaveText('09:15:00');
  await expect(page.locator('#today-date')).toContainText('10月5日');
  await page.locator('#settings-open').click();
  await page.locator('#timezone-select').selectOption('Asia/Tokyo');
  await page.locator('#settings-close').click();
  await expect(page.locator('#clock')).toHaveText('10:15:00');
  await page.locator('#clock').click();
  await page.locator('#clock-system').click();
  await expect(page.locator('#clock')).toHaveText('13:00:00');
  expect(await stored(page, SETTINGS)).not.toHaveProperty('manualTime');
});

test('restoring default display keeps tasks, notes and courses', async ({ page }) => {
  const row = await addTask(page, '保留这个任务');
  await row.locator('.expand').click();
  await row.locator('.inline-add').click();
  await row.locator('.inline-note').fill('保留这个说明');
  await row.locator('.save-note').click();
  await enableSchedule(page);
  await addCourse(page, '保留这门课');
  await page.locator('#schedule-lock-toggle').click();
  await page.locator('#schedule-collapse').click();
  await page.locator('#settings-open').click();
  await page.locator('.theme-choice[data-value="mo"]').click();
  await page.locator('#font-size-range').fill('18');
  await page.locator('#language-select').selectOption('en');
  await page.locator('#reset-defaults').click();
  await expect(page.locator('#widget')).toHaveAttribute('data-theme', 'default');
  await expect(page.locator('#schedule-card')).not.toBeVisible();
  await expect(page.locator('.task-title')).toHaveText('保留这个任务');
  expect((await stored(page, TASKS))[0].items[0].text).toBe('保留这个说明');
  expect((await stored(page, COURSES))[0].name).toBe('保留这门课');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('#font-size-range')).toHaveValue('14');
  await expect(page.locator('#schedule-lock-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#schedule-card')).not.toHaveClass(/schedule-collapsed|schedule-free/);
  await enableSchedule(page);
  await expect(page.locator('.schedule-scroll')).toBeVisible();
});

test('task panel collapse, lock, drag and resize', async ({ page }) => {
  await addTask(page, '窗口交互任务');
  await page.locator('#collapse-toggle').click();
  await expect(page.locator('#widget')).toHaveClass(/collapsed/);
  await page.reload();
  await expect(page.locator('#widget')).toHaveClass(/collapsed/);
  await page.locator('#collapse-toggle').click();
  const before = await page.locator('#widget').boundingBox();
  await dragBy(page, page.locator('#widget .top'), -350, 150, { x: 15, y: 30 });
  const moved = await page.locator('#widget').boundingBox();
  expect(moved.x).toBeLessThan(before.x - 300);
  expect(moved.y).toBeGreaterThan(before.y + 100);
  await dragBy(page, page.locator('[data-resize="se"]'), 100, 90);
  const resized = await page.locator('#widget').boundingBox();
  expect(resized.width).toBeGreaterThan(moved.width + 80);
  expect(resized.height).toBeGreaterThan(moved.height + 70);
  await page.locator('#lock-toggle').click();
  await expect(page.locator('[data-resize="se"]')).not.toBeVisible();
  await dragBy(page, page.locator('#widget .top'), -120, 0, { x: 15, y: 30 });
  const locked = await page.locator('#widget').boundingBox();
  expect(Math.abs(locked.x - resized.x)).toBeLessThan(2);
  await page.reload();
  await expect(page.locator('#widget')).toHaveClass(/locked/);
});

test('schedule creation, edit, validation, deletion and persistence', async ({ page }) => {
  await enableSchedule(page);
  const course = await addCourse(page);
  await expect(course).toBeVisible();
  await expect(course).toHaveAttribute('title', /高等数学.*08:00–09:00.*教学楼 201.*李老师/);
  await course.click();
  await expect(page.locator('#course-name')).toBeFocused();
  await page.locator('#course-name').fill('线性代数');
  await page.locator('#course-day').selectOption('2');
  await page.locator('#course-start').selectOption('600');
  await expect(page.locator('#course-end')).toHaveValue('630');
  await page.locator('#course-end').selectOption('570');
  await page.locator('#schedule-save').click();
  await expect(page.locator('#schedule-scrim')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('结束时间需晚于开始时间');
  await page.locator('#course-end').selectOption('660');
  await page.locator('#schedule-save').click();
  await page.reload();
  await expect(page.locator('.schedule-course')).toHaveAttribute('title', /线性代数.*10:00–11:00/);
  await page.locator('.schedule-course').click({ button: 'right' });
  await page.locator('#schedule-delete-current').click();
  await expect(page.locator('.schedule-course')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.schedule-course')).toHaveCount(0);
});

test('dragging a course updates its day and preserves duration', async ({ page }) => {
  await enableSchedule(page);
  const course = await addCourse(page);
  const from = await course.boundingBox();
  const target = page.locator('.schedule-slot[data-day="2"][data-slot="6"]');
  const to = await target.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + 8);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('.schedule-course')).toHaveAttribute('title', /10:00–11:00/);
  expect((await stored(page, COURSES))[0]).toMatchObject({ day: 2, start: 600, end: 660 });
  await expect(page.locator('#schedule-scrim')).not.toBeVisible();
});

test('schedule visibility, collapse, independent movement and resize persist', async ({ page }) => {
  await enableSchedule(page);
  await page.locator('#schedule-collapse').click();
  await expect(page.locator('.schedule-scroll')).not.toBeVisible();
  await page.reload();
  await expect(page.locator('#schedule-card')).toHaveClass(/schedule-collapsed/);
  await page.locator('#schedule-collapse').click();
  await page.locator('#schedule-lock-toggle').click();
  await expect(page.locator('#schedule-card')).toHaveClass(/schedule-free/);
  await dragBy(page, page.locator('.schedule-head'), -550, 50, { x: 20, y: 25 });
  await expect(page.locator('#app-stack')).toHaveClass(/schedule-floating/);
  await page.locator('[data-schedule-resize="se"]').hover();
  const before = await page.locator('#schedule-card').boundingBox();
  await dragBy(page, page.locator('[data-schedule-resize="se"]'), 100, 50);
  await expect.poll(async () => (await page.locator('#schedule-card').boundingBox()).width).toBeGreaterThan(before.width + 80);
  const saved = await stored(page, 'minimal-task-widget-schedule-layout-v1');
  expect(saved).toMatchObject({ floating: true, customSize: true });
  await page.reload();
  await expect(page.locator('#app-stack')).toHaveClass(/schedule-floating/);
  await expect(page.locator('#schedule-card')).toHaveClass(/schedule-free/);
  await page.locator('#settings-open').click();
  await page.locator('#course-toggle').click();
  await page.locator('#settings-close').click();
  await expect(page.locator('#schedule-card')).not.toBeVisible();
  await page.reload();
  await expect(page.locator('#schedule-card')).not.toBeVisible();
});

test('unsupported browser pin reports a fallback and resets its state', async ({ page }) => {
  await page.evaluate(() => Object.defineProperty(window, 'documentPictureInPicture', { value: undefined, configurable: true }));
  await page.locator('#widget-pin-toggle').click();
  await expect(page.locator('#widget-pin-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#toast')).toContainText('当前浏览器不支持');
});

test('task text renders as text instead of markup', async ({ page }) => {
  const row = await addTask(page, '<img src=x onerror=alert(1)>');
  await expect(row.locator('.task-title')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(row.locator('.task-title img')).toHaveCount(0);
});

test('malformed local task data does not prevent loading the widget', async ({ page }) => {
  for (const value of ['{broken', '{}', '[null,42,"bad"]']) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: TASKS, value });
    await page.reload();
    await expect(page.locator('#clock')).toHaveText('12:00:00');
    await page.locator('[data-add="side"]').click();
    await expect(page.locator('#scrim')).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

test('storage changes synchronize tasks and display settings between pages', async ({ page, context }) => {
  const other = await context.newPage();
  const errors = [];
  other.on('pageerror', error => errors.push(error.message));
  await other.goto(url);
  await addTask(page, '来自另一个窗口', 'side');
  await expect(other.locator('.task-title')).toHaveText('来自另一个窗口');
  await page.locator('#settings-open').click();
  await page.locator('.theme-choice[data-value="zhu"]').click();
  await page.locator('#font-size-range').fill('18');
  await expect(other.locator('#widget')).toHaveAttribute('data-theme', 'zhu');
  await expect(other.locator('#font-size-range')).toHaveValue('18');
  await page.locator('#course-toggle').click();
  await page.locator('#settings-close').click();
  await expect(other.locator('#schedule-card')).toBeVisible();
  await addCourse(page, '同步课程');
  await expect(other.locator('.schedule-course')).toContainText('同步课程');
  await page.locator('#schedule-lock-toggle').click();
  await expect(other.locator('#schedule-card')).toHaveClass(/schedule-free/);
  await expect(other.locator('#schedule-lock-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#lock-toggle').click();
  await expect(other.locator('#widget')).toHaveClass(/locked/);
  await expect(other.locator('#lock-toggle')).toHaveClass(/locked/);
  await other.close();
  expect(errors).toEqual([]);
});

test('saving a course deleted in another window closes the editor without recreating it', async ({ page, context }) => {
  await enableSchedule(page);
  const course = await addCourse(page, '跨窗口删除课程');
  await course.click();
  await page.locator('#course-name').fill('尚未保存的课程修改');

  const other = await context.newPage();
  const errors = [];
  other.on('pageerror', error => errors.push(error.message));
  await other.goto(url);
  await other.locator('.schedule-course').click();
  await other.locator('#schedule-delete-current').click();
  await expect(page.locator('.schedule-course')).toHaveCount(0);
  await expect(page.locator('#schedule-scrim')).toBeVisible();

  await page.locator('#schedule-save').click();
  await expect(page.locator('#schedule-scrim')).not.toBeVisible();
  await expect(page.locator('#toast')).toHaveText('课程已删除');
  expect(await stored(page, COURSES)).toEqual([]);
  await page.reload();
  await expect(page.locator('.schedule-course')).toHaveCount(0);
  await expect(other.locator('.schedule-course')).toHaveCount(0);
  await other.close();
  expect(errors).toEqual([]);
});

test('month-end calendar navigation never skips February', async ({ page }) => {
  await choosePeriod(page, 'day', '2026-01-31');
  await page.locator('[data-add="main"]').click();
  await expect(page.locator('#task-calendar-month')).toContainText('1月');
  await page.locator('#task-calendar-next').click();
  await expect(page.locator('#task-calendar-month')).toContainText('2月');
  await page.locator('#task-calendar-next').click();
  await expect(page.locator('#task-calendar-month')).toContainText('3月');
  await page.locator('#task-calendar-prev').click();
  await expect(page.locator('#task-calendar-month')).toContainText('2月');
});

test('changing the UI language never translates user task, note or course content', async ({ page }) => {
  const row = await addTask(page, '保存');
  await row.locator('.expand').click();
  await row.locator('.inline-add').click();
  await row.locator('.inline-note').fill('完成');
  await row.locator('.save-note').click();
  await enableSchedule(page);
  await addCourse(page, '取消');
  await page.locator('#settings-open').click();
  await page.locator('#language-select').selectOption('en');
  await page.locator('#settings-close').click();
  await expect(row).toHaveClass(/open/);
  await expect(row.locator('.note-text')).toBeVisible();
  await expect(row.locator('.task-title')).toHaveText('保存');
  await expect(row.locator('.note-text')).toHaveText('完成');
  await expect(page.locator('.schedule-course span')).toHaveText('取消');
});

test('stored rich text strips active content and keeps formatting and embedded PNGs', async ({ page }) => {
  await addTask(page, '富文本任务');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const html = '<b>保留加粗</b><script>window.unsafeRan=true</script><img src="x" onerror="window.unsafeRan=true"><iframe srcdoc="bad"></iframe><img src="' + png + '" onload="window.unsafeRan=true">';
  await page.evaluate(({ taskKey, html }) => {
    const tasks = JSON.parse(localStorage.getItem(taskKey));
    tasks[0].memos = [{ title: '安全备注', html }];
    localStorage.setItem(taskKey, JSON.stringify(tasks));
    localStorage.setItem('minimal-task-widget-draft-html-v1', html);
  }, { taskKey: TASKS, html });
  await page.reload();
  await page.locator('.expand').click();
  await expect(page.locator('.memo-body b')).toHaveText('保留加粗');
  await expect(page.locator('.memo-body script, .memo-body iframe, .memo-body [onerror], .memo-body [onload]')).toHaveCount(0);
  await expect(page.locator('.memo-body img')).toHaveAttribute('src', png);
  await page.locator('#draft-open').click();
  await expect(page.locator('#draft-editor script, #draft-editor iframe, #draft-editor [onerror], #draft-editor [onload]')).toHaveCount(0);
  expect(await page.evaluate(() => window.unsafeRan)).toBeUndefined();
});

test('invalid settings and course records recover without breaking rendering', async ({ page }) => {
  await page.evaluate(({ settings, courses }) => {
    localStorage.setItem(settings, JSON.stringify({ timezone: 'not/a/timezone', language: 'wrong', theme: 'wrong', fontSize: -10, periodMode: 'unknown', periodStart: 'bad', periodEnd: 'bad', courseEnabled: true }));
    localStorage.setItem(courses, JSON.stringify([null, 42, { id: 'bad', day: 90, start: 1, end: 'invalid' }]));
  }, { settings: SETTINGS, courses: COURSES });
  await page.reload();
  await expect(page.locator('#clock')).toHaveText('12:00:00');
  await expect(page.locator('.schedule-course')).toHaveCount(0);
  await expect(page.locator('#widget')).toHaveAttribute('data-theme', 'default');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await addTask(page, '恢复后添加任务');
  await expect(page.locator('.task-title')).toHaveText('恢复后添加任务');
});

test('manual time uses the selected timezone and blank input restores system time', async ({ page }) => {
  await page.locator('#settings-open').click();
  await page.locator('#timezone-select').selectOption('Asia/Tokyo');
  await page.locator('#settings-close').click();
  await page.locator('#clock').click();
  await expect(page.locator('#manual-datetime')).toHaveValue('2026-09-29T13:00');
  await page.locator('#manual-datetime').fill('2026-10-05T12:00');
  await page.locator('#clock-save').click();
  await expect(page.locator('#clock')).toHaveText('12:00:00');
  await page.reload();
  await page.locator('#clock').click();
  await expect(page.locator('#manual-datetime')).toHaveValue('2026-10-05T12:00');
  await page.locator('#manual-datetime').fill('');
  await page.locator('#clock-save').click();
  await expect(page.locator('#clock-scrim')).not.toBeVisible();
  await expect(page.locator('#clock')).toHaveText('13:00:00');
  expect(await stored(page, SETTINGS)).not.toHaveProperty('manualTime');
});

test('manual time rejects nonexistent daylight-saving time and accepts the autumn overlap', async ({ page }) => {
  await page.locator('#settings-open').click();
  await page.locator('#timezone-select').selectOption('America/New_York');
  await page.locator('#settings-close').click();
  await page.locator('#clock').click();
  await page.locator('#manual-datetime').fill('2026-03-08T02:30');
  await page.locator('#clock-save').click();
  await expect(page.locator('#clock-scrim')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('请选择有效的日期和时间');
  expect(await stored(page, SETTINGS)).not.toHaveProperty('manualTime');
  await page.locator('#manual-datetime').fill('2026-11-01T01:30');
  await page.locator('#clock-save').click();
  await expect(page.locator('#clock-scrim')).not.toBeVisible();
  await expect(page.locator('#clock')).toHaveText('01:30:00');
  await page.locator('#clock').click();
  await expect(page.locator('#manual-datetime')).toHaveValue('2026-11-01T01:30');
});
