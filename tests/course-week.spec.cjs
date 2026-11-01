const { test: base, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const COURSES = 'minimal-task-widget-schedule-v1';
const NOW = '2026-11-02T04:00:00Z';
const test = base.extend({ page: async ({ page, context }, use) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  context.on('page', popup => popup.on('pageerror', error => errors.push(error.message)));
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto(url);
  await page.locator('#settings-open').click();
  await page.locator('#course-toggle').click();
  await page.locator('#settings-close').click();
  await use(page);
  expect(errors).toEqual([]);
} });
test.use({ viewport: { width: 1400, height: 1100 } });
const raw = page => page.evaluate(key => localStorage.getItem(key), COURSES);
const saved = async page => JSON.parse(await raw(page));
async function add(page, name, once) {
  await page.locator('#schedule-edit').click();
  await page.locator('#course-name').fill(name);
  await expect(page.locator('#course-week-only')).toHaveAttribute('aria-checked', 'false');
  if (once) await page.locator('#course-week-only').click();
  await page.locator('#schedule-save').click();
}
async function day(page, date) {
  await page.locator('#today-date').click();
  await page.locator('#period-range input').fill(date);
  await page.locator('#period-apply').click();
}
async function today(page) {
  await page.locator('#today-date').click();
  await page.locator('#period-today').click();
}

test('one-week courses hide at the next Monday, remain saved and return when viewing their historical week', async ({ page }) => {
  await add(page, '每周课程', false);
  await add(page, '本周临时课程', true);
  expect((await saved(page)).map(course => course.weekStart)).toEqual([undefined, '2026-11-02']);
  await expect(page.locator('#schedule-week-range')).toHaveText('2026-11-02 – 2026-11-08');
  const original = await raw(page);
  await page.reload();
  await expect(page.locator('.schedule-course')).toHaveCount(2);
  await page.clock.setFixedTime(new Date('2026-11-08T15:59:59Z'));
  await expect(page.locator('.schedule-course')).toHaveCount(2);
  await page.clock.setFixedTime(new Date('2026-11-08T16:00:00Z'));
  await expect(page.locator('.schedule-course')).toHaveText(['每周课程']);
  await expect(page.locator('#schedule-week-range')).toHaveText('2026-11-09 – 2026-11-15');
  expect(await raw(page)).toBe(original);
  await day(page, '2026-11-04');
  await expect(page.locator('.schedule-course')).toHaveCount(2);
  await page.locator('#period-open').click();
  await page.locator('[data-period="week"]').click();
  await page.locator('#period-apply').click();
  await expect(page.locator('.schedule-course')).toHaveCount(2);
  await page.locator('#period-open').click();
  await page.locator('[data-period="month"]').click();
  await page.locator('#period-apply').click();
  await expect(page.locator('.schedule-course')).toHaveText(['每周课程']);
  await day(page, '2026-11-04');
  await add(page, '查看历史时添加的本周课程', true);
  expect((await saved(page)).at(-1).weekStart).toBe('2026-11-09');
  await expect(page.locator('.schedule-course')).toHaveCount(2);
  await today(page);
  await expect(page.locator('.schedule-course')).toHaveText(['每周课程', '查看历史时添加的本周课程']);
});

test('editing and dragging preserve the original week and unknown fields; disabling the switch makes the course repeat', async ({ page }) => {
  const legacy = { id: 'legacy', name: '原有课程', day: 2, start: 600, end: 660, teacher: '保留老师', extension: { imported: ['keep', 1] } };
  const scoped = { id: 'scoped', name: '单周课程', day: 0, start: 480, end: 540, weekStart: '2026-11-02', extension: { keep: true } };
  await page.evaluate(({ key, records }) => localStorage.setItem(key, JSON.stringify(records)), { key: COURSES, records: [legacy, scoped] });
  await page.reload();
  expect(await saved(page)).toEqual([legacy, scoped]);
  await page.locator('.schedule-course', { hasText: '单周课程' }).click();
  await expect(page.locator('#course-week-only')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#course-room').fill('新的教室');
  await page.locator('#schedule-save').click();
  expect(await saved(page)).toEqual([legacy, { ...scoped, room: '新的教室', teacher: '' }]);
  const source = await page.locator('.schedule-course', { hasText: '单周课程' }).boundingBox();
  const target = await page.locator('.schedule-slot[data-day="1"][data-slot="4"]').boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await saved(page))[1].day).toBe(1);
  expect((await saved(page))[1]).toMatchObject({ weekStart: scoped.weekStart, extension: scoped.extension });
  await page.clock.setFixedTime(new Date('2026-11-09T04:00:00Z'));
  await expect(page.locator('.schedule-course > span')).toHaveText(['原有课程']);
  await day(page, '2026-11-03');
  await page.locator('.schedule-course', { hasText: '单周课程' }).click();
  await expect(page.locator('#course-week-range')).toHaveText('2026-11-02 – 2026-11-08');
  await page.locator('#course-week-only').click();
  await page.locator('#schedule-save').click();
  await today(page);
  await expect(page.locator('.schedule-course')).toHaveCount(2);
  expect((await saved(page))[0]).toEqual(legacy);
  expect((await saved(page))[1]).toMatchObject({ weekStart: '', extension: scoped.extension });
});

test('unrelated edits leave absent and unknown legacy week fields unchanged', async ({ page }) => {
  const legacy = { id: 'old', name: '没有周字段', day: 0, start: 480, end: 540, room: '旧教室', teacher: '老师', extension: { keep: true } };
  const unknown = { ...legacy, id: 'future', name: '保留未知周字段', day: 1, weekStart: { format: 'future', value: 7 } };
  await page.evaluate(({ key, records }) => localStorage.setItem(key, JSON.stringify(records)), { key: COURSES, records: [legacy, unknown] });
  await page.reload();
  for (const course of [legacy, unknown]) {
    await page.locator('.schedule-course', { hasText: course.name }).click();
    await expect(page.locator('#course-week-only')).toHaveAttribute('aria-checked', 'false');
    await page.locator('#course-room').fill('新教室');
    await page.locator('#schedule-save').click();
  }
  expect(await saved(page)).toEqual([{ ...legacy, room: '新教室' }, { ...unknown, room: '新教室' }]);
});

test('failed scope changes retain stored data and the open editor until a successful retry', async ({ page }) => {
  await add(page, '等待修改的课程', false);
  const before = await raw(page);
  await page.locator('.schedule-course').click();
  await page.locator('#course-week-only').click();
  await page.evaluate(key => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Full storage', 'QuotaExceededError');
      return write.call(this, name, value);
    };
    window.restoreCourseWrites = () => { Storage.prototype.setItem = write; };
  }, COURSES);
  await page.locator('#schedule-save').click();
  await expect(page.locator('#schedule-scrim')).toHaveClass(/open/);
  await expect(page.locator('#course-week-only')).toHaveAttribute('aria-checked', 'true');
  expect(await raw(page)).toBe(before);
  await page.evaluate(() => window.restoreCourseWrites());
  await page.locator('#schedule-save').click();
  await expect(page.locator('#schedule-scrim')).not.toHaveClass(/open/);
  expect(await saved(page)).toHaveLength(1);
  expect((await saved(page))[0].weekStart).toBe('2026-11-02');
});

test('course weeks respect the selected timezone, manual clock and year boundary, and update both windows', async ({ page, context }) => {
  await page.clock.setFixedTime(new Date('2027-01-03T16:30:00Z'));
  await page.locator('#settings-open').click();
  await page.locator('#timezone-select').selectOption('America/Los_Angeles');
  await page.locator('#settings-close').click();
  await add(page, '洛杉矶周日课程', true);
  expect((await saved(page))[0].weekStart).toBe('2026-12-28');
  await expect(page.locator('#schedule-week-range')).toHaveText('2026-12-28 – 2027-01-03');
  const other = await context.newPage();
  await other.clock.setFixedTime(new Date('2027-01-03T16:30:00Z'));
  await other.goto(url);
  await page.locator('#settings-open').click();
  await page.locator('#timezone-select').selectOption('Asia/Tokyo');
  await page.locator('#settings-close').click();
  for (const target of [page, other]) {
    await expect(target.locator('.schedule-course')).toHaveCount(0);
    await expect(target.locator('#schedule-week-range')).toHaveText('2027-01-04 – 2027-01-10');
  }
  await page.locator('#clock').click();
  await page.locator('#manual-datetime').fill('2026-12-31T12:00');
  await page.locator('#clock-save').click();
  for (const target of [page, other]) await expect(target.locator('.schedule-course')).toHaveCount(1);
  await add(page, '手动日期内的单周课程', true);
  await expect(other.locator('.schedule-course')).toHaveCount(2);
  expect((await saved(page))[1].weekStart).toBe('2026-12-28');
  await other.close();
});

test('the switch is translated in five languages, works with the keyboard and resets between new-course dialogs', async ({ page }) => {
  for (const [locale, label] of [['en', 'This week only'], ['ja', '今週のみ'], ['ko', '이번 주만'], ['zh-TW', '僅本週'], ['zh-CN', '仅本周']]) {
    await page.locator('#settings-open').click();
    await page.locator('#language-select').selectOption(locale);
    await page.locator('#settings-close').click();
    await page.locator('#schedule-edit').click();
    const toggle = page.getByRole('switch', { name: label });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.locator('#schedule-cancel').click();
  }
  expect(await saved(page)).toBeNull();
});

test('one-week course creation works in PiP and retains its scope after returning', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: {
      requestWindow: async () => {
        const popup = window.open('', '_blank', 'width=1200,height=1100'), close = popup.close.bind(popup);
        popup.close = () => { popup.dispatchEvent(new PageTransitionEvent('pagehide')); close(); };
        return popup;
      },
    } });
  });
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#widget-pin-toggle').click()]);
  await popup.setViewportSize({ width: 1400, height: 1100 });
  await add(popup, '浮窗本周课程', true);
  expect((await saved(page))[0].weekStart).toBe('2026-11-02');
  await popup.locator('#widget-pin-toggle').click();
  await expect(page.locator('.schedule-course')).toHaveText('浮窗本周课程');
  await page.clock.setFixedTime(new Date('2026-11-09T04:00:00Z'));
  await expect(page.locator('.schedule-course')).toHaveCount(0);
  expect(await saved(page)).toHaveLength(1);
});
