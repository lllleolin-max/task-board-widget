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
