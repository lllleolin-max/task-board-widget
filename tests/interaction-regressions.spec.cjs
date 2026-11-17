const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const TASKS = 'minimal-task-widget-v1';
let pageErrors;

test.beforeEach(async ({ page, context }) => {
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  context.on('page', other => other.on('pageerror', error => pageErrors.push(error.message)));
  await page.goto(url);
  expect(pageErrors, 'The renderer must initialize before testing interactions').toEqual([]);
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify([
    { id: 'a', type: 'side', title: 'Task A', done: false, items: [] },
    { id: 'b', type: 'side', title: 'Task B', done: false, items: [] },
  ])), TASKS);
  await page.reload();
  expect(pageErrors, 'The renderer must initialize with saved tasks').toEqual([]);
});

test.afterEach(() => {
  expect(pageErrors, 'Interactions must not throw renderer errors').toEqual([]);
});

async function beginNote(page, text) {
  const row = page.locator('.task[data-id="a"]');
  await row.locator('.expand').click();
  await row.locator('.inline-add').click();
  const input = row.locator('.inline-note');
  await input.fill(text);
  return { row, input };
}

test('completing a different task preserves the open note editor and its unsaved text', async ({ page }) => {
  const { row, input } = await beginNote(page, '尚未保存的说明');
  await page.locator('.task[data-id="b"] .check').click();
  await expect(page.locator('.task[data-id="b"]')).toHaveClass(/done/);
  await expect(row).toHaveClass(/open/);
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('尚未保存的说明');
  await expect(row.locator('.inline-add')).toBeDisabled();
  await row.locator('.save-note').click();
  await expect(row.locator('.note-text')).toHaveText('尚未保存的说明');
  await page.reload();
  await expect(page.locator('.task[data-id="b"]')).toHaveClass(/done/);
  await row.locator('.expand').click();
  await expect(row.locator('.note-text')).toHaveText('尚未保存的说明');
});

test('remote appearance changes preserve the note text, focus and selection', async ({ page, context }) => {
  const { row, input } = await beginNote(page, '保留输入和光标');
  await input.press('Home');
  await input.press('Shift+ArrowRight');
  await input.press('Shift+ArrowRight');
  const selection = await input.evaluate(el => [el.selectionStart, el.selectionEnd]);
  const other = await context.newPage();
  await other.goto(url);
  await other.locator('#settings-open').click();
  await other.locator('#font-size-range').fill('18');
  await expect(page.locator('#font-size-range')).toHaveValue('18');
  await expect(row).toHaveClass(/open/);
  await expect(input).toHaveValue('保留输入和光标');
  await expect(input).toBeFocused();
  expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual(selection);
  await other.locator('.theme-choice[data-value="mo"]').click();
  await expect(page.locator('#widget')).toHaveAttribute('data-theme', 'mo');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('保留输入和光标');
  await other.close();
});

test('saving an open note merges a note added in another window', async ({ page, context }) => {
  const { row, input } = await beginNote(page, '窗口 A 草稿');
  const other = await context.newPage();
  await other.goto(url);
  const remote = await beginNote(other, '窗口 B 已保存');
  await remote.row.locator('.save-note').click();
  await expect(row.locator('.note-text')).toHaveText('窗口 B 已保存');
  await expect(row).toHaveClass(/open/);
  await expect(input).toHaveValue('窗口 A 草稿');
  await expect(input).toBeFocused();
  await input.press('Control+Enter');
  await expect(row.locator('.note-text')).toHaveText(['窗口 B 已保存', '窗口 A 草稿']);
  await expect(remote.row.locator('.note-text')).toHaveText(['窗口 B 已保存', '窗口 A 草稿']);
  await page.reload();
  await row.locator('.expand').click();
  await expect(row.locator('.note-text')).toHaveText(['窗口 B 已保存', '窗口 A 草稿']);
  await other.close();
});

test('remote font changes keep the active course element mounted and focused', async ({ page, context }) => {
  await page.locator('#settings-open').click();
  await page.locator('#course-toggle').click();
  await page.locator('#settings-close').click();
  await page.locator('#schedule-edit').click();
  await page.locator('#course-name').fill('正在查看的课程');
  await page.locator('#schedule-save').click();
  const course = page.locator('.schedule-course');
  await course.focus();
  const original = await course.elementHandle();
  const other = await context.newPage();
  await other.goto(url);
  await other.locator('#settings-open').click();
  await other.locator('#font-size-range').fill('18');
  await expect(page.locator('#font-size-range')).toHaveValue('18');
  expect(await original.evaluate(el => el.isConnected)).toBe(true);
  await expect(course).toBeFocused();
  await expect(course).toContainText('正在查看的课程');
  await other.close();
});

test('a floating schedule collapses to its header and expands to its previous size', async ({ page }) => {
  await page.locator('#settings-open').click();
  await page.locator('#course-toggle').click();
  await page.locator('#settings-close').click();
  await page.locator('#schedule-lock-toggle').click();
  const header = page.locator('.schedule-head');
  const start = await header.boundingBox();
  await page.mouse.move(start.x + 20, start.y + 25);
  await page.mouse.down();
  await page.mouse.move(start.x - 480, start.y + 75, { steps: 15 });
  await page.mouse.up();
  await expect(page.locator('#app-stack')).toHaveClass(/schedule-floating/);
  await page.locator('#schedule-collapse').hover();
  const expanded = await page.locator('#schedule-card').boundingBox();
  await page.locator('#schedule-collapse').click();
  await expect(page.locator('.schedule-scroll')).not.toBeVisible();
  await expect.poll(async () => {
    const card = await page.locator('#schedule-card').boundingBox();
    const head = await header.boundingBox();
    return card.height - head.height;
  }).toBeLessThan(4);
  expect((await page.locator('#schedule-card').boundingBox()).width).toBeCloseTo(expanded.width, 0);
  await page.locator('#schedule-collapse').click();
  await expect(page.locator('.schedule-scroll')).toBeVisible();
  await expect.poll(async () => Math.abs((await page.locator('#schedule-card').boundingBox()).height - expanded.height)).toBeLessThan(2);
  expect((await page.locator('#schedule-card').boundingBox()).width).toBeCloseTo(expanded.width, 0);
});

for (const panel of ['widget', 'schedule']) {
  test(`desktop ${panel} toast stays near its panel, is included in the shape, and releases its area`, async ({ page }) => {
    await page.addInitScript(() => {
      window.boundsReports = {};
      window.desktopBridge = {
        reportWidgetBounds: bounds => { window.boundsReports.widget = bounds; },
        reportScheduleBounds: bounds => { window.boundsReports.schedule = bounds; },
        getPins: async () => ({ widget: false, schedule: false }),
        setLocale: () => {},
        onWidgetBounds: () => {},
        getWidgetBounds: async () => ({ left: 160, top: 80, width: 352, height: 240 }),
        onCourseEnabled: () => {},
      };
    });
    await page.evaluate(() => localStorage.setItem(
      'minimal-task-widget-settings-v1',
      JSON.stringify({ courseEnabled: true }),
    ));
    await page.goto(`${url}?panel=${panel}`);
    expect(pageErrors).toEqual([]);

    if (panel === 'schedule') {
      // The host sends one authoritative widget rectangle. Docking must settle
      // correctly without a second update to repair an animated mirror width.
      await expect.poll(async () => {
        const rect = await page.locator('#schedule-card').boundingBox();
        return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width) };
      }).toEqual({ x: 160, y: 332, width: 352 });
    }

    if (panel === 'widget') {
      await page.locator('#clock').click();
      await page.locator('#manual-datetime').fill('2026-10-05T12:00');
      await page.locator('#clock-save').click();
      await expect(page.locator('#toast')).toHaveText('日期和时间已保存');
    } else {
      await page.locator('#schedule-edit').click();
      await page.locator('#course-name').fill('桌面提示回归课程');
      await page.locator('#schedule-save').click();
      await expect(page.locator('#toast')).toHaveText('课程已添加');
    }

    const toast = page.locator('#toast');
    await expect(toast).toHaveCSS('opacity', '1');
    const toastBox = await toast.boundingBox();
    const panelBox = await page.locator(panel === 'widget' ? '#widget' : '#schedule-card').boundingBox();
    expect(Math.abs(toastBox.x + toastBox.width / 2 - panelBox.x - panelBox.width / 2)).toBeLessThan(2);
    const gap = Math.min(
      Math.abs(toastBox.y - panelBox.y - panelBox.height),
      Math.abs(panelBox.y - toastBox.y - toastBox.height),
    );
    expect(gap).toBeLessThan(20);
    const viewport = page.viewportSize();
    expect(toastBox.x).toBeGreaterThanOrEqual(0);
    expect(toastBox.y).toBeGreaterThanOrEqual(0);
    expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(viewport.width);
    expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(viewport.height);

    // Assert the visible notification fits an actual region sent to the native
    // window. Opacity alone cannot prove visibility after Windows clips the HWND.
    await expect.poll(() => page.evaluate(({ panel, box }) => {
      const report = window.boundsReports[panel];
      return !!report && [report, ...(report.extraRects || [])].some(region =>
        region.left <= box.x + 1 && region.top <= box.y + 1 &&
        region.left + region.width >= box.x + box.width - 1 &&
        region.top + region.height >= box.y + box.height - 1,
      );
    }, { panel, box: toastBox })).toBe(true);
    await expect(toast).not.toHaveClass(/show/);
    await expect.poll(() => page.evaluate(panel => window.boundsReports[panel]?.extraRects, panel)).toEqual([]);
  });
}

const SCHEDULE_LAYOUT = 'minimal-task-widget-schedule-layout-v1';

async function desktopPair(page, context, layout) {
  let schedule, latest;
  await page.exposeFunction('relayWidgetBounds', async bounds => {
    latest = bounds;
    if (schedule && !schedule.isClosed()) {
      await schedule.evaluate(value => window.receiveWidgetBounds?.(value), bounds);
    }
  });
  const bridge = (target, initial) => target.addInitScript(initial => {
    window.desktopBridge = {
      reportWidgetBounds: bounds => { window.relayWidgetBounds?.(bounds); },
      reportScheduleBounds: bounds => { window.scheduleBounds = bounds; },
      getPins: async () => ({ widget: false, schedule: false }),
      setLocale: () => {},
      onWidgetBounds: callback => { window.receiveWidgetBounds = callback; },
      getWidgetBounds: async () => initial,
      onCourseEnabled: () => {},
      setCourseEnabled: () => {},
    };
  }, initial);
  await page.evaluate(({ key, layout }) => {
    localStorage.setItem(key, JSON.stringify(layout));
    localStorage.setItem('minimal-task-widget-settings-v1', JSON.stringify({ courseEnabled: false }));
  }, { key: SCHEDULE_LAYOUT, layout });
  await bridge(page, null);
  await page.goto(`${url}?panel=widget`);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // A disabled hidden mirror measures zero height; it must not replace the
  // schedule window's saved dimensions with its own fallback dimensions.
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SCHEDULE_LAYOUT)).toEqual(layout);
  await page.locator('#settings-open').click();
  await page.locator('#course-toggle').click();
  await page.locator('#settings-close').click();
  schedule = await context.newPage();
  await bridge(schedule, latest);
  await schedule.goto(`${url}?panel=schedule`);
  await expect(schedule.locator('#schedule-card')).toBeVisible();
  await expect(schedule.locator('#schedule-lock-toggle')).toHaveAttribute('aria-pressed', 'true');
  await schedule.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return schedule;
}

async function movePointer(page, locator, dx, dy, position) {
  const box = await locator.boundingBox();
  const x = box.x + (position?.x ?? box.width / 2);
  const y = box.y + (position?.y ?? box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 15 });
  await page.mouse.up();
}

for (const { name, custom, savedHeight, expectedHeight } of [
  { name: 'default', custom: false, savedHeight: 400, expectedHeight: 400 },
  { name: 'legacy default', custom: false, savedHeight: 220, expectedHeight: 400 },
  { name: 'custom', custom: true, savedHeight: 340, expectedHeight: 340 },
]) {
  test(`desktop widget movement preserves schedule-owned ${name} dimensions`, async ({ page, context }) => {
    const layout = {
      floating: false, left: 160, top: 420, width: custom ? 420 : 352,
      height: savedHeight, dockEdge: 'bottom', ...(custom ? { customSize: true } : {}),
    };
    const schedule = await desktopPair(page, context, layout);
    const card = schedule.locator('#schedule-card');
    await expect.poll(async () => (await card.boundingBox()).height).toBe(expectedHeight);
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SCHEDULE_LAYOUT);
    await movePointer(page, page.locator('#widget .top'), -350, 40, { x: 15, y: 30 });
    await movePointer(page, page.locator('[data-resize="se"]'), 60, 40);
    await expect.poll(async () => {
      const main = await page.locator('#widget').boundingBox(), docked = await card.boundingBox();
      return {
        gap: Math.round(docked.y - main.y - main.height),
        left: Math.round(docked.x - main.x),
        width: Math.round(docked.width - (custom ? layout.width : main.width)),
        height: Math.round(docked.height),
      };
    }).toEqual({ gap: 12, left: 0, width: 0, height: expectedHeight });
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SCHEDULE_LAYOUT)).toEqual(saved);
    await expect(schedule.locator('#schedule-lock-toggle')).toHaveAttribute('aria-pressed', 'true');
    await schedule.close();
  });
}

test('desktop widget reset clears remote schedule layout without deleting courses', async ({ page, context }) => {
  const schedule = await desktopPair(page, context, {
    floating: true, left: 100, top: 300, width: 450, height: 350,
    customSize: true, dockEdge: 'right',
  });
  await expect(schedule.locator('#app-stack')).toHaveClass(/schedule-floating/);
  await schedule.locator('#schedule-edit').click();
  await schedule.locator('#course-name').fill('布局重置后保留的课程');
  await schedule.locator('#schedule-save').click();
  const courses = await schedule.evaluate(() => localStorage.getItem('minimal-task-widget-schedule-v1'));
  await page.locator('#settings-open').click();
  await page.locator('#reset-defaults').click();
  await expect(schedule.locator('#schedule-card')).not.toBeVisible();
  await expect(schedule.locator('#app-stack')).not.toHaveClass(/schedule-floating|schedule-side-docked|schedule-sized-docked/);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SCHEDULE_LAYOUT)).toMatchObject({
    floating: false, customSize: false, dockEdge: 'bottom',
  });
  await page.locator('#settings-open').click();
  await page.locator('#course-toggle').click();
  await page.locator('#settings-close').click();
  await expect(schedule.locator('#schedule-card')).toBeVisible();
  await expect(schedule.locator('.schedule-course')).toContainText('布局重置后保留的课程');
  expect(await schedule.evaluate(() => localStorage.getItem('minimal-task-widget-schedule-v1'))).toBe(courses);
  await schedule.close();
});

for (const { edge, width, height } of [
  { edge: 'left', width: 566, height: 269 },
  { edge: 'right', width: 600, height: 500 },
  { edge: 'top', width: 700, height: 300 },
  { edge: 'bottom', width: 900, height: 550 },
]) {
  test(`dragging the widget to the ${edge} edge keeps its custom docked schedule inside the viewport`, async ({ page, context }) => {
    const schedule = await desktopPair(page, context, {
      floating: false, left: 160, top: 420, width, height,
      customSize: true, dockEdge: edge,
    });
    const main = page.locator('#widget'), card = schedule.locator('#schedule-card');
    const before = await main.boundingBox();
    const viewport = page.viewportSize();
    const start = { x: before.x + 15, y: before.y + 25 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(
      edge === 'left' ? 2 : edge === 'right' ? viewport.width - 2 : start.x,
      edge === 'top' ? 2 : edge === 'bottom' ? viewport.height - 2 : start.y,
      { steps: 15 },
    );
    async function expectBothInside() {
      await expect.poll(async () => {
        const boxes = await Promise.all([main.boundingBox(), card.boundingBox()]);
        return boxes.every(rect => rect.x >= -0.1 && rect.y >= -0.1 &&
          rect.x + rect.width <= viewport.width + 0.1 && rect.y + rect.height <= viewport.height + 0.1);
      }, { message: 'Both actual panel rectangles must remain visible while dragging and after release' }).toBe(true);
    }
    await expectBothInside();
    await page.mouse.up();
    await expectBothInside();
    const after = await card.boundingBox();
    expect({ width: after.width, height: after.height }).toEqual({ width, height });
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SCHEDULE_LAYOUT))
      .toMatchObject({ width, height, customSize: true, dockEdge: edge });
    await schedule.close();
  });
}

test('floating to left snap keeps reported bounds current and allows a complete second widget drag', async ({ page, context }) => {
  const schedule = await desktopPair(page, context, {
    floating: true, left: 100, top: 500, width: 566, height: 269,
    customSize: true, dockEdge: 'bottom',
  });
  await page.bringToFront();
  await movePointer(page, page.locator('#widget .top'), -100, 180, { x: 15, y: 25 });
  const main = await page.locator('#widget').boundingBox();
  await schedule.bringToFront();
  await schedule.locator('#schedule-lock-toggle').click();
  const card = schedule.locator('#schedule-card'), head = await schedule.locator('.schedule-head').boundingBox();
  await schedule.mouse.move(head.x + 15, head.y + 25);
  await schedule.mouse.down();
  await schedule.mouse.move(main.x - 566 - 12 + 20 + 15, main.y + 20 + 25, { steps: 15 });
  await schedule.evaluate(() => {
    window.snapFrames = [];
    window.observeSnap = true;
    const sample = () => {
      if (!window.observeSnap) return;
      const rect = document.getElementById('schedule-card').getBoundingClientRect(), report = window.scheduleBounds;
      if (report) window.snapFrames.push({
        left: rect.left - report.left, top: rect.top - report.top,
        right: rect.right - report.left - report.width,
        bottom: rect.bottom - report.top - report.height,
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await schedule.mouse.up();
  // Include the former 320ms FLIP animation and its 380ms cleanup callback.
  await schedule.waitForTimeout(450);
  const frames = await schedule.evaluate(() => { window.observeSnap = false; return window.snapFrames; });
  expect(frames.length).toBeGreaterThan(5);
  expect.soft(frames.filter(frame => frame.left < -1 || frame.top < -1 || frame.right > 1 || frame.bottom > 1),
    'A snapped card must fit the reported native region on every observed frame').toEqual([]);
  await expect(schedule.locator('#app-stack')).not.toHaveClass(/schedule-floating/);
  const docked = await card.boundingBox();
  expect(Math.round(main.x - docked.x - docked.width)).toBe(12);
  await schedule.locator('#schedule-lock-toggle').click();
  await expect(schedule.locator('#schedule-lock-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => {
    window.nativeDragEvents = [];
    for (const event of ['dragstart', 'pointercancel']) document.addEventListener(event,
      () => window.nativeDragEvents.push(event), true);
    // A selection left by an earlier interaction must not turn a panel drag
    // into the browser's native text drag, which cancels pointer capture.
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(document.querySelector('#widget .top'));
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.bringToFront();
  await movePointer(page, page.locator('#widget .top'), -100, 40, { x: 15, y: 25 });
  const moved = await page.locator('#widget').boundingBox();
  expect.soft(moved.x).toBe(main.x - 100);
  expect.soft(moved.y).toBe(main.y + 40);
  expect(await page.evaluate(() => window.nativeDragEvents)).toEqual([]);
  await expect.poll(async () => {
    const rect = await card.boundingBox();
    return { gap: Math.round(moved.x - rect.x - rect.width), top: Math.round(rect.y - moved.y) };
  }).toEqual({ gap: 12, top: 0 });
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SCHEDULE_LAYOUT))
    .toMatchObject({ floating: false, dockEdge: 'left', customSize: true, width: 566, height: 269 });
  await schedule.close();
});

test('dragging a floating schedule near an off-screen left dock keeps it floating and fully visible', async ({ page, context }) => {
  const schedule = await desktopPair(page, context, {
    floating: true, left: 100, top: 500, width: 566, height: 269,
    customSize: true, dockEdge: 'bottom',
  });
  await page.bringToFront();
  const initial = await page.locator('#widget').boundingBox();
  await movePointer(page, page.locator('#widget .top'), 540 - initial.x, 300 - initial.y, { x: 15, y: 25 });
  const main = await page.locator('#widget').boundingBox();
  await schedule.bringToFront();
  await schedule.locator('#schedule-lock-toggle').click();
  const head = await schedule.locator('.schedule-head').boundingBox();
  await schedule.mouse.move(head.x + 15, head.y + 25);
  await schedule.mouse.down();
  await schedule.mouse.move(8 + 15, main.y + 20 + 25, { steps: 15 });
  await schedule.mouse.up();
  await schedule.waitForTimeout(450);
  const card = await schedule.locator('#schedule-card').boundingBox();
  expect.soft(card.x).toBeGreaterThanOrEqual(0);
  await expect(schedule.locator('#app-stack')).toHaveClass(/schedule-floating/);
  expect(await page.locator('#widget').boundingBox()).toEqual(main);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SCHEDULE_LAYOUT))
    .toMatchObject({ floating: true, customSize: true, width: 566, height: 269 });
  await schedule.close();
});

test('left snap feasibility uses the resized widget width for a default floating schedule', async ({ page, context }) => {
  const schedule = await desktopPair(page, context, {
    floating: true, left: 80, top: 550, width: 352, height: 400,
    customSize: false, dockEdge: 'bottom',
  });
  await page.bringToFront();
  const initial = await page.locator('#widget').boundingBox();
  await movePointer(page, page.locator('#widget .top'), 400 - initial.x, 180 - initial.y, { x: 15, y: 25 });
  await movePointer(page, page.locator('[data-resize="se"]'), 148, 0);
  const main = await page.locator('#widget').boundingBox();
  expect(main.width).toBe(500);
  await schedule.bringToFront();
  await schedule.locator('#schedule-lock-toggle').click();
  const head = await schedule.locator('.schedule-head').boundingBox();
  await schedule.mouse.move(head.x + 15, head.y + 25);
  await schedule.mouse.down();
  // 36px fits a 352px floating card beside the widget, but the final default
  // dock would adopt the widget's 500px width and extend to -112px.
  await schedule.mouse.move(36 + 15, main.y + 25, { steps: 15 });
  await schedule.mouse.up();
  await schedule.waitForTimeout(450);
  const card = await schedule.locator('#schedule-card').boundingBox();
  expect.soft(card.x).toBeGreaterThanOrEqual(0);
  await expect(schedule.locator('#app-stack')).toHaveClass(/schedule-floating/);
  expect(card.width).toBe(352);
  expect(await page.locator('#widget').boundingBox()).toEqual(main);
  await schedule.close();
});

test('bottom snap feasibility uses the natural docked height rather than the shorter floating height', async ({ page, context }) => {
  const schedule = await desktopPair(page, context, {
    floating: true, left: 100, top: 120, width: 352, height: 220,
    customSize: false, dockEdge: 'bottom',
  });
  const card = schedule.locator('#schedule-card');
  await expect.poll(async () => (await card.boundingBox()).height).toBe(220);
  await page.bringToFront();
  const initial = await page.locator('#widget').boundingBox();
  await movePointer(page, page.locator('#widget .top'), 500 - initial.x,
    700 - initial.height - initial.y, { x: 15, y: 25 });
  const main = await page.locator('#widget').boundingBox();
  await schedule.bringToFront();
  await schedule.locator('#schedule-lock-toggle').click();
  const head = await schedule.locator('.schedule-head').boundingBox();
  await schedule.mouse.move(head.x + 15, head.y + 25);
  await schedule.mouse.down();
  // The 220px floating card fits here. Its 400px natural docked height would
  // extend below the viewport when attached at the widget's bottom + 12px.
  await schedule.mouse.move(main.x + 20 + 15, main.y + main.height + 12 + 20 + 25, { steps: 15 });
  await schedule.mouse.up();
  await schedule.waitForTimeout(450);
  const floating = await card.boundingBox();
  expect.soft(floating.y + floating.height).toBeLessThanOrEqual(page.viewportSize().height);
  await expect(schedule.locator('#app-stack')).toHaveClass(/schedule-floating/);
  expect({ width: floating.width, height: floating.height }).toEqual({ width: 352, height: 220 });
  expect(await page.locator('#widget').boundingBox()).toEqual(main);
  await schedule.close();
});

test('docked dragging preserves a valid middle-screen pointer destination', async ({ page, context }) => {
  const schedule = await desktopPair(page, context, {
    floating: false, left: 160, top: 420, width: 600, height: 500,
    customSize: true, dockEdge: 'right',
  });
  const before = await page.locator('#widget').boundingBox();
  await movePointer(page, page.locator('#widget .top'), -750, 120, { x: 15, y: 25 });
  const after = await page.locator('#widget').boundingBox();
  expect(after.x).toBe(before.x - 750);
  expect(after.y).toBe(before.y + 120);
  await schedule.close();
});

for (const { edge, left, top, handle, dx, dy } of [
  { edge: 'right', left: 300, top: 200, handle: 'e', dx: 180, dy: 0 },
  { edge: 'bottom', left: 300, top: 300, handle: 's', dx: 0, dy: 200 },
  { edge: 'left', left: 700, top: 200, handle: 'w', dx: -180, dy: 0 },
  { edge: 'top', left: 300, top: 380, handle: 'n', dx: 0, dy: -180 },
]) {
  test(`resizing the widget keeps its ${edge}-docked custom schedule within the viewport`, async ({ page, context }) => {
    const layout = { floating: false, left: 160, top: 420, width: 566, height: 269, customSize: true, dockEdge: edge };
    const schedule = await desktopPair(page, context, layout);
    const initial = await page.locator('#widget').boundingBox();
    await movePointer(page, page.locator('#widget .top'), left - initial.x, top - initial.y, { x: 15, y: 25 });
    const before = await page.locator('#widget').boundingBox();
    await movePointer(page, page.locator(`[data-resize="${handle}"]`), dx, dy);
    const main = await page.locator('#widget').boundingBox();
    const card = await schedule.locator('#schedule-card').boundingBox();
    if (dx) expect(main.width).toBeCloseTo(before.width + Math.abs(dx), 1);
    if (dy) expect(main.height).toBeCloseTo(before.height + Math.abs(dy), 1);
    for (const rect of [main, card]) {
      expect.soft(rect.x).toBeGreaterThanOrEqual(0);
      expect.soft(rect.y).toBeGreaterThanOrEqual(0);
      expect.soft(rect.x + rect.width).toBeLessThanOrEqual(page.viewportSize().width);
      expect.soft(rect.y + rect.height).toBeLessThanOrEqual(page.viewportSize().height);
    }
    expect({ width: card.width, height: card.height }).toEqual({ width: 566, height: 269 });
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SCHEDULE_LAYOUT))
      .toMatchObject({ floating: false, width: 566, height: 269, customSize: true, dockEdge: edge });
    await schedule.close();
  });
}

test('a floating schedule does not constrain the widget at the viewport edge', async ({ page, context }) => {
  const schedule = await desktopPair(page, context, {
    floating: true, left: 100, top: 300, width: 600, height: 500,
    customSize: true, dockEdge: 'left',
  });
  const card = schedule.locator('#schedule-card');
  await expect.poll(async () => (await card.boundingBox()).y).toBe(300);
  const before = await card.boundingBox();
  await movePointer(page, page.locator('#widget .top'), -1000, 0, { x: 15, y: 25 });
  expect((await page.locator('#widget').boundingBox()).x).toBe(0);
  expect(await card.boundingBox()).toEqual(before);
  await schedule.close();
});

for (const { edge, width, height } of [
  { edge: 'left', width: 1000, height: 300 },
  { edge: 'bottom', width: 500, height: 900 },
]) {
  test(`an oversized ${edge}-docked combination keeps the widget reachable without shrinking the custom schedule`, async ({ page, context }) => {
    const schedule = await desktopPair(page, context, {
      floating: false, left: 160, top: 420, width, height,
      customSize: true, dockEdge: edge,
    });
    await movePointer(page, page.locator('#widget .top'), edge === 'left' ? -1000 : 0,
      edge === 'bottom' ? 1000 : 0, { x: 15, y: 25 });
    const main = await page.locator('#widget').boundingBox();
    if (edge === 'left') expect(main.x).toBe(0);
    else expect(main.y + main.height).toBe(page.viewportSize().height);
    const card = await schedule.locator('#schedule-card').boundingBox();
    expect({ width: card.width, height: card.height }).toEqual({ width, height });
    await schedule.close();
  });
}
