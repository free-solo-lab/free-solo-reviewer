import type { ReviewSession, ModelResult } from './model.js';
import { reviewRevisionForPoint } from './review-timeline.js';

/** Collect semantic updates over the visible period, independently of the technical queue. */
export function reviewPeriod(session: ReviewSession, from: string, hasCodeChanges = true) {
  const checkpoint = session.workflow?.checkpoints.find((c) => c.id === from);
  const baseline = reviewRevisionForPoint(session, from);
  const runs = [
    ...(session.history ?? []).map((r) => r.run),
    ...(session.run ? [session.run] : []),
  ].filter((run, i, all) => all.findLastIndex((r) => r.id === run.id) === i);
  const index = runs.findIndex((r) => r.id === (checkpoint?.analysisId ?? baseline?.run.id));
  const after =
    from === 'base'
      ? runs
      : index >= 0
        ? runs.slice(index + 1)
        : runs.filter((r) => !checkpoint || r.startedAt >= checkpoint.at);
  const items = new Map<string, NonNullable<ModelResult['followUp']>['items'][number]>();
  const summaries: { id: string; text: string }[] = [];
  if (hasCodeChanges)
    for (const run of after) {
      for (const item of run.result.followUp?.items ?? []) items.set(item.previousId, item);
      if (run.result.followUp?.summary)
        summaries.push({ id: run.id, text: run.result.followUp.summary });
    }
  const titles = new Map<string, string>();
  for (const revision of session.history ?? []) {
    for (const item of revision.run.result.findings) titles.set(item.id, item.title);
    for (const comment of revision.drafts.flatMap((d) => d.comments))
      titles.set(comment.id, comment.body);
  }
  return { items: [...items.values()], summaries, titles, at: checkpoint?.at ?? baseline?.savedAt };
}
