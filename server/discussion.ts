import type { ReactionContent } from '../shared/reactions.js';
import type { ReviewSession } from '../shared/model.js';
import type { GitHubGateway } from './github.js';
import { Store } from './store.js';
import { AppError } from './process.js';
import { randomUUID } from 'node:crypto';
import type { ReviewDraft, Snapshot, ReviewDiscussion } from '../shared/model.js';
import { reviewDraftsWithHistory } from '../shared/review-history.js';
import { t } from '../shared/i18n.js';

/** Own publications are context, not new review feedback to analyze. Replies from other
 * participants remain eligible even when they belong to a review published by us. */
export function ownReviewDiscussion(
  drafts: ReviewDraft[],
  snapshots: Snapshot[],
  logins: string[] = [],
) {
  const own = new Set(logins.map((login) => login.toLowerCase()));
  const reviews = new Set<string>(),
    markers = new Set<string>();
  for (const original of drafts)
    for (const draft of reviewDraftsWithHistory(original)) {
      const repoId =
        snapshots.find((snapshot) => snapshot.id === draft.snapshotId)?.repoId ??
        draft.comments.find((comment) => comment.evidence)?.evidence?.repoId;
      if (repoId && draft.submission) reviews.add(`${repoId}:${draft.submission.id}`);
      if (draft.attempt?.marker) markers.add(draft.attempt.marker);
    }
  return (comment: ReviewDiscussion) => {
    if (own.has(comment.author.toLowerCase())) return true;
    if ([...markers].some((marker) => comment.body.includes(marker))) return true;
    if (comment.replyTo) return false;
    const reviewId =
      comment.reviewId ??
      (/^review:\d+$/.test(comment.id) ? Number(comment.id.slice(7)) : undefined);
    return !!reviewId && reviews.has(`${comment.repoId}:${reviewId}`);
  };
}

export class Discussions {
  constructor(
    private store: Store,
    private github: GitHubGateway,
    /** The live session of a running analysis, which would otherwise overwrite these changes. */
    private session: (id: string) => ReviewSession | undefined = (id) => store.session(id),
  ) {}
  async refresh(sessionId: string) {
    const session = this.session(sessionId);
    if (!session) throw new AppError(t('Session not found.'), 404);
    if (!this.github.discussion)
      return { comments: session.threadDiscussion ?? session.discussion ?? [], warnings: [] };
    const before = new Map(
      (session.threadDiscussion ?? session.discussion ?? []).map((comment) => [
        `${comment.repoId}:${comment.id}`,
        JSON.stringify(comment),
      ]),
    );
    const loaded: ReviewDiscussion[] = [],
      succeeded = new Set<string>(),
      warnings: string[] = [];
    for (const snapshot of session.snapshots.filter((snapshot) => snapshot.pr)) {
      try {
        loaded.push(
          ...(await this.github.discussion(snapshot.slug, snapshot.pr!.number)).map((comment) => ({
            ...comment,
            repoId: snapshot.repoId,
          })),
        );
        succeeded.add(snapshot.repoId);
      } catch {
        warnings.push(
          t(
            'Could not refresh the replies: {0}. Saved discussions are available.',
            snapshot.repoName,
          ),
        );
      }
    }
    // Re-read after network I/O: never replace an analysis or a concurrently saved reply.
    const current = this.session(sessionId);
    if (!current) throw new AppError(t('Session not found.'), 404);
    const preserved = (current.threadDiscussion ?? current.discussion ?? []).filter(
      (comment) =>
        !succeeded.has(comment.repoId) ||
        before.get(`${comment.repoId}:${comment.id}`) !== JSON.stringify(comment),
    );
    const merged = new Map(loaded.map((comment) => [`${comment.repoId}:${comment.id}`, comment]));
    for (const comment of preserved) merged.set(`${comment.repoId}:${comment.id}`, comment);
    const comments = [...merged.values()];
    if (
      JSON.stringify(current.threadDiscussion ?? current.discussion ?? []) !==
      JSON.stringify(comments)
    )
      current.discussionRevision = randomUUID();
    current.threadDiscussion = comments;
    this.store.saveSession(current);
    return { comments: current.threadDiscussion, warnings };
  }
  async react(
    sessionId: string,
    repoId: string,
    commentId: string,
    content: ReactionContent,
    active: boolean,
  ) {
    const session = this.session(sessionId);
    if (!session) throw new AppError(t('Session not found.'), 404);
    const snapshot = session.snapshots.find(
      (snapshot) => snapshot.repoId === repoId && snapshot.pr,
    );
    const comment = (session.threadDiscussion ?? session.discussion)?.find(
      (comment) => comment.repoId === repoId && comment.id === commentId,
    );
    if (!snapshot || !comment || !/^(inline|comment|review):[1-9]\d*$/.test(commentId))
      throw new AppError(t('Message not found. Refresh the replies.'), 404);
    if (
      commentId.startsWith('inline:')
        ? !this.github.setCommentReaction
        : !this.github.reactDiscussion
    )
      throw new AppError(t('GitHub reactions are unavailable.'), 503);
    const reactions = commentId.startsWith('inline:')
      ? await this.github.setCommentReaction!(
          snapshot.slug,
          Number(commentId.slice(7)),
          content,
          active,
        )
      : await this.github.reactDiscussion!(
          snapshot.slug,
          snapshot.pr!.number,
          commentId,
          content,
          active,
        );
    const current = this.session(sessionId);
    const latest =
      (current?.threadDiscussion ?? current?.discussion)?.find(
        (item) => item.repoId === repoId && item.id === commentId,
      ) ?? comment;
    const updated = { ...latest, reactions };
    if (current) {
      current.threadDiscussion = (current.threadDiscussion ?? current.discussion ?? []).map(
        (comment) =>
          comment.repoId === repoId && comment.id === commentId
            ? { ...comment, reactions }
            : comment,
      );
      current.discussionRevision = randomUUID();
      this.store.saveSession(current);
    }
    return updated;
  }
  async reply(sessionId: string, repoId: string, rootId: string, body: string) {
    const session = this.session(sessionId);
    if (!session) throw new AppError(t('Session not found.'), 404);
    const snapshot = session.snapshots.find(
      (snapshot) => snapshot.repoId === repoId && snapshot.pr,
    );
    const root = (session.threadDiscussion ?? session.discussion)?.find(
      (comment) => comment.repoId === repoId && comment.id === rootId && !comment.replyTo,
    );
    if (!snapshot || !root || !/^(inline|comment|review):[1-9]\d*$/.test(rootId))
      throw new AppError(t('Discussion thread not found. Refresh the replies.'), 404);
    if (rootId.startsWith('inline:') ? !this.github.reply : !this.github.replyDiscussion)
      throw new AppError(t('GitHub replies are unavailable.'), 503);
    const reply = {
      ...(rootId.startsWith('inline:')
        ? await this.github.reply!(
            snapshot.slug,
            snapshot.pr!.number,
            Number(rootId.slice(7)),
            body,
          )
        : await this.github.replyDiscussion!(snapshot.slug, snapshot.pr!.number, root, body)),
      repoId,
    };
    const current = this.session(sessionId);
    if (current) {
      current.threadDiscussion = [
        ...(current.threadDiscussion ?? current.discussion ?? []).filter(
          (comment) => comment.repoId !== repoId || comment.id !== reply.id,
        ),
        reply,
      ];
      current.discussionRevision = randomUUID();
      this.store.saveSession(current);
    }
    return reply;
  }
}
