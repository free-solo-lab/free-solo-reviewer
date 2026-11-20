import type { ReviewDiscussion } from './model.js';
import type { RemoteReviewDecision } from './review-workflow.js';

/** The marker Reviewer adds to the body of every review it sends. */
const REVIEW_MARKER = /<!--\s*free-solo-review:[^>]*-->/g;
/** A review summary without the marker; empty when the review only carried line comments. */
export const reviewSummaryText = (body: string) => body.replace(REVIEW_MARKER, '').trim();

export interface DiscussionRound<T> {
  /** `review:<id>` of a GitHub review, or `conversation` for comments outside reviews. */
  id: string;
  /** 1-based order of the review in the PR; absent for the conversation. */
  number?: number;
  author?: string;
  at: string;
  /** The commit the review was written on, when one of its line comments tells it. */
  commitId?: string;
  /** The reviewer's approval or change request sent with this review. */
  decision?: RemoteReviewDecision['state'];
  items: T[];
}

/** The GitHub review a top-level comment belongs to, if any. */
function reviewOf(comment: ReviewDiscussion) {
  if (comment.reviewId != null) return comment.reviewId;
  const id = /^review:(\d+)$/.exec(comment.id)?.[1];
  return id ? Number(id) : undefined;
}

/**
 * Top-level comments grouped by the GitHub review they were sent in, newest review first, so the
 * discussion reads as its history. Comments outside reviews come last, oldest first.
 */
export function discussionRounds<T extends { root: ReviewDiscussion }>(
  items: T[],
  /** Every comment of the repository: review summaries name and date the rounds. */
  comments: ReviewDiscussion[],
  /** Approvals and change requests; one without text or comments is still a round. */
  decisions: RemoteReviewDecision[] = [],
): DiscussionRound<T>[] {
  const reviews = new Map<number, DiscussionRound<T>>();
  const conversation: DiscussionRound<T> = { id: 'conversation', at: '', items: [] };
  const roundOf = (review: number, comment: ReviewDiscussion) => {
    let round = reviews.get(review);
    if (!round) {
      round = { id: `review:${review}`, author: comment.author, at: comment.at, items: [] };
      reviews.set(review, round);
    }
    if (comment.at < round.at) round.at = comment.at;
    return round;
  };
  for (const comment of comments) {
    const review = reviewOf(comment);
    if (review == null || comment.replyTo) continue;
    const round = roundOf(review, comment);
    if (comment.id.startsWith('review:')) {
      round.author = comment.author;
      round.at = comment.at;
    }
    round.commitId ??= comment.originalCommitId ?? comment.commitId;
  }
  for (const decision of decisions) {
    if (decision.id == null) continue;
    const round = reviews.get(decision.id) ?? {
      id: `review:${decision.id}`,
      author: decision.author,
      at: decision.at,
      items: [],
    };
    reviews.set(decision.id, round);
    round.decision = decision.state;
    round.commitId ??= decision.commitId;
  }
  for (const item of items) {
    const review = reviewOf(item.root);
    (review == null ? conversation : roundOf(review, item.root)).items.push(item);
  }
  const ordered = [...reviews.values()].sort((a, b) => a.at.localeCompare(b.at));
  ordered.forEach((round, i) => (round.number = i + 1));
  conversation.items.sort((a, b) => a.root.at.localeCompare(b.root.at));
  conversation.at = conversation.items[0]?.root.at ?? '';
  return [
    ...ordered.reverse().filter((round) => round.items.length || round.decision),
    ...(conversation.items.length ? [conversation] : []),
  ];
}
