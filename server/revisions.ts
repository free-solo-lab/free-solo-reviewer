import type { ReviewSession, ReviewDraft } from '../shared/model.js';

/** Never overwrite a pinned review when newer commits or discussion arrive. */
export function archiveReview(session: ReviewSession, drafts: ReviewDraft[]) {
  if (!session.run || session.run.state === 'running') return;
  if (
    !session.run.result.summary &&
    !session.run.result.findings.length &&
    !session.run.result.scenarios.length
  )
    return;
  session.history ??= [];
  if (session.history.some((revision) => revision.id === session.run!.id)) return;
  session.history.push(
    structuredClone({
      id: session.run.id,
      savedAt: new Date().toISOString(),
      snapshots: session.snapshots,
      run: session.run,
      drafts,
    }),
  );
}
