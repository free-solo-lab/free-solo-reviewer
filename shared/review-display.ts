import type { ReviewSession } from './model.js';
import { sourceIdentity } from './review-workflow.js';
import { reviewRevisionForPoint } from './review-timeline.js';

/** Keep the original reviewed material stable; current updates are a separate layer. */
export function displayedRevision(session: ReviewSession | null, selected = '') {
  if (selected === 'current') return undefined;
  if (selected) return session?.history?.find((revision) => revision.id === selected);
  if (session?.update?.scopeChanged) return undefined;
  // Once the updates are analyzed, the current version shows what changed since the review.
  if (session?.run?.result.followUp) return undefined;
  return session?.history?.[0];
}
export function hasRefreshChanges(before: ReviewSession, after: ReviewSession) {
  return (
    before.run?.id !== after.run?.id ||
    before.update?.id !== after.update?.id ||
    before.snapshots.map((snapshot) => snapshot.id).join(',') !==
      after.snapshots.map((snapshot) => snapshot.id).join(',')
  );
}

/** Discussion and analysis bookkeeping do not constitute changes to source code. */
export function hasRefreshCodeChanges(before: ReviewSession, after: ReviewSession) {
  return (
    before.snapshots.length !== after.snapshots.length ||
    after.snapshots.some((snapshot) => {
      const previous = before.snapshots.find((item) => item.repoId === snapshot.repoId);
      return (
        !previous ||
        sourceIdentity(previous) !== sourceIdentity(snapshot) ||
        sourceIdentity(previous, 'base') !== sourceIdentity(snapshot, 'base') ||
        previous.local?.baseRef !== snapshot.local?.baseRef
      );
    })
  );
}

/** Repair the old comments-only update without discarding a running job or a code revision. */
export function restoreDiscussionOnlyReview(session: ReviewSession) {
  const update = session.update;
  if (
    !update ||
    update.scopeChanged ||
    !update.changes.length ||
    session.run?.state === 'running' ||
    update.changes.some((change) => change.fromSha !== change.toSha || change.files.length)
  )
    return false;
  const previous = session.history?.find((revision) => revision.id === update.previousReviewId);
  // Incremental baselines also require their original comparison scope, which older archives
  // did not retain. Only restore the complete, self-contained analysis we can verify.
  if (
    !previous ||
    previous.run.previousReviewId ||
    hasRefreshCodeChanges(session, { ...session, snapshots: previous.snapshots })
  )
    return false;
  session.run = structuredClone(previous.run);
  session.history = session.history?.filter((revision) => revision.id !== previous.id);
  if (!session.history?.length) delete session.history;
  delete session.update;
  return true;
}

/** A change of comparison base starts a new scope, not a follow-up to the old review. */
export function comparisonReview(session: ReviewSession | null) {
  if (!session) return undefined;
  const previousId =
    session.run?.previousReviewId ??
    (session.update?.scopeChanged ? undefined : session.update?.previousReviewId);
  return previousId ? reviewRevisionForPoint(session, previousId) : undefined;
}
