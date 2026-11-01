const { contextBridge, ipcRenderer } = require('electron');

// Reconcile before any application script can interpret an old/empty database.
// Keep raw strings, including fields this version does not understand.
let storageReady = false;
let storageRecovered = false;
try {
  const observed = Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]));
  const result = ipcRenderer.sendSync('desktop:storage-bootstrap', observed);
  if (!result?.ok) throw new Error('Storage safeguard unavailable');
  for (const [key, value] of Object.entries(result.values)) {
    if (localStorage.getItem(key) === value) continue;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
  storageReady = true;
  storageRecovered = !!result.recovered;
} catch { /* Do not allow an empty fallback to overwrite unreadable saved data. */ }
finally {
  try { ipcRenderer.sendSync('desktop:storage-ready'); }
  catch { storageReady = false; }
}

function persistStorage(key, value) {
  if (!storageReady || typeof key !== 'string' || (value !== null && typeof value !== 'string')) return false;
  let previous;
  try {
    previous = localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { return false; }
  let rollback = previous;
  try {
    const result = ipcRenderer.sendSync('desktop:storage-write', key, value, previous);
    if (result === true) return true;
    if (result && (result.current === null || typeof result.current === 'string')) rollback = result.current;
  } catch { /* Roll back unless the independent snapshot committed as well. */ }
  try {
    if (localStorage.getItem(key) === value) {
      if (rollback === null) localStorage.removeItem(key);
      else localStorage.setItem(key, rollback);
    }
  } catch { storageReady = false; }
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
