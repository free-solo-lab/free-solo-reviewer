import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const mocked = vi.hoisted(() => ({
  electron: {} as Record<string, unknown>,
  connect: vi.fn(),
  write: vi.fn(),
}));
vi.mock('electron', () => mocked.electron);
vi.mock('../desktop/service-controller', () => ({ connectOrStartService: mocked.connect }));
vi.mock('../desktop/diagnostics', async (original) => ({
  ...(await original<typeof import('../desktop/diagnostics')>()),
  createDesktopLog: () => ({ path: '/logs/desktop.log', write: mocked.write }),
}));
vi.mock('../desktop/updater', () => ({
  Updater: class {
    cleanup = vi.fn().mockResolvedValue(undefined);
  },
}));

const service = { owned: true, close: vi.fn() };
const app = Object.assign(new EventEmitter(), {
  isPackaged: false,
  setName: vi.fn(),
  getVersion: () => '0.2.0',
  getAppPath: () => '/source/app',
  getPath: () => '/profile',
  isReady: () => true,
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  quit: vi.fn(),
  exit: vi.fn(),
});
const showMessageBox = vi.fn();
const showErrorBox = vi.fn();
const openPath = vi.fn();
const writeText = vi.fn();
const menu = vi.fn();
let windowCreated = false;
class Window extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn(),
    session: { setPermissionRequestHandler: vi.fn() },
  });
  constructor() {
    super();
    windowCreated = true;
  }
  show() {}
  loadURL() {
    queueMicrotask(() => this.emit('ready-to-show'));
    return Promise.resolve();
  }
}

const failureEvents = ['uncaughtException', 'unhandledRejection'] as const;
let previousListeners: Map<string, Function[]>;
const systemVersion = process.getSystemVersion;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  app.removeAllListeners();
  service.owned = true;
  service.close.mockResolvedValue(undefined);
  windowCreated = false;
  mocked.connect.mockResolvedValue({ ...service, url: 'http://127.0.0.1:4318' });
  openPath.mockResolvedValue('');
  previousListeners = new Map(failureEvents.map((event) => [event, process.listeners(event)]));
  process.getSystemVersion = () => '15.0';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ language: 'ru' }) }));
  Object.assign(mocked.electron, {
    app,
    BrowserWindow: Window,
    Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: menu },
    clipboard: { writeText },
    dialog: { showMessageBox, showErrorBox },
    shell: { openPath },
    ipcMain: { handle: vi.fn() },
    net: {},
  });
});
afterEach(() => {
  for (const event of failureEvents)
    for (const listener of process.listeners(event))
      if (!previousListeners.get(event)!.includes(listener))
        process.removeListener(event, listener);
  if (systemVersion === undefined) Reflect.deleteProperty(process, 'getSystemVersion');
  else process.getSystemVersion = systemVersion;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function launch() {
  await import('../desktop/main');
  await vi.waitFor(() => expect(windowCreated).toBe(true));
}
function fail() {
  const handler = process
    .listeners('unhandledRejection')
    .find((listener) => !previousListeners.get('unhandledRejection')!.includes(listener))!;
  handler(new Error('synthetic main-process failure'), Promise.resolve());
}
function pendingClose() {
  let finish!: () => void;
  service.close.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
  return () => finish();
}

it.each(['dialog', 'copy'])(
  'stops the backend before exiting when the %s action fails',
  async (action) => {
    const finish = pendingClose();
    if (action === 'dialog') showMessageBox.mockRejectedValue(new Error('dialog unavailable'));
    else {
      showMessageBox.mockResolvedValue({ response: 1 });
      writeText.mockImplementation(() => {
        throw new Error('clipboard unavailable');
      });
    }
    await launch();
    fail();
    await vi.waitFor(() => expect(service.close).toHaveBeenCalledOnce());
    expect(app.exit).not.toHaveBeenCalled();
    expect(mocked.write).toHaveBeenCalledWith(expect.objectContaining({ stage: 'unhandled' }));
    fail(); // errors while stopping cannot open another dialog or start another cleanup
    expect(showMessageBox).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(() => expect(app.exit).toHaveBeenCalledExactlyOnceWith(1));
  },
);

it('prevents repeated Quit from bypassing the pending backend shutdown', async () => {
  const finish = pendingClose();
  await launch();
  const first = { preventDefault: vi.fn() };
  const second = { preventDefault: vi.fn() };
  app.emit('before-quit', first);
  await vi.waitFor(() => expect(service.close).toHaveBeenCalledOnce());
  app.emit('before-quit', second);
  expect(first.preventDefault).toHaveBeenCalledOnce();
  expect(second.preventDefault).toHaveBeenCalledOnce();
  expect(app.quit).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
  const completed = { preventDefault: vi.fn() };
  app.emit('before-quit', completed);
  expect(completed.preventDefault).not.toHaveBeenCalled();
});

it('cancels a pending startup and waits for its cleanup before quitting', async () => {
  let rejectStartup!: (error: unknown) => void;
  mocked.connect.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectStartup = reject;
    }),
  );
  await import('../desktop/main');
  await vi.waitFor(() => expect(mocked.connect).toHaveBeenCalledOnce());
  const signal = mocked.connect.mock.calls[0][0].signal as AbortSignal;
  app.emit('before-quit', { preventDefault: vi.fn() });
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  expect(app.quit).not.toHaveBeenCalled();
  rejectStartup(signal.reason);
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
  expect(windowCreated).toBe(false);
  expect(service.close).not.toHaveBeenCalled();
  expect(mocked.write.mock.calls.some(([record]) => record.message)).toBe(false);
});

it('keeps a separately started backend running on a fatal desktop failure', async () => {
  mocked.connect.mockResolvedValue({ ...service, owned: false, url: 'http://127.0.0.1:4318' });
  showMessageBox.mockRejectedValue(new Error('dialog unavailable'));
  await launch();
  fail();
  await vi.waitFor(() => expect(app.exit).toHaveBeenCalledExactlyOnceWith(1));
  expect(service.close).not.toHaveBeenCalled();
});

it.each(['returned error', 'rejected promise'])(
  'reports a log-folder %s from the menu without quitting',
  async (mode) => {
    if (mode === 'returned error') openPath.mockResolvedValue('folder missing');
    else openPath.mockRejectedValue(new Error('folder missing'));
    await launch();
    const template = menu.mock.calls[0][0] as {
      submenu: { label?: string; click?: () => void }[];
    }[];
    const showLogs = template[0].submenu.find((item) => item.label === 'Показать логи')!;
    expect(showLogs).toBeDefined();
    showLogs.click!();
    await vi.waitFor(() => expect(showErrorBox).toHaveBeenCalledOnce());
    expect(showErrorBox.mock.calls[0][1]).toContain('folder missing');
    expect(service.close).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
  },
);
