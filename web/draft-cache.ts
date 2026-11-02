import { z } from 'zod';
import { evidenceSchema, type ReviewDraft } from '../shared/model';

const cacheSchema = z.array(
  z.object({
    sessionId: z.string(),
    snapshotId: z.string(),
    headSha: z.string(),
    round: z.string().optional(),
    body: z.string(),
    action: z.enum(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']),
    comments: z.array(
      z.object({
        id: z.string(),
        body: z.string(),
        evidence: evidenceSchema.nullable(),
        selected: z.boolean(),
        forCodex: z.boolean().optional(),
        discussionId: z.string().optional(),
      }),
    ),
  }),
);
const key = (sessionId: string) => `review-drafts:${sessionId}`;

/** Keep older requests ahead of newer edits, including after a failed save. */
export class DraftSaveQueue {
  private pending: Promise<unknown> = Promise.resolve();
  enqueue<T>(save: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => {}).then(save);
    this.pending = next;
    return next;
  }
}

export function cacheDrafts(
  sessionId: string,
  drafts: ReviewDraft[],
  storage: Storage = localStorage,
) {
  storage.setItem(
    key(sessionId),
    JSON.stringify(drafts.filter((draft) => draft.state === 'draft')),
  );
}
export function clearDraftCache(sessionId: string, storage: Storage = localStorage) {
  storage.removeItem(key(sessionId));
}
export function restoreDrafts(
  sessionId: string,
  remote: ReviewDraft[],
  storage: Storage = localStorage,
) {
  try {
    const cached = cacheSchema.safeParse(JSON.parse(storage.getItem(key(sessionId)) ?? 'null'));
    if (!cached.success) return { drafts: remote, recovered: false };
    let recovered = false;
    const drafts = remote.map((draft) => {
      const local = cached.data.find(
        (item) =>
          draft.state === 'draft' &&
          item.sessionId === sessionId &&
          item.snapshotId === draft.snapshotId &&
          item.headSha === draft.headSha &&
          item.round === draft.round,
      );
      if (!local) return draft;
      const restored = {
        ...draft,
        body: local.body,
        action: local.action,
        comments: local.comments,
      };
      if (JSON.stringify(restored) !== JSON.stringify(draft)) recovered = true;
      return restored;
    });
    return { drafts, recovered };
  } catch {
    return { drafts: remote, recovered: false };
  }
}
