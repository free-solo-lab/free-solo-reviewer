import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeReviewer } from '../server/service-client';
import { connectOrStartService } from '../desktop/service-controller';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('../server/service-client', () => ({ probeReviewer: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-controller-'));
  roots.push(root);
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    }),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const ready = {
    service: 'free-solo-reviewer' as const,
    protocol: 1 as const,
    pid: child.pid,
    dataDir: join(root, 'data'),
    instanceId: 'fixture',
  };
  vi.mocked(probeReviewer).mockResolvedValueOnce(undefined).mockResolvedValue(ready);
  const onUnexpectedExit = vi.fn();
  const options = {
    node: '/bundled/node',
    entry: '/bundled/server.mjs',
    webDir: root,
    onUnexpectedExit,
    env: {
      REVIEW_STATE_DIR: join(root, 'state'),
      REVIEW_DATA_DIR: ready.dataDir,
      REVIEW_PORT: '4318',
    },
    cwd: root,
  };
  return { child, options, ready, onUnexpectedExit };
}

it('reports an unexpected exit only after connecting to an owned server', async () => {
  const f = await fixture();
  await connectOrStartService(f.options);
  f.child.exitCode = 7;
  f.child.emit('exit', 7, null);
  expect(f.onUnexpectedExit).toHaveBeenCalledWith({ exitCode: 7, signal: null });
});

it('does not report a normal desktop shutdown as a failure', async () => {
  const f = await fixture();
  const service = await connectOrStartService(f.options);
  await service.close();
  expect(f.onUnexpectedExit).not.toHaveBeenCalled();
});

it('makes repeated close calls share one server shutdown', async () => {
  const f = await fixture();
  const service = await connectOrStartService(f.options);
  const first = service.close();
  expect(service.close()).toBe(first);
  await first;
  expect(f.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  expect(f.onUnexpectedExit).not.toHaveBeenCalled();
});

it('never reports or stops the server started by another launcher', async () => {
  const f = await fixture();
  vi.mocked(probeReviewer)
    .mockReset()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue({ ...f.ready, pid: 9000 });
  const service = await connectOrStartService(f.options);
  expect(service.owned).toBe(false);
  await service.close();
  expect(f.onUnexpectedExit).not.toHaveBeenCalled();
  expect(f.child.kill).toHaveBeenCalledOnce(); // only the losing child, never the other server
});

it('handles immediate executable errors without losing the spawn error event', async () => {
  const f = await fixture();
  const failure = Object.assign(new Error('bundled node missing'), { code: 'ENOENT' });
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => f.child.emit('error', failure));
    return f.child as unknown as ReturnType<typeof spawn>;
  });
  await expect(connectOrStartService(f.options)).rejects.toBe(failure);
  expect(f.onUnexpectedExit).not.toHaveBeenCalled();
});
