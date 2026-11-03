/** Exercise drag-to-Applications installation without changing the user's Applications folder. */
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { command } from '../server/process.js';

const { values } = parseArgs({ options: { image: { type: 'string' } } });
const root = fileURLToPath(new URL('..', import.meta.url));
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const image = resolve(
  values.image ?? join(root, 'release', `Reviewer-${metadata.version}-darwin-${process.arch}.dmg`),
);
console.log(await command('/usr/bin/hdiutil', ['verify', image], { timeout: 300000 }));
const temporary = await mkdtemp(join(tmpdir(), 'reviewer-dmg-smoke-'));
const mount = join(temporary, 'volume');
const installed = join(temporary, 'Installed Applications', 'Reviewer.app');
let mounted = false;
try {
  await mkdir(mount);
  await command('/usr/bin/hdiutil', [
    'attach',
    '-readonly',
    '-nobrowse',
    '-noautoopen',
    '-mountpoint',
    mount,
    image,
  ]);
  mounted = true;
  assert.equal(await readlink(join(mount, 'Applications')), '/Applications');
  const app = join(mount, 'Reviewer.app');
  assert((await lstat(join(app, 'Contents/MacOS/Reviewer'))).mode & 0o111);
  assert(
    (
      await lstat(join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/Current'))
    ).isSymbolicLink(),
  );
  await command('/usr/bin/ditto', [app, installed], { timeout: 300000 });
  await command('/usr/bin/hdiutil', ['detach', mount]);
  mounted = false;
  console.log(
    await command(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('smoke-service.ts', import.meta.url)),
        '--app',
        installed,
      ],
      { cwd: root, timeout: 180000 },
    ),
  );
} finally {
  // Never remove a mount point recursively unless its volume has been detached.
  if (mounted) await command('/usr/bin/hdiutil', ['detach', mount]);
  await rm(temporary, { recursive: true, force: true });
}
