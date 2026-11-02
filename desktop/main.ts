import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { connectOrStartService } from './service-controller.js';
import { externalUrl, isInternalUrl } from './navigation.js';
import { isLanguage, setLanguage, t } from '../shared/i18n.js';

app.setName('Reviewer');
let mainWindow: BrowserWindow | null = null;
let service: Awaited<ReturnType<typeof connectOrStartService>> | undefined;
let quitting = false;
const lifetime = new AbortController();
async function showWindow() {
  if (!service || quitting) return;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    title: 'Reviewer',
    width: 1440,
    height: 940,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#f6f8f2',
    titleBarStyle: 'default',
    webPreferences: {
      preload: join(app.getAppPath(), 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    mainWindow = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    const safe = externalUrl(url);
    if (safe) void shell.openExternal(safe).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url, service!.url)) return;
    event.preventDefault();
    const safe = externalUrl(url);
    if (safe) void shell.openExternal(safe).catch(() => {});
  });
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback) =>
    callback(
      contents === win.webContents &&
        isInternalUrl(contents.getURL(), service!.url) &&
        permission === 'clipboard-sanitized-write',
    ),
  );
  await win.loadURL(service.url);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    void showWindow();
  });
  app.on('activate', () => {
    void showWindow();
  });
  // Closing the window leaves analyses running; explicit Quit closes only an owned server.
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    lifetime.abort();
    if (!service?.owned) return;
    event.preventDefault();
    void service.close().finally(() => app.quit());
  });
  void app.whenReady().then(async () => {
    try {
      const root = app.getAppPath();
      service = await connectOrStartService({
        node: join(root, 'runtime', 'node'),
        entry: join(root, 'runtime', 'server.mjs'),
        webDir: join(root, 'ui'),
        signal: lifetime.signal,
      });
      // Menus follow the language chosen in the app's settings.
      const settings = await fetch(`${service.url}/api/settings/language`)
        .then((response) => response.json() as Promise<{ language?: unknown }>)
        .catch(() => ({ language: undefined }));
      if (isLanguage(settings.language)) setLanguage(settings.language);
      ipcMain.handle('reviewer:choose-directory', async (event) => {
        if (
          !mainWindow ||
          event.sender !== mainWindow.webContents ||
          !event.senderFrame ||
          !isInternalUrl(event.senderFrame.url, service!.url)
        )
          throw new Error(t('Request source not allowed.'));
        const result = await dialog.showOpenDialog(mainWindow, {
          title: t('Choose a Git repository'),
          properties: ['openDirectory'],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Reviewer',
            submenu: [
              { role: 'about' },
              {
                label: t('Open Reviewer'),
                click: () => {
                  void showWindow();
                },
              },
              {
                label: t('Open in browser'),
                click: () => {
                  void shell.openExternal(service!.url);
                },
              },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          {
            label: t('Edit'),
            submenu: [
              { role: 'undo' },
              { role: 'redo' },
              { type: 'separator' },
              { role: 'cut' },
              { role: 'copy' },
              { role: 'paste' },
              { role: 'selectAll' },
            ],
          },
          {
            label: t('View'),
            submenu: [
              { role: 'reload' },
              { role: 'resetZoom' },
              { role: 'zoomIn' },
              { role: 'zoomOut' },
              { role: 'togglefullscreen' },
            ],
          },
          { role: 'windowMenu', label: t('Window') },
        ]),
      );
      await showWindow();
    } catch (error) {
      if (!quitting) dialog.showErrorBox(t('Could not open Reviewer'), (error as Error).message);
      app.quit();
    }
  });
}
