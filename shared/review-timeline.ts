import type { Contract, ReviewSession, Snapshot, ReviewRevision } from './model.js';
import { checkpointSnapshots, lineage, sourceIdentity } from './review-workflow.js';

export interface ReviewPoint {
  kind?: 'base' | 'analysis' | 'review' | 'current';
  analysisId?: string;
  aliases?: string[];
  id: string;
  at: string;
  snapshots: Snapshot[];
}
export interface ReviewRangeComparison {
  from: string;
  to: string;
  snapshots: Snapshot[];
  contracts: Contract[];
}
const scope = (snapshots: Snapshot[]) =>
  JSON.stringify(snapshots.map((s) => [s.repoId, lineage(s)]).sort());
const contents = (snapshots: Snapshot[]) =>
  JSON.stringify(snapshots.map((s) => [s.repoId, sourceIdentity(s)]).sort());

/** Only analyzed source versions are selectable; comments and intermediate commits are not. */
export function reviewPoints(session: ReviewSession): ReviewPoint[] {
  const candidates = (session.history ?? [])
    .map((r) => ({
      id: r.id,
      at: r.run.finishedAt ?? r.savedAt,
      snapshots: r.snapshots,
      run: r.run,
    }))
    .filter(
      (r) =>
        scope(r.snapshots) === scope(session.snapshots) &&
        contents(r.snapshots) !== contents(session.snapshots) &&
        r.run.state !== 'running' &&
        (r.run.state === 'complete' || !!r.run.result.summary || !!r.run.result.scenarios.length),
    );
  // A resumed analysis on the same source is still one version, even when its name changed.
  const unique = new Map<string, ReviewPoint>();
  for (const { run, ...candidate } of candidates) {
    const key = contents(candidate.snapshots),
      prior = unique.get(key);
    unique.set(key, {
      ...candidate,
      kind: 'analysis',
      analysisId: run.id,
      aliases: [...(prior?.aliases ?? []), candidate.id],
    });
  }
  for (const checkpoint of session.workflow?.checkpoints ?? []) {
    const snapshots = checkpointSnapshots(session, checkpoint);
    if (scope(snapshots) !== scope(session.snapshots)) continue;
    const key = contents(snapshots),
      prior = unique.get(key);
    unique.set(key, {
      id: checkpoint.id,
      at: checkpoint.at,
      snapshots,
      kind: 'review',
      analysisId: checkpoint.analysisId,
      aliases: [...(prior?.aliases ?? []), checkpoint.id],
    });
  }
  const points = [...unique.values()].sort(
    (a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0),
  );
  const initial =
    session.history?.find((r) => scope(r.snapshots) === scope(session.snapshots))?.snapshots ??
    session.snapshots;
  return [
    {
      id: 'base',
      kind: 'base',
      at: session.workflow?.initial.at ?? session.createdAt,
      snapshots: session.workflow?.initial.snapshots ?? initial,
    },
    ...points,
    {
      id: 'current',
      kind: 'current',
      at:
        session.run?.finishedAt ??
        session.run?.startedAt ??
        session.update?.at ??
        session.createdAt,
      snapshots: session.snapshots,
    },
  ];
}

export function selectedReviewRange(session: ReviewSession, from?: string, to?: string) {
  const points = reviewPoints(session);
  const end = points.length - 1;
  const lastReview = [...(session.workflow?.checkpoints ?? [])]
    .reverse()
    .find((c) => points.some((p) => p.id === c.id || p.aliases?.includes(c.id)));
  const fallback = session.workflow ? (lastReview?.id ?? 'base') : points[Math.max(0, end - 1)].id;
  const baseline = from || (to !== 'current' ? to : undefined) || fallback;
  let start = points.findIndex((p) => p.id === baseline || p.aliases?.includes(baseline));
  if (start < 0 || start >= end)
    start = points.findIndex((p) => p.id === fallback || p.aliases?.includes(fallback));
  if (start < 0 || start >= end) start = 0;
  return { points, from: points[start], to: end > 0 ? points[end] : undefined };
}

export const reviewSnapshotId = (snapshot: Snapshot) => snapshot.reviewSnapshotId ?? snapshot.id;

export function reviewRevisionForPoint(
  session: ReviewSession | null,
  id: string,
): ReviewRevision | undefined {
  if (!session) return undefined;
  const checkpoint = session.workflow?.checkpoints.find((c) => c.id === id);
  const runId = checkpoint?.analysisId ?? id;
  const saved = session.history?.find((r) => r.id === runId);
  if (saved)
    return checkpoint
      ? { ...saved, id, snapshots: checkpointSnapshots(session, checkpoint) }
      : saved;
  if (checkpoint && session.run?.id === runId)
    return {
      id,
      savedAt: checkpoint.at,
      snapshots: checkpointSnapshots(session, checkpoint),
      run: session.run,
      drafts: [],
    };
  return undefined;
}
export function reviewContext(session: ReviewSession | null, id: string) {
  const revision = reviewRevisionForPoint(session, id);
  if (revision) return revision;
  const checkpoint = session?.workflow?.checkpoints.find((c) => c.id === id);
  return checkpoint && session
    ? { id, snapshots: checkpointSnapshots(session, checkpoint), run: null, drafts: [] }
    : undefined;
}
