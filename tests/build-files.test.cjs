const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

test('node-gyp resolves generated Windows solution and make files', async t => {
  const { glob } = createRequire(require.resolve('node-gyp/package.json'))('tinyglobby');
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'taskboard-build-files-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, 'build'));
  const options = { cwd, expandDirectories: false };
  assert.deepEqual(await glob('build/*.sln', options), []);
  for (const name of ['binding.sln', 'addon.mk', 'notes.txt'])
    await fs.writeFile(path.join(cwd, 'build', name), '');
  for (const [pattern, name] of [['*.sln', 'binding.sln'], ['*.mk', 'addon.mk']])
    assert.deepEqual(await glob('build/' + pattern, options), [path.join('build', name)]);
});
