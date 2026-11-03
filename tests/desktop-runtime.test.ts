import { afterEach, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Metafile } from 'esbuild';
import metadata from '../package.json';
import { command } from '../server/process';
import {
  copyWebAssets,
  installRuntimeDependencies,
  pruneRuntimeAssets,
  reachablePackages,
  runtimePackage,
} from '../desktop/runtime-package';

vi.mock('../server/process', () => ({ command: vi.fn() }));
const cleanup: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
const metafile: Metafile = {
  inputs: {},
  outputs: {
    'server.mjs': {
      bytes: 0,
      inputs: {},
      exports: [],
      imports: ['node:fs', 'fastify', '@fastify/static', 'zod/v4'].map((path) => ({
        path,
        kind: 'import-statement',
        external: true,
      })),
    },
  },
};
async function files() {
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  return runtimePackage(metadata, lock, metafile);
}
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'reviewer-runtime-'));
  cleanup.push(root);
  return root;
}
async function put(root: string, path: string, contents = 'fixture') {
  const file = join(root, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, contents);
}
async function nativeAssets(root: string) {
  for (const arch of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    await put(root, `node_modules/node-pty/prebuilds/${arch}/spawn-helper`);
    await chmod(join(root, `node_modules/node-pty/prebuilds/${arch}/spawn-helper`), 0o644);
    await put(root, `node_modules/node-pty/prebuilds/${arch}/pty.node`);
  }
  await put(root, 'node_modules/node-pty/LICENSE');
  for (const language of ['java', 'kotlin', 'python']) {
    await put(root, `node_modules/tree-sitter-wasms/out/tree-sitter-${language}.wasm`);
  }
  await put(root, 'node_modules/tree-sitter-wasms/LICENSE');
}

it('projects the runtime roots without rewriting kept packages or changing the source lock', async () => {
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const original = JSON.stringify(lock);
  const result = runtimePackage(metadata, lock, metafile);
  const manifest = JSON.parse(result.manifest);
  expect(Object.keys(manifest.dependencies).sort()).toEqual([
    '@fastify/static',
    '@openai/codex',
    'fastify',
    'node-pty',
    'tree-sitter-wasms',
    'zod',
  ]);
  expect(manifest.overrides).toEqual(metadata.overrides);
  expect(manifest.dependencies['@openai/codex']).toBe(
    lock.packages['node_modules/@openai/codex'].version,
  );
  expect(manifest.devDependencies).toBeUndefined();
  const projected = JSON.parse(result.lock);
  expect(projected.packages[''].dependencies).toEqual(manifest.dependencies);
  expect(projected.packages[''].devDependencies).toBeUndefined();
  for (const [path, value] of Object.entries(projected.packages)) {
    if (path) expect(value).toEqual(lock.packages[path]);
  }
  expect(JSON.stringify(lock)).toBe(original);
});

it('leaves UI and build packages out of the runtime lock, since npm ci installs every entry', async () => {
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const projected = JSON.parse(runtimePackage(metadata, lock, metafile).lock);
  const paths = Object.keys(projected.packages);
  for (const name of ['react', 'react-dom', 'swagger-ui-react', '@xterm/xterm', 'vite', 'esbuild'])
    expect(paths, name).not.toContain(`node_modules/${name}`);
  expect(paths.length).toBeLessThan(Object.keys(lock.packages).length / 2);
  // Every dependency of a kept package resolves to a kept package, as Node resolves it.
  for (const path of paths.filter(Boolean)) {
    const entry = projected.packages[path];
    for (const name of Object.keys(entry.dependencies ?? {})) {
      const candidates = [];
      for (let base = path; ;) {
        candidates.push(`${base}/node_modules/${name}`);
        const parent = base.lastIndexOf('/node_modules/');
        if (parent < 0) break;
        base = base.slice(0, parent);
      }
      candidates.push(`node_modules/${name}`);
      expect(
        candidates.some((candidate) => candidate in projected.packages),
        `${path} → ${name}`,
      ).toBe(true);
    }
  }
});

it('resolves nested copies of a package before the hoisted one', () => {
  const lock = {
    packages: {
      '': {},
      'node_modules/a': { version: '1', dependencies: { b: '2' } },
      'node_modules/a/node_modules/b': { version: '2' },
      'node_modules/b': { version: '1' },
      'node_modules/c': { version: '1', optionalDependencies: { missing: '1' } },
      'node_modules/unused': { version: '1' },
    },
  };
  expect(Object.keys(reachablePackages(lock, ['a', 'c'])).sort()).toEqual([
    'node_modules/a',
    'node_modules/a/node_modules/b',
    'node_modules/c',
  ]);
});

it.each(['arm64', 'x64'])(
  'keeps the %s terminal binaries, supported grammars and licenses',
  async (arch) => {
    const root = await temporary();
    await nativeAssets(root);
    await pruneRuntimeAssets(root, arch);
    expect(await readdir(join(root, 'node_modules/node-pty/prebuilds'))).toEqual([
      `darwin-${arch}`,
    ]);
    expect(
      (await lstat(join(root, `node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`)))
        .mode & 0o111,
    ).toBeTruthy();
    expect((await readdir(join(root, 'node_modules/tree-sitter-wasms/out'))).sort()).toEqual([
      'tree-sitter-java.wasm',
      'tree-sitter-kotlin.wasm',
    ]);
    expect(await readFile(join(root, 'node_modules/node-pty/LICENSE'), 'utf8')).toBe('fixture');
    expect(await readFile(join(root, 'node_modules/tree-sitter-wasms/LICENSE'), 'utf8')).toBe(
      'fixture',
    );
  },
);

it('replaces an old dependency cache, reuses the new one, and reinstalls when the manifest changes', async () => {
  const root = await temporary();
  const config = await files();
  await put(root, '.dependencies', 'old unfiltered cache');
  vi.mocked(command).mockImplementation(async () => {
    await rm(join(root, 'node_modules'), { recursive: true, force: true });
    await nativeAssets(root);
    return '';
  });
  await installRuntimeDependencies(root, config, 'arm64');
  expect(command).toHaveBeenCalledTimes(1);
  expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(config.manifest);
  expect(await readFile(join(root, 'package-lock.json'), 'utf8')).toBe(config.lock);
  await installRuntimeDependencies(root, config, 'arm64');
  expect(command).toHaveBeenCalledTimes(1);
  const next = {
    ...config,
    manifest: JSON.stringify({ ...JSON.parse(config.manifest), version: '9.9.9' }),
  };
  await installRuntimeDependencies(root, next, 'arm64');
  expect(command).toHaveBeenCalledTimes(2);
});

it('does not mark a failed dependency installation as reusable', async () => {
  const root = await temporary();
  await put(root, '.dependencies', 'old cache');
  vi.mocked(command).mockRejectedValue(new Error('installation failed'));
  await expect(installRuntimeDependencies(root, await files(), 'arm64')).rejects.toThrow(
    'installation failed',
  );
  await expect(readFile(join(root, '.dependencies'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('replaces old UI assets on consecutive builds instead of accumulating hashed bundles', async () => {
  const root = await temporary();
  const source = join(root, 'dist');
  const destination = join(root, 'ui');
  await put(source, 'assets/old.js');
  await copyWebAssets(source, destination);
  await rm(join(source, 'assets/old.js'));
  await put(source, 'assets/current.js');
  await copyWebAssets(source, destination);
  expect(await readdir(join(destination, 'assets'))).toEqual(['current.js']);
});
