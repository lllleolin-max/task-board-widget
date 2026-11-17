// Run only after a closed-profile backup and program replacement. No fixture
// records are written: this checks the real installation against its export.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { _electron, expect } = require('@playwright/test');

function physicalProfileFile(file, realpath = fs.realpathSync.native) {
  const resolved = path.win32.normalize(realpath(file));
  assert.ok(!/\\Packages\\[^\\]+\\LocalCache\\(?:Roaming|Local)\\/i.test(resolved),
    `Windows redirected the Taskboard snapshot to ${resolved}. Run the verifier through scripts/start-from-desktop.ps1.`);
  return resolved;
}

async function verify(executable, expectedFile, outputFile) {
  assert.ok(executable && expectedFile && outputFile,
    'Usage: node scripts/verify-installed-data.cjs <executable> <expected-raw.json> <verified-raw.json>');
  const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
  assert.ok(expected && typeof expected === 'object' && !Array.isArray(expected) &&
    Object.values(expected).every(value => typeof value === 'string' || value === null));
  const presentValues = values => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
  // The userData string alone is identical inside and outside MSIX redirection.
  // Check the existing file before spawning Electron, then confirm what it sees.
  let nativeSnapshot;
  if (process.platform === 'win32') {
    const snapshot = path.join(process.env.APPDATA, 'task-board-widget', 'data-safety', 'current.json');
    nativeSnapshot = physicalProfileFile(snapshot);
    // A read can fall through to native AppData while new files are redirected.
    const probe = `${snapshot}.${randomUUID()}.tmp`;
    fs.writeFileSync(probe, '', { flag: 'wx' });
    try {
      assert.equal(path.win32.dirname(physicalProfileFile(probe)).toLowerCase(),
        path.win32.dirname(nativeSnapshot).toLowerCase(), 'Snapshot reads and new writes must use the same directory');
    } finally { fs.unlinkSync(probe); }
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app, verified, summary;
  try {
    app = await _electron.launch({ executablePath: path.resolve(executable), args: [], env, timeout: 30000 });
    const panel = name => app.windows().find(page => page.url().endsWith(`?panel=${name}`));
    await expect.poll(() => !!panel('widget') && !!panel('schedule')).toBe(true);
    const widget = panel('widget');
    for (const page of [widget, panel('schedule')]) {
      await page.waitForFunction(() => document.readyState === 'complete' && !!window.desktopBridge);
      assert.equal(await page.evaluate(() => window.desktopBridge.isStorageReady()), true, 'Storage safeguard must initialize successfully');
    }
    const actual = await widget.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(presentValues(expected)).sort(), 'The full set of saved keys must match');
    const runningSnapshot = await app.evaluate(({ app }) => {
      const fs = process.mainModule.require('node:fs');
      const path = process.mainModule.require('node:path');
      return fs.realpathSync.native(path.join(app.getPath('userData'), 'data-safety', 'current.json'));
    });
    if (nativeSnapshot) {
      assert.equal(path.win32.normalize(runningSnapshot).toLowerCase(), nativeSnapshot.toLowerCase(),
        'The installed program must read the same physical snapshot as the desktop verifier');
    }
    const disk = JSON.parse(fs.readFileSync(runningSnapshot, 'utf8')).values;
    assert.deepEqual(presentValues(disk), actual, 'The desktop snapshot and browser mirror must match');
    for (const [key, value] of Object.entries(expected)) {
      if (value === null) assert.equal(disk[key], null, `Missing saved deletion: ${key}`);
    }
    verified = { ...expected, ...actual };
    for (const page of app.windows()) {
      const acknowledged = await page.evaluate(keys => Object.fromEntries(keys.map(key =>
        [key, window.desktopBridge.readStorage(key)])), Object.keys(verified));
      assert.deepEqual(acknowledged, verified, 'Both panels must read the same acknowledged raw data');
    }
    for (const [key, value] of Object.entries(presentValues(expected))) {
      if (actual[key] === value) continue;
      // Following the system date is the only accepted automatic setting change.
      if (key === 'minimal-task-widget-settings-v1') {
        const before = JSON.parse(value), after = JSON.parse(actual[key]);
        assert.ok(before.followSystemDate === true || !Object.hasOwn(before, 'followSystemDate'),
          'Historical date selection must be preserved');
        assert.equal(before.periodMode ?? 'day', 'day');
        const today = await widget.evaluate(() => currentZoneDay());
        assert.equal(after.periodStart, today); assert.equal(after.periodEnd, today);
        delete before.periodStart; delete before.periodEnd;
        delete after.periodStart; delete after.periodEnd;
        assert.deepEqual(after, before);
      } else assert.equal(actual[key], value, `Data changed during update: ${key}`);
    }
    summary = { verifiedKeys: Object.keys(expected).length,
      tasks: JSON.parse(actual['minimal-task-widget-v1'] || '[]').length,
      courses: JSON.parse(actual['minimal-task-widget-schedule-v1'] || '[]').length,
      physicalSnapshot: nativeSnapshot,
      version: await app.evaluate(({ app }) => app.getVersion()) };
  } finally { if (app) await app.close(); }
  fs.writeFileSync(outputFile, JSON.stringify(verified, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(summary));
}

if (require.main === module) verify(...process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verify, physicalProfileFile };
