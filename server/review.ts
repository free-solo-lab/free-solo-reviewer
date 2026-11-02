import { sessionSnapshots } from '../shared/model.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  evidenceSchema,
  type ReviewDraft,
  type ReviewSession,
  type Snapshot,
} from '../shared/model.js';
import { GitHubApiError, type GitHubGateway, type ReviewPayload } from './github.js';
import { inlineLocation, readSource } from './repository.js';
import { Store } from './store.js';
import { AppError } from './process.js';
import { t } from '../shared/i18n.js';
import { recordReviewCheckpoint } from '../shared/review-workflow.js';
export const draftInputSchema = z.object({
  round: z.string().optional(),
  headSha: z.string(),
  body: z.string().max(60_000),
  action: z.enum(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']),
  comments: z
    .array(
      z.object({
        id: z.string(),
        body: z.string().min(1).max(20_000),
        evidence: evidenceSchema.nullable(),
        selected: z.boolean(),
        forCodex: z.boolean().optional(),
        discussionId: z.string().max(200).optional(),
        origin: z.object({ snapshotId: z.string(), evidence: evidenceSchema }).optional(),
        outdated: z.boolean().optional(),
      }),
    )
    .max(200),
});
export class ReviewManager {
  private locks = new Set<string>();
  constructor(
    private store: Store,
    private github: GitHubGateway,
  ) {}
  private checkpoint(session: ReviewSession, snapshot: Snapshot, draft: ReviewDraft) {
    if (!draft.submission) return;
    const current = this.store.session(session.id) ?? session;
    recordReviewCheckpoint(
      current,
      snapshot.repoId,
      `github:${snapshot.repoId}:${draft.submission.id}`,
      'github',
      draft.comments.filter((c) => c.selected && !c.forCodex).map((c) => c.id),
      draft.submission.at,
      draft.submission.id,
    );
    this.store.saveSession(current);
  }
  get(session: ReviewSession, snapshot: Snapshot): ReviewDraft {
    return (
      this.store.draft(session.id, snapshot.id) ?? {
        sessionId: session.id,
        snapshotId: snapshot.id,
        headSha: snapshot.headSha,
        body: '',
        action: 'COMMENT',
        comments: [],
        state: 'draft',
        attempt: null,
        submission: null,
      }
    );
  }
  save(session: ReviewSession, snapshot: Snapshot, input: unknown) {
    if (this.locks.has(`${session.id}:${snapshot.id}`))
      throw new AppError(t('Sending is already in progress.'), 409);
    const fields = draftInputSchema.parse(input);
    const old = this.get(session, snapshot);
    if (fields.round !== old.round)
      throw new AppError(
        t('This review is already sent. Open the current review before changing it.'),
        409,
      );
    const sent = new Set(
      old.published?.flatMap((review) => review.comments.map((comment) => comment.id)),
    );
    if (fields.comments.some((comment) => sent.has(comment.id)))
      throw new AppError(t('Sent comments are in the history and cannot be sent again.'), 409);
    if (old.state !== 'draft')
      throw new AppError(t('A sent or unconfirmed review cannot be edited.'), 409);
    if (fields.headSha !== snapshot.headSha)
      throw new AppError(t('The draft belongs to another commit.'), 409);
    const at = new Date().toISOString();
    const comments = fields.comments.map((comment) => {
      const previous = old.comments.find((item) => item.id === comment.id);
      const activity = [...(previous?.activity ?? [])];
      if (!previous) activity.push({ id: randomUUID(), action: 'created' as const, at });
      if (
        (!previous && comment.forCodex) ||
        (previous && !!previous.forCodex !== !!comment.forCodex)
      )
        activity.push({
          id: randomUUID(),
          action: comment.forCodex ? ('codex' as const) : ('review' as const),
          at,
        });
      return { ...comment, ...(activity.length ? { activity } : {}) };
    });
    const draft = { ...old, ...fields, comments };
    this.store.saveDraft(draft);
    return draft;
  }
  acceptFix(session: ReviewSession, snapshot: Snapshot, commentId: string) {
    const draft = this.get(session, snapshot);
    const completion = this.store
      .fixChat(session.id)
      ?.completedSteps?.find(
        (item) => item.repoId === snapshot.repoId && item.commentId === commentId && !item.skipped,
      );
    const comment = draft.comments.find((item) => item.id === commentId);
    if (draft.state !== 'draft' || !completion || !comment)
      throw new AppError(t('The completed fix is unavailable.'), 409);
    if (!comment.activity?.some((e) => e.action === 'accepted' && e.resultAt === completion.at)) {
      comment.activity = [
        ...(comment.activity ?? []),
        {
          id: randomUUID(),
          action: 'accepted',
          at: new Date().toISOString(),
          resultAt: completion.at,
        },
      ];
      this.store.saveDraft(draft);
    }
    return draft;
  }
  /** Continue on the same commit without ever re-sending already published comments. */
  continue(session: ReviewSession, snapshot: Snapshot) {
    if (this.locks.has(`${session.id}:${snapshot.id}`))
      throw new AppError(t('Sending is already in progress.'), 409);
    const old = this.get(session, snapshot);
    if (old.state === 'draft') return old;
    if (old.state !== 'submitted' || !old.submission)
      throw new AppError(
        t('Confirm the result of the previous submission by verifying with GitHub first.'),
        409,
      );
    const published = [...(old.published ?? [])];
    if (!published.some((review) => review.submission.id === old.submission!.id))
      published.push({
        snapshotId: old.snapshotId,
        headSha: old.headSha,
        body: old.body,
        action: old.action,
        comments: old.comments.filter((comment) => comment.selected && !comment.forCodex),
        submission: old.submission,
      });
    const draft: ReviewDraft = {
      ...old,
      headSha: snapshot.headSha,
      round: randomUUID(),
      published,
      body: '',
      action: 'COMMENT',
      comments: old.comments.filter((comment) => !comment.selected || comment.forCodex),
      state: 'draft',
      submission: null,
      attempt: null,
    };
    this.store.saveDraft(draft);
    return draft;
  }
  async reconcile(session: ReviewSession, snapshot: Snapshot) {
    const draft = this.get(session, snapshot);
    if (draft.state === 'submitted' || !draft.attempt || !snapshot.pr) return draft;
    const user = await this.github.user(snapshot.slug);
    const found = (await this.github.reviews(snapshot.slug, snapshot.pr.number)).find(
      (r) =>
        r.user.login === user.login &&
        r.commit_id === draft.headSha &&
        r.body.includes(draft.attempt!.marker) &&
        r.state !== 'PENDING',
    );
    if (found) {
      draft.state = 'submitted';
      draft.submission = { id: found.id, url: found.html_url, at: new Date().toISOString() };
      this.store.saveDraft(draft);
      this.checkpoint(session, snapshot, draft);
    }
    return draft;
  }
  async publish(session: ReviewSession, snapshot: Snapshot, round?: string) {
    if (!snapshot.pr) throw new AppError(t('A context repository has no PR.'));
    const key = `${session.id}:${snapshot.id}`;
    if (this.locks.has(key)) throw new AppError(t('Sending is already in progress.'), 409);
    this.locks.add(key);
    try {
      let draft = this.get(session, snapshot);
      if (draft.round !== round)
        throw new AppError(
          t('This review is already sent or replaced by a new one. Open the current review.'),
          409,
        );
      if (draft.state === 'submitted') return draft;
      if (draft.state === 'uncertain' || draft.state === 'submitting') {
        draft = await this.reconcile(session, snapshot);
        if (draft.state === 'submitted') return draft;
        throw new AppError(
          t(
            'The result of the previous submission is unknown. Check GitHub and verify again; publishing again is blocked to avoid a duplicate.',
          ),
          409,
        );
      }
      const current = await this.github.pull(snapshot.slug, snapshot.pr.number);
      if (current.headRefOid !== snapshot.headSha || draft.headSha !== snapshot.headSha)
        throw new AppError(
          t('New commits appeared in the PR. Refresh the snapshots and recheck the comments.'),
          409,
          'pr-updated',
        );
      const user = await this.github.user(snapshot.slug);
      if (!(await this.github.permission(snapshot.slug)))
        throw new AppError(t('GitHub did not confirm access to the repository.'), 403);
      if (current.author.login === user.login && draft.action !== 'COMMENT')
        throw new AppError(
          t(
            'GitHub does not allow approving or requesting changes on your own PR. Choose Comment.',
          ),
          403,
        );
      const comments: ReviewPayload['comments'] = [];
      const general: string[] = [];
      for (const comment of draft.comments.filter((c) => c.selected && !c.forCodex)) {
        if (!comment.body.trim()) throw new AppError(t('Empty comment.'));
        if (comment.evidence) {
          const owner =
            comment.outdated && comment.origin
              ? sessionSnapshots(session).find((s) => s.id === comment.origin!.snapshotId)
              : session.snapshots.find((s) => s.repoId === comment.evidence!.repoId);
          if (!owner) throw new AppError(t('The comment’s repository is missing.'));
          const text = await readSource(owner, comment.evidence);
          if (
            comment.evidence.endLine < comment.evidence.startLine ||
            comment.evidence.endLine > text.split('\n').length
          )
            throw new AppError(t('Invalid comment lines.'));
          const location = comment.outdated ? null : inlineLocation(snapshot, comment.evidence);
          if (location) comments.push({ ...location, body: comment.body });
          else
            general.push(
              t(
                '{0}\n\nContext: {1}/{2}:{3} ({4})',
                comment.body,
                owner.repoName,
                comment.evidence.path,
                comment.evidence.startLine,
                comment.evidence.side,
              ),
            );
        } else general.push(comment.body);
      }
      const body = [draft.body.trim(), ...general].filter(Boolean).join('\n\n---\n\n');
      if (draft.action !== 'APPROVE' && !body && !comments.length)
        throw new AppError(t('Add text or comments to the review.'));
      if (body.length > 60_000)
        throw new AppError(
          t('The overall review text exceeds 60,000 characters. Shorten the comments.'),
        );
      const marker = `<!-- free-solo-review:${randomUUID()} -->`;
      const payload: ReviewPayload = {
        commit_id: snapshot.headSha,
        event: draft.action,
        body: [body, marker].filter(Boolean).join('\n\n'),
        comments,
      };
      draft.state = 'submitting';
      draft.attempt = { marker, at: new Date().toISOString(), payload };
      this.store.saveDraft(draft);
      try {
        const response = await this.github.submit(snapshot.slug, snapshot.pr.number, payload);
        draft.state = 'submitted';
        draft.submission = {
          id: response.id,
          url: response.html_url,
          at: new Date().toISOString(),
        };
        this.store.saveDraft(draft);
        this.checkpoint(session, snapshot, draft);
        return draft;
      } catch (error) {
        if (error instanceof GitHubApiError) {
          draft.state = 'draft';
          draft.attempt = null;
          this.store.saveDraft(draft);
          throw new AppError(
            t('GitHub rejected the review: {0}. The draft is available for fixing.', error.message),
            error.httpStatus,
          );
        }
        draft.state = 'uncertain';
        this.store.saveDraft(draft);
        try {
          draft = await this.reconcile(session, snapshot);
        } catch {
          /* Keep persisted uncertainty if GitHub is unavailable. */
        }
        if (draft.state === 'submitted') return draft;
        throw new AppError(
          t(
            'GitHub did not confirm the submission result. The draft is saved; verify with GitHub. Publishing again is blocked.',
          ),
          502,
        );
      }
    } finally {
      this.locks.delete(key);
    }
  }
}
