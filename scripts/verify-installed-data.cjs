// Run only after a closed-profile backup and program replacement. No fixture
// records are written: this checks the real installation against its export.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron, expect } = require('@playwright/test');

async function verify(executable, expectedFile, outputFile) {
  assert.ok(executable && expectedFile && outputFile,
    'Usage: node scripts/verify-installed-data.cjs <executable> <expected-raw.json> <verified-raw.json>');
  const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
  assert.ok(expected && !Array.isArray(expected) && Object.values(expected).every(value => typeof value === 'string'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath: path.resolve(executable), args: [], env, timeout: 30000 });
    await expect.poll(() => app.windows().length).toBe(2);
    const widget = app.windows().find(page => page.url().includes('panel=widget'));
    await widget.waitForFunction(() => !!window.desktopBridge);
    assert.equal(await widget.evaluate(() => window.desktopBridge.isStorageReady()), true, 'Storage safeguard must initialize successfully');
    const actual = await widget.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));
    for (const page of app.windows()) {
      assert.equal(await page.evaluate(() => window.desktopBridge.isStorageReady()), true);
      const acknowledged = await page.evaluate(keys => Object.fromEntries(keys.map(key =>
        [key, window.desktopBridge.readStorage(key)])), Object.keys(actual));
      assert.deepEqual(acknowledged, actual, 'Both panels must read the same acknowledged raw data as the browser mirror');
    }
    for (const [key, value] of Object.entries(expected)) {
      if (actual[key] === value) continue;
      // Following the system date is the only accepted automatic setting change.
      if (key === 'minimal-task-widget-settings-v1') {
        const before = JSON.parse(value), after = JSON.parse(actual[key]);
        assert.equal(before.followSystemDate, true);
        const today = await widget.evaluate(() => currentZoneDay());
        assert.equal(after.periodStart, today); assert.equal(after.periodEnd, today);
        delete before.periodStart; delete before.periodEnd;
        delete after.periodStart; delete after.periodEnd;
        assert.deepEqual(after, before);
      } else assert.equal(actual[key], value, `Data changed during update: ${key}`);
    }
    fs.writeFileSync(outputFile, JSON.stringify(actual, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ verifiedKeys: Object.keys(expected).length,
      tasks: JSON.parse(actual['minimal-task-widget-v1'] || '[]').length,
      courses: JSON.parse(actual['minimal-task-widget-schedule-v1'] || '[]').length,
      version: await app.evaluate(({ app }) => app.getVersion()) }));
  } finally { if (app) await app.close(); }
}

if (require.main === module) verify(...process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verify };
