// Loaded only on Windows. Read the foreground class; never activate Explorer.
const user32 = require('koffi').load('user32.dll');
const foregroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
const previousWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hwnd, unsigned int command)');
const isVisible = user32.func('int __stdcall IsWindowVisible(uintptr_t hwnd)');
const className = user32.func('int __stdcall GetClassNameW(uintptr_t hwnd, _Out_ void * name, int count)');
const buffer = Buffer.alloc(512);

function isDesktopWindow(hwnd) {
  if (!hwnd) return false;
  const length = className(hwnd, buffer, 256);
  const name = buffer.toString('utf16le', 0, length * 2);
  return name === 'Progman' || name === 'WorkerW';
}

function isDesktopAbove(nativeHandle) {
  let hwnd = nativeHandle.length === 8 ? nativeHandle.readBigUInt64LE() : nativeHandle.readUInt32LE();
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

module.exports = { isDesktopForeground: () => isDesktopWindow(foregroundWindow()), isDesktopAbove };
