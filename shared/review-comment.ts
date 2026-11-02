import { withoutRecheckMarker, type FixCompletion } from './fix-chat.js';
import type { DraftComment, Evidence, ReviewSession } from './model.js';

export interface CommentActivity {
  id: string;
  at: string;
  action: 'created' | 'codex' | 'review' | 'accepted' | 'skipped' | 'restored';
  resultAt?: string;
}
export interface CommentStep {
  actor: 'reviewer' | 'codex' | 'github';
  action:
    | 'comment'
    | 'handoff'
    | 'review'
    | 'queued'
    | 'done'
    | 'skipped'
    | 'accepted'
    | 'sent'
    | 'restored';
  at?: string;
  pending?: boolean;
}

/** A compact excerpt, never a replacement for the author's saved comment. */
export function commentTitle(body: string) {
  const text = withoutRecheckMarker(body)
    .replace(/\s+/g, ' ')
    .replace(/^[-*#>]+\s*/, '')
    .trim();
  if (text.length <= 100) return text;
  const end = text.lastIndexOf(' ', 97);
  return text.slice(0, end > 45 ? end : 97) + '…';
}
export const acceptedFix = (comment: DraftComment, completion?: FixCompletion) =>
  !!completion &&
  !completion.skipped &&
  comment.activity?.some(
    (event) => event.action === 'accepted' && event.resultAt === completion.at,
  ) === true;

/** Unknown legacy dates stay unknown; completion never implies acceptance by the reviewer. */
export function commentSteps(
  comment: DraftComment,
  completion?: FixCompletion,
  sentAt?: string,
): CommentStep[] {
  const activity = comment.activity ?? [];
  const steps: CommentStep[] = [
    { actor: 'reviewer', action: 'comment', at: activity.find((e) => e.action === 'created')?.at },
  ];
  for (const event of activity.filter((e) => e.action === 'codex' || e.action === 'review'))
    steps.push({
      actor: 'reviewer',
      action: event.action === 'codex' ? 'handoff' : 'review',
      at: event.at,
    });
  for (const event of activity.filter((e) => e.action === 'skipped' || e.action === 'restored'))
    steps.push({
      actor: 'reviewer',
      action: event.action === 'skipped' ? 'skipped' : 'restored',
      at: event.at,
    });
  if (completion) {
    if (!completion.skipped || !steps.some((s) => s.action === 'skipped' && s.at === completion.at))
      steps.push({
        actor: completion.skipped ? 'reviewer' : 'codex',
        action: completion.skipped ? 'skipped' : 'done',
        at: completion.at,
      });
    const accepted = activity.find((e) => e.action === 'accepted' && e.resultAt === completion.at);
    if (accepted && !completion.skipped)
      steps.push({ actor: 'reviewer', action: 'accepted', at: accepted.at });
  } else if (comment.forCodex) steps.push({ actor: 'codex', action: 'queued', pending: true });
  if (sentAt) steps.push({ actor: 'github', action: 'sent', at: sentAt });
  return steps.sort((a, b) =>
    a.action === 'done' && !a.at && b.action === 'accepted'
      ? -1
      : b.action === 'done' && !b.at && a.action === 'accepted'
        ? 1
        : !a.at
          ? a.action === 'comment'
            ? -1
            : 1
          : !b.at
            ? b.action === 'comment'
              ? 1
              : -1
            : a.at.localeCompare(b.at),
  );
}

/** Resolve code in the comment's own version instead of using the selected comparison range. */
export function commentSource(
  session: ReviewSession,
  comment: DraftComment,
  snapshotId?: string,
): { evidence: Evidence; versionId: string } | undefined {
  const origin = comment.outdated ? comment.origin : undefined;
  const evidence = origin?.evidence ?? comment.evidence;
  if (!evidence) return;
  const id = origin?.snapshotId ?? snapshotId;
  if (!id || session.snapshots.some((s) => s.id === id)) return { evidence, versionId: 'current' };
  const saved = session.history?.find((r) => r.snapshots.some((s) => s.id === id));
  if (saved) return { evidence, versionId: saved.id };
  const checkpoint = session.workflow?.checkpoints.find((c) => c.snapshotIds.includes(id));
  return checkpoint ? { evidence, versionId: checkpoint.id } : undefined;
}
