import { afterEach, expect, it, vi } from 'vitest';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDesktopLog,
  createFailureReporter,
  desktopDiagnostic,
  openDesktopLogs,
  redactDiagnosticText,
} from '../desktop/diagnostics';
import { CommandError } from '../server/process';

const context = {
  version: '9.8.7',
  osVersion: '15.0',
  arch: 'arm64',
  appPath: '/Applications/Reviewer.app',
  logPath: '/logs/desktop.log',
};
const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

it('copies only diagnostic metadata and redacts credentials from the message', () => {
  const error = Object.assign(
    new CommandError(
      'Bearer private-token token=hidden ghp_secret sk-test-key',
      'repository contents',
      'private stderr',
      {
        exitCode: 7,
        signal: null,
        durationMs: 300,
        timeoutMs: 500,
      },
    ),
    { environment: { secret: true }, repository: 'private repository' },
  );
  const record = desktopDiagnostic(context, 'server', error);
  const text = JSON.stringify(record);
  for (const secret of [
    'private-token',
    'hidden',
    'ghp_secret',
    'sk-test-key',
    'repository contents',
    'private stderr',
    'environment',
  ]) {
    expect(text).not.toContain(secret);
  }
  expect(record).toMatchObject({
    ...context,
    stage: 'server',
    exitCode: 7,
    signal: null,
    durationMs: 300,
    timeoutMs: 500,
  });
  expect(redactDiagnosticText('custom-api-secret', { OPENAI_API_KEY: 'custom-api-secret' })).toBe(
    '[redacted]',
  );
});

it('rotates the desktop journal and retains only one previous copy with private permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-log-'));
  cleanup.push(root);
  const record = desktopDiagnostic(context, 'launch');
  const logger = createDesktopLog(root, Buffer.byteLength(JSON.stringify(record) + '\n') + 1);
  expect(logger.write(record)).toBe(true);
  expect(logger.write({ ...record, stage: 'server' })).toBe(true);
  expect(logger.write({ ...record, stage: 'window-ready' })).toBe(true);
  expect((await readdir(root)).sort()).toEqual(['desktop.log', 'desktop.log.1']);
  expect(JSON.parse(await readFile(logger.path, 'utf8')).stage).toBe('window-ready');
  expect(JSON.parse(await readFile(logger.path + '.1', 'utf8')).stage).toBe('server');
  expect((await lstat(logger.path)).mode & 0o777).toBe(0o600);
});

it('does not throw when the log folder cannot be created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-log-unavailable-'));
  cleanup.push(root);
  const file = join(root, 'file');
  await writeFile(file, 'not a directory');
  expect(createDesktopLog(file).write(desktopDiagnostic(context, 'launch'))).toBe(false);
});

it('supports log and copy actions before closing the application', async () => {
  const tools = {
    diagnostic: (stage: 'server', error: unknown) => desktopDiagnostic(context, stage, error),
    log: vi.fn(),
    show: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(2),
    copy: vi.fn(),
    showLogs: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
  const report = createFailureReporter({
    ...tools,
    diagnostic: (stage, error) => desktopDiagnostic(context, stage, error),
  });
  await report('server', new Error('server unavailable'));
  expect(tools.copy).toHaveBeenCalledTimes(1);
  expect(JSON.parse(tools.copy.mock.calls[0][0])).toMatchObject({
    stage: 'server',
    message: 'server unavailable',
  });
  expect(tools.showLogs).toHaveBeenCalledOnce();
  expect(tools.close).toHaveBeenCalledOnce();
  expect(tools.show.mock.calls[0][0]).toMatchObject({ type: 'error', defaultId: 2, cancelId: 2 });
});

it('logs concurrent failures but opens only one native dialog', async () => {
  let dismiss!: (value: number) => void;
  const show = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        dismiss = resolve;
      }),
  );
  const log = vi.fn();
  const close = vi.fn();
  const report = createFailureReporter({
    diagnostic: (stage, error) => desktopDiagnostic(context, stage, error),
    log,
    show,
    copy: vi.fn(),
    showLogs: vi.fn(),
    close,
  });
  const first = report('window', new Error('load failure'));
  await report('renderer', new Error('renderer failure'));
  expect(show).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledTimes(2);
  dismiss(2);
  await first;
  expect(close).toHaveBeenCalledOnce();
});

it('opens the log folder without showing an error on success', async () => {
  const openPath = vi.fn().mockResolvedValue('');
  const showErrorBox = vi.fn();
  await openDesktopLogs('/logs', { openPath, showErrorBox });
  expect(openPath).toHaveBeenCalledExactlyOnceWith('/logs');
  expect(showErrorBox).not.toHaveBeenCalled();
});

it.each(['returned error', 'rejected promise'])(
  'reports a log-folder %s without rejecting',
  async (mode) => {
    const failure = 'cannot open folder: token=synthetic-secret';
    const openPath =
      mode === 'returned error'
        ? vi.fn().mockResolvedValue(failure)
        : vi.fn().mockRejectedValue(new Error(failure));
    const showErrorBox = vi.fn();
    await expect(
      openDesktopLogs('/missing/logs', { openPath, showErrorBox }),
    ).resolves.toBeUndefined();
    expect(showErrorBox).toHaveBeenCalledOnce();
    const [title, detail] = showErrorBox.mock.calls[0];
    expect(title).toBeTruthy();
    expect(detail).toContain('/missing/logs');
    expect(detail).toContain('cannot open folder');
    expect(detail).not.toContain('synthetic-secret');
  },
);

it('returns to the failure dialog after showing a log-folder error', async () => {
  const show = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1).mockResolvedValueOnce(2);
  const showErrorBox = vi.fn();
  const close = vi.fn();
  const copy = vi.fn();
  await createFailureReporter({
    diagnostic: (stage, error) => desktopDiagnostic(context, stage, error),
    log: vi.fn(),
    show,
    showLogs: () =>
      openDesktopLogs('/logs', {
        openPath: vi.fn().mockResolvedValue('folder missing'),
        showErrorBox,
      }),
    copy,
    close,
  })('server', new Error('server failure'));
  expect(showErrorBox).toHaveBeenCalledOnce();
  expect(show).toHaveBeenCalledTimes(3);
  expect(copy).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
