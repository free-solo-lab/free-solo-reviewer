import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  net,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connectOrStartService } from './service-controller.js';
import { externalUrl, isInternalUrl } from './navigation.js';
import { Updater } from './updater.js';
import { UPDATE_MANIFEST_URL } from './update-manifest.js';
import { UPDATE_PUBLIC_KEY } from './update-public-key.js';
import { command } from '../server/process.js';
import { isLanguage, setLanguage, t } from '../shared/i18n.js';

app.setName('Reviewer');
let mainWindow: BrowserWindow | null = null;
let service: Awaited<ReturnType<typeof connectOrStartService>> | undefined;
let quitting = false;
const lifetime = new AbortController();
const updateDir = join(app.getPath('userData'), 'updates');
const updater = new Updater({
  currentVersion: app.getVersion(),
  arch: process.arch,
  // app.getAppPath() is Reviewer.app/Contents/Resources/app.
  bundlePath: app.isPackaged ? resolve(app.getAppPath(), '../../..') : null,
  workDir: updateDir,
  // A local manifest lets the update path be tried end to end before a release.
  manifestUrl: process.env.REVIEWER_UPDATE_URL ?? UPDATE_MANIFEST_URL,
  publicKey: UPDATE_PUBLIC_KEY,
  fetch: (url) => net.fetch(url, { cache: 'no-store' }),
  unzip: async (archive, destination) => {
    await command('/usr/bin/ditto', ['-x', '-k', archive, destination], { timeout: 300000 });
  },
  bundleVersion: async (bundle) =>
    (
      await command('/usr/bin/plutil', [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        '-o',
        '-',
        join(bundle, 'Contents/Info.plist'),
      ])
    ).trim(),
  dataDir: async () => {
    if (!service?.owned) return undefined;
    const status = await fetch(`${service.url}/api/status`)
      .then((response) => response.json() as Promise<{ dataDir?: string }>)
      .catch(() => ({ dataDir: undefined }));
    return status.dataDir;
  },
  spawnDetached: (file, args) => {
    mkdirSync(updateDir, { recursive: true });
    const log = openSync(join(updateDir, 'install.log'), 'a', 0o600);
    spawn(file, args, { detached: true, stdio: ['ignore', log, log] }).unref();
  },
  quit: () => app.quit(),
  onChange: (state) => mainWindow?.webContents.send('reviewer:update-changed', state),
});
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
      const trusted = (event: IpcMainInvokeEvent) => {
        if (
          !mainWindow ||
          event.sender !== mainWindow.webContents ||
          !event.senderFrame ||
          !isInternalUrl(event.senderFrame.url, service!.url)
        )
          throw new Error(t('Request source not allowed.'));
        return mainWindow;
      };
      ipcMain.handle('reviewer:choose-directory', async (event) => {
        const result = await dialog.showOpenDialog(trusted(event), {
          title: t('Choose a Git repository'),
          properties: ['openDirectory'],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      });
      ipcMain.handle('reviewer:update-state', (event) => {
        trusted(event);
        return updater.state;
      });
      ipcMain.handle('reviewer:update-check', (event) => {
        trusted(event);
        return updater.check();
      });
      ipcMain.handle('reviewer:update-install', (event) => {
        trusted(event);
        return updater.install();
      });
      // Checked shortly after start and every six hours; installing waits for the button.
      void updater.cleanup().catch(() => {});
      const check = () => void updater.check();
      setTimeout(check, 15_000).unref();
      setInterval(check, 6 * 60 * 60 * 1000).unref();
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
