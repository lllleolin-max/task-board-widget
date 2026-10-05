const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
// These identities locate existing profiles/installations. A display-name or
// version change must not silently make every saved task and course disappear.
assert.equal(manifest.name, 'task-board-widget', 'Preserve the existing application identity');
assert.equal(manifest.productName || manifest.name, 'task-board-widget',
  'A top-level productName changes the default user-data directory; use build.productName for the display name');
assert.equal(manifest.build.appId, 'com.lllleolin.taskboard', 'Preserve the installed application identity');
assert.equal(manifest.build.nsis.deleteAppDataOnUninstall, false, 'Installers must retain saved user data');
assert.equal(manifest.version, lock.version, 'package-lock version must match package.json');
assert.equal(manifest.version, lock.packages[''].version);
for (const file of ['main.cjs', 'preload.cjs', 'windows-desktop.cjs']) new vm.Script(read(file), { filename: file });
const html = read('index.html');
for (const [index, [, script]] of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
  new vm.Script(script, { filename: `index.html:script-${index + 1}` });
}
for (const [, asset] of html.matchAll(/["'](themes\/[^"']+)["']/g)) {
  assert.ok(fs.existsSync(path.join(root, asset)), `Missing asset: ${asset}`);
}
console.log(`Syntax, theme assets and version metadata verified (${manifest.version}).`);
