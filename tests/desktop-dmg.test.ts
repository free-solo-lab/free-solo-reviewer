import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, CommandError } from '../server/process';
import { createDiskImage } from '../desktop/dmg';

vi.mock('../server/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/process')>()),
  command: vi.fn(),
}));
const cleanup: string[] = [];
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reviewer dmg test-'));
  cleanup.push(root);
  const appPath = join(root, 'Reviewer.app');
  const executable = join(appPath, 'Contents', 'MacOS', 'Reviewer');
  await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(executable, 'executable');
  await chmod(executable, 0o755);
  await symlink('MacOS/Reviewer', join(appPath, 'Contents', 'executable'));
  const outDir = join(root, 'release');
  await mkdir(outDir);
  const destination = join(outDir, 'Reviewer-0.1.1-darwin-arm64.dmg');
  await writeFile(destination, 'previous image');
  return {
    appPath,
    outDir,
    destination,
    version: '0.1.1',
    arch: 'arm64' as const,
    retryDelayMs: 0,
  };
}

it('stages an installable bundle and publishes the completed image', async () => {
  const f = await fixture();
  vi.mocked(command).mockImplementation(async (binary, args) => {
    if (binary === '/usr/bin/ditto') {
      await cp(args[0], args[1], { recursive: true, verbatimSymlinks: true });
    } else {
      expect(binary).toBe('/usr/bin/hdiutil');
      expect(args).toContain('-nospotlight');
      const contents = args[args.indexOf('-srcfolder') + 1];
      expect(await readFile(join(contents, '.metadata_never_index'), 'utf8')).toBe('');
      const instructions = await readFile(join(contents, 'Install Reviewer.txt'), 'utf8');
      expect(instructions).toContain('Replace');
      expect(instructions).toContain('Заменить');
      expect(await readlink(join(contents, 'Applications'))).toBe('/Applications');
      expect(await readlink(join(contents, 'Reviewer.app/Contents/executable'))).toBe(
        'MacOS/Reviewer',
      );
      expect(
        (await lstat(join(contents, 'Reviewer.app/Contents/MacOS/Reviewer'))).mode & 0o111,
      ).toBeTruthy();
      expect(await readFile(f.destination, 'utf8')).toBe('previous image');
      await writeFile(args.at(-1)!, 'complete image');
    }
    return '';
  });
  expect(await createDiskImage(f)).toBe(f.destination);
  expect(command).toHaveBeenCalledWith('/usr/bin/hdiutil', expect.any(Array), {
    timeout: 5 * 60_000,
  });
  expect(command).toHaveBeenCalledWith('/usr/bin/ditto', expect.any(Array), { timeout: 300000 });
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('300'));
  expect(await readFile(f.destination, 'utf8')).toBe('complete image');
  expect(await readdir(f.outDir)).toEqual(['Reviewer-0.1.1-darwin-arm64.dmg']);
});

it.each(['copy', 'image'])(
  'cleans up after a %s failure and keeps the previous DMG',
  async (failure) => {
    const f = await fixture();
    vi.mocked(command).mockImplementation(async (binary, args) => {
      if (binary === '/usr/bin/ditto' && failure !== 'copy') {
        await cp(args[0], args[1], { recursive: true, verbatimSymlinks: true });
        return '';
      }
      if (binary === '/usr/bin/hdiutil') await writeFile(args.at(-1)!, 'partial image');
      throw new Error('disk full');
    });
    await expect(createDiskImage(f)).rejects.toThrow('disk full');
    expect(await readFile(f.destination, 'utf8')).toBe('previous image');
    expect(await readdir(f.outDir)).toEqual(['Reviewer-0.1.1-darwin-arm64.dmg']);
  },
);

it('retries an image that hdiutil failed to create and publishes the next good one', async () => {
  const f = await fixture();
  let images = 0;
  vi.mocked(command).mockImplementation(async (binary, args) => {
    if (binary === '/usr/bin/ditto') {
      await cp(args[0], args[1], { recursive: true, verbatimSymlinks: true });
      return '';
    }
    // A partially written image must be removed before every retry.
    await expect(readFile(args.at(-1)!)).rejects.toMatchObject({ code: 'ENOENT' });
    images++;
    if (images < 3) {
      await writeFile(args.at(-1)!, 'partial image');
      throw new Error('hdiutil: create failed');
    }
    await writeFile(args.at(-1)!, 'complete image');
    return '';
  });
  expect(await createDiskImage(f)).toBe(f.destination);
  expect(images).toBe(3);
  expect(console.warn).toHaveBeenCalledTimes(2);
  expect(await readFile(f.destination, 'utf8')).toBe('complete image');
  expect(await readdir(f.outDir)).toEqual(['Reviewer-0.1.1-darwin-arm64.dmg']);
});

it('preserves the final terminated command error and keeps the previous image intact', async () => {
  const f = await fixture();
  const error = new CommandError('hdiutil failed without output', '', '', {
    exitCode: null,
    signal: 'SIGTERM',
    killed: true,
    durationMs: 300000,
    timeoutMs: 300000,
  });
  let images = 0;
  vi.mocked(command).mockImplementation(async (binary, args) => {
    if (binary === '/usr/bin/ditto') {
      await cp(args[0], args[1], { recursive: true, verbatimSymlinks: true });
      return '';
    }
    images++;
    await writeFile(args.at(-1)!, 'incomplete image');
    throw error;
  });
  await expect(createDiskImage(f)).rejects.toBe(error);
  expect(images).toBe(3);
  expect(console.error).toHaveBeenCalledTimes(3);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('300'));
  expect(await readFile(f.destination, 'utf8')).toBe('previous image');
  expect(await readdir(f.outDir)).toEqual(['Reviewer-0.1.1-darwin-arm64.dmg']);
});
