const path = require('node:path');
const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');

let mainWindow;
let pinned = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 430,
    height: 820,
    minWidth: 390,
    minHeight: 460,
    title: 'Main / Side',
    backgroundColor: '#f2f1ed',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; pinned = false; });
}

ipcMain.handle('desktop:toggle-pin', () => {
  if (!mainWindow) return false;
  pinned = !pinned;
  mainWindow.setAlwaysOnTop(pinned, 'floating');
  return pinned;
});

if (process.platform === 'darwin') {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]));
} else {
  Menu.setApplicationMenu(null);
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.lllleolin.taskboard');
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
