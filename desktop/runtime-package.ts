import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import type { Metafile } from 'esbuild';
import { command } from '../server/process.js';
import { t } from '../shared/i18n.js';

interface PackageMetadata {
  name: string;
  version: string;
  license?: string;
  engines?: Record<string, string>;
  overrides?: Record<string, unknown>;
  dependencies: Record<string, string>;
}
interface PackageLock {
  packages: Record<string, { version?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

// These are loaded with createRequire/require.resolve, outside esbuild's import graph.
const dynamicDependencies = ['node-pty', 'tree-sitter-wasms', '@openai/codex'];
const grammarFiles = ['tree-sitter-java.wasm', 'tree-sitter-kotlin.wasm'];
// Bump when expanding retained assets, so an already-pruned cache is reinstalled.
const packagingRevision = 'runtime-2';

type LockedPackage = PackageLock['packages'][string] & {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/**
 * The lock entries a runtime install reaches from its roots. `npm ci` installs every entry of a
 * lock, so unreachable UI and build packages have to be left out of it, not only of the manifest.
 */
export function reachablePackages(lock: PackageLock, roots: string[]) {
  const packages = lock.packages as Record<string, LockedPackage>;
  // Node resolution: the closest node_modules folder up from the requiring package wins.
  const locate = (from: string, name: string) => {
    for (let base = from; ;) {
      const path = `${base ? `${base}/` : ''}node_modules/${name}`;
      if (packages[path]) return path;
      if (!base) return undefined;
      const parent = base.lastIndexOf('/node_modules/');
      base = parent < 0 ? '' : base.slice(0, parent);
    }
  };
  const kept = new Set<string>();
  const visit = (path: string | undefined) => {
    if (!path || kept.has(path)) return;
    kept.add(path);
    const entry = packages[path];
    // Optional and peer packages are kept when locked; npm skips other platforms itself.
    for (const name of Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
      ...entry.peerDependencies,
    }))
      visit(locate(path, name));
  };
  for (const name of roots) visit(locate('', name));
  return Object.fromEntries(Object.entries(packages).filter(([path]) => kept.has(path)));
}

export function runtimePackage(metadata: PackageMetadata, lock: PackageLock, metafile: Metafile) {
  const imports = Object.values(metafile.outputs).flatMap((output) =>
    output.imports
      .filter((entry) => entry.external && !isBuiltin(entry.path))
      .map((entry) => {
        const parts = entry.path.split('/');
        return parts.slice(0, entry.path.startsWith('@') ? 2 : 1).join('/');
      }),
  );
  const dependencies = Object.fromEntries(
    [...new Set([...imports, ...dynamicDependencies])].sort().map((name) => {
      const version = metadata.dependencies[name] ?? lock.packages[`node_modules/${name}`]?.version;
      if (!version) throw new Error(`No locked runtime dependency: ${name}`);
      return [name, version];
    }),
  );
  const manifest = {
    name: metadata.name,
    version: metadata.version,
    private: true,
    type: 'module',
    license: metadata.license,
    engines: metadata.engines,
    dependencies,
    overrides: metadata.overrides,
  };
  // Reachable packages keep their locked version and integrity; only the roots change.
  const runtimeLock = {
    ...lock,
    packages: {
      '': {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license,
        engines: manifest.engines,
        dependencies,
      },
      ...reachablePackages(lock, Object.keys(dependencies)),
    },
  };
  return { manifest: JSON.stringify(manifest), lock: JSON.stringify(runtimeLock) };
}

export async function pruneRuntimeAssets(runtime: string, arch: string) {
  const prebuilds = join(runtime, 'node_modules/node-pty/prebuilds');
  const nativeTarget = `darwin-${arch}`;
  for (const entry of await readdir(prebuilds)) {
    if (entry !== nativeTarget) await rm(join(prebuilds, entry), { recursive: true, force: true });
  }
  const grammars = join(runtime, 'node_modules/tree-sitter-wasms/out');
  for (const entry of await readdir(grammars)) {
    if (entry.endsWith('.wasm') && !grammarFiles.includes(entry)) await rm(join(grammars, entry));
  }
  // npm install scripts are disabled; the shipped helper has no execute bit by default.
  await chmod(join(prebuilds, nativeTarget, 'spawn-helper'), 0o755);
}

export async function installRuntimeDependencies(
  runtime: string,
  files: ReturnType<typeof runtimePackage>,
  arch: string,
) {
  await mkdir(runtime, { recursive: true });
  const fingerprint = createHash('sha256')
    .update(files.manifest)
    .update(files.lock)
    .update(arch)
    .update(packagingRevision)
    .digest('hex');
  const stamp = join(runtime, '.dependencies');
  const previous = await readFile(stamp, 'utf8').catch(() => null);
  if (previous !== fingerprint || !existsSync(join(runtime, 'node_modules'))) {
    await rm(stamp, { force: true });
    await writeFile(join(runtime, 'package.json'), files.manifest);
    await writeFile(join(runtime, 'package-lock.json'), files.lock);
    console.log(t('Installing the local server dependencies…'));
    const args = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
    await command(
      process.env.npm_execpath ? process.execPath : 'npm',
      process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args,
      { cwd: runtime, timeout: 300000 },
    );
  }
  await pruneRuntimeAssets(runtime, arch);
  await writeFile(stamp, fingerprint);
}

export async function copyWebAssets(source: string, destination: string) {
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
}

/** Logical bytes, excluding symlinks so framework links are not counted twice. */
export async function artifactBytes(path: string): Promise<number> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  const sizes = await Promise.all(
    (await readdir(path)).map((name) => artifactBytes(join(path, name))),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

export async function reportArtifactSize(path: string) {
  console.log(`${path}: ${((await artifactBytes(path)) / 1024 / 1024).toFixed(1)} MiB`);
}
