const { test: base, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const SETTINGS = 'minimal-task-widget-settings-v1';
const TASKS = 'minimal-task-widget-v1';
const NOW = '2026-09-29T04:00:00Z';
const test = base.extend({
  page: async ({ page, context }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    context.on('page', other => other.on('pageerror', error => errors.push(error.message)));
    await page.clock.setFixedTime(new Date(NOW));
    await page.goto(url);
    await use(page);
    expect(errors, 'Date and localization interactions must not throw').toEqual([]);
  },
});
const settings = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), SETTINGS);

async function language(page, locale) {
  await page.locator('#settings-open').click();
  await page.locator('#language-select').selectOption(locale);
  await page.locator('#settings-close').click();
}

async function period(page, mode, date) {
  await page.locator('#period-open').click();
  await page.locator(`[data-period="${mode}"]`).click();
  await page.locator('#period-range input').first().fill(date);
  await page.locator('#period-apply').click();
  await expect(page.locator('#period-scrim')).not.toHaveClass(/open/);
}

async function today(page, entry = '#period-open') {
  await page.locator(entry).click();
  await page.locator('#period-today').click();
  await expect(page.locator('#period-scrim')).not.toHaveClass(/open/);
}

async function expectEnglishUI(dialog) {
  const text = await dialog.evaluate(element => [element.innerText,
    ...[...element.querySelectorAll('[aria-label],[title],[placeholder]')]
      .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
      .flatMap(node => ['aria-label', 'title', 'placeholder'].map(name => node.getAttribute(name) || '')),
  ].join('\n'));
  // Only English uses this check: Japanese and Traditional Chinese legitimately use Han characters.
  expect(text, 'Visible English UI and accessibility labels must not contain untranslated Chinese').not.toMatch(/\p{Script=Han}/u);
}

test('English date and task dialogs translate dynamic buttons, calendars and accessibility text without translating user content', async ({ page }) => {
  const original = { id: 'user-content', type: 'main', title: '今天', date: '2026-09-29', dateEnd: '2026-09-29', done: false, items: [{ text: '查看当天', done: false }], memos: [], period: { mode: 'day', start: '2026-09-29', end: '2026-09-29' } };
  await page.evaluate(({ key, original }) => localStorage.setItem(key, JSON.stringify([original])), { key: TASKS, original });
  await page.reload();
  await page.locator('.task .expand').click();
  await language(page, 'en');
  await page.locator('#today-date').click();
  await expect(page.locator('#period-title')).toHaveText('Choose date to view');
  await expect(page.locator('#period-range input')).toHaveAttribute('aria-label', 'Choose date');
  await expectEnglishUI(page.locator('#period-scrim'));
  await page.locator('#period-cancel').click();
  await page.locator('#period-open').click();
  await expect(page.locator('#period-title')).toHaveText('Choose task period');
  await expect(page.locator('#period-kind button')).toHaveText(['Day', 'Week', 'Month', 'Custom']);
  await page.locator('[data-period="custom"]').click();
  await expect(page.locator('#period-range input').nth(1)).toHaveAttribute('aria-label', 'End date');
  await expect(page.locator('#period-apply')).toHaveText('Apply');
  await expectEnglishUI(page.locator('#period-scrim'));
  await page.locator('#period-cancel').click();

  await expect(page.locator('[data-add="main"]')).toHaveAttribute('aria-label', 'Add a main task');
  await page.locator('[data-add="main"]').click();
  await expect(page.locator('#dialog-title')).toHaveText('Add a main task');
  await expect(page.locator('#task-date-single')).toHaveText('One day');
  await expect(page.locator('#task-date-range')).toHaveText('Date range');
  await expect(page.locator('#task-date-today')).toHaveText('Today');
  await expect(page.locator('#task-calendar-prev')).toHaveAttribute('aria-label', 'Previous month');
  await expect(page.locator('#task-calendar-next')).toHaveAttribute('aria-label', 'Next month');
  await expect(page.locator('#task-date-summary')).toHaveText(/^Date: /);
  await page.locator('#task-date-range').click();
  await page.locator('.task-calendar-day:not(.outside)').filter({ hasText: /^10$/ }).click();
  await expect(page.locator('#task-date-summary')).toContainText('select an end date');
  await expectEnglishUI(page.locator('#form'));
  await page.locator('.task-calendar-day:not(.outside)').filter({ hasText: /^12$/ }).click();
  await expect(page.locator('#task-date-summary')).toContainText(' to ');
  await page.locator('#task-date-today').click();
  await page.locator('#task-date-single').click();
  await expect(page.locator('#date-input')).toHaveValue('2026-09-29');
  await expectEnglishUI(page.locator('#form'));
  await page.locator('#task-input').fill('英文界面里的中文任务');
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('[data-add="side"]')).toHaveAttribute('aria-label', 'Add a side task');
  await page.locator('[data-add="side"]').click();
  await expect(page.locator('#dialog-title')).toHaveText('Add a side task');
  await expect(page.locator('#date-field')).toBeHidden();
  await page.locator('#task-input').fill('保存');
  await page.locator('#time-input').fill('15:30');
  await expectEnglishUI(page.locator('#form'));
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('.task[data-id="user-content"] .task-title')).toHaveText('今天');
  await expect(page.locator('.task[data-id="user-content"] .note-text')).toHaveText('查看当天');
  const tasks = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), TASKS);
  expect(tasks.find(task => task.id === original.id)).toMatchObject(original);
  expect(tasks.map(task => task.title)).toEqual(['今天', '英文界面里的中文任务', '保存']);
});

test('Today returns from Month and a historical day in one click and has the correct label in all five languages', async ({ page }) => {
  await language(page, 'en');
  await period(page, 'month', '2026-08-20');
  await today(page);
  expect(await settings(page)).toMatchObject({ periodMode: 'day', periodStart: '2026-09-29', periodEnd: '2026-09-29', followSystemDate: true });
  await page.locator('#today-date').click();
  await page.locator('#period-range input').fill('2026-09-20');
  await page.locator('#period-apply').click();
  expect((await settings(page)).followSystemDate).toBe(false);
  await today(page, '#today-date');
  expect(await settings(page)).toMatchObject({ periodStart: '2026-09-29', periodEnd: '2026-09-29', followSystemDate: true });
  for (const [locale, label, title] of [
    ['en', 'Today', 'Choose date to view'], ['zh-TW', '今天', '選擇檢視日期'],
    ['ja', '今日', '表示する日付を選択'], ['ko', '오늘', '볼 날짜 선택'],
    ['zh-CN', '今天', '选择查看日期'],
  ]) {
    await language(page, locale);
    await page.locator('#today-date').click();
    await expect(page.locator('#period-today')).toHaveText(label);
    await expect(page.locator('#period-title')).toHaveText(title);
    await page.locator('#period-cancel').click();
  }
});

test('Today uses the selected timezone and manual clock, including inside PiP', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-29T15:30:00Z'));
  await page.locator('#settings-open').click();
  await page.locator('#timezone-select').selectOption('Asia/Tokyo');
  await page.locator('#settings-close').click();
  await period(page, 'month', '2026-08-01');
  await today(page);
  expect(await settings(page)).toMatchObject({ periodStart: '2026-09-30', periodEnd: '2026-09-30', timezone: 'Asia/Tokyo' });
  await page.locator('#clock').click();
  await page.locator('#manual-datetime').fill('2026-10-05T00:01');
  await page.locator('#clock-save').click();
  const manual = await settings(page);
  await period(page, 'month', '2026-09-01');
  await page.evaluate(() => {
    Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: {
      requestWindow: async () => {
        const popup = window.open('', '_blank', 'width=1100,height=1100'), close = popup.close.bind(popup);
        popup.close = () => { popup.dispatchEvent(new PageTransitionEvent('pagehide')); close(); };
        return popup;
      },
    } });
  });
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#widget-pin-toggle').click()]);
  await popup.setViewportSize({ width: 1100, height: 1100 });
  await today(popup, '#today-date');
  expect(await settings(page)).toMatchObject({ periodMode: 'day', periodStart: '2026-10-05', periodEnd: '2026-10-05', followSystemDate: true, timezone: 'Asia/Tokyo', manualTime: manual.manualTime, manualTimeSavedAt: manual.manualTimeSavedAt });
  await expect(popup.locator('#clock')).toHaveText('00:01:00');
  await popup.locator('#widget-pin-toggle').click();
  await expect(page.locator('#widget')).toBeVisible();
  expect((await settings(page)).periodStart).toBe('2026-10-05');
});

test('a failed Today save keeps the old filter and open dialog and can be retried', async ({ page }) => {
  await period(page, 'month', '2026-08-20');
  const before = await page.evaluate(key => localStorage.getItem(key), SETTINGS);
  await page.locator('#period-open').click();
  await page.evaluate(key => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Settings quota exhausted', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
    window.restoreIssueWrites = () => { Storage.prototype.setItem = setItem; };
  }, SETTINGS);
  await page.locator('#period-today').click();
  await expect(page.locator('#period-scrim')).toHaveClass(/open/);
  await expect(page.locator('#toast')).toContainText('保存失败');
  expect(await page.evaluate(key => localStorage.getItem(key), SETTINGS)).toBe(before);
  await expect(page.locator('#period-range input')).toHaveValue('2026-08-01');
  await page.evaluate(() => window.restoreIssueWrites());
  await page.locator('#period-today').click();
  await expect(page.locator('#period-scrim')).not.toHaveClass(/open/);
  await page.reload();
  expect(await settings(page)).toMatchObject({ periodMode: 'day', periodStart: '2026-09-29', periodEnd: '2026-09-29', followSystemDate: true });
});

test('Today synchronizes windows and keeps following the local day after midnight without rewriting tasks', async ({ page, context }) => {
  const records = ['2026-09-29', '2026-09-30'].map((date, index) => ({
    id: date, type: 'side', title: `${date}的任务`, done: !index, completedOn: index ? '' : date,
    items: [], period: { mode: 'day', start: date, end: date },
  }));
  await page.evaluate(({ key, records }) => localStorage.setItem(key, JSON.stringify(records)), { key: TASKS, records });
  await page.reload();
  await period(page, 'month', '2026-09-01');
  const other = await context.newPage();
  await other.clock.setFixedTime(new Date(NOW));
  await other.goto(url);
  await today(page);
  for (const target of [page, other]) {
    await expect(target.locator('.task-title')).toHaveText('2026-09-29的任务');
    expect(await settings(target)).toMatchObject({ periodMode: 'day', periodStart: '2026-09-29', followSystemDate: true });
  }
  await Promise.all([page, other].map(target => target.clock.setFixedTime(new Date('2026-09-30T04:00:00Z'))));
  for (const target of [page, other]) {
    await expect(target.locator('.task-title')).toHaveText('2026-09-30的任务');
    expect(await settings(target)).toMatchObject({ periodStart: '2026-09-30', periodEnd: '2026-09-30', followSystemDate: true });
  }
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), TASKS)).toEqual(records);
  await other.close();
});
