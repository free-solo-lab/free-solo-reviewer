import type { DraftComment, Evidence } from './model.js';

/** Attach a thread below its final line, including deleted lines and renamed files. */
export function commentsAtLine(comments: DraftComment[], line: Evidence): DraftComment[] {
  return comments.filter(
    ({ evidence }) =>
      evidence &&
      evidence.repoId === line.repoId &&
      evidence.side === line.side &&
      evidence.path === line.path &&
      evidence.endLine === line.startLine,
  );
}
