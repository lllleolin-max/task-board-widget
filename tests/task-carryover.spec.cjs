const { test: base, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const TASKS = 'minimal-task-widget-v1';
const SETTINGS = 'minimal-task-widget-settings-v1';
const NOW = '2026-09-30T04:00:00Z';
const day = date => ({ mode: 'day', start: date, end: date });
const mainTask = (id, date, extra = {}) => ({
  id, title: id, type: 'main', date, dateStart: '', dateEnd: date,
  time: '', done: false, items: [], memos: [], period: day(date), ...extra,
});
const sideTask = (id, date, extra = {}) => ({
  id, title: id, type: 'side', date: '', dateStart: '', dateEnd: '',
  time: '20:30', done: false, items: [], memos: [], period: day(date), ...extra,
});
const row = (page, id) => page.locator(`.task[data-id="${id}"]`);

const test = base.extend({
  page: async ({ page, context }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    context.on('page', other => other.on('pageerror', error => errors.push(error.message)));
    await page.clock.setFixedTime(new Date(NOW));
    await page.goto(url);
    await use(page);
    expect(errors, 'Carryover interactions must not throw renderer errors').toEqual([]);
  },
});

async function seed(page, records, settings = {}) {
  await page.evaluate(({ records, settings, TASKS, SETTINGS }) => {
    localStorage.setItem(TASKS, JSON.stringify(records));
    localStorage.setItem(SETTINGS, JSON.stringify({
      timezone: 'Asia/Shanghai', periodMode: 'day', periodStart: '2026-09-29',
      periodEnd: '2026-09-29', followSystemDate: true, ...settings,
    }));
  }, { records, settings, TASKS, SETTINGS });
  await page.reload();
}

async function saved(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), TASKS);
}

async function expectCurrentDay(page, value) {
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)).periodStart, SETTINGS)).toBe(value);
}

async function selectDay(page, date) {
  await page.locator('#today-date').click();
  await page.locator('#period-range input').fill(date);
  await page.locator('#period-apply').click();
  await expect(page.locator('#period-scrim')).not.toHaveClass(/open/);
}

async function selectPeriod(page, mode, start, end = start) {
  await page.locator('#period-open').click();
  await page.locator(`[data-period="${mode}"]`).click();
  await page.locator('#period-range input').first().fill(start);
  if (mode === 'custom') await page.locator('#period-range input').nth(1).fill(end);
  await page.locator('#period-apply').click();
  await expect(page.locator('#period-scrim')).not.toHaveClass(/open/);
}

async function taskAction(page, id, action) {
  await row(page, id).locator('.task-title').click({ button: 'right' });
  await page.locator(`#task-menu [data-task-action="${action}"]`).click();
}

test('daily main and side tasks carry across live midnight and restart without duplicating or rewriting their origin', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-29T04:00:00Z'));
  const records = [mainTask('跨日主线', '2026-09-29'), sideTask('跨日支线', '2026-09-29')];
  await seed(page, records);
  await expect(page.locator('.carryover-label')).toHaveCount(0);
  await page.clock.setFixedTime(new Date(NOW));
  await expectCurrentDay(page, '2026-09-30');
  for (const record of records) {
    await expect(row(page, record.id)).toHaveCount(1);
    await expect(row(page, record.id).locator('.task-title')).toHaveText(record.title);
    await expect(row(page, record.id).locator('.carryover-label')).toHaveText('9月29日未完成');
  }
  await expect(row(page, '跨日主线').locator('.deadline')).toHaveCount(0);
  await expect(row(page, '跨日支线').locator('.deadline')).toHaveText('20:30');
  // Simulate reopening after the app was not running for several days.
  for (const date of ['2026-10-02', '2026-10-04']) {
    await page.clock.setFixedTime(new Date(`${date}T04:00:00Z`));
    await page.reload();
    await expectCurrentDay(page, date);
    await expect(page.locator('.task')).toHaveCount(2);
    await expect(page.locator('.carryover-label')).toHaveText(['9月29日未完成', '9月29日未完成']);
    expect(await saved(page)).toEqual(records);
  }
});

test('completed carryovers stay on their completion day, stop the next day and reappear when reopened from history', async ({ page }) => {
  const records = [mainTask('完成主线', '2026-09-29'), sideTask('完成支线', '2026-09-29')];
  await seed(page, records);
  for (const record of records) {
    await row(page, record.id).locator('.check').click();
    await expect(row(page, record.id)).toHaveClass(/done/);
    await expect(row(page, record.id).locator('.carryover-label')).not.toBeVisible();
  }
  for (const record of await saved(page)) expect(record).toMatchObject({ done: true, completedOn: '2026-09-30' });
  await page.reload();
  await expect(page.locator('.task.done')).toHaveCount(2);
  await page.clock.setFixedTime(new Date('2026-10-01T04:00:00Z'));
  await expectCurrentDay(page, '2026-10-01');
  await expect(page.locator('.task')).toHaveCount(0);
  await selectDay(page, '2026-09-30');
  await expect(page.locator('.task.done')).toHaveCount(2);
  await selectDay(page, '2026-09-29');
  await expect(page.locator('.task.done')).toHaveCount(2);
  for (const record of records) await row(page, record.id).locator('.check').click();
  for (const record of await saved(page)) {
    expect(record.done).toBe(false);
    expect(record.completedOn).toBeFalsy();
  }
  // Completing from a historical view still records the actual local day.
  await row(page, '完成主线').locator('.check').click();
  expect((await saved(page)).find(task => task.id === '完成主线').completedOn).toBe('2026-10-01');
  await row(page, '完成主线').locator('.check').click();
  await selectDay(page, '2026-10-01');
  await expect(page.locator('.carryover-label')).toHaveText(['9月29日未完成', '9月29日未完成']);
});

test('future views, non-daily side tasks and legacy completed records do not receive premature carryovers', async ({ page }) => {
  await seed(page, [
    mainTask('过去未完成', '2026-09-29'),
    mainTask('旧版已完成', '2026-09-29', { done: true }),
    mainTask('当天旧版已完成', '2026-09-30', { done: true }),
    mainTask('未来主线', '2026-10-02'),
    sideTask('未来支线', '2026-10-02'),
    sideTask('过期周支线', '2026-09-20', { period: { mode: 'week', start: '2026-09-14', end: '2026-09-20' } }),
    sideTask('过期月支线', '2026-08-31', { period: { mode: 'month', start: '2026-08-01', end: '2026-08-31' } }),
    sideTask('过期自定义支线', '2026-09-20', { period: { mode: 'custom', start: '2026-09-18', end: '2026-09-20' } }),
    sideTask('非单日日支线', '2026-09-29', { period: { mode: 'day', start: '2026-09-28', end: '2026-09-29' } }),
  ]);
  await expect(page.locator('.task-title')).toHaveText(['过去未完成', '当天旧版已完成']);
  await selectDay(page, '2026-10-02');
  await expect(page.locator('.task-title')).toHaveText(['未来主线', '未来支线']);
  await expect(page.locator('.carryover-label')).toHaveCount(0);
  await selectDay(page, '2026-09-28');
  await expect(row(page, '过去未完成')).toHaveCount(0);
});

test('week, month and custom filters retain their original membership without carryover labels', async ({ page }) => {
  await seed(page, [
    mainTask('九月主线', '2026-09-20'), sideTask('旧日支线', '2026-09-20'),
    sideTask('本周支线', '2026-09-30', { period: { mode: 'week', start: '2026-09-28', end: '2026-10-04' } }),
    sideTask('本月支线', '2026-09-30', { period: { mode: 'month', start: '2026-09-01', end: '2026-09-30' } }),
    sideTask('自定义支线', '2026-09-19', { period: { mode: 'custom', start: '2026-09-18', end: '2026-09-19' } }),
  ]);
  await selectPeriod(page, 'week', '2026-09-30');
  await expect(page.locator('.task-title')).toHaveText(['本周支线']);
  await expect(page.locator('.carryover-label')).toHaveCount(0);
  await selectPeriod(page, 'month', '2026-09-30');
  await expect(page.locator('.task-title')).toHaveText(['九月主线', '本月支线']);
  await expect(page.locator('.carryover-label')).toHaveCount(0);
  await selectPeriod(page, 'custom', '2026-09-18', '2026-09-19');
  await expect(page.locator('.task-title')).toHaveText(['自定义支线']);
  await expect(page.locator('.carryover-label')).toHaveCount(0);
});

test('main ranges carry only after their final day and explicit legacy dates override the creation period', async ({ page }) => {
  const records = [
    mainTask('范围主线', '2026-09-28', { dateEnd: '2026-09-30', period: { mode: 'week', start: '2026-09-28', end: '2026-10-04' } }),
    mainTask('旧版明确日期', '2026-09-29', { dateEnd: '', period: { mode: 'week', start: '2026-09-28', end: '2026-10-04' } }),
    mainTask('旧版起始日期', '', { dateStart: '2026-09-29', dateEnd: '', period: null }),
    mainTask('仅有周期日期', '', { dateEnd: '', period: { mode: 'week', start: '2026-09-28', end: '2026-09-30' } }),
  ];
  await seed(page, records);
  await expect(row(page, '范围主线')).toBeVisible();
  await expect(row(page, '范围主线').locator('.carryover-label')).not.toBeVisible();
  await expect(row(page, '仅有周期日期').locator('.carryover-label')).not.toBeVisible();
  for (const id of ['旧版明确日期', '旧版起始日期']) {
    await expect(row(page, id).locator('.carryover-label')).toHaveText('9月29日未完成');
  }
  await selectDay(page, '2026-10-01');
  await expect(row(page, '范围主线')).toHaveCount(0);
  await expect(row(page, '仅有周期日期')).toHaveCount(0);
  await page.clock.setFixedTime(new Date('2026-10-01T04:00:00Z'));
  for (const id of ['范围主线', '仅有周期日期']) {
    await expect(row(page, id).locator('.carryover-label')).toHaveText('9月30日未完成');
  }
  expect(await saved(page)).toEqual(records);
  for (const record of records) await row(page, record.id).locator('.check').click();
  await page.clock.setFixedTime(new Date('2026-10-02T04:00:00Z'));
  await selectDay(page, '2026-10-02');
  // The legacy record's original week must not keep a completed task visible
  // after its explicit due date and its completion day have both passed.
  await expect(page.locator('.task')).toHaveCount(0);
});

test('carryover completion and task menu actions synchronize across windows without losing the record', async ({ page, context }) => {
  await seed(page, [
    mainTask('当天主线', '2026-09-30'),
    mainTask('同步继承主线', '2026-09-29', { items: [{ text: '保留事项', done: false }], memos: [{ title: '保留备注', html: '<b>完整内容</b>' }] }),
    sideTask('同步继承支线', '2026-09-29'),
  ]);
  const other = await context.newPage();
  await other.clock.setFixedTime(new Date(NOW));
  await other.goto(url);
  await taskAction(page, '同步继承主线', 'pin');
  await expect(other.locator('#main-tasks .task-title')).toHaveText(['同步继承主线', '当天主线']);
  const original = (await saved(page)).find(task => task.id === '同步继承主线');
  await taskAction(page, '同步继承主线', 'delete');
  await expect(row(other, '同步继承主线')).toHaveCount(0);
  await row(other, '同步继承支线').locator('.check').click();
  await expect(row(page, '同步继承支线')).toHaveClass(/done/);
  await expect(row(page, '同步继承支线').locator('.carryover-label')).not.toBeVisible();
  await page.locator('#task-undo').click();
  await expect(row(other, '同步继承主线').locator('.carryover-label')).toHaveText('9月29日未完成');
  const records = await saved(page);
  expect(records).toHaveLength(3);
  expect(records.find(task => task.id === original.id)).toEqual(original);
  expect(records.find(task => task.id === '同步继承支线')).toMatchObject({ done: true, completedOn: '2026-09-30' });
  await other.close();
});

test('failed completion writes preserve carryover status and retry records the completion day once', async ({ page }) => {
  await seed(page, [mainTask('失败重试继承', '2026-09-29')]);
  const before = await saved(page);
  await page.evaluate(key => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Task storage quota exhausted', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
    window.restoreTaskWrites = () => { Storage.prototype.setItem = setItem; };
  }, TASKS);
  await row(page, '失败重试继承').locator('.check').click();
  await expect(page.locator('#toast')).toContainText('保存失败');
  await expect(row(page, '失败重试继承')).not.toHaveClass(/done/);
  await expect(row(page, '失败重试继承').locator('.carryover-label')).toHaveText('9月29日未完成');
  expect(await saved(page)).toEqual(before);
  await page.evaluate(() => window.restoreTaskWrites());
  await row(page, '失败重试继承').locator('.check').click();
  await expect(row(page, '失败重试继承')).toHaveClass(/done/);
  const records = await saved(page);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ done: true, completedOn: '2026-09-30', date: '2026-09-29', dateEnd: '2026-09-29' });
});

test('carryover and completion use the selected timezone and manual calendar day at midnight boundaries', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-29T15:30:00Z'));
  await seed(page, [mainTask('时区主线', '2026-09-29'), sideTask('时区支线', '2026-09-29')]);
  await expectCurrentDay(page, '2026-09-29');
  await expect(page.locator('.carryover-label')).toHaveCount(0);
  await page.locator('#settings-open').click();
  await page.locator('#timezone-select').selectOption('Asia/Tokyo');
  await page.locator('#settings-close').click();
  await expectCurrentDay(page, '2026-09-30');
  await expect(page.locator('.carryover-label')).toHaveCount(2);
  for (const [time, labels] of [['2026-09-29T23:59', 0], ['2026-09-30T00:01', 2]]) {
    await page.locator('#clock').click();
    await page.locator('#manual-datetime').fill(time);
    await page.locator('#clock-save').click();
    await expectCurrentDay(page, time.slice(0, 10));
    await expect(page.locator('.carryover-label')).toHaveCount(labels);
  }
  await row(page, '时区支线').locator('.check').click();
  expect((await saved(page)).find(task => task.id === '时区支线')).toMatchObject({ done: true, completedOn: '2026-09-30' });
  await expect(row(page, '时区主线').locator('.carryover-label')).toHaveText('9月29日未完成');
  await expect(row(page, '时区支线').locator('.deadline')).toHaveText('20:30');
  await expect(row(page, '时区支线').locator('.carryover-label')).not.toBeVisible();
});
