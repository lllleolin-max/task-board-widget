const { test: base, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const TASKS = 'minimal-task-widget-v1';
const SETTINGS = 'minimal-task-widget-settings-v1';
const COURSES = 'minimal-task-widget-schedule-v1';
const DRAFT = 'minimal-task-widget-draft-html-v1';
const LAYOUT = 'minimal-task-widget-schedule-layout-v1';
const saveFailure = /保存失败|无法.*保存|存储空间/;

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.evaluate(key => localStorage.setItem(key, '[]'), TASKS);
    await page.reload();
    await use(page);
    expect(errors, 'Storage failures and malformed saved data must not escape as renderer exceptions').toEqual([]);
  },
});

async function raw(page, key) {
  return page.evaluate(key => localStorage.getItem(key), key);
}

async function denyWrites(page, key) {
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    window.restoreStorageWrites = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Local storage quota exhausted', 'QuotaExceededError');
      return original.call(this, name, value);
    };
  }, key);
}

async function restoreWrites(page) {
  await page.evaluate(() => window.restoreStorageWrites());
}

async function expectFailureToast(page) {
  await expect(page.locator('#toast')).toBeVisible();
  await expect(page.locator('#toast')).toHaveClass(/show/);
  await expect(page.locator('#toast')).toHaveText(saveFailure);
}

async function enableCourses(page) {
  await page.locator('#settings-open').click();
  await page.locator('#course-toggle').click();
  await page.locator('#settings-close').click();
  await expect(page.locator('#schedule-card')).toBeVisible();
}

test('task quota failure keeps the form and prior data; retry saves exactly one task', async ({ page }) => {
  const before = await raw(page, TASKS);
  await denyWrites(page, TASKS);
  await page.locator('[data-add="side"]').click();
  await page.locator('#task-input').fill('保留未保存任务');
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('#scrim')).toHaveClass(/open/);
  await expect(page.locator('#task-input')).toHaveValue('保留未保存任务');
  await expectFailureToast(page);
  expect(await raw(page, TASKS)).toBe(before);
  await restoreWrites(page);
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('#scrim')).not.toHaveClass(/open/);
  await expect(page.locator('.task-title').filter({ hasText: '保留未保存任务' })).toHaveCount(1);
  expect(JSON.parse(await raw(page, TASKS)).filter(task => task.title === '保留未保存任务')).toHaveLength(1);
  await page.reload();
  await expect(page.locator('.task-title').filter({ hasText: '保留未保存任务' })).toHaveCount(1);
});

test('course quota failure keeps the editor and prior data; retry saves exactly one course', async ({ page }) => {
  await enableCourses(page);
  const before = await raw(page, COURSES);
  await denyWrites(page, COURSES);
  await page.locator('#schedule-edit').click();
  await page.locator('#course-name').fill('保留未保存课程');
  await page.locator('#course-room').fill('教学楼 101');
  await page.locator('#schedule-save').click();
  await expect(page.locator('#schedule-scrim')).toHaveClass(/open/);
  await expect(page.locator('#course-name')).toHaveValue('保留未保存课程');
  await expect(page.locator('#course-room')).toHaveValue('教学楼 101');
  await expectFailureToast(page);
  expect(await raw(page, COURSES)).toBe(before);
  await restoreWrites(page);
  await page.locator('#schedule-save').click();
  await expect(page.locator('#schedule-scrim')).not.toHaveClass(/open/);
  await expect(page.locator('.schedule-course').filter({ hasText: '保留未保存课程' })).toHaveCount(1);
  expect(JSON.parse(await raw(page, COURSES)).filter(course => course.name === '保留未保存课程')).toHaveLength(1);
});

test('draft quota failure preserves unsaved text and the saved copy until a successful retry', async ({ page }) => {
  await page.evaluate(key => localStorage.setItem(key, '<div>已保存的草稿</div>'), DRAFT);
  await page.reload();
  const before = await raw(page, DRAFT);
  await denyWrites(page, DRAFT);
  await page.locator('#draft-open').click();
  await page.locator('#draft-editor').fill('本地配额不足时保留的草稿');
  await expect(page.locator('#draft-editor')).toHaveText('本地配额不足时保留的草稿');
  await expectFailureToast(page);
  expect(await raw(page, DRAFT)).toBe(before);
  await restoreWrites(page);
  await page.locator('#draft-editor').press('End');
  await page.locator('#draft-editor').press('!');
  await expect.poll(() => raw(page, DRAFT)).toContain('本地配额不足时保留的草稿!');
  await page.reload();
  await page.locator('#draft-open').click();
  await expect(page.locator('#draft-editor')).toHaveText('本地配额不足时保留的草稿!');
});

test('out-of-range saved manual time falls back to a usable clock and task UI', async ({ page }) => {
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ manualTime: 1e20, manualTimeSavedAt: Date.now() })), SETTINGS);
  await page.reload();
  await expect(page.locator('#clock')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(page.locator('.schedule-slot')).toHaveCount(210);
  await page.locator('[data-add="side"]').click();
  await page.locator('#task-input').fill('日期恢复后的任务');
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('.task-title').filter({ hasText: '日期恢复后的任务' })).toHaveCount(1);
});

test('manual-clock quota failure keeps the selected time and reports failure until retry succeeds', async ({ page }) => {
  const before = await raw(page, SETTINGS);
  await denyWrites(page, SETTINGS);
  await page.locator('#clock').click();
  await page.locator('#manual-datetime').fill('2025-04-01T12:30');
  await page.locator('#clock-save').click();
  await expect(page.locator('#clock-scrim')).toHaveClass(/open/);
  await expect(page.locator('#manual-datetime')).toHaveValue('2025-04-01T12:30');
  await expectFailureToast(page);
  expect(await raw(page, SETTINGS)).toBe(before);
  await restoreWrites(page);
  await page.locator('#clock-save').click();
  await expect(page.locator('#clock-scrim')).not.toHaveClass(/open/);
  expect(Number.isFinite(JSON.parse(await raw(page, SETTINGS)).manualTime)).toBe(true);
});

test('reopening the manual-clock editor preserves a valid Unix epoch time of zero', async ({ page }) => {
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ timezone: 'Asia/Shanghai' })), SETTINGS);
  await page.reload();
  await page.locator('#clock').click();
  await page.locator('#manual-datetime').fill('1970-01-01T08:00');
  await page.locator('#clock-save').click();
  expect(JSON.parse(await raw(page, SETTINGS)).manualTime).toBe(0);
  await page.locator('#clock').click();
  await expect(page.locator('#manual-datetime')).toHaveValue('1970-01-01T08:00');
});

test('failed display-setting writes retain the course switch, language, font and theme', async ({ page }) => {
  const before = await raw(page, SETTINGS);
  await denyWrites(page, SETTINGS);
  await page.locator('#settings-open').click();
  await page.locator('#course-toggle').click();
  await expect(page.locator('#course-toggle')).toHaveAttribute('aria-checked', 'false');
  await expectFailureToast(page);
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('#language-select')).toHaveValue('zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.locator('#font-size-range').fill('18');
  await expect(page.locator('#font-size-range')).toHaveValue('14');
  expect(await page.locator('html').evaluate(element => element.style.getPropertyValue('--base-font'))).toBe('14px');
  await page.locator('.theme-choice[data-value="mo"]').click();
  await expect(page.locator('#widget')).toHaveAttribute('data-theme', 'default');
  await expectFailureToast(page);
  expect(await raw(page, SETTINGS)).toBe(before);
  await restoreWrites(page);
  await page.locator('#course-toggle').click();
  await expect(page.locator('#course-toggle')).toHaveAttribute('aria-checked', 'true');
  expect(JSON.parse(await raw(page, SETTINGS)).courseEnabled).toBe(true);
});

test('period changes and restoring system time remain retryable when settings storage is full', async ({ page }) => {
  await page.locator('#clock').click();
  await page.locator('#manual-datetime').fill('2025-04-01T12:30');
  await page.locator('#clock-save').click();
  const beforePeriod = await raw(page, SETTINGS);
  await denyWrites(page, SETTINGS);
  await page.locator('#period-open').click();
  await page.locator('[data-period="week"]').click();
  await page.locator('#period-apply').click();
  await expect(page.locator('#period-scrim')).toHaveClass(/open/);
  await expectFailureToast(page);
  expect(await raw(page, SETTINGS)).toBe(beforePeriod);
  await restoreWrites(page);
  await page.locator('#period-apply').click();
  await expect(page.locator('#period-scrim')).not.toHaveClass(/open/);
  expect(JSON.parse(await raw(page, SETTINGS)).periodMode).toBe('week');
  const beforeReset = await raw(page, SETTINGS);
  await denyWrites(page, SETTINGS);
  await page.locator('#clock').click();
  await page.locator('#clock-system').click();
  await expect(page.locator('#clock-scrim')).toHaveClass(/open/);
  await expectFailureToast(page);
  expect(await raw(page, SETTINGS)).toBe(beforeReset);
  await restoreWrites(page);
  await page.locator('#clock-system').click();
  await expect(page.locator('#clock-scrim')).not.toHaveClass(/open/);
  expect(JSON.parse(await raw(page, SETTINGS)).manualTime).toBeUndefined();
});

test('malformed task dates and prototype-named display settings recover without breaking rendering', async ({ page }) => {
  await page.evaluate(({ tasks, settings }) => {
    localStorage.setItem(tasks, JSON.stringify([
      { id: 'bad-numeric-date', type: 'side', title: '数值日期的原任务', date: 1, dateEnd: 2, items: [] },
      { id: 'bad-object-date', type: 'side', title: '对象日期的原任务', date: {}, dateEnd: [], items: [] },
    ]));
    localStorage.setItem(settings, JSON.stringify({ theme: '__proto__', language: 'constructor' }));
  }, { tasks: TASKS, settings: SETTINGS });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('#widget')).toHaveAttribute('data-theme', 'default');
  await expect(page.locator('.task-title')).toHaveCount(2);
  await expect(page.locator('#side-tasks')).not.toContainText('NaN');
  await expect(page.locator('#clock')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
});

async function expectScheduleInsideViewport(page) {
  await expect.poll(async () => {
    const box = await page.locator('#schedule-card').boundingBox();
    const { width, height } = page.viewportSize();
    return !!box && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1;
  }).toBe(true);
}

test('floating course layout is clamped on load, reload and a cross-window storage update', async ({ page, context }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.evaluate(({ settings, layout }) => {
    localStorage.setItem(settings, JSON.stringify({ courseEnabled: true }));
    localStorage.setItem(layout, JSON.stringify({ floating: true, left: 3000, top: 3000, width: 352, height: 220 }));
  }, { settings: SETTINGS, layout: LAYOUT });
  await page.reload();
  await expectScheduleInsideViewport(page);
  await page.reload();
  await expectScheduleInsideViewport(page);
  const other = await context.newPage();
  await other.goto(url);
  await other.evaluate(key => localStorage.setItem(key, JSON.stringify({ floating: true, left: -500, top: 9000, width: 4000, height: 3000 })), LAYOUT);
  await expectScheduleInsideViewport(page);
  await other.close();
});

test('PiP temporary layout never overwrites the original course layout across close and reload', async ({ page }) => {
  await page.evaluate(({ settings, layout }) => {
    localStorage.setItem(settings, JSON.stringify({ courseEnabled: true }));
    localStorage.setItem(layout, JSON.stringify({ floating: true, left: 100, top: 600, width: 300, height: 250, customSize: true }));
  }, { settings: SETTINGS, layout: LAYOUT });
  await page.reload();
  await expect(page.locator('#schedule-card')).toBeVisible();
  const before = JSON.parse(await raw(page, LAYOUT));
  await page.evaluate(() => {
    Object.defineProperty(window, 'documentPictureInPicture', {
      configurable: true,
      value: {
        requestWindow: async () => {
          const popup = window.open('', '_blank', 'width=1000,height=1000');
          const close = popup.close.bind(popup);
          popup.close = () => { popup.dispatchEvent(new PageTransitionEvent('pagehide')); close(); };
          return popup;
        },
      },
    });
  });
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#widget-pin-toggle').click()]);
  await popup.setViewportSize({ width: 1100, height: 1100 });
  await expect(popup.locator('#widget')).toBeVisible();
  await popup.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(JSON.parse(await raw(page, LAYOUT))).toEqual(before);
  await popup.locator('#widget-pin-toggle').click();
  await expect(page.locator('#widget')).toBeVisible();
  await expect(page.locator('#app-stack')).toHaveClass(/schedule-floating/);
  expect(JSON.parse(await raw(page, LAYOUT))).toEqual(before);
  await page.reload();
  await expect(page.locator('#app-stack')).toHaveClass(/schedule-floating/);
  expect(JSON.parse(await raw(page, LAYOUT))).toEqual(before);
});
