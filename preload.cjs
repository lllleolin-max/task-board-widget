const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Keep a drag in its original transparent window until DOM capture is released.
document.addEventListener('gotpointercapture', () => ipcRenderer.send('desktop:pointer-capture', true));
document.addEventListener('lostpointercapture', () => ipcRenderer.send('desktop:pointer-capture', false));

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
