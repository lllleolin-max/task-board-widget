const { contextBridge, ipcRenderer } = require('electron');

// The main process owns acknowledged raw data. Chromium localStorage is only a
// compatibility mirror: transient/queued cache events cannot clear a panel.
let storageReady = false;
let storageRecovered = false;
let committed = Object.create(null);
const storageListeners = new Set();
const keyRevisions = new Map();
let cacheErrorReported = false;
function mirrorStorage(key, value) {
  try {
    if (localStorage.getItem(key) === value) return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    if (!cacheErrorReported) {
      cacheErrorReported = true;
      ipcRenderer.send('desktop:storage-cache-error');
    }
  }
}
function updateCommitted(key, value, revision = 0) {
  if (revision < (keyRevisions.get(key) || 0)) return false;
  keyRevisions.set(key, revision);
  committed[key] = value;
  mirrorStorage(key, value);
  return true;
}
function notifyStorage(key, value) {
  for (const callback of storageListeners) callback({ key, newValue: value });
}
ipcRenderer.on('desktop:storage-changed', (_event, { key, value, revision }) => {
  if (!storageReady) return;
  if (updateCommitted(key, value, revision)) notifyStorage(key, value);
});
try {
  let observed = null;
  try { observed = Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])); }
  catch { /* An existing independent snapshot can still be read. */ }
  const result = ipcRenderer.sendSync('desktop:storage-bootstrap', observed);
  if (!result?.ok) throw new Error('Storage safeguard unavailable');
  committed = Object.assign(Object.create(null), result.values);
  for (const [key, value] of Object.entries(committed)) mirrorStorage(key, value);
  // Pick up any commit made by the other renderer during preload.
  const latest = ipcRenderer.sendSync('desktop:storage-ready');
  if (!latest?.ok) throw new Error('Storage safeguard unavailable');
  committed = Object.assign(Object.create(null), latest.values);
  for (const [key, value] of Object.entries(committed)) {
    keyRevisions.set(key, latest.revision || 0);
    mirrorStorage(key, value);
  }
  storageReady = true;
  storageRecovered = !!result.recovered;
} catch { /* Do not allow an empty fallback to overwrite unreadable saved data. */ }

function persistStorage(key, value) {
  if (!storageReady || typeof key !== 'string' || (value !== null && typeof value !== 'string')) return false;
  const previous = Object.hasOwn(committed, key) ? committed[key] : null;
  try {
    const result = ipcRenderer.sendSync('desktop:storage-write', key, value, previous);
    if (result?.ok === true) {
      updateCommitted(key, value, result.revision);
      return true;
    }
    if (result && (result.current === null || typeof result.current === 'string')) {
      updateCommitted(key, result.current, result.revision);
      // Let the failed caller preserve its form before refreshing stale data.
      Promise.resolve().then(() => notifyStorage(key, result.current));
    }
  } catch { /* Failed commits never change the acknowledged data or cache. */ }
  return false;
}

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Keep a drag in its original transparent window until DOM capture is released.
const capturedPointers = new Set();
document.addEventListener('gotpointercapture', (event) => {
  const wasCaptured = capturedPointers.size > 0;
  capturedPointers.add(event.pointerId);
  if (!wasCaptured) ipcRenderer.send('desktop:pointer-capture', true);
});
document.addEventListener('lostpointercapture', (event) => {
  if (capturedPointers.delete(event.pointerId) && capturedPointers.size === 0) {
    ipcRenderer.send('desktop:pointer-capture', false);
  }
});
function releasePointerCapture() {
  if (capturedPointers.size === 0) return;
  capturedPointers.clear();
  ipcRenderer.send('desktop:pointer-capture', false);
}
window.addEventListener('blur', releasePointerCapture);
window.addEventListener('pagehide', releasePointerCapture);

contextBridge.exposeInMainWorld('desktopBridge', {
  isStorageReady: () => storageReady,
  reloadStorage: () => ipcRenderer.send('desktop:storage-reload'),
  readStorage: key => {
    if (!storageReady) throw new Error('Storage safeguard unavailable');
    return Object.hasOwn(committed, key) ? committed[key] : null;
  },
  onStorageChanged: callback => {
    storageListeners.add(callback);
    return () => storageListeners.delete(callback);
  },
  storageRecovered,
  writeStorage: persistStorage,
  setPin: (panel, enabled) => ipcRenderer.invoke('desktop:set-pin', panel, !!enabled),
  getPins: () => ipcRenderer.invoke('desktop:get-pins'),
  getStartup: () => ipcRenderer.invoke('desktop:get-startup'),
  setStartup: (enabled) => ipcRenderer.invoke('desktop:set-startup', !!enabled),
  setCourseEnabled: (enabled) => ipcRenderer.send('desktop:set-course-enabled', !!enabled),
  onCourseEnabled: (callback) => subscribe('desktop:course-enabled', callback),
  reportWidgetBounds: (bounds) => ipcRenderer.send('desktop:report-widget-bounds', bounds),
  reportScheduleBounds: (bounds) => ipcRenderer.send('desktop:report-schedule-bounds', bounds),
  getWidgetBounds: () => ipcRenderer.invoke('desktop:get-widget-bounds'),
  onWidgetBounds: (callback) => subscribe('desktop:widget-bounds', callback),
  setLocale: (locale) => ipcRenderer.send('desktop:set-locale', locale),
});
