import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from '../server/process.js';

/** Publish only a complete image; a failed rebuild leaves the previous DMG intact. */
export async function createDiskImage(options: {
  appPath: string;
  outDir: string;
  version: string;
  arch: 'arm64' | 'x64';
}) {
  await mkdir(options.outDir, { recursive: true });
  const temporary = await mkdtemp(join(options.outDir, '.reviewer-dmg-'));
  const filename = `Reviewer-${options.version}-darwin-${options.arch}.dmg`;
  const destination = join(options.outDir, filename);
  try {
    const contents = join(temporary, 'contents');
    await mkdir(contents);
    await command('/usr/bin/ditto', [options.appPath, join(contents, 'Reviewer.app')], {
      timeout: 300000,
    });
    await symlink('/Applications', join(contents, 'Applications'));
    const image = join(temporary, filename);
    await command(
      '/usr/bin/hdiutil',
      [
        'create',
        '-volname',
        'Reviewer',
        '-srcfolder',
        contents,
        '-fs',
        'HFS+',
        '-format',
        'UDZO',
        image,
      ],
      { timeout: 300000 },
    );
    await rename(image, destination);
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** The archive the app downloads to update itself; ditto keeps symlinks and permissions. */
export async function createUpdateArchive(options: {
  appPath: string;
  outDir: string;
  version: string;
  arch: 'arm64' | 'x64';
}) {
  await mkdir(options.outDir, { recursive: true });
  const filename = `Reviewer-${options.version}-darwin-${options.arch}.zip`;
  const destination = join(options.outDir, filename);
  const temporary = join(options.outDir, `.${filename}.partial`);
  await rm(temporary, { force: true });
  await command(
    '/usr/bin/ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', options.appPath, temporary],
    { timeout: 300000 },
  );
  await rename(temporary, destination);
  return destination;
}
