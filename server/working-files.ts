import { workingSources, contentFingerprint } from './repository.js';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type { Repository, Snapshot } from '../shared/model.js';
import { AppError, git } from './process.js';
import { safePath } from './repository.js';
import { wrongBranchMessage } from '../shared/code-edits.js';
import { errorMessage } from '../shared/errors.js';
import { t } from '../shared/i18n.js';

const MAX_SIZE = 1_000_000;
const writes = new Map<string, Promise<unknown>>();
export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * A file of the repository's working folder that the reviewer may edit: a regular text file that
 * Git tracks or would track, inside the folder, in a local review or a PR checked out there.
 */
async function workingFile(repo: Repository, snapshot: Snapshot, path: string) {
  const root = await realpath(repo.path);
  if (snapshot.local?.branchName) {
    const branch = (
      await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
    ).trim();
    if (branch !== snapshot.local.branchName)
      throw new AppError(wrongBranchMessage(snapshot.local.branchName), 409);
  }
  if (!snapshot.local) {
    const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (
      head !== (snapshot.working?.headCommit ?? snapshot.workspaceHead ?? snapshot.headSha) &&
      contentFingerprint((await workingSources(repo)).sources) !== snapshot.contentHash
    )
      throw new AppError(wrongBranchMessage(snapshot.pr?.headRefName ?? 'PR'), 409);
  }
  const file = safePath(root, path);
  const listed = (
    await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', path])
  )
    .split('\0')
    .includes(path);
  if (!listed)
    throw new AppError(t('The file is not in the working folder or is ignored by Git.'), 404);
  const stat = await lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink())
    throw new AppError(t('Only a regular file can be edited.'), 400);
  if (stat.size > MAX_SIZE)
    throw new AppError(t('The file is larger than 1 MB; edit it in your IDE.'), 413);
  // A link earlier in the path must not lead outside the folder.
  safePath(root, relative(root, await realpath(file)));
  return file;
}

/**
 * Puts the working folder on the PR branch at the reviewed commit. It never discards work:
 * uncommitted changes or a local branch that went its own way stop it with an explanation.
 */
export async function checkoutPullRequest(repo: Repository, snapshot: Snapshot) {
  const pr = snapshot.pr;
  if (!pr) throw new AppError(t('Switching branches is available only in a PR review.'), 400);
  const root = await realpath(repo.path);
  const branch = pr.headRefName;
  const sha = snapshot.headSha;
  // The name comes from GitHub; it must be a valid branch name, never an option.
  await git(root, ['check-ref-format', '--branch', branch]).catch(() => {
    throw new AppError(t('Invalid PR branch name: {0}', branch), 400);
  });
  if ((await git(root, ['rev-parse', '--verify', 'HEAD'])).trim() === sha) return { branch };
  if ((await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim())
    throw new AppError(
      t(
        'The working folder has uncommitted changes. Commit or remove them, then switch the branch.',
      ),
      409,
    );
  try {
    await git(root, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    await git(root, ['fetch', '--no-tags', 'origin', `refs/pull/${pr.number}/head`]);
  }
  const local = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    .then((out) => out.trim())
    .catch(() => '');
  try {
    if (!local) await git(root, ['switch', '-c', branch, sha]);
    else {
      // Only move the local branch forward to the PR commit; its own commits stay.
      const behind = await git(root, ['merge-base', '--is-ancestor', local, sha])
        .then(() => true)
        .catch(() => false);
      if (!behind)
        throw new AppError(
          t('The local branch {0} diverges from the PR. Switch it manually.', branch),
          409,
        );
      await git(root, ['switch', branch]);
      if (local !== sha) await git(root, ['merge', '--ff-only', sha]);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(t('Could not switch to branch {0}: {1}', branch, errorMessage(error)), 409);
  }
  return { branch };
}

export async function readWorkingFile(repo: Repository, snapshot: Snapshot, path: string) {
  const text = await readFile(await workingFile(repo, snapshot, path), 'utf8');
  if (text.includes('\0')) throw new AppError(t('A binary file cannot be edited.'), 400);
  return { content: text, hash: contentHash(text) };
}

/** Saves only over the version the editor loaded, so edits made elsewhere are never lost. */
export async function writeWorkingFile(
  repo: Repository,
  snapshot: Snapshot,
  path: string,
  hash: string,
  content: string,
) {
  if (content.includes('\0')) throw new AppError(t('Invalid file content.'));
  if (Buffer.byteLength(content) > MAX_SIZE)
    throw new AppError(t('The file is larger than 1 MB.'), 413);
  const file = await workingFile(repo, snapshot, path);
  const previous = writes.get(file) ?? Promise.resolve();
  const writing = previous
    .catch(() => {})
    .then(async () => {
      const previous = await readFile(file, 'utf8');
      if (contentHash(previous) !== hash)
        throw new AppError(
          t(
            'The file changed in the working folder. Autosave stopped to keep the external edits. Copy your text and open the file again.',
          ),
          409,
        );
      await writeFile(file, content);
      return { hash: contentHash(content), previous };
    });
  writes.set(file, writing);
  try {
    return await writing;
  } finally {
    if (writes.get(file) === writing) writes.delete(file);
  }
}
