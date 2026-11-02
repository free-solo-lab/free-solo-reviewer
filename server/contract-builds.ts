import { posix } from 'node:path';
import { readSource } from './repository.js';
import type {
  BuildModule,
  BuildTool,
  Contract,
  ContractBuild,
  Evidence,
  Snapshot,
} from '../shared/model.js';

/** Build files that define a module, by file name. */
const buildFiles: [RegExp, BuildTool][] = [
  [/^build\.gradle(\.kts)?$/, 'gradle'],
  [/^pom\.xml$/, 'maven'],
  [/^package\.json$/, 'npm'],
  [/^go\.mod$/, 'go'],
  [/^Cargo\.toml$/, 'cargo'],
  [/^BUILD(\.bazel)?$/, 'bazel'],
  [/\.csproj$/, 'dotnet'],
  [/^pyproject\.toml$/, 'python'],
];
/** Code generators recognised in build files, with the contract formats they build. */
const generators: [RegExp, string, Contract['format'][]][] = [
  [
    /openapi-generator|org\.openapi\.generator/,
    'openapi-generator',
    ['openapi', 'openapi-fragment'],
  ],
  [/swagger-codegen/, 'swagger-codegen', ['openapi', 'openapi-fragment']],
  [
    /openapi-typescript|\borval\b|openapi-fetch/,
    'openapi-typescript',
    ['openapi', 'openapi-fragment'],
  ],
  [
    /com\.google\.protobuf|protobuf-maven-plugin|\bprotoc\b|ts-proto|@bufbuild/,
    'protobuf',
    ['protobuf'],
  ],
  [/\bgrpc\b|grpc-java|protoc-gen-grpc/i, 'gRPC', ['protobuf']],
  [/thrift/i, 'Thrift', ['thrift']],
  [/graphql-codegen|@graphql-codegen|dgs-codegen|apollo/i, 'GraphQL codegen', ['graphql']],
  [/antlr/i, 'ANTLR', ['antlr']],
];
const MAX_BUILD_FILES = 500;

interface Module extends BuildModule {
  text: string;
  /** Names other build files use to depend on this module. */
  refs: RegExp[];
}

/** Adds build structure to contracts: the owning module, its generators and dependent modules. */
export async function attachBuilds(snapshots: Snapshot[], contracts: Contract[]) {
  if (!contracts.length) return;
  const modules = (await Promise.all(snapshots.map(readModules))).flat();
  for (const contract of contracts) contract.build = buildOf(contract, modules);
}

/** Build boundaries reused by views that must distinguish services inside one repository. */
export async function projectModules(snapshot: Snapshot): Promise<BuildModule[]> {
  return (await readModules(snapshot)).map(publicModule);
}

async function readModules(snapshot: Snapshot): Promise<Module[]> {
  const head = new Set(snapshot.headFiles);
  const paths = [...new Set([...snapshot.headFiles, ...snapshot.baseFiles])]
    .filter((path) => !/(^|\/)node_modules\//.test(path) && toolOf(path))
    .slice(0, MAX_BUILD_FILES);
  const modules: Module[] = [];
  for (const path of paths) {
    const side = head.has(path) ? 'head' : 'base';
    let text: string;
    try {
      text = await readSource(snapshot, { side, path });
    } catch {
      continue;
    }
    const tool = toolOf(path)!;
    const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
    // A Gradle module with both build files, or a package.json beside a pom, counts once.
    if (modules.some((module) => module.dir === dir)) continue;
    const name = nameOf(tool, text, dir, snapshot.repoName);
    const evidence: Evidence = { repoId: snapshot.repoId, side, path, startLine: 1, endLine: 1 };
    modules.push({
      repoId: snapshot.repoId,
      dir,
      name,
      tool,
      evidence,
      text,
      refs: refsOf(tool, name, dir),
    });
  }
  return modules;
}
const toolOf = (path: string) =>
  buildFiles.find(([pattern]) => pattern.test(posix.basename(path)))?.[1];

function nameOf(tool: BuildTool, text: string, dir: string, repoName: string) {
  const base = dir ? posix.basename(dir) : repoName;
  const first = (pattern: RegExp) => text.match(pattern)?.[1];
  switch (tool) {
    case 'gradle':
      return dir ? `:${dir.replaceAll('/', ':')}` : repoName;
    case 'maven':
      return ownArtifact(text) || base;
    case 'npm':
      try {
        return (JSON.parse(text) as { name?: string }).name ?? base;
      } catch {
        return base;
      }
    case 'go':
      return first(/^module\s+(\S+)/m) ?? base;
    case 'cargo':
    case 'python':
      return first(/^\s*name\s*=\s*"([^"]+)"/m) ?? base;
    case 'bazel':
      return `//${dir}`;
    case 'dotnet':
      return base;
  }
}
/** The project's own artifactId, outside its parent, dependency and plugin blocks. */
function ownArtifact(text: string) {
  const own = text.replace(
    /<(parent|dependencies|dependencyManagement|build|profiles)>[\s\S]*?<\/\1>/g,
    '',
  );
  return own.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/)?.[1] ?? '';
}

function refsOf(tool: BuildTool, name: string, dir: string): RegExp[] {
  const quoted = escape(name);
  const last = escape(dir ? posix.basename(dir) : name);
  switch (tool) {
    case 'gradle': {
      const accessor = dir
        .split('/')
        .map((part) => part.replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase()))
        .join('.');
      return [
        new RegExp(`project\\(\\s*(?:path\\s*[:=]\\s*)?["']${quoted}["']`),
        ...(accessor ? [new RegExp(`\\bprojects\\.${escape(accessor)}\\b(?!\\.)`)] : []),
        // A published artifact: "group:name:version".
        new RegExp(`["'][\\w.-]+:${last}(?::|["'])`),
      ];
    }
    case 'maven':
      return [
        new RegExp(
          `<dependency>(?:(?!</dependency>)[\\s\\S])*<artifactId>\\s*${quoted}\\s*</artifactId>`,
        ),
        new RegExp(`["'][\\w.-]+:${quoted}(?::|["'])`),
      ];
    case 'npm':
      return [new RegExp(`"${quoted}"\\s*:\\s*"`)];
    case 'go':
      return [new RegExp(`^\\s*(?:require\\s+)?${quoted}\\s+v`, 'm')];
    case 'cargo':
    case 'python':
      return [
        new RegExp(`^\\s*${quoted}\\s*=`, 'm'),
        new RegExp(`["']${quoted}(?:[<>=~!\\[ ]|["'])`),
      ];
    case 'bazel':
      return [new RegExp(`["']${quoted}(?::[\\w.-]+)?["']`)];
    case 'dotnet':
      return [new RegExp(`ProjectReference[^>]*\\b${quoted}\\.csproj`)];
  }
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildOf(contract: Contract, modules: Module[]): ContractBuild {
  const own = modules
    .filter((m) => m.repoId === contract.repoId && within(contract.path, m.dir))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  const found = new Map<Module, ContractBuild['consumers'][number]>();
  const add = (
    module: Module,
    at: number,
    via: 'path' | 'dependency' | 'transitive',
    through?: Module,
  ) => {
    const line = lineAt(module.text, at);
    found.set(module, {
      ...publicModule(module),
      evidence: { ...module.evidence, startLine: line, endLine: line },
      via,
      ...(through && { through: through.name }),
      generators: generatorsIn(module.text, contract.format),
    });
  };
  for (const module of modules) {
    if (module === own) continue;
    const at = module.repoId === contract.repoId ? pathIndex(module, contract.path) : -1;
    const ref = own && at < 0 ? dependencyOn(own, module) : null;
    if (at >= 0) add(module, at, 'path');
    else if (ref) add(module, ref.index!, 'dependency');
  }
  // Modules that build with a consumer get the contract's generated code as well.
  const queue = [...found.keys()];
  for (let target = queue.shift(); target; target = queue.shift())
    for (const module of modules) {
      if (module === own || found.has(module)) continue;
      const ref = dependencyOn(target, module);
      if (!ref) continue;
      add(module, ref.index!, 'transitive', target);
      queue.push(module);
    }
  const consumers = [...found.values()];
  return {
    module: own ? publicModule(own) : null,
    generators: own ? generatorsIn(own.text, contract.format) : [],
    consumers,
  };
}
function dependencyOn(target: Module, module: Module) {
  // A parent module configures its subprojects rather than building with them.
  if (module.repoId === target.repoId && within(target.dir, module.dir)) return null;
  return target.refs.map((pattern) => module.text.match(pattern)).find(Boolean) ?? null;
}
const within = (path: string, dir: string) => !dir || path.startsWith(`${dir}/`);
const publicModule = ({ repoId, dir, name, tool, evidence }: Module): BuildModule => ({
  repoId,
  dir,
  name,
  tool,
  evidence,
});
/** Where the build file names the contract by its path from the repository root or the module. */
function pathIndex(module: Module, path: string) {
  for (const candidate of [path, posix.relative(module.dir || '.', path)]) {
    const index = module.text.indexOf(candidate);
    if (index >= 0 && candidate.includes('/')) return index;
  }
  return -1;
}
const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;
function generatorsIn(text: string, format: Contract['format']) {
  return generators
    .filter(([pattern, , formats]) => formats.includes(format ?? 'openapi') && pattern.test(text))
    .map(([, label]) => label);
}
