import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickDirectory } from '../server/directory-picker';
import { createApp } from '../server/app';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});
async function temporaryDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'review-folder-picker-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe('native folder selection', () => {
  it('returns a selected local path with spaces and Unicode without uploading its contents', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'Репозиторий с пробелами');
    await mkdir(path);
    let executable = '';
    const selected = await pickDirectory({
      platform: 'darwin',
      run: async (binary) => {
        executable = binary;
        return { code: 0, stdout: `${path}/\n` };
      },
    });
    expect(executable).toBe('osascript');
    expect(selected).toBe(`${path}/`);
  });
  it('distinguishes cancellation from a missing native dialog or unavailable display', async () => {
    expect(
      await pickDirectory({ platform: 'darwin', run: async () => ({ code: 0, stdout: '\n' }) }),
    ).toBeNull();
    expect(
      await pickDirectory({ platform: 'linux', run: async () => ({ code: 1, stdout: '' }) }),
    ).toBeNull();
    await expect(
      pickDirectory({
        platform: 'linux',
        run: async () => ({ code: 1, stdout: '', stderr: 'Cannot open display' }),
      }),
    ).rejects.toThrow('Укажите путь вручную');
    await expect(
      pickDirectory({ platform: 'darwin', run: async () => ({ code: 'ENOENT', stdout: '' }) }),
    ).rejects.toThrow('Укажите путь вручную');
  });
  it('rejects a relative or inaccessible directory returned by the native program', async () => {
    await expect(
      pickDirectory({
        platform: 'darwin',
        run: async () => ({ code: 0, stdout: 'relative/path\n' }),
      }),
    ).rejects.toThrow('Выбранный каталог недоступен');
  });
});

describe('local folder picker API', () => {
  async function setup(chooseDirectory: () => Promise<string | null>) {
    const { app, store } = createApp({ dataDir: await temporaryDirectory(), chooseDirectory });
    cleanup.push(() => app.close());
    const request = (payload: unknown = {}, origin = 'http://127.0.0.1:4318') =>
      app.inject({
        method: 'POST',
        url: '/api/repositories/pick-directory',
        headers: { host: '127.0.0.1:4318', 'content-type': 'application/json', origin },
        payload: JSON.stringify(payload),
      });
    return { request, store };
  }
  it('returns the selected path without connecting a repo, and handles cancellation', async () => {
    let result: string | null = '/local/repository';
    const { request, store } = await setup(async () => result);
    expect((await request()).json()).toEqual({ path: '/local/repository' });
    expect(store.repositories()).toEqual([]);
    result = null;
    expect((await request()).json()).toEqual({ path: null });
  });
  it('rejects foreign origins and unexpected input before invoking a native dialog', async () => {
    let calls = 0;
    const { request } = await setup(async () => {
      calls++;
      return null;
    });
    expect((await request({}, 'https://example.com')).statusCode).toBe(403);
    expect((await request({ command: 'untrusted' })).statusCode).toBe(400);
    expect(calls).toBe(0);
  });
  it('opens only one dialog at a time and releases the lock on cancellation or error', async () => {
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let fail = false;
    const { request } = await setup(async () => {
      started();
      await gate;
      if (fail) throw new Error('picker failed');
      return null;
    });
    const first = request();
    await ready;
    expect((await request()).statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
    fail = true;
    expect((await request()).statusCode).toBe(500);
    fail = false;
    expect((await request()).statusCode).toBe(200);
  });
});
