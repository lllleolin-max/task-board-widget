const { contextBridge, ipcRenderer } = require('electron');

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
