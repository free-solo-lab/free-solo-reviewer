import { afterEach, expect, it, vi } from 'vitest';
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
import { command } from '../server/process';
import { createDiskImage } from '../desktop/dmg';

vi.mock('../server/process', () => ({ command: vi.fn() }));
const cleanup: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
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
  return { appPath, outDir, destination, version: '0.1.1', arch: 'arm64' as const };
}

it('stages an installable bundle and publishes the completed image', async () => {
  const f = await fixture();
  vi.mocked(command).mockImplementation(async (binary, args) => {
    if (binary === '/usr/bin/ditto') {
      await cp(args[0], args[1], { recursive: true, verbatimSymlinks: true });
    } else {
      expect(binary).toBe('/usr/bin/hdiutil');
      const contents = args[args.indexOf('-srcfolder') + 1];
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
