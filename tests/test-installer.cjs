// Windows-only integration test: compile and execute the real startup macros.
// All registry writes stay under a fresh, non-startup HKCU subtree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8', windowsHide: true, timeout: 60000, ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function findCompiler() {
  if (process.env.MAKENSIS) return process.env.MAKENSIS;
  const cache = process.env.ELECTRON_BUILDER_CACHE ||
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  const search = (directory, depth) => {
    const candidate = path.join(directory, 'makensis.exe');
    if (fs.existsSync(candidate)) return candidate;
    if (depth === 0) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const found = search(path.join(directory, entry.name), depth - 1);
        if (found) return found;
      }
    }
  };
  if (fs.existsSync(cache)) {
    // Supports both nsis/<version>/Bin and nsis-<version>/<cache-id>/Bin.
    const entries = fs.readdirSync(cache, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('nsis'))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const found = search(path.join(cache, entry.name), 2);
      if (found) return found;
    }
  }
  const found = run('where.exe', ['makensis.exe']);
  if (found.status === 0) return found.stdout.trim().split(/\r?\n/)[0];
  throw new Error('NSIS was not found. Set MAKENSIS to makensis.exe or build the Windows installer once.');
}

// Preserve dollar signs and quotes when embedding paths in NSIS source.
const quote = value => `"${value.replace(/\$/g, () => '$$').replace(/"/g, () => '$\\"')}"`;

function main() {
  if (process.platform !== 'win32') {
    console.log('SKIP: native installer macro tests require Windows.');
    return;
  }
  const compiler = findCompiler();
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-installer-tests-'));
  const key = `Software\\TaskboardInstallerTests\\${randomUUID()}`;
  const registryRoot = `HKCU\\${key}`;
  const runKey = `${key}\\Run`;
  const approvedKey = `${key}\\StartupApproved`;
  const executableName = `${manifest.build.productName}.exe`;
  const appId = manifest.build.appId;
  const output = path.join(temp, 'result.txt');
  const executable = path.join(temp, 'startup-test.exe');
  let checks = 0;
  const fail = label => [
    `FileOpen $9 ${quote(output)} w`,
    `FileWrite $9 ${quote(`FAIL: ${label}`)}`,
    'FileClose $9',
    'SetErrorLevel 1',
    'Quit',
  ];
  const expectValue = (command, expected, label) => {
    checks++;
    return [
      'ClearErrors', command,
      '${If} ${Errors}', ...fail(`${label}: value missing or wrong type`), '${EndIf}',
      `\${If} $2 != ${quote(expected)}`, ...fail(label), '${EndIf}',
    ];
  };
  const expectAbsent = registryKey => {
    checks++;
    return [`StrCpy $1 ${quote(registryKey)}`, 'Call AssertStartupAbsent'];
  };
  const expectOtherValues = () => [
    ...expectValue(`ReadRegStr $2 HKCU ${quote(runKey)} "OtherApp"`, 'keep this command', 'unrelated Run value changed'),
    ...expectValue(`ReadRegDWORD $2 HKCU ${quote(approvedKey)} "OtherApp"`, '7', 'unrelated approval value changed'),
  ];
  const seedStartup = () => [
    'ClearErrors',
    `WriteRegStr HKCU ${quote(runKey)} ${quote(appId)} "stale command"`,
    // StartupApproved's disabled state is a REG_BINARY, not a string.
    `WriteRegBin HKCU ${quote(approvedKey)} ${quote(appId)} "030000000000000000000000"`,
    '${If} ${Errors}', ...fail('could not seed existing startup records'), '${EndIf}',
  ];
  const body = [
    `WriteRegStr HKCU ${quote(runKey)} "OtherApp" "keep this command"`,
    `WriteRegDWORD HKCU ${quote(approvedKey)} "OtherApp" 7`,
  ];
  for (const directory of ['C:\\Taskboard', 'C:\\My Apps\\Taskboard', 'C:\\我的应用\\任务看板']) {
    body.push(
      ...seedStartup(),
      `StrCpy $INSTDIR ${quote(directory)}`,
      'StrCpy $0 ${BST_CHECKED}',
      '!insertmacro taskboardSetStartup',
      ...expectValue(`ReadRegStr $2 HKCU ${quote(runKey)} ${quote(appId)}`,
        `"${directory}\\${executableName}"`, `quoted startup command for ${directory}`),
      ...expectAbsent(approvedKey),
      ...expectOtherValues(),
    );
  }
  for (const operation of ['disable', 'remove', 'remove again']) {
    if (operation !== 'remove again') body.push(...seedStartup());
    body.push(
      ...(operation === 'disable'
        ? ['StrCpy $0 0', '!insertmacro taskboardSetStartup']
        : ['!insertmacro taskboardRemoveStartup']),
      ...expectAbsent(runKey),
      ...expectAbsent(approvedKey),
      ...expectOtherValues(),
    );
  }
  const source = [
    'Unicode true',
    'RequestExecutionLevel user',
    'SilentInstall silent',
    'Name "Taskboard isolated macro test"',
    `OutFile ${quote(executable)}`,
    '!include "LogicLib.nsh"',
    '!include "WinMessages.nsh"',
    `!define APP_ID ${quote(appId)}`,
    `!define APP_EXECUTABLE_FILENAME ${quote(executableName)}`,
    `!define TASKBOARD_RUN_KEY ${quote(runKey)}`,
    `!define TASKBOARD_APPROVED_KEY ${quote(approvedKey)}`,
    `!include ${quote(path.join(root, 'build', 'installer.nsh'))}`,
    // Enumerate names so a remaining binary approval entry cannot pass a
    // ReadRegStr check merely because it has the wrong registry type.
    'Function AssertStartupAbsent',
    'StrCpy $3 0',
    'next_value:',
    'ClearErrors',
    'EnumRegValue $4 HKCU "$1" $3',
    'IfErrors absent',
    `\${If} $4 == ${quote(appId)}`,
    ...fail('startup value remains after removal'),
    '${EndIf}',
    'IntOp $3 $3 + 1',
    'Goto next_value',
    'absent:',
    'FunctionEnd',
    'Section',
    ...body,
    `FileOpen $9 ${quote(output)} w`,
    `FileWrite $9 "PASS: ${checks} native registry assertions"`,
    'FileClose $9',
    'SetErrorLevel 0',
    'SectionEnd',
  ].join('\r\n');
  try {
    const script = path.join(temp, 'startup-test.nsi');
    fs.writeFileSync(script, `\uFEFF${source}`, 'utf8');
    const compiled = run(compiler, ['/V2', script]);
    assert.equal(compiled.status, 0, `NSIS compilation failed:\n${compiled.stdout}\n${compiled.stderr}`);
    const executed = run(executable, ['/S']);
    const result = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : 'No result from native harness';
    assert.equal(executed.status, 0, result);
    assert.match(result, /^PASS:/);
    console.log(`${result} (${compiler})`);
  } finally {
    // Only the UUID subtree and the directory created above may be removed.
    try {
      assert.match(registryRoot, /^HKCU\\Software\\TaskboardInstallerTests\\[a-f0-9-]{36}$/);
      for (const view of ['32', '64']) {
        run('reg.exe', ['delete', registryRoot, '/f', `/reg:${view}`]);
        assert.equal(run('reg.exe', ['query', registryRoot, `/reg:${view}`]).status, 1,
          'The isolated registry subtree must be removed');
      }
    } finally {
      assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temp).startsWith('taskboard-installer-tests-'));
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

main();
