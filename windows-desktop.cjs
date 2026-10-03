// Loaded only on Windows. Observe the shell without activating it.
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const foregroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
const desktopWindow = user32.func('uintptr_t __stdcall GetDesktopWindow()');
const previousWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hwnd, unsigned int command)');
const isVisible = user32.func('int __stdcall IsWindowVisible(uintptr_t hwnd)');
const windowStyle = user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)');
const setWindowPos = user32.func('int __stdcall SetWindowPos(uintptr_t hwnd, intptr_t after, int x, int y, int width, int height, unsigned int flags)');
const className = user32.func('int __stdcall GetClassNameW(uintptr_t hwnd, _Out_ void * name, int count)');
const buffer = Buffer.alloc(512);
const eventProc = koffi.proto('void __stdcall TaskboardWinEventProc(uintptr_t hook, unsigned long event, uintptr_t hwnd, long object, long child, unsigned long thread, unsigned long time)');
const setHook = user32.func('uintptr_t __stdcall SetWinEventHook(unsigned long first, unsigned long last, uintptr_t module, TaskboardWinEventProc * callback, unsigned long process, unsigned long thread, unsigned long flags)');
const unhook = user32.func('int __stdcall UnhookWinEvent(uintptr_t hook)');

function isDesktopWindow(hwnd) {
  if (!hwnd) return false;
  const length = className(hwnd, buffer, 256);
  const name = buffer.toString('utf16le', 0, length * 2);
  return name === 'Progman' || name === 'WorkerW';
}

function isDesktopAbove(nativeHandle) {
  let hwnd = handleValue(nativeHandle);
  // GW_HWNDPREV walks toward the top of the Z-order. A desktop session can
  // contain hundreds of hidden helper windows; detect cycles instead of
  // cutting off a valid chain after an arbitrary number of handles.
  const visited = new Set();
  while (!visited.has(String(hwnd))) {
    visited.add(String(hwnd));
    hwnd = previousWindow(hwnd, 3);
    if (!hwnd) return false;
    if (isVisible(hwnd) && isDesktopWindow(hwnd)) return true;
  }
  return false;
}

function handleValue(handle) {
  return handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE();
}

function foregroundContext(handles) {
  const hwnd = foregroundWindow();
  if (!hwnd) return null; // Activation can briefly have no foreground window.
  if (isDesktopWindow(hwnd)) return 'desktop';
  return handles.some(handle => String(handleValue(handle)) === String(hwnd)) ? 'panel' : 'other';
}

function isTopmost(handle) {
  return !!(Number(windowStyle(handleValue(handle), -20)) & 8);
}

function ensureTopmost(handle, enabled) {
  // Chromium can retain a Z-order level after Windows has cleared the flag,
  // making a repeated Electron setter a no-op. Repair only a native mismatch.
  if (isTopmost(handle) !== enabled) setWindowPos(handleValue(handle), enabled ? -1 : -2, 0, 0, 0, 0, 0x213);
  return isTopmost(handle);
}

function placeBelowForeground(handle, panelHandles) {
  const hwnd = foregroundWindow();
  if (!hwnd || isDesktopWindow(hwnd) ||
      panelHandles.some(panel => String(handleValue(panel)) === String(hwnd)) ||
      (Number(windowStyle(hwnd, -20)) & 8)) return;
  // HWND_NOTOPMOST alone puts a window above other normal windows. After
  // removing a desktop boost, explicitly let the new foreground app cover it.
  setWindowPos(handleValue(handle), hwnd, 0, 0, 0, 0, 0x213); // no move/size/activate/owner Z-order
}

function watchChanges(listener) {
  let active = false, notifying = false, pending = null;
  const notify = () => {
    if (!active) return;
    if (notifying) {
      if (pending === null) pending = setImmediate(() => { pending = null; notify(); });
      return;
    }
    notifying = true;
    try { listener(); }
    finally { notifying = false; }
  };
  const callback = koffi.register((_hook, event, hwnd, object, child) => {
    if (!active) return;
    if (event === 3) { notify(); return; } // EVENT_SYSTEM_FOREGROUND
    // Top-level Z-order changes may name the desktop root, not Explorer.
    if ((event === 0x8002 || event === 0x8004) && child === 0 &&
        (object === 0 || object === -4) &&
        (String(hwnd) === String(desktopWindow()) || isDesktopWindow(hwnd))) notify();
  }, koffi.pointer(eventProc));
  // OUTOFCONTEXT: callbacks run on this Electron main thread's message loop.
  const hooks = [setHook(3, 3, 0, callback, 0, 0, 0), setHook(0x8002, 0x8004, 0, callback, 0, 0, 0)];
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    active = false;
    if (pending !== null) { clearImmediate(pending); pending = null; }
    const removed = hooks.map(handle => !handle || !!unhook(handle));
    // Never free a callback that Windows could still invoke after a failed unhook.
    if (removed.every(Boolean)) {
      if (notifying) setImmediate(() => koffi.unregister(callback));
      else koffi.unregister(callback);
    }
  };
  if (hooks.some(handle => !handle)) { stop(); return null; }
  active = true;
  return stop;
}

module.exports = { isDesktopForeground: () => isDesktopWindow(foregroundWindow()), isDesktopAbove, foregroundContext, isTopmost, ensureTopmost, placeBelowForeground, watchChanges };
