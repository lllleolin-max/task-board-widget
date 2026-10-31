const { test: base, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const TASKS = 'minimal-task-widget-v1';
const NOW = '2026-09-29T04:00:00Z';
const titles = { main: ['主线甲', '主线乙'], side: ['支线甲', '支线乙'] };

function task(page, title) {
  return page.locator('.task').filter({ has: page.locator('.task-title', { hasText: title }) });
}

function group(page, type) {
  return page.locator(`#${type}-tasks .task-title`);
}

async function addTask(page, title, type = 'main') {
  await page.locator(`[data-add="${type}"]`).click();
  await page.locator('#task-input').fill(title);
  await page.locator('#form button[type="submit"]').click();
  await expect(page.locator('#scrim')).not.toHaveClass(/open/);
  await expect(task(page, title)).toBeVisible();
}

const test = base.extend({
  page: async ({ page, context }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    context.on('page', other => other.on('pageerror', error => errors.push(error.message)));
    await page.clock.setFixedTime(new Date(NOW));
    await page.goto(url);
    for (const type of ['main', 'side']) {
      for (const title of titles[type]) await addTask(page, title, type);
    }
    await use(page);
    expect(errors, 'Task menu interactions must not throw renderer errors').toEqual([]);
  },
});

async function savedTasks(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), TASKS);
}

async function openMenu(page, title) {
  await task(page, title).locator('.task-title').click({ button: 'right' });
  await expect(page.locator('#task-menu')).toBeVisible();
  await expect(page.locator('#task-menu')).toHaveAttribute('role', 'menu');
}

async function act(page, title, action) {
  await openMenu(page, title);
  const item = page.locator(`#task-menu [data-task-action="${action}"]`);
  await expect(item).toHaveAttribute('role', 'menuitem');
  await item.click();
}

async function denyTaskWrites(page) {
  await page.evaluate(key => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Task storage quota exhausted', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
    window.restoreTaskWrites = () => { Storage.prototype.setItem = setItem; };
  }, TASKS);
}

test('pinning is persistent and stable within each task group, and unpinning restores the original order', async ({ page }) => {
  await act(page, titles.main[1], 'pin');
  await act(page, titles.side[1], 'pin');
  await expect(group(page, 'main')).toHaveText([titles.main[1], titles.main[0]]);
  await expect(group(page, 'side')).toHaveText([titles.side[1], titles.side[0]]);
  await page.reload();
  await expect(group(page, 'main')).toHaveText([titles.main[1], titles.main[0]]);
  await expect(group(page, 'side')).toHaveText([titles.side[1], titles.side[0]]);

  // Pin order must not replace the original order between equally pinned tasks.
  await act(page, titles.main[0], 'pin');
  await expect(group(page, 'main')).toHaveText(titles.main);
  await act(page, titles.main[0], 'pin');
  await expect(group(page, 'main')).toHaveText([titles.main[1], titles.main[0]]);
  await act(page, titles.main[1], 'pin');
  await expect(group(page, 'main')).toHaveText(titles.main);
  await expect(group(page, 'side')).toHaveText([titles.side[1], titles.side[0]]);
  await act(page, titles.side[1], 'pin');
  await page.reload();
  await expect(group(page, 'main')).toHaveText(titles.main);
  await expect(group(page, 'side')).toHaveText(titles.side);
});

test('the task menu remains inside the viewport and supports keyboard, Escape and outside dismissal', async ({ page }) => {
  const title = task(page, titles.main[1]).locator('.task-title');
  const box = await title.boundingBox();
  await title.click({ button: 'right', position: { x: box.width - 1, y: box.height / 2 } });
  const menu = page.locator('#task-menu');
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox(), viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  const pin = menu.locator('[data-task-action="pin"]');
  const remove = menu.locator('[data-task-action="delete"]');
  await expect(pin).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(remove).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(pin).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(group(page, 'main')).toHaveText([titles.main[1], titles.main[0]]);

  const before = await savedTasks(page);
  await openMenu(page, titles.main[0]);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await openMenu(page, titles.side[0]);
  await page.mouse.click(10, viewport.height - 10);
  await expect(menu).toBeHidden();
  expect(await savedTasks(page)).toEqual(before);
});

test('delete and undo restore the complete task, merge a concurrent addition, and synchronize both windows', async ({ page, context }) => {
  await page.evaluate(({ key, title }) => {
    const tasks = JSON.parse(localStorage.getItem(key));
    Object.assign(tasks.find(task => task.title === title), {
      done: true,
      time: '15:30',
      date: '2026-09-28',
      dateStart: '2026-09-28',
      dateEnd: '2026-09-30',
      items: [{ text: '已确认的完整说明', done: true, html: '<b>保留加粗</b>' }],
      memos: [{ title: '完整备注', html: '<p>保留备注内容</p>' }],
      auditData: { nested: ['保留扩展字段', 7] },
    });
    localStorage.setItem(key, JSON.stringify(tasks));
  }, { key: TASKS, title: titles.main[0] });
  await page.reload();
  const other = await context.newPage();
  await other.clock.setFixedTime(new Date(NOW));
  await other.goto(url);
  await act(page, titles.main[1], 'pin');
  await expect(group(other, 'main')).toHaveText([titles.main[1], titles.main[0]]);
  await act(page, titles.main[0], 'pin');
  await expect(group(other, 'main')).toHaveText(titles.main);
  const original = (await savedTasks(page)).find(task => task.title === titles.main[0]);

  await act(page, titles.main[0], 'delete');
  await expect(task(page, titles.main[0])).toHaveCount(0);
  await expect(task(other, titles.main[0])).toHaveCount(0);
  await expect(page.locator('#task-undo')).toBeVisible();
  await addTask(other, '另一窗口新增的任务');
  await expect(task(page, '另一窗口新增的任务')).toBeVisible();
  await page.locator('#task-undo').click();
  await expect(group(page, 'main')).toHaveText([...titles.main, '另一窗口新增的任务']);
  await expect(group(other, 'main')).toHaveText([...titles.main, '另一窗口新增的任务']);
  const restored = await savedTasks(page);
  expect(restored).toHaveLength(5);
  expect(restored.find(task => task.id === original.id)).toEqual(original);
  await task(page, titles.main[0]).locator('.expand').click();
  await expect(task(page, titles.main[0]).locator('.memo-body')).toHaveText('保留备注内容');
  await expect(task(page, titles.main[0]).locator('.note-text')).toHaveText('保留加粗');
  await page.reload();
  await expect(group(page, 'main')).toHaveText([...titles.main, '另一窗口新增的任务']);
  expect((await savedTasks(page)).find(task => task.id === original.id)).toEqual(original);
  await other.close();
});

test('failed pin and delete writes preserve the saved tasks and remain retryable', async ({ page }) => {
  const before = await savedTasks(page);
  await denyTaskWrites(page);
  for (const action of ['pin', 'delete']) {
    await act(page, titles.main[1], action);
    await expect(page.locator('#toast')).toContainText('保存失败');
    expect(await savedTasks(page)).toEqual(before);
    await expect(group(page, 'main')).toHaveText(titles.main);
    await expect(group(page, 'side')).toHaveText(titles.side);
  }
  await page.evaluate(() => window.restoreTaskWrites());
  await act(page, titles.main[1], 'delete');
  await expect(task(page, titles.main[1])).toHaveCount(0);
  await expect(page.locator('#task-undo')).toBeVisible();
});

test('failed undo preserves its recovery action and restores exactly one task after retry', async ({ page }) => {
  await act(page, titles.side[0], 'delete');
  await expect(task(page, titles.side[0])).toHaveCount(0);
  const afterDelete = await savedTasks(page);
  await denyTaskWrites(page);
  await page.locator('#task-undo').click();
  await expect(page.locator('#toast')).toContainText(/保存失败|撤销失败/);
  expect(await savedTasks(page)).toEqual(afterDelete);
  await expect(task(page, titles.side[0])).toHaveCount(0);
  await expect(page.locator('#task-undo')).toBeVisible();
  await page.evaluate(() => window.restoreTaskWrites());
  await page.locator('#task-undo').click();
  await expect(group(page, 'side')).toHaveText(titles.side);
  expect(await savedTasks(page)).toHaveLength(4);
  await page.reload();
  await expect(group(page, 'side')).toHaveText(titles.side);
});

test('ordinary setting notifications preserve the pending task deletion undo action', async ({ page }) => {
  await act(page, titles.side[0], 'delete');
  await expect(task(page, titles.side[0])).toHaveCount(0);
  await page.locator('#settings-open').click();
  await page.locator('#course-toggle').click();
  await expect(page.locator('#toast')).toContainText('课表已开启');
  await expect(page.locator('#task-undo')).toBeVisible();
  await page.locator('#course-toggle').click();
  await expect(page.locator('#toast')).toContainText('课表已关闭');
  await expect(page.locator('#task-undo')).toBeVisible();
  await page.locator('#settings-close').click();
  await page.locator('#task-undo').click();
  await expect(group(page, 'side')).toHaveText(titles.side);
  expect(await savedTasks(page)).toHaveLength(4);
});

test('task menus and undo keep working when the widget enters and leaves PiP', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(window, 'documentPictureInPicture', {
      configurable: true,
      value: {
        requestWindow: async () => {
          const popup = window.open('', '_blank', 'width=1100,height=1100');
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
  await expect(page.locator('#widget')).toHaveCount(0);
  await act(popup, titles.main[1], 'pin');
  await expect(group(popup, 'main')).toHaveText([titles.main[1], titles.main[0]]);
  await act(popup, titles.side[0], 'delete');
  await expect(task(popup, titles.side[0])).toHaveCount(0);
  await popup.locator('#task-undo').click();
  await expect(group(popup, 'side')).toHaveText(titles.side);
  await popup.locator('#widget-pin-toggle').click();
  await expect(page.locator('#widget')).toBeVisible();
  await act(page, titles.main[1], 'pin');
  await expect(group(page, 'main')).toHaveText(titles.main);
  await act(page, titles.side[1], 'delete');
  await expect(task(page, titles.side[1])).toHaveCount(0);
  await page.locator('#task-undo').click();
  await expect(group(page, 'side')).toHaveText(titles.side);
});

test('desktop menu interaction and the undo button are included in native window bounds reports', async ({ page }) => {
  await page.addInitScript(() => {
    window.desktopBridge = {
      reportWidgetBounds: bounds => { window.widgetBounds = bounds; },
      reportScheduleBounds() {},
      getPins: async () => ({ widget: false, schedule: false }),
      setLocale() {},
      onWidgetBounds() {},
      getWidgetBounds: async () => null,
      onCourseEnabled() {},
    };
  });
  await page.goto(`${url}?panel=widget`);
  await openMenu(page, titles.side[1]);
  // Modal input coverage lets the native host receive menu and outside clicks,
  // including the part of the menu that extends beyond the widget card.
  await expect.poll(() => page.evaluate(() => window.widgetBounds?.modal)).toBe(true);
  await page.mouse.click(10, page.viewportSize().height - 10);
  await expect(page.locator('#task-menu')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.widgetBounds?.modal)).toBe(false);

  await act(page, titles.side[1], 'delete');
  const undo = page.locator('#task-undo');
  await expect(undo).toBeVisible();
  const box = await undo.boundingBox();
  await expect.poll(() => page.evaluate(box => {
    const report = window.widgetBounds;
    return !!report && [report, ...(report.extraRects || [])].some(rect =>
      rect.left <= box.x + 1 && rect.top <= box.y + 1 &&
      rect.left + rect.width >= box.x + box.width - 1 &&
      rect.top + rect.height >= box.y + box.height - 1);
  }, box)).toBe(true);
  await undo.click();
  await expect(group(page, 'side')).toHaveText(titles.side);
  await expect.poll(() => page.evaluate(() => window.widgetBounds?.modal)).toBe(false);
});
