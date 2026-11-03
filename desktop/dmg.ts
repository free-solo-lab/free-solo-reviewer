import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { command } from '../server/process.js';

const IMAGE_ATTEMPTS = 3;

/** Publish only a complete image; a failed rebuild leaves the previous DMG intact. */
export async function createDiskImage(options: {
  appPath: string;
  outDir: string;
  version: string;
  arch: 'arm64' | 'x64';
  /** The pause before the first retry of `hdiutil create`; later ones wait longer. */
  retryDelayMs?: number;
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
    for (let attempt = 1; ; attempt++) {
      try {
        await rm(image, { force: true });
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
        break;
      } catch (error) {
        // GitHub's macOS runners now and then fail `hdiutil create` without a message; it
        // succeeds when run again.
        if (attempt >= IMAGE_ATTEMPTS) throw error;
        console.warn(`hdiutil create failed (attempt ${attempt} of ${IMAGE_ATTEMPTS}); retrying.`);
        await delay((options.retryDelayMs ?? 5000) * attempt);
      }
    }
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
