import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createDesktopShutdown, stopChildProcess } from '../desktop/shutdown';

afterEach(() => vi.useRealTimers());

function childProcess() {
  return Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((_signal: NodeJS.Signals) => true),
  });
}

it('waits for an owned child to exit after SIGTERM and removes its listeners', async () => {
  vi.useFakeTimers();
  const child = childProcess();
  const closed = vi.fn();
  const closing = stopChildProcess(child as unknown as ChildProcess).then(closed);
  await Promise.resolve();
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(closed).not.toHaveBeenCalled();
  child.emit('exit', 0, null);
  await closing;
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.listenerCount('error')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('escalates a stuck child after ten seconds and still waits for its exit', async () => {
  vi.useFakeTimers();
  const child = childProcess();
  const closing = stopChildProcess(child as unknown as ChildProcess);
  await vi.advanceTimersByTimeAsync(9999);
  expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
  await vi.advanceTimersByTimeAsync(1);
  expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  child.emit('exit', null, 'SIGKILL');
  await closing;
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds the wait after SIGKILL and cleans up when the OS reports no exit', async () => {
  vi.useFakeTimers();
  const child = childProcess();
  const result = stopChildProcess(child as unknown as ChildProcess).catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(await result).toBeInstanceOf(Error);
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.listenerCount('error')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not signal a child that has already exited', async () => {
  const child = childProcess();
  child.exitCode = 0;
  await stopChildProcess(child as unknown as ChildProcess);
  expect(child.kill).not.toHaveBeenCalled();
});

it.runIf(process.platform !== 'win32')('stops a real child that ignores SIGTERM', async () => {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  try {
    await once(child, 'message');
    vi.useFakeTimers();
    const closing = stopChildProcess(child);
    await vi.advanceTimersByTimeAsync(10_000);
    await closing;
    expect(child.signalCode).toBe('SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});

function shutdownFixture() {
  let finish!: () => void;
  const service = {
    owned: true,
    close: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
  };
  const tools = {
    abort: vi.fn(),
    getService: vi.fn(() => service),
    log: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
  };
  return { service, tools, finish: () => finish(), shutdown: createDesktopShutdown(tools) };
}

it('runs cleanup once and exits only after the owned server has stopped', async () => {
  const f = shutdownFixture();
  const stopping = f.shutdown.stop(1);
  expect(f.shutdown.stopping).toBe(true);
  expect(f.shutdown.stop()).toBe(stopping);
  await vi.waitFor(() => expect(f.service.close).toHaveBeenCalledOnce());
  expect(f.tools.abort).toHaveBeenCalledOnce();
  expect(f.tools.exit).not.toHaveBeenCalled();
  expect(f.shutdown.complete).toBe(false);
  f.finish();
  await stopping;
  expect(f.shutdown.complete).toBe(true);
  expect(f.tools.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.tools.quit).not.toHaveBeenCalled();
});

it('leaves a separately started server running on ordinary Quit', async () => {
  const f = shutdownFixture();
  f.service.owned = false;
  await f.shutdown.stop();
  expect(f.service.close).not.toHaveBeenCalled();
  expect(f.tools.quit).toHaveBeenCalledOnce();
  expect(f.tools.exit).not.toHaveBeenCalled();
});

it('logs cleanup failures before completing a fatal exit', async () => {
  const f = shutdownFixture();
  const failure = new Error('could not stop child');
  f.service.close.mockRejectedValue(failure);
  await f.shutdown.stop(1);
  expect(f.tools.log).toHaveBeenCalledExactlyOnceWith(failure);
  expect(f.tools.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.shutdown.complete).toBe(true);
});

it('waits for a pending startup before completing cleanup', async () => {
  let started!: (value: { owned: boolean; close(): Promise<void> }) => void;
  const pending = new Promise<{ owned: boolean; close(): Promise<void> }>((resolve) => {
    started = resolve;
  });
  const close = vi.fn().mockResolvedValue(undefined);
  const exit = vi.fn();
  const shutdown = createDesktopShutdown({
    abort: vi.fn(),
    getService: () => pending,
    log: vi.fn(),
    quit: vi.fn(),
    exit,
  });
  const stopping = shutdown.stop(1);
  await Promise.resolve();
  expect(exit).not.toHaveBeenCalled();
  started({ owned: true, close });
  await stopping;
  expect(close).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
});
