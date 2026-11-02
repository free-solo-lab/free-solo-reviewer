import { realpath, mkdir, writeFile, lstat, readFile } from 'node:fs/promises';
import { basename, join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, AppError } from './process.js';
import { githubSlug, type GitHubGateway } from './github.js';
import type { ChangedFile, Evidence, Repository, Snapshot } from '../shared/model.js';

export async function connectRepository(path: string): Promise<Repository> {
  const root = await realpath(path);
  const top = await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim());
  const slug = githubSlug(await git(top, ['remote', 'get-url', 'origin']));
  return { id: randomUUID(), path: top, name: basename(top), slug };
}
export const isSha = (s: string) => /^[a-f0-9]{40,64}$/.test(s);
const allowed =
  /\.(java|kt|kts|sql|xml|ya?ml|jsonc?|properties|gradle|groovy|proto|graphql|gql|md|txt|[cm]?jsx?|tsx?|html?|css|scss|py|sh|bash|zsh|go|rs|toml|ini|cs|c|h|cpp|hpp|cc|swift|rb|php|svg)$/i;
const excluded =
  /(^|\/)(\.git|\.env[^/]*|node_modules|target|build|dist|vendor|credentials[^/]*|secrets?[^/]*)(\/|$)|(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$|(?:private.?key|keystore)|\.(pem|p12|jks|key)$/i;
export function safePath(root: string, path: string): string {
  if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path))
    throw new AppError('Недопустимый путь.');
  const dest = resolve(root, path);
  const rel = relative(root, dest);
  if (rel === '..' || rel.startsWith('../') || !rel)
    throw new AppError('Путь выходит за пределы снимка.');
  return dest;
}
async function materialize(repo: Repository, sha: string, dest: string) {
  if (!isSha(sha)) throw new AppError('Некорректный commit SHA.');
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const tree = (await git(repo.path, ['ls-tree', '-rlz', sha])).split('\0').filter(Boolean);
  const entries: { path: string; size: number }[] = [];
  let total = 0;
  for (const entry of tree) {
    const match = /^(\d+) blob [a-f0-9]+\s+(\d+)\t([\s\S]+)$/.exec(entry);
    if (
      !match ||
      match[1] === '120000' ||
      !(allowed.test(match[3]) || /(^|\/)Dockerfile(?:\.[^/]+)?$/i.test(match[3])) ||
      excluded.test(match[3])
    )
      continue;
    const size = Number(match[2]);
    if (size > 1_000_000) continue;
    total += size;
    entries.push({ path: match[3], size });
  }
  if (entries.length > 6000 || total > 64_000_000)
    throw new AppError(
      'Снимок превышает лимит: 6000 текстовых файлов или 64 MB. Выберите меньший репозиторий.',
    );
  const files: string[] = [];
  for (let i = 0; i < entries.length; i += 16) {
    const results = await Promise.allSettled(
      entries.slice(i, i + 16).map(async (e) => {
        const text = await git(repo.path, ['show', `${sha}:${e.path}`]);
        if (text.includes('\0')) return;
        const path = safePath(dest, e.path);
        await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
        await writeFile(path, text, { mode: 0o400 });
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
  let old = 0,
    next = 0,
    inHunk = false;
  for (const line of patch.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      old = Number(m[1]);
      next = Number(m[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      addedLines.push(next++);
    } else if (line.startsWith('-')) {
      removedLines.push(old++);
    } else if (line.startsWith(' ')) {
      old++;
      next++;
    }
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
  const files: ChangedFile[] = [];
  for (const change of changes) {
    const patch = await git(repo.path, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      '-U4',
      base,
      head,
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
  return {
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
}
export async function readSource(
  snapshot: Snapshot,
  evidence: Pick<Evidence, 'side' | 'path'>,
): Promise<string> {
  const files = evidence.side === 'head' ? snapshot.headFiles : snapshot.baseFiles;
  if (!files.includes(evidence.path)) throw new AppError('Файл отсутствует в снимке.', 404);
  const root = await realpath(evidence.side === 'head' ? snapshot.headDir : snapshot.baseDir);
  const path = safePath(root, evidence.path);
  if (!(await lstat(path)).isFile()) throw new AppError('Ожидался обычный файл.');
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
