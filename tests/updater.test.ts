import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../shared/platform';
import { sha256, signManifest } from '../desktop/update-manifest';
import { INSTALL_SCRIPT, Updater, type UpdaterOptions } from '../desktop/updater';

const run = promisify(execFile);
const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'reviewer-updater-'));
  cleanup.push(root);
  return root;
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const key = {
  private: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  public: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};
const archive = Buffer.from('the new Reviewer.app, zipped');

async function setup(
  options: Partial<UpdaterOptions> & { version?: string; checksum?: string } = {},
) {
  const root = await temporary();
  await mkdir(join(root, 'Applications'));
  const signed = signManifest(
    {
      version: options.version ?? '0.2.0',
      publishedAt: '2026-11-03T12:00:00Z',
      notes: 'Notes',
      notesUrl: 'https://example.test/v0.2.0',
      assets: [
        {
          arch: 'arm64',
          url: 'https://example.test/Reviewer.zip',
          sha256: options.checksum ?? sha256(archive),
          size: archive.length,
        },
      ],
    },
    key.private,
  );
  const states: UpdateState[] = [];
  const calls = { spawn: vi.fn(), quit: vi.fn() };
  const updater = new Updater({
    currentVersion: '0.1.3',
    arch: 'arm64',
    bundlePath: join(root, 'Applications', 'Reviewer.app'),
    workDir: join(root, 'updates'),
    manifestUrl: 'https://example.test/latest.json',
    publicKey: key.public,
    fetch: async (url) =>
      url.endsWith('latest.json')
        ? Response.json(signed)
        : new Response(new Blob([archive]).stream()),
    unzip: async (_archive, destination) => {
      await mkdir(join(destination, 'Reviewer.app'), { recursive: true });
    },
    bundleVersion: async () => options.version ?? '0.2.0',
    dataDir: async () => join(root, 'data'),
    spawnDetached: calls.spawn,
    quit: calls.quit,
    onChange: (state) => states.push(state),
    now: () => new Date('2026-11-03T12:00:00Z'),
    ...options,
  });
  return { root, updater, states, calls };
}

describe('desktop updater', () => {
  it('downloads a newer signed release, checks it and installs it on request', async () => {
    const { root, updater, states, calls } = await setup();
    expect(await updater.check()).toMatchObject({
      state: 'ready',
      version: '0.2.0',
      kind: 'minor',
    });
    expect(states.map((s) => s.state)).toEqual(
      expect.arrayContaining(['checking', 'downloading', 'ready']),
    );
    // The archive is removed once it is unpacked; the unpacked app waits for the button.
    expect(await readdir(join(root, 'updates', '0.2.0'))).toEqual(['unpacked']);
    expect(calls.spawn).not.toHaveBeenCalled();

    await updater.install();
    const [shell, args] = calls.spawn.mock.calls[0];
    expect(shell).toBe('/bin/sh');
    expect(args).toEqual([
      join(root, 'updates', 'install.sh'),
      String(process.pid),
      join(root, 'Applications', 'Reviewer.app'),
      join(root, 'updates', '0.2.0', 'unpacked', 'Reviewer.app'),
      join(root, 'updates', 'previous', 'Reviewer.app'),
      join(root, 'data'),
      join(root, 'data', 'backups', 'before-0.2.0-2026-11-03T12-00-00-000Z'),
    ]);
    expect(await readFile(args[0], 'utf8')).toBe(INSTALL_SCRIPT);
    expect(calls.quit).toHaveBeenCalledOnce();
  });
  it('does not back up data before a patch release', async () => {
    const { updater, calls } = await setup({ version: '0.1.4' });
    await updater.check();
    await updater.install();
    expect(calls.spawn.mock.calls[0][1].slice(-2)).toEqual(['', '']);
  });
  it('rejects a download whose checksum differs from the signed one', async () => {
    const { updater } = await setup({ checksum: 'f'.repeat(64) });
    expect(await updater.check()).toMatchObject({
      state: 'error',
      message: expect.stringContaining('контрольной суммой'),
      update: { version: '0.2.0' },
    });
    await expect(updater.install()).rejects.toThrow();
  });
  it('rejects an archive with another version inside', async () => {
    const { updater } = await setup({ bundleVersion: async () => '0.1.9' });
    expect(await updater.check()).toMatchObject({ state: 'error' });
  });
  it('stays quiet when no newer release exists or none is published yet', async () => {
    expect(await (await setup({ version: '0.1.3' })).updater.check()).toMatchObject({
      state: 'idle',
      checkedAt: '2026-11-03T12:00:00.000Z',
    });
    const missing = await setup({ fetch: async () => new Response('', { status: 404 }) });
    expect(await missing.updater.check()).toMatchObject({ state: 'idle' });
  });
  it('rejects a manifest that the release key did not sign', async () => {
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    const { updater } = await setup({ publicKey: other.toString() });
    expect(await updater.check()).toMatchObject({ state: 'error' });
  });
  it('offers a manual download where the app cannot replace itself', async () => {
    for (const bundlePath of [
      null,
      '/private/var/folders/x/AppTranslocation/1/d/Reviewer.app',
      '/Volumes/Reviewer/Reviewer.app',
    ]) {
      const { updater } = await setup({ bundlePath });
      expect(await updater.check()).toMatchObject({ state: 'manual', version: '0.2.0' });
    }
  });
  it('removes the replaced app and downloads of installed versions', async () => {
    const { root, updater } = await setup();
    for (const path of ['previous/Reviewer.app', '0.1.3/unpacked', '0.1.2/x', '0.2.0/unpacked'])
      await mkdir(join(root, 'updates', path), { recursive: true });
    await updater.cleanup();
    expect(await readdir(join(root, 'updates'))).toEqual(['0.2.0']);
  });
});

describe('install script', () => {
  async function layout() {
    const root = await temporary();
    const bin = join(root, 'bin');
    await mkdir(bin);
    // A stand-in for /usr/bin/open that records what would be opened.
    await writeFile(join(bin, 'open'), `#!/bin/sh\necho "$1" >> "${join(root, 'opened')}"\n`);
    await chmod(join(bin, 'open'), 0o755);
    const app = join(root, 'Applications', 'Reviewer.app');
    const next = join(root, 'updates', '0.2.0', 'unpacked', 'Reviewer.app');
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'version'), 'old');
    await mkdir(next, { recursive: true });
    await writeFile(join(next, 'version'), 'new');
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'data', 'review.sqlite'), 'database');
    await writeFile(join(root, 'install.sh'), INSTALL_SCRIPT);
    const install = (args: string[]) =>
      run('/bin/sh', [join(root, 'install.sh'), ...args], {
        env: { ...process.env, REVIEWER_OPEN: join(bin, 'open') },
      });
    // A process that has already exited stands for the quitting app.
    const done = await run('/bin/sh', ['-c', 'echo $$']);
    return { root, app, next, install, pid: done.stdout.trim() };
  }
  it('replaces the app after backing up the data and opens the new version', async () => {
    const { root, app, next, install, pid } = await layout();
    const previous = join(root, 'updates', 'previous', 'Reviewer.app');
    const backup = join(root, 'data', 'backups', 'before-0.2.0');
    await install([pid, app, next, previous, join(root, 'data'), backup]);
    expect(await readFile(join(app, 'version'), 'utf8')).toBe('new');
    expect(await readFile(join(previous, 'version'), 'utf8')).toBe('old');
    expect(await readFile(join(backup, 'review.sqlite'), 'utf8')).toBe('database');
    expect(await readFile(join(root, 'opened'), 'utf8')).toBe(`${app}\n`);
  });
  it('puts the old app back and opens it when the new one cannot be moved', async () => {
    const { root, app, install, pid } = await layout();
    const previous = join(root, 'updates', 'previous', 'Reviewer.app');
    await expect(
      install([pid, app, join(root, 'missing.app'), previous, '', '']),
    ).rejects.toThrow();
    expect(await readFile(join(app, 'version'), 'utf8')).toBe('old');
    expect(await readFile(join(root, 'opened'), 'utf8')).toBe(`${app}\n`);
  });
});
