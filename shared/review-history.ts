import type { ReviewDraft } from './model';

/** Old publications stay visible in code and can be matched to GitHub discussion threads. */
export function reviewDraftsWithHistory(draft: ReviewDraft): ReviewDraft[] {
  return [
    draft,
    ...(draft.published ?? []).map((published): ReviewDraft => ({
      sessionId: draft.sessionId,
      snapshotId: published.snapshotId,
      headSha: published.headSha,
      body: published.body,
      action: published.action,
      comments: published.comments,
      state: 'submitted',
      submission: published.submission,
      attempt: null,
    })),
  ];
}
