const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorageGuard } = require('../storage-guard.cjs');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-storage-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const read = (dir, file = 'current.json') => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const fault = message => Object.assign(new Error(message), { code: 'EIO' });

test('bootstrap preserves raw task content and unknown keys without rewriting an unchanged snapshot', t => {
  const dir = directory(t), guard = createStorageGuard(dir);
  const raw = Object.fromEntries([
    ['tasks', '  [{"id":1,"unknown":{"image":"data:keep"}}]\n'],
    ['__proto__', 'user value'], ['unknown-key', '  not JSON  '],
  ]);
  assert.deepEqual(guard.bootstrap(raw), raw);
  const original = fs.readFileSync(path.join(dir, 'current.json'));
  assert.deepEqual(createStorageGuard(dir).bootstrap(raw), raw);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'current.json')), original);
  assert.equal(read(dir).revision, 1);
  assert.equal(read(dir, 'previous.json').checksum, read(dir).checksum);
});

test('missing and rolled-back LevelDB values recover from the last acknowledged snapshot and preserve observed data', t => {
  const dir = directory(t), guard = createStorageGuard(dir);
  guard.bootstrap({ tasks: '[1,2]', courses: '[3]', draft: '<p>keep</p>' });
  guard.write('tasks', '[1,2,4]', '[1,2]');
  const restarted = createStorageGuard(dir);
  assert.deepEqual(restarted.bootstrap({ tasks: '[1]', courses: '[]', extra: 'new external key' }),
    { tasks: '[1,2,4]', courses: '[3]', draft: '<p>keep</p>', extra: 'new external key' });
  assert.equal(restarted.status().incidentSaved, true);
  const incidents = fs.readdirSync(dir).filter(file => file.startsWith('observed-'));
  assert.equal(incidents.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, incidents[0]))),
    { tasks: '[1]', courses: '[]', extra: 'new external key' });
  restarted.bootstrap({ tasks: '[1]', courses: '[]', extra: 'new external key' });
  assert.equal(fs.readdirSync(dir).filter(file => file.startsWith('observed-')).length, 1);
  assert.equal(restarted.status().revision, 3);
  assert.equal(createStorageGuard(dir).bootstrap({}).tasks, '[1,2,4]');
});

test('intentional empty collections and deleted keys remain empty after an old database reappears', t => {
  const dir = directory(t), guard = createStorageGuard(dir);
  guard.bootstrap({ tasks: '[1]', draft: 'obsolete', courses: '[]' });
  guard.write('tasks', '[]', '[1]');
  guard.write('draft', null, 'obsolete');
  assert.deepEqual(createStorageGuard(dir).bootstrap({ tasks: '[1]', draft: 'obsolete', courses: '[]' }),
    { tasks: '[]', draft: null, courses: '[]' });
});

test('an unavailable browser cache can read existing raw data but cannot create an empty baseline', t => {
  const dir = directory(t), guard = createStorageGuard(dir);
  assert.throws(() => guard.bootstrap(null), /no saved snapshot/);
  assert.deepEqual(fs.readdirSync(dir), []);
  const raw = { tasks: ' [1,2]\n', courses: '[3]', draft: 'image and text' };
  guard.bootstrap(raw);
  const contents = fs.readFileSync(path.join(dir, 'current.json'));
  assert.deepEqual(createStorageGuard(dir).bootstrap(null), raw);
  const values = guard.values();
  values.tasks = '[]';
  assert.equal(guard.read('tasks'), raw.tasks, 'Readers cannot mutate the authoritative snapshot');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'current.json')), contents);
});

test('CAS rejects stale renderer writes and a later bootstrap cannot replace newer committed data', t => {
  const dir = directory(t), guard = createStorageGuard(dir);
  guard.bootstrap({ tasks: '[1]' });
  guard.write('tasks', '[1,2]', '[1]');
  const saved = fs.readFileSync(path.join(dir, 'current.json'));
  assert.throws(() => guard.write('tasks', '[1,3]', '[1]'), { code: 'STORAGE_CONFLICT', current: '[1,2]' });
  assert.deepEqual(fs.readFileSync(path.join(dir, 'current.json')), saved);
  assert.equal(guard.bootstrap({ tasks: '[1]' }).tasks, '[1,2]');
  guard.write('tasks', '[1,2,3]', '[1,2]');
  assert.equal(read(dir).values.tasks, '[1,2,3]');
  assert.equal(guard.read('tasks'), '[1,2,3]');
  assert.equal(guard.read('missing'), null);
  assert.equal(guard.read('constructor'), null);
  guard.write('tasks', null, '[1,2,3]');
  assert.equal(guard.read('tasks'), null);
});

test('uncommitted temporary files never supersede the acknowledged snapshot', t => {
  const dir = directory(t), guard = createStorageGuard(dir);
  guard.bootstrap({ tasks: '[1]' });
  fs.writeFileSync(path.join(dir, 'current.json.interrupted.tmp'), '{"values":{"tasks":"[]"}}');
  assert.deepEqual(createStorageGuard(dir).bootstrap({ tasks: '[1]' }), { tasks: '[1]' });
  assert.ok(fs.existsSync(path.join(dir, 'current.json.interrupted.tmp')));
});

test('damaged current snapshot is retained byte-for-byte and repaired from the previous valid snapshot', t => {
  const dir = directory(t), guard = createStorageGuard(dir);
  guard.bootstrap({ tasks: '[1]' });
  guard.write('tasks', '[1,2]', '[1]');
  const broken = Buffer.from([0xff, 0x01, 0x7b]);
  fs.writeFileSync(path.join(dir, 'current.json'), broken);
  const restarted = createStorageGuard(dir);
  assert.deepEqual(restarted.bootstrap({}), { tasks: '[1]' });
  assert.equal(restarted.status().recoveredFromPrevious, true);
  const preserved = fs.readdirSync(dir).find(file => file.startsWith('corrupt-current-'));
  assert.deepEqual(fs.readFileSync(path.join(dir, preserved)), broken);
  assert.equal(read(dir).values.tasks, '[1]');
  assert.equal(read(dir, 'previous.json').values.tasks, '[1]');
});

test('missing current is repaired and damaged previous is archived when current remains valid', t => {
  const dir = directory(t);
  createStorageGuard(dir).bootstrap({ tasks: '[1]' });
  fs.unlinkSync(path.join(dir, 'current.json'));
  assert.deepEqual(createStorageGuard(dir).bootstrap({ tasks: '[1]' }), { tasks: '[1]' });
  fs.writeFileSync(path.join(dir, 'previous.json'), 'broken previous');
  const restarted = createStorageGuard(dir);
  restarted.bootstrap({ tasks: '[1]' });
  restarted.write('tasks', '[2]', '[1]');
  assert.ok(fs.readdirSync(dir).some(file => file.startsWith('corrupt-previous-')));
  assert.equal(read(dir, 'previous.json').values.tasks, '[1]');
});

test('two damaged snapshots fail closed without overwriting either file or accepting an empty observation', t => {
  const dir = directory(t);
  createStorageGuard(dir).bootstrap({ tasks: '[1]' });
  fs.writeFileSync(path.join(dir, 'current.json'), 'bad current');
  fs.writeFileSync(path.join(dir, 'previous.json'), 'bad previous');
  assert.throws(() => createStorageGuard(dir).bootstrap({}), /No intact storage snapshot/);
  assert.equal(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'), 'bad current');
  assert.equal(fs.readFileSync(path.join(dir, 'previous.json'), 'utf8'), 'bad previous');
});

test('checksum mismatch is detected even when JSON remains parseable', t => {
  const dir = directory(t);
  createStorageGuard(dir).bootstrap({ tasks: '[1]' });
  const tampered = read(dir); tampered.values.tasks = '[]';
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(tampered));
  assert.deepEqual(createStorageGuard(dir).bootstrap({}), { tasks: '[1]' });
  assert.ok(fs.readdirSync(dir).some(file => file.startsWith('corrupt-current-')));
});

test('future snapshot formats fail closed instead of rolling back to a supported older copy', t => {
  for (const file of ['current.json', 'previous.json']) {
    const dir = directory(t);
    createStorageGuard(dir).bootstrap({ tasks: '[1]' });
    const future = JSON.stringify({ format: 2, revision: 20, values: { tasks: '[1,2,3]' }, futureExtension: 'retain' });
    fs.writeFileSync(path.join(dir, file), future);
    assert.throws(() => createStorageGuard(dir).bootstrap({ tasks: '[1,2,3]' }), { code: 'UNSUPPORTED_STORAGE_FORMAT' });
    assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), future);
    assert.equal(fs.readdirSync(dir).length, 2);
  }
});

test('a future-format replacement during a live session cannot be overwritten by an older writer', t => {
  const dir = directory(t), guard = createStorageGuard(dir);
  guard.bootstrap({ tasks: '[1]' });
  const future = JSON.stringify({ format: 2, revision: 2, values: { tasks: '[1,2]' } });
  fs.writeFileSync(path.join(dir, 'current.json'), future);
  assert.throws(() => guard.write('tasks', '[1,3]', '[1]'), { code: 'UNSUPPORTED_STORAGE_FORMAT' });
  assert.equal(guard.status().revision, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'), future);
  assert.equal(read(dir, 'previous.json').values.tasks, '[1]');
});

test('a valid older current snapshot cannot supersede a newer previous revision', t => {
  const dir = directory(t), guard = createStorageGuard(dir);
  guard.bootstrap({ tasks: '[1]' });
  const oldest = fs.readFileSync(path.join(dir, 'current.json'));
  guard.write('tasks', '[1,2]', '[1]');
  guard.write('tasks', '[1,2,3]', '[1,2]');
  fs.writeFileSync(path.join(dir, 'current.json'), oldest);
  const restarted = createStorageGuard(dir);
  assert.deepEqual(restarted.bootstrap({}), { tasks: '[1,2]' });
  assert.equal(restarted.status().recoveredFromPrevious, true);
  assert.ok(fs.readdirSync(dir).some(file => file.startsWith('rolled-back-current-')));
});

test('failed rename keeps the acknowledged value, allows retry and cleans only its own temporary file', t => {
  const dir = directory(t);
  let fail = false;
  const io = { ...fs, renameSync(from, to) {
    if (fail && to === path.join(dir, 'current.json')) throw fault('disk unavailable');
    return fs.renameSync(from, to);
  } };
  const guard = createStorageGuard(dir, io);
  guard.bootstrap({ tasks: '[1]' });
  fail = true;
  assert.throws(() => guard.write('tasks', '[1,2]', '[1]'), /disk unavailable/);
  assert.equal(guard.status().revision, 1);
  assert.equal(read(dir).values.tasks, '[1]');
  assert.equal(read(dir, 'previous.json').values.tasks, '[1]');
  assert.ok(!fs.readdirSync(dir).some(file => file.endsWith('.tmp')));
  fail = false;
  guard.write('tasks', '[1,2]', '[1]');
  assert.equal(read(dir).values.tasks, '[1,2]');
});

test('disk read failures and incident archive failures are surfaced before recovery can overwrite observations', t => {
  const dir = directory(t);
  createStorageGuard(dir).bootstrap({ tasks: '[1]' });
  const denied = { ...fs, readFileSync(file, ...args) {
    if (file === path.join(dir, 'current.json')) throw fault('read denied');
    return fs.readFileSync(file, ...args);
  } };
  assert.throws(() => createStorageGuard(dir, denied).bootstrap({}), /read denied/);
  const noArchive = { ...fs, openSync(file, ...args) {
    if (path.basename(file).startsWith('observed-')) throw fault('archive denied');
    return fs.openSync(file, ...args);
  } };
  assert.throws(() => createStorageGuard(dir, noArchive).bootstrap({ tasks: '[]' }), /archive denied/);
  assert.equal(read(dir).values.tasks, '[1]');
  assert.equal(read(dir).revision, 1);
});

test('fsync failure keeps both committed snapshots and an external valid replacement is not overwritten', t => {
  const dir = directory(t);
  let fail = false;
  const io = { ...fs, fsyncSync(fd) { if (fail) throw fault('sync failed'); return fs.fsyncSync(fd); } };
  const guard = createStorageGuard(dir, io);
  guard.bootstrap({ tasks: '[1]' });
  const previous = fs.readFileSync(path.join(dir, 'previous.json'));
  fail = true;
  assert.throws(() => guard.write('tasks', '[2]', '[1]'), /sync failed/);
  assert.equal(guard.status().revision, 1);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'previous.json')), previous);
  fail = false;
  const external = createStorageGuard(dir);
  external.bootstrap({ tasks: '[1]' });
  external.write('tasks', '[3]', '[1]');
  assert.throws(() => guard.write('tasks', '[2]', '[1]'), /outside this process/);
  assert.equal(read(dir).values.tasks, '[3]');
});

test('damage occurring during a live session is archived before the next successful write', t => {
  const dir = directory(t), guard = createStorageGuard(dir);
  guard.bootstrap({ tasks: '[1]' });
  fs.writeFileSync(path.join(dir, 'current.json'), 'damage while running');
  guard.write('tasks', '[2]', '[1]');
  assert.equal(read(dir).values.tasks, '[2]');
  assert.equal(read(dir, 'previous.json').values.tasks, '[1]');
  const preserved = fs.readdirSync(dir).find(file => file.startsWith('corrupt-current-'));
  assert.equal(fs.readFileSync(path.join(dir, preserved), 'utf8'), 'damage while running');
});

test('invalid inputs and writes before bootstrap cannot create or modify snapshots', t => {
  const dir = directory(t), guard = createStorageGuard(dir);
  assert.throws(() => guard.write('tasks', '[]'), /initialized/);
  assert.throws(() => guard.read('tasks'), /initialized/);
  for (const raw of [null, [], { tasks: [] }, { tasks: null }]) assert.throws(() => guard.bootstrap(raw));
  assert.equal(fs.readdirSync(dir).length, 0);
  guard.bootstrap({ malformedRaw: '[not valid JSON' });
  assert.throws(() => guard.write('malformedRaw', {}), /Invalid storage write/);
  assert.throws(() => guard.read({}), /Invalid storage key/);
  assert.equal(read(dir).values.malformedRaw, '[not valid JSON');
});
