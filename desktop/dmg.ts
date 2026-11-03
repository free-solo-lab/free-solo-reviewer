import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { command } from '../server/process.js';
import { inAllLanguages, t } from '../shared/i18n.js';

const imageTimeoutMs = 5 * 60_000;

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
    await writeFile(join(contents, '.metadata_never_index'), '');
    await writeFile(
      join(contents, 'Install Reviewer.txt'),
      inAllLanguages(
        'Installing Reviewer\n\n1. Quit Reviewer before updating.\n2. Drag Reviewer.app onto Applications. If prompted, choose Replace.\n3. Eject this disk image.\n4. Open Reviewer from Applications.\n\nSpotlight can show copies on mounted images and in old build folders. Eject images and remove old copies you no longer need.\n\nThese builds are ad-hoc signed, without Apple notarization. If macOS asks for permission, use System Settings > Privacy & Security > Open Anyway. If it says the app is damaged, verify the download checksum and download the latest release again. See https://github.com/free-solo-lab/free-solo-reviewer/releases/latest',
      ).join('\n\n--------------------\n\n') + '\n',
    );
    const image = join(temporary, filename);
    for (let attempt = 1; ; attempt++) {
      const started = performance.now();
      console.log(t('Creating DMG (limit: {0} s): {1}', imageTimeoutMs / 1000, destination));
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
            '-nospotlight',
            '-fs',
            'HFS+',
            '-format',
            'UDZO',
            image,
          ],
          { timeout: imageTimeoutMs },
        );
        console.log(t('DMG created in {0} s.', ((performance.now() - started) / 1000).toFixed(1)));
        break;
      } catch (error) {
        console.error(
          t(
            'DMG creation failed after {0} s (limit: {1} s).',
            ((performance.now() - started) / 1000).toFixed(1),
            imageTimeoutMs / 1000,
          ),
        );
        // Keep the upstream retry policy for intermittent failures on hosted macOS runners.
        if (attempt >= IMAGE_ATTEMPTS) throw error;
        console.warn(
          t('hdiutil create failed (attempt {0} of {1}); retrying.', attempt, IMAGE_ATTEMPTS),
        );
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
