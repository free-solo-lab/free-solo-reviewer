import type { Evidence, ReviewDiscussion, ReviewDraft, Snapshot } from './model.js';
import { reviewFilePath } from './viewed-files.js';

export interface CodeDiscussion {
  root: ReviewDiscussion;
  replies: ReviewDiscussion[];
  evidence?: Evidence;
  localCommentId?: string;
}
export function sourceDiscussions(
  comments: ReviewDiscussion[],
  snapshot: Snapshot,
  origin: Evidence,
  current: boolean,
  drafts: ReviewDraft[] = [],
): CodeDiscussion[] {
  const local = comments.filter(
    (comment) => comment.repoId === snapshot.repoId && comment.id.startsWith('inline:'),
  );
  const byId = new Map(local.map((comment) => [comment.id, comment]));
  const rootOf = (comment: ReviewDiscussion) => {
    const seen = new Set<string>();
    while (comment.replyTo && byId.has(comment.replyTo) && !seen.has(comment.id)) {
      seen.add(comment.id);
      comment = byId.get(comment.replyTo)!;
    }
    return comment;
  };
  const roots = local.filter((comment) => rootOf(comment).id === comment.id);
  return roots
    .filter(
      (root) =>
        root.location &&
        reviewFilePath(snapshot, root.location.path) === reviewFilePath(snapshot, origin.path),
    )
    .map((root) => {
      const location = root.location!;
      const original = root.originalCommitId === snapshot.headSha;
      const line = current
        ? location.line
        : original
          ? location.originalLine
          : root.commitId === snapshot.headSha
            ? location.line
            : null;
      const start = current
        ? location.startLine
        : original
          ? location.originalStartLine
          : location.startLine;
      const changed = snapshot.files.find(
        (file) => file.path === reviewFilePath(snapshot, origin.path),
      );
      const evidence = line
        ? {
            ...origin,
            side: location.side,
            path:
              location.side === 'base'
                ? (changed?.oldPath ?? location.path)
                : reviewFilePath(snapshot, location.path),
            startLine: start ?? line,
            endLine: line,
          }
        : undefined;
      const candidates = drafts
        .filter((draft) => draft.submission?.id === root.reviewId)
        .flatMap((draft) => draft.comments)
        .filter(
          (comment) =>
            comment.selected &&
            comment.body.trim() === root.body.trim() &&
            comment.evidence?.repoId === root.repoId &&
            comment.evidence.path === location.path &&
            comment.evidence.side === location.side &&
            (comment.evidence.endLine === location.originalLine ||
              comment.evidence.endLine === location.line),
        );
      const matching = [...new Map(candidates.map((comment) => [comment.id, comment])).values()];
      return {
        root,
        evidence,
        localCommentId: matching.length === 1 ? matching[0].id : undefined,
        replies: local
          .filter((comment) => comment.id !== root.id && rootOf(comment).id === root.id)
          .sort((a, b) => a.at.localeCompare(b.at)),
      };
    });
}
export function discussionAtLine(threads: CodeDiscussion[], line: Evidence) {
  return threads.filter(
    (thread) =>
      thread.evidence?.path === line.path &&
      thread.evidence.side === line.side &&
      thread.evidence.endLine === line.startLine,
  );
}
