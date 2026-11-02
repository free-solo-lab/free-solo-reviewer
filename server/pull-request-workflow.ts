import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullRequestPreview } from '../shared/pull-request-workflow.js';
import type { Snapshot } from '../shared/model.js';
import { ensureReviewWorkflow } from '../shared/review-workflow.js';
import { fileViewScope } from '../shared/viewed-files.js';
import { t } from '../shared/i18n.js';
import { AppError, git } from './process.js';
import {
  changedFiles,
  workingSources,
  readSource,
  createSnapshot,
  contentFingerprint,
} from './repository.js';
import { GitHubApiError, type GitHubGateway } from './github.js';
import { Store } from './store.js';
import { snapshotDiff } from './snapshot-diff.js';

/** Publication uses a separate branch/index: unrelated working and staged files stay local. */
export class PullRequestWorkflow {
  constructor(
    private store: Store,
    private github: GitHubGateway,
    private dataDir: string,
  ) {}
  private context(sessionId: string, repoId: string) {
    const session = this.store.session(sessionId),
      repo = this.store.repository(repoId);
    const snapshot = session?.snapshots.find((s) => s.repoId === repoId);
    if (!session || !repo || !snapshot) throw new AppError(t('Repository not found.'), 404);
    return { session, repo, snapshot };
  }
  async prepare(sessionId: string, repoId: string): Promise<PullRequestPreview> {
    const { session, repo, snapshot } = this.context(sessionId, repoId);
    if ((!snapshot.local && !snapshot.working) || repo.slug.startsWith('local/'))
      throw new AppError(t('A local review with a GitHub remote is required.'), 400);
    const existing = this.store
      .pullRequestPreviews(sessionId)
      .find((p) => p.repoId === repoId && p.snapshotId === snapshot.id && p.state !== 'complete');
    if (existing) return existing;
    const initial =
      ensureReviewWorkflow(session).initial.snapshots.find((s) => s.repoId === repoId) ?? snapshot;
    if (!initial.local && !snapshot.pr)
      throw new AppError(t('The initial local base is unavailable.'), 409);
    const base = snapshot.pr?.baseRefName ?? initial.local!.baseRef.replace(/^origin\//, '');
    if (base === 'HEAD')
      throw new AppError(t('Choose the project base branch before creating a PR.'), 409);
    await git(repo.path, ['check-ref-format', `refs/heads/${base}`]);
    const parent = snapshot.pr
      ? snapshot.pr.headRefOid
      : (
          await git(repo.path, ['merge-base', initial.local!.baseCommit, initial.local!.headCommit])
        ).trim();
    const published = snapshot.pr
      ? await createSnapshot(repo, snapshot.pr.number, join(this.dataDir, 'snapshots'), this.github)
      : undefined;
    if (published?.pr?.state && published.pr.state !== 'open')
      throw new AppError(t('The PR is already closed.'), 409);
    if (published && published.headSha !== parent)
      throw new AppError(t('The publication branch changed. Nothing was overwritten.'), 409);
    const files = published
      ? await snapshotDiff(published, snapshot)
      : await changedFiles(
          { ...repo, path: snapshot.local!.gitDir },
          initial.mergeBase,
          snapshot.headSha,
        );
    if (!files.length) throw new AppError(t('There are no reviewed code changes to publish.'), 409);
    const working = await workingSources(repo);
    if (contentFingerprint(working.sources) !== snapshot.contentHash)
      throw new AppError(
        t('The working folder changed. Refresh the review before publishing.'),
        409,
      );
    const id = randomUUID();
    const fixed =
      this.store
        .fixChat(sessionId)
        ?.completedSteps?.filter((s) => s.repoId === repoId && !s.skipped) ?? [];
    const body = [
      session.run?.result.summary ?? session.title,
      ...(fixed.length ? [t('Completed fixes'), ...fixed.map((s) => `- ${s.body}`)] : []),
    ].join('\n\n');
    const preview: PullRequestPreview = {
      id,
      existingPr: snapshot.pr?.number,
      sessionId,
      repoId,
      snapshotId: snapshot.id,
      branch:
        snapshot.pr?.headRefName ??
        `reviewer/${(snapshot.local?.branchName ?? 'changes').replace(/[^\w/-]/g, '-')}-${id.slice(0, 8)}`,
      base,
      title: session.title,
      body,
      files: files.flatMap((f) =>
        f.oldPath && f.oldPath !== f.path ? [f.oldPath, f.path] : [f.path],
      ),
      fingerprint: working.fingerprint,
      parent,
      state: 'prepared',
    };
    this.store.savePullRequestPreview(preview);
    return preview;
  }
  async create(sessionId: string, id: string, title: string, body: string) {
    const preview = this.store.pullRequestPreview(id);
    if (!preview || preview.sessionId !== sessionId)
      throw new AppError(t('The PR preview is unavailable.'), 404);
    const { session, repo, snapshot } = this.context(sessionId, preview.repoId);
    if (!this.github.createPullRequest || !this.github.findPullRequest)
      throw new AppError(t('PR publication is unavailable.'), 501);
    if (preview.state === 'complete') return { session, preview };
    if (preview.state === 'prepared') {
      if (
        snapshot.id !== preview.snapshotId ||
        (await workingSources(repo)).fingerprint !== preview.fingerprint
      )
        throw new AppError(
          t('The working folder changed. Refresh the review before publishing.'),
          409,
        );
      preview.title = title;
      preview.body = body;
      this.store.savePullRequestPreview(preview);
      const temp = await mkdtemp(join(tmpdir(), 'reviewer-publish-'));
      const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index') };
      try {
        await git(repo.path, ['read-tree', preview.parent], { env });
        for (const path of preview.files) {
          if (!snapshot.headFiles.includes(path)) {
            await git(repo.path, ['update-index', '--force-remove', '--', path], { env });
            continue;
          }
          const text = await readSource(snapshot, { side: 'head', path });
          const blob = (
            await git(repo.path, ['hash-object', '-w', '--stdin'], { input: text, env })
          ).trim();
          const entry = (await git(repo.path, ['ls-tree', preview.parent, '--', path])).trim();
          const mode = entry.startsWith('100755') ? '100755' : '100644';
          await git(repo.path, ['update-index', '--add', '--cacheinfo', mode, blob, path], { env });
        }
        const tree = (await git(repo.path, ['write-tree'], { env })).trim();
        preview.commit = (
          await git(repo.path, ['commit-tree', tree, '-p', preview.parent], {
            env,
            input: preview.title + '\n',
          })
        ).trim();
        // Persist the commit before exposing the branch, so retry uses exactly this source.
        preview.state = 'committed';
        this.store.savePullRequestPreview(preview);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
    if (preview.state === 'committed') {
      if (preview.existingPr) {
        const remote = await this.github.pull(repo.slug, preview.existingPr);
        if (remote.state && remote.state !== 'open')
          throw new AppError(t('The PR is already closed.'), 409);
        if (remote.headRefOid !== preview.parent && remote.headRefOid !== preview.commit)
          throw new AppError(t('The publication branch changed. Nothing was overwritten.'), 409);
      }
      const ref = `refs/reviewer-publications/${preview.id}`;
      const current = (await git(repo.path, ['rev-parse', '--verify', ref]).catch(() => '')).trim();
      if (current && current !== preview.commit)
        throw new AppError(t('The publication branch changed. Nothing was overwritten.'), 409);
      if (!current) await git(repo.path, ['update-ref', ref, preview.commit!, '0'.repeat(40)]);
      // Never force-push. Retrying an already accepted push is a no-op.
      await git(repo.path, ['push', 'origin', `${ref}:refs/heads/${preview.branch}`]);
      preview.state = 'pushed';
      this.store.savePullRequestPreview(preview);
    }
    const marker = `<!-- reviewer-publication:${preview.id} -->`;
    let pr = preview.existingPr
      ? await this.github.pull(repo.slug, preview.existingPr)
      : await this.github.findPullRequest(repo.slug, preview.branch, preview.base);
    if (pr && !preview.existingPr && !pr.body.includes(marker))
      throw new AppError(t('This branch already has a different PR. Nothing was duplicated.'), 409);
    if (!pr) {
      if (preview.state === 'uncertain')
        throw new AppError(
          t('GitHub has not confirmed the previous publication yet. Check again before retrying.'),
          409,
        );
      preview.state = 'uncertain';
      this.store.savePullRequestPreview(preview);
      try {
        pr = await this.github.createPullRequest(repo.slug, {
          head: preview.branch,
          base: preview.base,
          title: preview.title,
          body: preview.body + '\n\n' + marker,
        });
      } catch (error) {
        if (
          error instanceof GitHubApiError &&
          error.httpStatus >= 400 &&
          error.httpStatus < 500 &&
          ![408, 429].includes(error.httpStatus)
        ) {
          preview.state = 'pushed';
          this.store.savePullRequestPreview(preview);
        }
        throw error;
      }
      preview.pullRequest = pr;
      this.store.savePullRequestPreview(preview);
    }
    if (pr.headRefOid !== preview.commit)
      throw new AppError(t('The published code differs from the reviewed version.'), 409);
    const remote = await createSnapshot(
      repo,
      pr.number,
      join(this.dataDir, 'snapshots'),
      this.github,
    );
    // Keep the project and immutable local history. Publication alone never calls Codex.
    remote.reviewLineage = snapshot.reviewLineage;
    const checkout = await workingSources(repo);
    if (contentFingerprint(checkout.sources) === remote.contentHash)
      remote.workspaceHead = checkout.headCommit;
    const fresh = this.store.session(sessionId)!;
    ensureReviewWorkflow(fresh).versions.push(snapshot);
    fresh.snapshots = fresh.snapshots.map((s) => (s.repoId === repo.id ? remote : s));
    this.transferMarks(sessionId, snapshot, remote);
    for (const draft of this.store.drafts(sessionId).filter((d) => d.snapshotId === snapshot.id))
      this.store.saveDraft({ ...draft, snapshotId: remote.id, headSha: remote.headSha });
    this.store.saveSession(fresh);
    preview.state = 'complete';
    preview.pullRequest = pr;
    this.store.savePullRequestPreview(preview);
    return { session: fresh, preview };
  }
  private transferMarks(sessionId: string, before: Snapshot, after: Snapshot) {
    const oldScope = fileViewScope(before, sessionId),
      scope = fileViewScope(after, sessionId);
    for (const mark of this.store.viewedFiles().filter((m) => m.scope === oldScope)) {
      const parts = JSON.parse(mark.id);
      parts[0] = scope;
      this.store.saveViewedFile({ ...mark, scope, id: JSON.stringify(parts) });
    }
    for (const mark of this.store.viewedMethods().filter((m) => m.scope === oldScope)) {
      const parts = JSON.parse(mark.id);
      parts[0] = scope;
      this.store.saveViewedMethod({ ...mark, scope, id: JSON.stringify(parts) });
    }
  }
}
