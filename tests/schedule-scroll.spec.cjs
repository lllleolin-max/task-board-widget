const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const layoutKey = 'minimal-task-widget-schedule-layout-v1';
test.use({ viewport: { width: 1600, height: 1280 } });

for (const placement of ['floating', 'bottom', 'top', 'left', 'right', 'default']) {
  test(`the last course remains reachable in a ${placement} schedule through locking and collapse`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const custom = placement !== 'default';
    const expected = { width: custom ? 566 : 352, height: custom ? 269 : 400 };
    await page.addInitScript(({ placement, layoutKey, custom, expected }) => {
      localStorage.setItem('minimal-task-widget-settings-v1', JSON.stringify({ courseEnabled: true }));
      localStorage.setItem(layoutKey, JSON.stringify({
        floating: placement === 'floating', left: 500, top: 300,
        width: expected.width, height: custom ? expected.height : 220,
        customSize: custom, dockEdge: placement === 'default' ? 'bottom' : placement,
      }));
      localStorage.setItem('minimal-task-widget-schedule-v1', JSON.stringify([
        { id: 'last', name: '末节课程', day: 0, start: 1290, end: 1320 },
      ]));
      window.desktopBridge = {
        reportScheduleBounds: () => {},
        getPins: async () => ({ widget: false, schedule: false }),
        setLocale: () => {},
        onWidgetBounds: callback => { window.receiveWidgetBounds = callback; },
        getWidgetBounds: async () => ({ left: 640, top: 600, width: 352, height: 240 }),
        onCourseEnabled: () => {},
      };
    }, { placement, layoutKey, custom, expected });
    await page.goto(`${url}?panel=schedule`);
    const card = page.locator('#schedule-card');
    const scroll = page.locator('.schedule-scroll');
    const course = page.locator('.schedule-course', { hasText: '末节课程' });

    async function expectLastCourseReachable() {
      await expect.poll(async () => {
        const rect = await card.boundingBox();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      }).toEqual(expected);
      await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
      // Read all edges in one frame, including during the entrance animation.
      const visibleEdges = await card.evaluate(element => {
        const outer = element.getBoundingClientRect();
        const last = element.querySelector('.schedule-course').getBoundingClientRect();
        const row = element.querySelector('.schedule-slot[data-day="0"][data-slot="29"]').getBoundingClientRect();
        return {
          topGap: last.top - outer.top,
          courseOverflow: last.bottom - outer.bottom + 1,
          rowOverflow: row.bottom - outer.bottom + 1,
        };
      });
      expect(visibleEdges.topGap).toBeGreaterThanOrEqual(0);
      expect(visibleEdges.courseOverflow).toBeLessThanOrEqual(0);
      expect(visibleEdges.rowOverflow).toBeLessThanOrEqual(0);
      // A bounding rectangle alone does not prove the clipped content can be used.
      await course.click({ timeout: 2000 });
      await expect(page.locator('#course-name')).toHaveValue('末节课程');
      await page.keyboard.press('Escape');
    }

    await expectLastCourseReachable();
    await page.locator('#schedule-lock-toggle').click();
    await expect(card).toHaveClass(/schedule-free/);
    await expectLastCourseReachable();
    await page.locator('#schedule-collapse').click();
    await expect(scroll).not.toBeVisible();
    await expect.poll(async () => {
      const outer = await card.boundingBox(), header = await page.locator('.schedule-head').boundingBox();
      return Math.round(outer.height - header.height);
    }).toBe(2);
    await page.locator('#schedule-collapse').click();
    await expectLastCourseReachable();
    await page.locator('#schedule-lock-toggle').click();
    await expect(card).not.toHaveClass(/schedule-free/);
    await page.evaluate(() => window.receiveWidgetBounds({ left: 590, top: 570, width: 352, height: 300 }));
    await expectLastCourseReachable();
    if (custom) {
      expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), layoutKey))
        .toMatchObject({ width: expected.width, height: expected.height, customSize: true });
    }
    expect(errors).toEqual([]);
  });
}
