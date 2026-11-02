import { sessionSnapshots, type ReviewSession, type Snapshot } from '../shared/model.js';
import { reviewPoints, type ReviewRangeComparison } from '../shared/review-timeline.js';
import { changedFiles } from './repository.js';
import { snapshotDiff } from './snapshot-diff.js';
import { extractAllContracts } from './contracts.js';
import { Store } from './store.js';
import { AppError } from './process.js';
import { t } from '../shared/i18n.js';
import { sourceIdentity } from '../shared/review-workflow.js';

/** Local, immutable display views. Never saved as analyses and never sent to the model. */
export class ReviewComparisons {
  private views = new Map<string, Promise<ReviewRangeComparison>>();
  private snapshots = new Map<
    string,
    { sessionId: string; snapshot: Snapshot; origins: string[] }
  >();
  constructor(private store: Store) {}

  snapshot(session: ReviewSession, id: string) {
    const view = this.snapshots.get(id) ?? this.store.comparisonSnapshot(id);
    const known = new Set(sessionSnapshots(session).map((s) => s.id));
    return view?.sessionId === session.id && view.origins.every((id) => known.has(id))
      ? view.snapshot
      : undefined;
  }

  read(session: ReviewSession, from: string) {
    const to = 'current';
    const points = reviewPoints(session);
    const a = points.findIndex((p) => p.id === from || p.aliases?.includes(from)),
      b = points.length - 1;
    if (a < 0 || b <= a) throw new AppError(t('The comparison range is unavailable.'), 400);
    const key = JSON.stringify([
      session.id,
      from,
      to,
      points[a].snapshots.map((s) => s.id),
      points[b].snapshots.map((s) => s.id),
    ]);
    let pending = this.views.get(key);
    if (!pending) {
      pending = this.build(session, points[a].snapshots, points[b].snapshots, from, to);
      this.views.set(key, pending);
      pending.catch(() => this.views.delete(key));
      if (this.views.size > 64) this.views.delete(this.views.keys().next().value!);
    }
    return pending;
  }

  private async build(
    session: ReviewSession,
    before: Snapshot[],
    after: Snapshot[],
    from: string,
    to: string,
  ): Promise<ReviewRangeComparison> {
    const snapshots = await Promise.all(
      after.map(async (target) => {
        const previous = before.find((s) => s.repoId === target.repoId)!;
        const side = from === 'base' ? 'base' : 'head';
        const sha = side === 'base' ? previous.mergeBase : previous.headSha;
        const repo = this.store.repository(target.repoId);
        const saved = session.update?.changes.find(
          (c) => c.repoId === target.repoId && c.fromSha === sha && c.toSha === target.headSha,
        );
        const files =
          sourceIdentity(previous, side) === sourceIdentity(target)
            ? []
            : sha === target.mergeBase
              ? target.files
              : (saved?.files ??
                (repo
                  ? await changedFiles(
                      target.local ? { ...repo, path: target.local.gitDir } : repo,
                      sha,
                      target.headSha,
                    ).catch(() => snapshotDiff(previous, target, side))
                  : null));
        if (!files) throw new AppError(t('Repository not found.'), 404);
        const snapshot: Snapshot = {
          ...target,
          id: `comparison:${encodeURIComponent(session.id)}:${encodeURIComponent(target.id)}:${encodeURIComponent(previous.id)}:${side}`,
          reviewSnapshotId: target.id,
          ...(from !== 'base' && { reviewBase: { snapshotId: previous.id, revisionId: from } }),
          mergeBase: sha,
          baseSha: sha,
          files,
          baseDir: side === 'base' ? previous.baseDir : previous.headDir,
          baseFiles: side === 'base' ? previous.baseFiles : previous.headFiles,
          baseContentHash: sourceIdentity(previous, side),
        };
        this.snapshots.set(snapshot.id, {
          sessionId: session.id,
          snapshot,
          origins: [previous.id, target.id],
        });
        this.store.saveComparisonSnapshot({
          sessionId: session.id,
          snapshot,
          origins: [previous.id, target.id],
        });
        if (this.snapshots.size > 512) this.snapshots.delete(this.snapshots.keys().next().value!);
        return snapshot;
      }),
    );
    return { from, to, snapshots, contracts: await extractAllContracts(snapshots) };
  }
}
