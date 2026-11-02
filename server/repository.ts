import { realpath, mkdir, writeFile, lstat, readFile } from 'node:fs/promises';
import { basename, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { git, AppError, CommandError, SAFE_GIT_CONFIG } from './process.js';
import { githubRemoteSlug, type GitHubGateway } from './github.js';
import type {
  ChangedFile,
  Evidence,
  Repository,
  RepositoryBranches,
  Snapshot,
} from '../shared/model.js';
import { patchLines } from '../shared/patch.js';
import { t } from '../shared/i18n.js';

export async function connectRepository(path: string): Promise<Repository> {
  const root = await realpath(path);
  const top = await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim());
  let slug = `local/${basename(top)}`;
  try {
    slug = await githubRemoteSlug(await git(top, ['remote', 'get-url', 'origin']));
  } catch {
    /* Local review needs no remote. */
  }
  return { id: randomUUID(), path: top, name: basename(top), slug };
}
/** Prefer the tracked primary branch; HEAD must be an explicit working-copy-only choice. */
export async function defaultLocalBase(repo: Repository): Promise<string> {
  try {
    const primary = (
      await git(repo.path, [
        'symbolic-ref',
        '--quiet',
        '--short',
        'refs/remotes/origin/HEAD',
      ]).catch(() => '')
    ).trim();
    if (primary.startsWith('origin/')) return primary;
    const refs = (
      await git(repo.path, [
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads/main',
        'refs/heads/master',
        'refs/remotes/origin/main',
        'refs/remotes/origin/master',
      ])
    )
      .trim()
      .split('\n');
    return (
      ['origin/main', 'origin/master', 'main', 'master'].find((ref) => refs.includes(ref)) ?? 'HEAD'
    );
  } catch {
    return 'HEAD';
  }
}
/** Branches to compare with, most recently changed first; remote HEAD aliases are left out. */
export async function localBranches(repo: Repository): Promise<RepositoryBranches> {
  const refs = await git(repo.path, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
  ]);
  const current = (
    await git(repo.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
  ).trim();
  const branches: RepositoryBranches = { current: current || null, local: [], remote: [] };
  for (const ref of refs.split('\n')) {
    if (ref.startsWith('refs/heads/')) branches.local.push(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD'))
      branches.remote.push(ref.slice('refs/remotes/'.length));
  }
  return branches;
}
export async function refreshRemoteBase(repo: Repository, baseRef: string) {
  if (!baseRef.startsWith('origin/')) return;
  const branch = baseRef.slice('origin/'.length);
  await git(repo.path, ['check-ref-format', `refs/heads/${branch}`]);
  // Update only the remote-tracking ref; never checkout, merge, or edit the working tree.
  await git(repo.path, [
    'fetch',
    '--no-tags',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
}
export const isSha = (s: string) => /^[a-f0-9]{40,64}$/.test(s);
const allowed =
  /\.(java|kt|kts|sql|xml|ya?ml|jsonc?|properties|gradle|groovy|proto|thrift|g4|graphql|gql|md|txt|[cm]?jsx?|tsx?|html?|css|scss|py|sh|bash|zsh|go|rs|toml|ini|cs|c|h|cpp|hpp|cc|swift|rb|php|svg)$/i;
const excluded =
  /(^|\/)(\.git|\.codex|\.aws|\.ssh|\.review|\.env[^/]*|auth\.json|node_modules|target|build|dist|vendor|credentials[^/]*|secrets?[^/]*)(\/|$)|(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$|(?:private.?key|keystore)|\.(pem|p12|jks|key)$/i;
export function safePath(root: string, path: string): string {
  if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path))
    throw new AppError(t('Invalid path.'));
  const dest = resolve(root, path);
  const rel = relative(root, dest);
  if (rel === '..' || rel.startsWith('../') || !rel)
    throw new AppError(t('The path leaves the snapshot.'));
  return dest;
}
/** Reads blobs through one `git cat-file --batch` process instead of one process per file. */
async function readBlobs(cwd: string, oids: string[]): Promise<Buffer[]> {
  if (!oids.length) return [];
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', [...SAFE_GIT_CONFIG, 'cat-file', '--batch'], {
      cwd,
      timeout: 120_000,
    });
    const chunks: Buffer[] = [],
      errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const stderr = Buffer.concat(errors).toString();
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new CommandError(`git: ${stderr.trim().slice(0, 1500)}`, '', stderr));
    });
    child.stdin.end(oids.map((oid) => `${oid}\n`).join(''));
  });
  const blobs: Buffer[] = [];
  let offset = 0;
  for (const oid of oids) {
    const end = output.indexOf(10, offset);
    const [, type, size] = output.toString('utf8', offset, end).split(' ');
    if (type !== 'blob') throw new AppError(t('Git did not return file {0}.', oid), 502);
    blobs.push(output.subarray(end + 1, end + 1 + Number(size)));
    offset = end + 1 + Number(size) + 1;
  }
  return blobs;
}
async function materialize(repo: Repository, sha: string, dest: string) {
  if (!isSha(sha)) throw new AppError(t('Invalid commit SHA.'));
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const tree = (await git(repo.path, ['ls-tree', '-rlz', sha])).split('\0').filter(Boolean);
  const entries: { path: string; oid: string; size: number }[] = [];
  let total = 0;
  for (const entry of tree) {
    const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(entry);
    if (
      !match ||
      match[1] === '120000' ||
      !(allowed.test(match[4]) || /(^|\/)Dockerfile(?:\.[^/]+)?$/i.test(match[4])) ||
      excluded.test(match[4])
    )
      continue;
    const size = Number(match[3]);
    if (size > 1_000_000) continue;
    total += size;
    entries.push({ path: match[4], oid: match[2], size });
  }
  if (entries.length > 6000 || total > 64_000_000)
    throw new AppError(
      t('The snapshot exceeds the limit: 6000 text files or 64 MB. Choose a smaller repository.'),
    );
  const blobs = await readBlobs(
    repo.path,
    entries.map((e) => e.oid),
  );
  const files: string[] = [];
  for (let i = 0; i < entries.length; i += 16) {
    const results = await Promise.allSettled(
      entries.slice(i, i + 16).map(async (e, j) => {
        const blob = blobs[i + j];
        if (blob.includes(0)) return;
        const path = safePath(dest, e.path);
        await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
        await writeFile(path, blob.toString('utf8'), { mode: 0o400 });
        files.push(e.path);
      }),
    );
    for (const r of results) if (r.status === 'rejected') throw r.reason;
  }
  return files.sort();
}
export function parsePatch(patch: string): Pick<ChangedFile, 'addedLines' | 'removedLines'> {
  const addedLines: number[] = [],
    removedLines: number[] = [];
  for (const line of patchLines(patch)) {
    if (line.kind === 'addition') addedLines.push(line.newLine);
    else if (line.kind === 'deletion') removedLines.push(line.oldLine);
  }
  return { addedLines, removedLines };
}
export async function changedFiles(repo: Repository, base: string, head: string) {
  const parts = (
    await git(repo.path, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-status',
      '-z',
      '--find-renames',
      base,
      head,
      '--',
    ])
  ).split('\0');
  const changes: { status: string; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < parts.length && parts[i];) {
    const status = parts[i++];
    const first = parts[i++];
    if (status.startsWith('R') || status.startsWith('C'))
      changes.push({ status, path: parts[i++], oldPath: first });
    else changes.push({ status, path: first });
  }
  const diff = ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '-U4', base, head];
  // One diff for the change set; per-file diffs remain for headers that git quotes or splits.
  const sections = (await git(repo.path, [...diff, '--']).catch(() => ''))
    .split(/^(?=diff --git )/m)
    .filter(Boolean);
  const whole =
    sections.length === changes.length &&
    changes.every((change, i) =>
      sections[i].startsWith(`diff --git a/${change.oldPath ?? change.path} b/${change.path}\n`),
    );
  const files: ChangedFile[] = [];
  for (const [i, change] of changes.entries()) {
    const patch = whole
      ? sections[i]
      : await git(repo.path, [
          ...diff,
          '--',
          ...(change.oldPath ? [change.oldPath] : []),
          change.path,
        ]);
    files.push({ ...change, patch, ...parsePatch(patch) });
  }
  return files;
}
export async function createSnapshot(
  repo: Repository,
  prNumber: number | null,
  root: string,
  github: GitHubGateway,
): Promise<Snapshot> {
  const pr = prNumber ? await github.pull(repo.slug, prNumber) : null;
  let headSha: string, baseSha: string, mergeBase: string;
  if (pr) {
    // Fetch the actual remote objects without changing any local branch or checkout.
    await git(repo.path, [
      'fetch',
      '--no-tags',
      'origin',
      `refs/pull/${pr.number}/head`,
      pr.baseRefName,
    ]);
    headSha = pr.headRefOid;
    baseSha = pr.baseRefOid;
    for (const sha of [headSha, baseSha]) {
      try {
        await git(repo.path, ['cat-file', '-e', `${sha}^{commit}`]);
      } catch {
        await git(repo.path, ['fetch', '--no-tags', 'origin', sha]);
      }
    }
    mergeBase = (await git(repo.path, ['merge-base', baseSha, headSha])).trim();
  } else {
    headSha = (await git(repo.path, ['rev-parse', 'HEAD'])).trim();
    baseSha = headSha;
    mergeBase = headSha;
  }
  const id = randomUUID();
  const baseDir = join(root, id, 'base'),
    headDir = join(root, id, 'head');
  const baseFiles = await materialize(repo, mergeBase, baseDir);
  const headFiles = await materialize(repo, headSha, headDir);
  const files = pr ? await changedFiles(repo, mergeBase, headSha) : [];
  const snapshot: Snapshot = {
    id,
    repoId: repo.id,
    repoName: repo.name,
    slug: repo.slug,
    pr,
    headSha,
    baseSha,
    mergeBase,
    baseDir,
    headDir,
    baseFiles,
    headFiles,
    files,
  };
  await snapshotContent(snapshot);
  return snapshot;
}
export const contentFingerprint = (sources: Map<string, string>) =>
  createHash('sha256')
    .update(JSON.stringify([...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
    .digest('hex');
/** Materialized files are immutable. Transport/commit changes do not invalidate their analysis. */
export async function snapshotContent(snapshot: Snapshot) {
  for (const side of ['head', 'base'] as const) {
    const field = side === 'head' ? 'contentHash' : 'baseContentHash';
    if (snapshot[field]) continue;
    const sources = new Map<string, string>();
    const paths = side === 'head' ? snapshot.headFiles : snapshot.baseFiles;
    for (let i = 0; i < paths.length; i += 32)
      for (const [path, text] of await Promise.all(
        paths
          .slice(i, i + 32)
          .map(async (path) => [path, await readSource(snapshot, { path, side })] as const),
      ))
        sources.set(path, text);
    snapshot[field] = contentFingerprint(sources);
  }
  return snapshot;
}
/** Read only regular, reviewable working files; never follow symlinks or include ignored secrets. */
export async function workingSources(repo: Repository) {
  const root = await realpath(repo.path);
  const paths = [
    ...new Set(
      (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  const sources = new Map<string, string>();
  let total = 0;
  for (const path of paths) {
    if (!(allowed.test(path) || /(^|\/)Dockerfile(?:\.[^/]+)?$/i.test(path)) || excluded.test(path))
      continue;
    const file = safePath(root, path);
    let stat;
    try {
      stat = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.size > 1_000_000) continue;
    const actual = await realpath(file);
    safePath(root, relative(root, actual));
    const text = await readFile(actual, 'utf8');
    if (text.includes('\0')) continue;
    total += Buffer.byteLength(text);
    if (sources.size >= 6000 || total > 64_000_000)
      throw new AppError(t('The working folder exceeds the snapshot limit: 6000 files or 64 MB.'));
    sources.set(path, text);
  }
  const headCommit = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
  return { sources, headCommit, fingerprint: sourcesFingerprint(headCommit, sources) };
}
/** One hash of the commit and every tracked text file: any edit in the folder changes it. */
export const sourcesFingerprint = (headCommit: string, sources: Map<string, string>) =>
  createHash('sha256')
    .update(JSON.stringify([headCommit, [...sources]]))
    .digest('hex');

/** Freeze local source in a separate object store without changing the working branch or user's index. */
export async function createLocalSnapshot(
  repo: Repository,
  baseRef: string,
  root: string,
  refreshBase = true,
  pinned?: { branchName?: string; baseCommit?: string },
): Promise<Snapshot> {
  if (refreshBase) await refreshRemoteBase(repo, baseRef);
  const currentBranch = (
    await git(repo.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
  ).trim();
  const detached = !!pinned?.branchName && pinned.branchName !== currentBranch;
  const headCommit = (
    await git(repo.path, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      detached ? `refs/heads/${pinned!.branchName}^{commit}` : 'HEAD',
    ])
  ).trim();
  const baseSha = (
    await git(repo.path, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${baseRef === 'HEAD' && pinned?.baseCommit ? pinned.baseCommit : baseRef}^{commit}`,
    ])
  ).trim();
  const mergeBase = (await git(repo.path, ['merge-base', baseSha, headCommit])).trim();
  const id = randomUUID(),
    baseDir = join(root, id, 'base'),
    headDir = join(root, id, 'head');
  const baseFiles = await materialize(repo, mergeBase, baseDir);
  const working = detached
    ? await (async () => {
        const paths = await materialize(repo, headCommit, headDir);
        const sources = new Map(
          await Promise.all(
            paths.map(
              async (path) => [path, await readFile(safePath(headDir, path), 'utf8')] as const,
            ),
          ),
        );
        return { headCommit, sources, fingerprint: sourcesFingerprint(headCommit, sources) };
      })()
    : await workingSources(repo);
  if (working.headCommit !== headCommit)
    throw new AppError(t('The branch changed during loading. Load again.'), 409);
  await mkdir(headDir, { recursive: true, mode: 0o700 });
  if (!detached)
    for (const [path, text] of working.sources) {
      const dest = safePath(headDir, path);
      await mkdir(resolve(dest, '..'), { recursive: true, mode: 0o700 });
      await writeFile(dest, text, { mode: 0o400 });
    }
  const gitDir = resolve(root, '..', 'local-git', repo.id);
  await mkdir(gitDir, { recursive: true, mode: 0o700 });
  await git(gitDir, ['init', '--bare', '--quiet']);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: resolve(root, id, 'index'),
    GIT_AUTHOR_NAME: 'Local review',
    GIT_AUTHOR_EMAIL: 'review@localhost',
    GIT_COMMITTER_NAME: 'Local review',
    GIT_COMMITTER_EMAIL: 'review@localhost',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  const commit = async (dir: string, parent?: string) => {
    await git(gitDir, ['read-tree', '--empty'], { env });
    await git(
      gitDir,
      ['-c', 'core.bare=false', `--work-tree=${dir}`, 'add', '-f', '-A', '--', '.'],
      { env },
    );
    const tree = (await git(gitDir, ['write-tree'], { env })).trim();
    return (
      await git(
        gitDir,
        ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Local review snapshot'],
        { env },
      )
    ).trim();
  };
  const localBase = await commit(baseDir),
    headSha = await commit(headDir, localBase);
  const files = await changedFiles({ ...repo, path: gitDir }, localBase, headSha);
  const snapshot: Snapshot = {
    id,
    repoId: repo.id,
    repoName: repo.name,
    slug: repo.slug,
    pr: null,
    baseSha: localBase,
    mergeBase: localBase,
    headSha,
    baseDir,
    headDir,
    baseFiles,
    headFiles: [...working.sources.keys()],
    files,
    local: {
      branchName:
        pinned?.branchName ??
        (
          await git(repo.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() =>
            headCommit.slice(0, 7),
          )
        ).trim(),
      baseRef,
      baseCommit: baseSha,
      headCommit,
      fingerprint: working.fingerprint,
      gitDir,
    },
  };
  snapshot.contentHash = contentFingerprint(working.sources);
  await snapshotContent(snapshot);
  return snapshot;
}

export async function readSource(
  snapshot: Snapshot,
  evidence: Pick<Evidence, 'side' | 'path'>,
): Promise<string> {
  const files = evidence.side === 'head' ? snapshot.headFiles : snapshot.baseFiles;
  if (!files.includes(evidence.path))
    throw new AppError(t('The file is missing in the snapshot.'), 404);
  const root = await realpath(evidence.side === 'head' ? snapshot.headDir : snapshot.baseDir);
  const path = safePath(root, evidence.path);
  if (!(await lstat(path)).isFile()) throw new AppError(t('A regular file was expected.'));
  // realpath also guards against a symlink introduced after snapshot creation.
  const actual = await realpath(path);
  safePath(root, relative(root, actual));
  return readFile(path, 'utf8');
}
export function inlineLocation(
  snapshot: Snapshot,
  evidence: Evidence,
): { path: string; line: number; side: 'LEFT' | 'RIGHT' } | null {
  const file = snapshot.files.find((f) =>
    evidence.side === 'base' ? (f.oldPath ?? f.path) === evidence.path : f.path === evidence.path,
  );
  if (!file || evidence.repoId !== snapshot.repoId) return null;
  const line = evidence.startLine;
  if (!(evidence.side === 'head' ? file.addedLines : file.removedLines).includes(line)) return null;
  return { path: file.path, line, side: evidence.side === 'head' ? 'RIGHT' : 'LEFT' };
}
