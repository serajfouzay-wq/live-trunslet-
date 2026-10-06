// Desktop shell: starts the translation server inside the app and shows it in its own window.
import { app, BrowserWindow, Menu, ipcMain, screen, shell, session, clipboard, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const icon = path.join(root, 'build', 'icon.png');

// Keep the user's settings, pictures and transcripts outside the install folder (survives updates).
const dataDir = process.env.LT_DATA_DIR || path.join(app.getPath('userData'), 'data');
process.env.DATA_DIR = dataDir;
fs.mkdirSync(dataDir, { recursive: true });

// Audio and timers must keep running when the window is covered or minimised during an event.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let control = null;
let displayWin = null;
let splash = null;
let port = 0;
let hubRef = null;

const baseUrl = () => `http://localhost:${port}`;
const isOurs = (url) => { try { return new URL(url).hostname === 'localhost' && Number(new URL(url).port) === port; } catch { return false; } };

function webPrefs() {
  return { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false };
}

/* ----------------------------------------------------------------- windows */

function createSplash() {
  splash = new BrowserWindow({ width: 460, height: 320, frame: false, resizable: false, movable: true, center: true, show: false, backgroundColor: '#060a13', icon, skipTaskbar: true, alwaysOnTop: true });
  splash.loadFile(path.join(here, 'splash.html'));
  splash.once('ready-to-show', () => splash?.show());
}

function createControl() {
  control = new BrowserWindow({
    width: 1520, height: 960, minWidth: 1100, minHeight: 700, show: false,
    backgroundColor: '#060a13', title: 'Live Translate', icon, autoHideMenuBar: true,
    webPreferences: webPrefs(),
  });
  control.loadURL(`${baseUrl()}/control`);
  control.once('ready-to-show', () => { control.show(); splash?.close(); splash = null; });
  control.on('closed', () => { control = null; closeDisplay(); app.quit(); });
  guard(control);
}

/** Keep the pages inside the app, send everything else to the normal browser. */
function guard(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurs(url) && new URL(url).pathname.startsWith('/display')) openDisplay('auto');
    else if (/^https?:/.test(url) && !isOurs(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isOurs(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
}

let lastPick = 'auto';
function openDisplay(pick = lastPick) {
  lastPick = pick;
  if (displayWin && !displayWin.isDestroyed()) { displayWin.close(); }
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  let target = null;
  if (pick === 'auto') target = all.find((d) => d.id !== primary.id) || null;
  else if (pick !== 'window') target = all.find((d) => String(d.id) === String(pick)) || null;

  const opts = { backgroundColor: '#000000', title: 'Live Translate · Big screen', icon, autoHideMenuBar: true, show: false, webPreferences: webPrefs() };
  if (target) Object.assign(opts, { x: target.bounds.x + 40, y: target.bounds.y + 40, width: 1280, height: 720 });
  else Object.assign(opts, { width: 1280, height: 720 });
  displayWin = new BrowserWindow(opts);
  displayWin.loadURL(`${baseUrl()}/display`);
  displayWin.once('ready-to-show', () => {
    displayWin.show();
    if (target) displayWin.setFullScreen(true); // lands on the chosen monitor, full screen
  });
  displayWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape' && displayWin.isFullScreen()) displayWin.setFullScreen(false);
    if (input.key === 'F11') displayWin.setFullScreen(!displayWin.isFullScreen());
  });
  displayWin.on('closed', () => { displayWin = null; });
  guard(displayWin);
}

function closeDisplay() {
  if (displayWin && !displayWin.isDestroyed()) displayWin.close();
  displayWin = null;
}

/* -------------------------------------------------------------------- menu */

function buildMenu() {
  const template = [
    {
      label: 'Live Translate',
      submenu: [
        { label: 'Open big screen', accelerator: 'CmdOrCtrl+D', click: () => openDisplay('auto') },
        { label: 'Close big screen', click: closeDisplay },
        { type: 'separator' },
        { label: 'Copy phone link', click: () => { clipboard.writeText(hubRef?.joinUrl || ''); } },
        { label: 'Open data folder', click: () => shell.openPath(dataDir) },
        { type: 'separator' },
        { role: 'quit', label: 'Quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Open logs folder', click: () => shell.openPath(path.join(dataDir, 'logs')) },
        { label: `About (version ${app.getVersion()})`, click: () => dialog.showMessageBox({ type: 'info', title: 'Live Translate', message: `Live Translate ${app.getVersion()}`, detail: `Your data is saved in:\n${dataDir}`, icon: undefined }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* --------------------------------------------------------------------- IPC */

ipcMain.handle('desktop:info', () => ({ version: app.getVersion(), electron: process.versions.electron, dataDir, platform: process.platform }));
ipcMain.handle('desktop:displays', () => {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({ id: d.id, label: d.label || `Screen ${i + 1}`, primary: d.id === primary.id, width: d.size.width, height: d.size.height }));
});
ipcMain.handle('desktop:openDisplay', (_e, pick) => { openDisplay(String(pick || 'auto')); });
ipcMain.handle('desktop:closeDisplay', () => closeDisplay());
ipcMain.handle('desktop:openDataFolder', () => shell.openPath(dataDir));

/* ------------------------------------------------------------------ startup */

app.on('second-instance', () => {
  if (control) { if (control.isMinimized()) control.restore(); control.focus(); }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { hubRef?.stop(); hubRef?.persistNow(); } catch { /* ignore */ } });

app.whenReady().then(async () => {
  createSplash();
  buildMenu();

  // Only our own pages may use the microphone.
  const fromUs = (url) => isOurs(url || '');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const ok = fromUs(details.requestingUrl) && ['media', 'fullscreen', 'clipboard-sanitized-write'].includes(permission);
    callback(ok);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => fromUs(origin) && ['media', 'fullscreen', 'clipboard-sanitized-write'].includes(permission));

  try {
    const mod = await import(pathToFileURL(path.join(root, 'server', 'index.js')).href);
    const started = await mod.ready;
    port = started.port;
    hubRef = started.hub;
    createControl();
  } catch (e) {
    splash?.close();
    dialog.showErrorBox('Live Translate could not start', `${e.stack || e}\n\nLogs: ${path.join(dataDir, 'logs')}`);
    app.quit();
  }
});
