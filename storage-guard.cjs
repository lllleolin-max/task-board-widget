const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('hex');

function valuesCopy(values, allowDeleted = true) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid storage snapshot');
  const entries = Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.some(([, value]) => typeof value !== 'string' && !(allowDeleted && value === null)))
    throw new Error('Snapshot values must be raw storage strings');
  return Object.fromEntries(entries);
}

function documentFor(values, revision) {
  const payload = { format: 1, revision, values: valuesCopy(values) };
  return { ...payload, checksum: hash(JSON.stringify(payload)) };
}

// Independent of Chromium's LevelDB files. A single main process owns this store;
// null values remember explicit deletions even when an older database reappears.
function createStorageGuard(directory, io = fs) {
  const currentPath = path.join(directory, 'current.json');
  const previousPath = path.join(directory, 'previous.json');
  let snapshot;
  let recoveredFromPrevious = false;
  let incidentSaved = false;

  function atomicWrite(file, contents) {
    io.mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = io.openSync(temporary, 'wx', 0o600);
      io.writeFileSync(descriptor, contents);
      io.fsyncSync(descriptor);
      io.closeSync(descriptor);
      descriptor = undefined;
      io.renameSync(temporary, file);
    } catch (error) {
      if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch {} }
      try { io.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  function archive(prefix, contents) {
    const file = path.join(directory, `${prefix}-${hash(contents)}.json`);
    let existing;
    try { existing = io.readFileSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (!existing.equals(Buffer.from(contents))) throw new Error('Archived snapshot checksum mismatch');
    } else atomicWrite(file, contents);
  }

  function read(file) {
    let raw;
    try { raw = io.readFileSync(file); }
    catch (error) { if (error.code === 'ENOENT') return { missing: true }; throw error; }
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (parsed && Object.hasOwn(parsed, 'format') && parsed.format !== 1) {
        const error = new Error('Unsupported storage snapshot format; use a compatible application version');
        error.code = 'UNSUPPORTED_STORAGE_FORMAT';
        throw error;
      }
      if (!parsed || parsed.format !== 1 || !Number.isSafeInteger(parsed.revision) || parsed.revision < 1)
        throw new Error('Invalid storage snapshot header');
      const verified = documentFor(parsed.values, parsed.revision);
      if (parsed.checksum !== verified.checksum) throw new Error('Storage snapshot checksum mismatch');
      return { document: verified, raw };
    } catch (error) {
      if (error.code === 'UNSUPPORTED_STORAGE_FORMAT') throw error;
      return { invalid: true, raw };
    }
  }

  function commit(values) {
    const next = documentFor(values, (snapshot?.revision || 0) + 1);
    for (const [file, label] of [[currentPath, 'current'], [previousPath, 'previous']]) {
      const existing = read(file);
      if (existing.invalid) archive(`corrupt-${label}`, existing.raw);
      if (snapshot && label === 'current' && existing.document && existing.document.checksum !== snapshot.checksum)
        throw new Error('Storage snapshot changed outside this process; reload and retry');
    }
    // Keep the last acknowledged state before replacing the current state.
    // A failed write never advances the in-memory revision.
    atomicWrite(previousPath, JSON.stringify(snapshot || next));
    atomicWrite(currentPath, JSON.stringify(next));
    snapshot = next;
  }

  function load() {
    const current = read(currentPath), previous = read(previousPath);
    if (current.missing && previous.missing) return;
    if (!current.document && !previous.document) throw new Error('No intact storage snapshot; original files retained');
    if (current.invalid) archive('corrupt-current', current.raw);
    if (previous.invalid) archive('corrupt-previous', previous.raw);
    if (current.document && previous.document && current.document.revision === previous.document.revision &&
        current.document.checksum !== previous.document.checksum)
      throw new Error('Storage snapshots disagree at the same revision; original files retained');
    const selected = !current.document || (previous.document && previous.document.revision > current.document.revision)
      ? previous.document : current.document;
    if (selected !== current.document) {
      if (current.document) archive('rolled-back-current', current.raw);
      atomicWrite(currentPath, JSON.stringify(selected));
      recoveredFromPrevious = true;
    }
    snapshot = selected;
  }

  function bootstrap(observedRaw) {
    const observed = valuesCopy(observedRaw, false);
    if (!snapshot) load();
    if (!snapshot) commit(observed);
    else {
      const differs = Object.entries(snapshot.values).some(([key, value]) =>
        (Object.hasOwn(observed, key) ? observed[key] : null) !== value);
      if (differs) {
        // Preserve external/newer edits for diagnosis before repairing a rollback.
        // Incident files never become the authoritative or previous snapshot.
        archive('observed', JSON.stringify(observed));
        incidentSaved = true;
      }
      const additional = Object.keys(observed).filter(key => !Object.hasOwn(snapshot.values, key));
      if (additional.length) commit({ ...snapshot.values, ...Object.fromEntries(additional.map(key => [key, observed[key]])) });
    }
    return { ...snapshot.values };
  }

  function write(key, value, previous) {
    if (!snapshot) throw new Error('Storage must be initialized before writing');
    if (typeof key !== 'string' || (typeof value !== 'string' && value !== null)) throw new Error('Invalid storage write');
    const current = Object.hasOwn(snapshot.values, key) ? snapshot.values[key] : null;
    if (arguments.length >= 3 && current !== previous) {
      const error = new Error('Storage changed in another window; reload and retry');
      error.code = 'STORAGE_CONFLICT';
      error.current = current;
      throw error;
    }
    if (Object.hasOwn(snapshot.values, key) && current === value) return;
    commit({ ...snapshot.values, [key]: value });
  }

  return {
    bootstrap,
    write,
    read: key => {
      if (!snapshot) throw new Error('Storage must be initialized before reading');
      if (typeof key !== 'string') throw new Error('Invalid storage key');
      return Object.hasOwn(snapshot.values, key) ? snapshot.values[key] : null;
    },
    status: () => ({ revision: snapshot?.revision || 0, recoveredFromPrevious, incidentSaved }),
  };
}

module.exports = { createStorageGuard };
