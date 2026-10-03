const { test: base, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const test = base.extend({
  page: async ({ page, context }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    context.on('page', popup => popup.on('pageerror', error => errors.push(error.message)));
    await page.clock.setFixedTime(new Date('2026-09-29T04:00:00Z'));
    await page.goto(url);
    await use(page);
    expect(errors, 'No uncaught errors while moving the UI between documents').toEqual([]);
  },
});

async function openPinWindow(page) {
  // Use a real same-origin popup for DOM adoption and pointer event propagation.
  // Only the browser PiP permission/OS window API is mocked; the app's handlers run unchanged.
  await page.evaluate(() => {
    Object.defineProperty(window, 'documentPictureInPicture', {
      configurable: true,
      value: {
        requestWindow: async () => {
          const popup = window.open('', '_blank', 'width=1000,height=1000');
          const close = popup.close.bind(popup);
          popup.close = () => {
            popup.dispatchEvent(new PageTransitionEvent('pagehide'));
            close();
          };
          return popup;
        },
      },
    });
  });
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('#widget-pin-toggle').click(),
  ]);
  await popup.setViewportSize({ width: 1100, height: 1100 });
  await expect(popup.locator('#widget')).toBeVisible();
  await expect(popup.locator('#widget-pin-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#widget')).toHaveCount(0);
  return popup;
}

async function dragBy(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  const x = box.x + box.width - 10;
  const y = box.y + box.height - 8;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}

test('PiP keeps widget dragging, keyboard shortcuts and task creation working', async ({ page }) => {
  const popup = await openPinWindow(page);
  const before = await popup.locator('#widget').boundingBox();
  await dragBy(popup, popup.locator('#widget .top'), 130, 65);
  await expect.poll(async () => (await popup.locator('#widget').boundingBox()).x)
    .toBeGreaterThan(before.x + 90);
  await expect(popup.locator('#widget')).not.toHaveClass(/window-interacting/);

  await popup.keyboard.press('d');
  await expect(popup.locator('#draft-window')).toBeVisible();
  await popup.keyboard.press('Escape');
  await expect(popup.locator('#draft-window')).not.toBeVisible();
  await popup.locator('[data-add="main"]').click();
  await popup.locator('#task-input').fill('浮窗内新建任务');
  await popup.locator('#form button[type="submit"]').click();
  await expect(popup.locator('.task-title', { hasText: '浮窗内新建任务' })).toBeVisible();

  await popup.locator('#widget-pin-toggle').click();
  await expect(page.locator('#widget')).toBeVisible();
  await expect(page.locator('#widget-pin-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.task-title', { hasText: '浮窗内新建任务' })).toBeVisible();
});

test('PiP applies display settings, translates new UI and restores them to the opener', async ({ page }) => {
  const popup = await openPinWindow(page);
  await popup.locator('#settings-open').click();
  await popup.locator('.theme-choice[data-value="zhu"]').click();
  await popup.locator('#font-size-range').fill('18');
  await popup.locator('#language-select').selectOption('en');
  await expect(popup.locator('html')).toHaveAttribute('lang', 'en');
  expect(await popup.locator('html').evaluate(el => el.style.getPropertyValue('--task-font'))).toBe('18px');
  expect(await popup.locator('html').evaluate(el => el.style.getPropertyValue('--theme-art'))).toContain('竹影听风');
  await popup.locator('#settings-close').click();
  await popup.locator('[data-add="main"]').click();
  await expect(popup.locator('#dialog-title')).not.toHaveText('添加主线任务');
  await popup.keyboard.press('Escape');
  await popup.locator('#widget-pin-toggle').click();

  await expect(page.locator('#widget')).toHaveAttribute('data-theme', 'zhu');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await page.locator('html').evaluate(el => el.style.getPropertyValue('--task-font'))).toBe('18px');
  expect(await page.locator('html').evaluate(el => el.style.getPropertyValue('--theme-art'))).toContain('竹影听风');
  await page.locator('[data-add="main"]').click();
  await expect(page.locator('#dialog-title')).not.toHaveText('添加主线任务');
});

test('PiP supports dragging courses and moving the independent schedule', async ({ page }) => {
  await page.locator('#settings-open').click();
  await page.locator('#course-toggle').click();
  await page.locator('#settings-close').click();
  await page.locator('#schedule-edit').click();
  await page.locator('#course-name').fill('浮窗课程');
  await page.locator('#schedule-save').click();
  const popup = await openPinWindow(page);
  const course = popup.locator('.schedule-course', { hasText: '浮窗课程' });
  const from = await course.boundingBox();
  const slot = popup.locator('.schedule-slot[data-day="2"][data-slot="6"]');
  await slot.scrollIntoViewIfNeeded();
  const target = await slot.boundingBox();
  await popup.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await popup.mouse.down();
  await popup.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await popup.mouse.up();
  await expect(course).toHaveAttribute('title', /10:00–11:00/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('minimal-task-widget-schedule-v1'))[0].day)).toBe(2);

  await popup.locator('#schedule-lock-toggle').click();
  const before = await popup.locator('#schedule-card').boundingBox();
  // The empty left side of the heading avoids its action buttons.
  const head = await popup.locator('.schedule-head').boundingBox();
  await popup.mouse.move(head.x + 12, head.y + head.height / 2);
  await popup.mouse.down();
  await popup.mouse.move(head.x + 222, head.y + head.height / 2 + 90, { steps: 10 });
  await popup.mouse.up();
  await expect.poll(async () => (await popup.locator('#schedule-card').boundingBox()).x)
    .toBeGreaterThan(before.x + 150);
  await expect(popup.locator('#schedule-card')).not.toHaveClass(/schedule-dragging/);
});
