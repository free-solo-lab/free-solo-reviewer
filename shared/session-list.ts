import type { AnalysisRun, ReviewSession } from './model.js';
import { checkpointSnapshots, reviewDecision, sameReviewedSource } from './review-workflow.js';

export type SessionReviewState =
  | 'new'
  | 'ready'
  | 'sent'
  | 'approved'
  | 'review-again'
  | 'local-sent'
  | 'running'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface SessionListItem {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  state: AnalysisRun['state'] | 'ready';
  reviewState: SessionReviewState;
  services: number;
  source: 'pr' | 'local';
  pullRequests: { number: number; repoName: string }[];
  branches: string[];
}

/** A human submission describes reviewed source, independently of the latest technical run. */
export function sessionListItem(session: ReviewSession): SessionListItem {
  const checkpoints = [...(session.workflow?.checkpoints ?? [])].sort((a, b) =>
    b.at.localeCompare(a.at),
  );
  const targets = session.snapshots.filter((snapshot) => snapshot.pr || snapshot.local);
  const onCurrent = targets.map((snapshot) =>
    checkpoints.filter(
      (checkpoint) =>
        checkpoint.repoId === snapshot.repoId &&
        checkpointSnapshots(session, checkpoint).some((old) => sameReviewedSource(old, snapshot)),
    ),
  );
  const reviewed = onCurrent.map((list) => list[0]);
  const approved = onCurrent.map((list) => reviewDecision(list) === 'APPROVE');
  // You approved an earlier version of a PR, and its code changed since.
  const approvalLost = targets.some(
    (snapshot, i) =>
      !approved[i] &&
      reviewDecision(
        checkpoints.filter((c) => c.kind === 'github' && c.repoId === snapshot.repoId),
      ) === 'APPROVE',
  );
  const state = session.run?.state ?? 'ready';
  const reviewState: SessionReviewState =
    state === 'running'
      ? 'running'
      : approved.length && approved.every(Boolean)
        ? 'approved'
        : approvalLost
          ? 'review-again'
          : reviewed.length && reviewed.every(Boolean)
            ? reviewed.some((checkpoint) => checkpoint?.kind === 'github')
              ? 'sent'
              : 'local-sent'
            : !session.run
              ? 'new'
              : state === 'complete'
                ? 'ready'
                : state === 'ready'
                  ? 'new'
                  : state;
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: [
      session.createdAt,
      session.run?.finishedAt ?? session.run?.startedAt ?? '',
      checkpoints[0]?.at ?? '',
    ]
      .sort()
      .at(-1)!,
    state,
    reviewState,
    services: session.snapshots.length,
    source: session.snapshots.some((snapshot) => snapshot.pr) ? 'pr' : 'local',
    pullRequests: session.snapshots.flatMap((snapshot) =>
      snapshot.pr ? [{ number: snapshot.pr.number, repoName: snapshot.repoName }] : [],
    ),
    branches: [
      ...new Set(
        session.snapshots.flatMap(
          (snapshot) => snapshot.pr?.headRefName ?? snapshot.local?.branchName ?? [],
        ),
      ),
    ],
  };
}
