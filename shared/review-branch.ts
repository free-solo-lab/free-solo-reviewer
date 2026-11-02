import type { ReviewSession } from './model.js';
import { ensureReviewWorkflow } from './review-workflow.js';

/** Recover the last saved analysis of the original branch after an old checkout-following refresh. */
export function restoreReviewBranch(session: ReviewSession) {
  if (session.run?.state === 'running') return false;
  const first = session.history?.find((r) => r.snapshots.some((s) => s.local?.branchName));
  if (!first) return false;
  const drift = session.snapshots.some(
    (s) =>
      s.local &&
      first.snapshots.some(
        (old) =>
          old.repoId === s.repoId &&
          old.local?.branchName &&
          old.local.branchName !== s.local!.branchName,
      ),
  );
  if (!drift) return false;
  const saved = [...(session.history ?? [])]
    .reverse()
    .find((r) =>
      r.snapshots.every(
        (s) =>
          !s.local ||
          first.snapshots.some(
            (old) => old.repoId === s.repoId && old.local?.branchName === s.local!.branchName,
          ),
      ),
    );
  if (!saved) return false;
  const workflow = ensureReviewWorkflow(session);
  for (const s of [...session.snapshots, ...workflow.initial.snapshots])
    if (!workflow.versions.some((v) => v.id === s.id)) workflow.versions.push(s);
  session.snapshots = structuredClone(saved.snapshots);
  session.run = structuredClone(saved.run);
  workflow.initial = { at: first.savedAt, snapshots: structuredClone(first.snapshots) };
  delete session.update;
  delete session.contracts;
  return true;
}
