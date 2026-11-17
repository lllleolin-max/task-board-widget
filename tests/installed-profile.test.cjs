const test = require('node:test');
const assert = require('node:assert/strict');
const { physicalProfileFile } = require('../scripts/verify-installed-data.cjs');

test('installed-data verification rejects a redirected file at the ordinary reported profile path', () => {
  const expected = 'C:\\Users\\example\\AppData\\Roaming\\task-board-widget\\data-safety\\current.json';
  assert.equal(physicalProfileFile(expected, file => file), expected);
  assert.throws(() => physicalProfileFile(expected, file => {
    assert.equal(file, expected);
    return 'C:\\Users\\example\\AppData\\Local\\Packages\\Example.Host_abc\\LocalCache\\Roaming\\task-board-widget\\data-safety\\current.json';
  }), /Windows redirected the Taskboard snapshot/);
});
