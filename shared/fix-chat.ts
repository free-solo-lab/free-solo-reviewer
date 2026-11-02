import type { DraftComment, Evidence } from './model';
import { inAllLanguages, prefixPattern, t } from './i18n.js';

export interface FixCompletion {
  repoId: string;
  commentId: string;
  body: string;
  evidence?: Evidence | null;
  result?: string;
  at?: string;
  /** The reviewer declined this step: it left the queue without changes from Codex. */
  skipped?: boolean;
}

export interface FixRequest {
  id: string;
  kind: 'question' | 'approval';
  prompt: string;
  options: string[];
  at: string;
  resume: 'plan' | 'apply' | 'step';
  /** The comment of the step that asked, so the answer resumes that step. */
  stepId?: string;
  fingerprint: string;
}
export interface FixAttention {
  sessionId: string;
  title: string;
  requestId: string;
  kind: FixRequest['kind'];
  prompt: string;
}
export interface FixChatEvent {
  id: string;
  at: string;
  kind: 'user' | 'assistant' | 'plan' | 'command' | 'files' | 'rollback' | 'status' | 'request';
  text: string;
  tasks?: { text: string; completed: boolean }[];
  request?: Pick<FixRequest, 'id' | 'kind' | 'prompt' | 'options'> & {
    resolution?: 'answered' | 'approved' | 'rejected' | 'cancelled';
    response?: string;
  };
}
/** One Codex comment of the fix plan, done in its own turn. */
export interface FixStep {
  commentId: string;
  state: 'running' | 'done' | 'failed';
  /** What Codex reported for this step. */
  result?: string;
}
export interface FixChat {
  selection?: { commentIds: string[]; together: boolean };
  contexts?: Record<string, { threadId?: string; fingerprint?: string; home: string }>;
  postFix?: { turnId: string; state: 'pending' | 'complete' | 'failed'; error?: string };
  sessionId: string;
  repoId: string;
  snapshotId: string;
  state:
    | 'planning'
    | 'planned'
    | 'applying'
    | 'stepped'
    | 'complete'
    | 'failed'
    | 'cancelled'
    | 'waiting_input'
    | 'waiting_approval';
  turnId: string;
  threadId?: string;
  commentsHash: string;
  events: FixChatEvent[];
  error?: string;
  pending?: FixRequest;
  /** Steps of the plan that were started, by comment; the rest are still to do. */
  steps?: FixStep[];
  /** Completed comments survive snapshot changes and switching to another repository. */
  completedSteps?: FixCompletion[];
  /** Run the remaining steps one after another without waiting for the user. */
  autoSteps?: boolean;
  /** The working folder as the last fix turn left it; the next step starts from it. */
  fingerprint?: string;
  /** The code before fixes: a `git stash create` commit (HEAD when clean) and untracked files. */
  rollback?: { commit: string; untracked: string[] };
}

/** Chat messages of a step-by-step fix; older chats keep them in the language of that time. */
export const STEP_TITLE = 'Step {0}: {1}{2}';
export const STEP_DONE = 'Step done. Steps left: {0}.';
export const ALL_STEPS_DONE = 'All steps done. Code changes are being refreshed automatically.';
/** Whether a status message reports a finished step, judged by its first sentence. */
const isStepDone = (text: string) =>
  [STEP_DONE, ALL_STEPS_DONE, 'All steps done. Refresh the review to check the code changes.'].some(
    (message) => inAllLanguages(message).some((variant) => text.startsWith(variant.split('. ')[0])),
  );
/** Put before a comment that must be checked again after the PR changed. */
export const RECHECK_MARKER = '[Recheck after the PR update]';
/** The comment without the recheck markers added in any language. */
export const withoutRecheckMarker = (body: string) =>
  body.replace(new RegExp(`^(?:${prefixPattern(RECHECK_MARKER)}\\s*)+`), '').trim();
const originalTask = withoutRecheckMarker;

/** Upgrade older chats, including those whose step flags were reset but events survived. */
export function completedFixSteps(chat: FixChat, comments: DraftComment[] = []): FixCompletion[] {
  const completed = new Map(
    (chat.completedSteps ?? []).map((entry) => [`${entry.repoId}:${entry.commentId}`, entry]),
  );
  const remember = (id: string, result?: string, at?: string) => {
    const key = `${chat.repoId}:${id}`;
    if (completed.has(key)) return;
    const comment = comments.find((item) => item.id === id);
    completed.set(key, {
      repoId: chat.repoId,
      commentId: id,
      body: comment ? originalTask(comment.body) : t('Completed step'),
      evidence: comment?.evidence,
      result,
      at,
    });
  };
  for (const step of chat.steps ?? [])
    if (step.state === 'done') remember(step.commentId, step.result);
  for (const event of chat.events) {
    if (event.kind !== 'user' || !event.id.endsWith(':user')) continue;
    const title = new RegExp(`^${prefixPattern(STEP_TITLE)}\\d+: ([^\\n]+)`).exec(event.text)?.[1];
    if (!title) continue;
    const prefix = event.id.slice(0, -5);
    const done = chat.events.find((item) => item.id === `${prefix}:done` && isStepDone(item.text));
    if (!done) continue;
    const candidates = comments.filter(
      (comment) => originalTask(comment.body).split('\n')[0].slice(0, 200) === title,
    );
    const ids = [...new Set(candidates.map((comment) => comment.id))];
    if (ids.length !== 1) continue;
    remember(
      ids[0],
      chat.events
        .filter((item) => item.id.startsWith(`${prefix}:`) && item.kind === 'assistant')
        .at(-1)?.text,
      done.at,
    );
  }
  return [...completed.values()];
}
