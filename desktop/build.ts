import { build } from 'esbuild';
import { packager } from '@electron/packager';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from '../server/process.js';
import { t } from '../shared/i18n.js';
const require = createRequire(import.meta.url);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = join(root, '.desktop', 'app');
const cache = join(root, '.desktop', 'cache');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const packageLock = await readFile(join(root, 'package-lock.json'), 'utf8');
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Official standalone Node runtime, independent of Homebrew libraries and shell setup. */
async function nodeRuntime() {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
    throw new Error(
      t('The desktop build supports only macOS arm64 and x64 on a matching Mac for now.'),
    );
  const arch = process.arch;
  const manifestPath = join(cache, `node-${arch}.json`);
  if (await exists(manifestPath)) {
    const previous = JSON.parse(await readFile(manifestPath, 'utf8'));
    const binary = join(cache, previous.file);
    if (await exists(binary)) return { binary, version: previous.version as string };
  }
  console.log(t('Downloading the official Node.js 24 LTS…'));
  const sums = await fetch('https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt', {
    signal: AbortSignal.timeout(60000),
  });
  if (!sums.ok) throw new Error(`Node.js: HTTP ${sums.status}`);
  const entry = (await sums.text()).match(
    new RegExp(`^([a-f0-9]{64})\\s+(node-(v24\\.\\d+\\.\\d+)-darwin-${arch}\\.tar\\.gz)$`, 'm'),
  );
  if (!entry) throw new Error(t('No Node.js archive was found for this architecture.'));
  const [, checksum, filename, version] = entry;
  const response = await fetch(`https://nodejs.org/dist/${version}/${filename}`, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Node.js: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== checksum)
    throw new Error(t('The Node.js checksum does not match.'));
  await mkdir(cache, { recursive: true });
  const archive = join(cache, filename);
  await writeFile(archive, bytes);
  await command('/usr/bin/tar', ['-xzf', archive, '-C', cache]);
  const file = `${filename.replace(/\.tar\.gz$/, '')}/bin/node`;
  await writeFile(manifestPath, JSON.stringify({ file, version }));
  return { binary: join(cache, file), version };
}
export async function buildDesktop() {
  await mkdir(target, { recursive: true });
  await mkdir(cache, { recursive: true });
  const runtime = join(target, 'runtime');
  await mkdir(runtime, { recursive: true });
  const node = await nodeRuntime();
  await copyFile(node.binary, join(runtime, 'node'));
  await copyFile(join(node.binary, '..', '..', 'LICENSE'), join(runtime, 'NODE_LICENSE'));
  await chmod(join(runtime, 'node'), 0o755);
  await writeFile(
    join(target, 'package.json'),
    JSON.stringify({
      name: 'reviewer-desktop',
      productName: 'Reviewer',
      version: metadata.version,
      main: 'main.cjs',
      private: true,
    }),
  );
  await copyFile(join(root, 'LICENSE'), join(target, 'LICENSE'));
  await Promise.all([
    build({
      entryPoints: [join(root, 'desktop/main.ts')],
      outfile: join(target, 'main.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['electron'],
    }),
    build({
      entryPoints: [join(root, 'desktop/preload.ts')],
      outfile: join(target, 'preload.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    }),
    build({
      entryPoints: [join(root, 'server/main.ts')],
      outfile: join(runtime, 'server.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      target: 'node24',
    }),
  ]);
  await cp(join(root, 'dist'), join(target, 'ui'), { recursive: true });
  const fingerprint = createHash('sha256').update(packageLock).update(process.arch).digest('hex');
  const installStamp = join(runtime, '.dependencies');
  if (!(await exists(installStamp)) || (await readFile(installStamp, 'utf8')) !== fingerprint) {
    await copyFile(join(root, 'package.json'), join(runtime, 'package.json'));
    await writeFile(join(runtime, 'package-lock.json'), packageLock);
    console.log(t('Installing the local server dependencies…'));
    await command(
      process.env.npm_execpath ? process.execPath : 'npm',
      process.env.npm_execpath
        ? [
            process.env.npm_execpath,
            'ci',
            '--omit=dev',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
          ]
        : ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: runtime, timeout: 300000 },
    );
    await writeFile(installStamp, fingerprint);
  }
  // npm runs no install scripts here, and node-pty's prebuilt helper comes without the
  // execute bit; the terminal cannot start a shell without it.
  const helper = join(
    runtime,
    'node_modules/node-pty/prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  );
  if (await exists(helper)) await chmod(helper, 0o755);
  await writeFile(
    join(target, 'versions.json'),
    JSON.stringify(
      {
        app: metadata.version,
        node: node.version,
        electron: require('electron/package.json').version,
      },
      null,
      2,
    ),
  );
  return target;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = await buildDesktop();
  if (process.argv.includes('--package')) {
    console.log(t('Building Reviewer.app…'));
    const paths = await packager({
      dir: source,
      name: 'Reviewer',
      executableName: 'Reviewer',
      platform: 'darwin',
      arch: process.arch === 'arm64' ? 'arm64' : 'x64',
      electronVersion: require('electron/package.json').version,
      out: join(root, 'release'),
      overwrite: true,
      asar: false,
      prune: false,
      derefSymlinks: false,
      appBundleId: 'lab.freesolo.reviewer',
      appCategoryType: 'public.app-category.developer-tools',
      darwinDarkModeSupport: true,
    });
    console.log(paths.map((path) => `${path}/Reviewer.app`).join('\n'));
  } else console.log(source);
}
