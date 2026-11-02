import type { ReviewDraft, ReviewSession, Snapshot } from './model.js';

export interface ReviewCheckpoint {
  id: string;
  key: string;
  at: string;
  kind: 'github' | 'local';
  repoId: string;
  snapshotIds: string[];
  analysisId?: string;
  commentIds: string[];
  submissionId?: number;
}
export interface RemoteReviewState {
  repoId: string;
  number: number;
  headSha: string;
  state: 'open' | 'closed' | 'merged';
  decision: 'approved' | 'changes_requested' | 'review_required' | 'unknown';
  at: string;
}
export interface ReviewWorkflow {
  version: 1;
  technicalDelta?: { snapshotIds: string[]; changes: import('./model.js').ReviewUpdate['changes'] };
  initial: { at: string; snapshots: Snapshot[] };
  versions: Snapshot[];
  checkpoints: ReviewCheckpoint[];
  remote?: RemoteReviewState[];
  remoteWarnings?: string[];
  fixUpdates?: Record<
    string,
    { state: 'pending' | 'complete' | 'failed'; at: string; error?: string }
  >;
}
export const sourceIdentity = (s: Snapshot, side: 'head' | 'base' = 'head') =>
  side === 'head' ? (s.contentHash ?? s.headSha) : (s.baseContentHash ?? s.mergeBase);
export const sameReviewedSource = (a: Snapshot, b: Snapshot) =>
  a.repoId === b.repoId && sourceIdentity(a) === sourceIdentity(b);
export const lineage = (s: Snapshot) =>
  s.reviewLineage ?? JSON.stringify([s.repoId, s.local?.baseRef ?? s.pr?.number ?? 'context']);

/** Additive migration: a saved analysis is never invented as a human review. */
export function ensureReviewWorkflow(session: ReviewSession, drafts: ReviewDraft[] = []) {
  const old = [...(session.history ?? []).flatMap((r) => r.snapshots), ...session.snapshots];
  for (const s of old)
    s.reviewLineage ??= JSON.stringify([
      session.id,
      s.repoId,
      s.local?.baseRef ?? s.pr?.number ?? 'context',
    ]);
  session.workflow ??= {
    version: 1,
    initial: {
      at: session.createdAt,
      snapshots: session.snapshots.map((s) => old.find((p) => lineage(p) === lineage(s)) ?? s),
    },
    versions: [],
    checkpoints: [],
  };
  const workflow = session.workflow;
  for (const original of [...drafts, ...(session.history ?? []).flatMap((r) => r.drafts)]) {
    const publications = [
      ...(original.published ?? []),
      ...(original.state === 'submitted' && original.submission ? [original] : []),
    ];
    for (const sent of publications) {
      if (!sent.submission) continue;
      const snapshot = old.find((s) => s.id === sent.snapshotId);
      if (!snapshot) continue;
      const key = `github:${snapshot.repoId}:${sent.submission.id}`;
      if (workflow.checkpoints.some((c) => c.key === key)) continue;
      const revision = session.history?.find((r) => r.snapshots.some((s) => s.id === snapshot.id));
      workflow.checkpoints.push({
        id: `checkpoint:${key}`,
        key,
        at: sent.submission.at,
        kind: 'github',
        repoId: snapshot.repoId,
        snapshotIds: (revision?.snapshots ?? session.snapshots).map((s) => s.id),
        analysisId: revision?.run.id ?? session.run?.id,
        commentIds: sent.comments.filter((c) => c.selected && !c.forCodex).map((c) => c.id),
        submissionId: sent.submission.id,
      });
      for (const s of revision?.snapshots ?? session.snapshots)
        if (!workflow.versions.some((v) => v.id === s.id)) workflow.versions.push(s);
    }
  }
  return workflow;
}

export function recordReviewCheckpoint(
  session: ReviewSession,
  repoId: string,
  key: string,
  kind: ReviewCheckpoint['kind'],
  commentIds: string[],
  at = new Date().toISOString(),
  submissionId?: number,
) {
  const workflow = ensureReviewWorkflow(session);
  const existing = workflow.checkpoints.find((c) => c.key === key);
  if (existing) return existing;
  for (const snapshot of session.snapshots)
    if (!workflow.versions.some((s) => s.id === snapshot.id)) workflow.versions.push(snapshot);
  const checkpoint: ReviewCheckpoint = {
    id: `checkpoint:${key}`,
    key,
    at,
    kind,
    repoId,
    snapshotIds: session.snapshots.map((s) => s.id),
    analysisId: session.run?.id,
    commentIds,
    submissionId,
  };
  workflow.checkpoints.push(checkpoint);
  return checkpoint;
}

export function checkpointSnapshots(session: ReviewSession, checkpoint: ReviewCheckpoint) {
  const snapshots = [
    ...session.snapshots,
    ...(session.history ?? []).flatMap((r) => r.snapshots),
    ...(session.workflow?.versions ?? []),
    ...(session.workflow?.initial.snapshots ?? []),
  ];
  return checkpoint.snapshotIds.flatMap((id) => snapshots.find((s) => s.id === id) ?? []);
}
