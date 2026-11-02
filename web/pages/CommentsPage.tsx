import { useEffect, useMemo, useState } from 'react';
import type {
  DraftComment,
  Evidence,
  ReviewDiscussion,
  ReviewDraft,
  Snapshot,
} from '../../shared/model';
import { reviewThreads, type CodeDiscussion } from '../../shared/discussion-threads';
import { tailHunk } from '../../shared/patch';
import { errorMessage } from '../../shared/errors';
import { useWorkspace } from '../workspace/state';
import { useFixCompletions } from '../queries';
import { loadSnapshotSource } from '../sessions';
import { CodeTokens } from '../Code';
import { Diff, Empty } from '../components';
import { DiscussionThread } from '../DiscussionThread';
import { MessageReactions } from '../MessageReactions';
import { highlightLines, languageForPath } from '../syntax';
import { cx } from '../ui/cx';
import { t } from '../../shared/i18n';
import { Icon, IconButton } from '../icons';
import { ReviewCommentRow } from '../dialogs/ReviewCommentRow';
import { commentSource, commentTitle } from '../../shared/review-comment';
import rowStyles from '../dialogs/ReviewDialog.module.css';
import { useCodexSelection, CodexSelectionActions } from '../workspace/useCodexSelection';
import styles from './CommentsPage.module.css';

/** Lines of code shown around a comment, and of a reviewer's diff above the commented line. */
const CONTEXT = 3,
  HUNK_LINES = 8;

/** The commented lines of a pinned file with a few lines around them. */
function CodeExcerpt({
  sessionId,
  snapshotId,
  evidence,
}: {
  sessionId: string;
  snapshotId: string;
  evidence: Evidence;
}) {
  const [text, setText] = useState<string | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setText(null);
    setError('');
    loadSnapshotSource(sessionId, snapshotId, evidence)
      .then((source) => live && setText(source.text))
      .catch((cause) => live && setError(errorMessage(cause)));
    return () => {
      live = false;
    };
  }, [sessionId, snapshotId, evidence.repoId, evidence.side, evidence.path]);
  const lines = useMemo(
    () => (text === null ? [] : highlightLines(text, languageForPath(evidence.path))),
    [text, evidence.path],
  );
  if (error) return <p className={styles.note}>{error}</p>;
  if (text === null) return <p className={styles.note}>{t('Loading code…')}</p>;
  const from = Math.max(1, evidence.startLine - CONTEXT),
    to = Math.min(lines.length, evidence.endLine + CONTEXT);
  return (
    <pre className={cx(styles.code, 'syntax-light')}>
      {lines.slice(from - 1, to).map((tokens, i) => {
        const line = from + i;
        return (
          <div
            key={line}
            className={cx(
              styles.line,
              line >= evidence.startLine && line <= evidence.endLine && styles.marked,
            )}
          >
            <span className={styles.number}>{line}</span>
            <CodeTokens tokens={tokens} />
          </div>
        );
      })}
    </pre>
  );
}

/** A GitHub thread from the code: the code the reviewer saw, the thread, and a Codex task. */
function ThreadCard({
  thread,
  snapshot,
  queued,
  onQueue,
  selection,
}: {
  thread: CodeDiscussion;
  snapshot: Snapshot;
  queued: boolean;
  onQueue?: () => void;
  selection: ReturnType<typeof useCodexSelection>;
}) {
  const { sessionData, openSource, reviewDiscussion } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const [replyOpen, setReplyOpen] = useState(0);
  const location = thread.root.location!;
  const line = location.line ?? location.originalLine;
  return (
    <article className={styles.card}>
      <RemoteHeader
        comment={thread.root}
        queued={queued}
        onQueue={onQueue}
        expanded={expanded}
        onExpand={() => setExpanded(!expanded)}
        onCode={thread.evidence ? () => void openSource(thread.evidence!) : undefined}
        location={`${location.path}${line ? `:${line}` : ''}`}
        replies={thread.replies.length}
        onReply={() => {
          setExpanded(true);
          setReplyOpen((n) => n + 1);
        }}
        selection={selection}
        item={{
          id: thread.root.id,
          discussionId: thread.root.id,
          repoId: snapshot.repoId,
          body: codexTask(thread),
          evidence: thread.evidence,
        }}
      />
      {expanded && (
        <div className={styles.details}>
          {thread.root.diffHunk ? (
            <div className={styles.hunk}>
              <Diff
                patch={tailHunk(thread.root.diffHunk, HUNK_LINES)}
                repoId={snapshot.repoId}
                path={location.path}
                onSelect={() => undefined}
              />
            </div>
          ) : thread.evidence && sessionData ? (
            <CodeExcerpt
              sessionId={sessionData.id}
              snapshotId={snapshot.id}
              evidence={thread.evidence}
            />
          ) : (
            <p className={styles.note}>{t('The code of this comment is only on GitHub.')}</p>
          )}
          {sessionData && (
            <DiscussionThread
              thread={thread}
              sessionId={sessionData.id}
              onReply={reviewDiscussion.reply}
              onReact={reviewDiscussion.react}
              replyOpen={replyOpen}
            />
          )}
        </div>
      )}
    </article>
  );
}

/** The same compact title, action chain and code icon as the review dialog. */
function RemoteHeader({
  comment,
  queued,
  onQueue,
  expanded,
  onExpand,
  onCode,
  location,
  replies = 0,
  selection,
  item,
  onReply,
}: {
  comment: ReviewDiscussion;
  queued: boolean;
  onQueue?: () => void;
  expanded: boolean;
  onExpand: () => void;
  onCode?: () => void;
  location?: string;
  replies?: number;
  selection: ReturnType<typeof useCodexSelection>;
  item: import('../workspace/useCodexSelection').CodexComment;
  onReply?: () => void;
}) {
  const { reviewDiscussion } = useWorkspace();
  return (
    <div className={rowStyles.commentRow}>
      <input
        type="checkbox"
        checked={selection.has(item)}
        onChange={() => selection.toggle(item)}
        aria-label={t('Select comment')}
        disabled={selection.busy}
      />
      <div className={rowStyles.commentMain}>
        <button
          className={rowStyles.commentTitle}
          aria-expanded={expanded}
          onClick={onExpand}
          title={comment.body}
        >
          {commentTitle(comment.body)}
        </button>
        <div className={rowStyles.chain}>
          <span className={rowStyles.step} title={t('From reviewers on GitHub')}>
            <Icon name="user" size={13} />@{comment.author}
          </span>
          <Icon name="arrowRight" size={11} />
          <span className={rowStyles.step}>
            <Icon name="send" size={13} />
            GitHub
          </span>
          {queued && (
            <>
              <Icon name="arrowRight" size={11} />
              <span className={rowStyles.step} title={t('In the Codex queue')}>
                <Icon name="circleDashed" size={13} />
                Codex
              </span>
            </>
          )}
          {replies > 0 && (
            <span className={rowStyles.step}>
              <Icon name="message" size={13} />
              {replies}
            </span>
          )}
          {comment.location?.line === null && (
            <span className={rowStyles.step} title={location}>
              {t('Outdated')}
            </span>
          )}
        </div>
      </div>
      <div className={rowStyles.actions}>
        <MessageReactions comment={comment} onReact={reviewDiscussion.react} />
        {onReply && <IconButton icon="message" label={t('Reply')} onClick={onReply} />}
        <IconButton
          icon="play"
          label={t('Run in Codex')}
          onClick={() => selection.run(true, item)}
          disabled={selection.busy}
        />
        {onCode && (
          <IconButton icon="code" label={t('Code related to this comment')} onClick={onCode} />
        )}
        {!queued && onQueue && (
          <IconButton icon="sparkles" label={t('Add to the Codex queue')} onClick={onQueue} />
        )}
        <a
          className={styles.external}
          href={comment.url}
          target="_blank"
          rel="noreferrer"
          aria-label={t('Open on GitHub')}
          title={t('Open on GitHub')}
        >
          <Icon name="externalLink" size={15} />
        </a>
      </div>
    </div>
  );
}
function GeneralComment({
  comment,
  queued,
  onQueue,
  selection,
  repoId,
  replies,
}: {
  comment: ReviewDiscussion;
  queued: boolean;
  onQueue?: () => void;
  selection: ReturnType<typeof useCodexSelection>;
  repoId: string;
  replies: ReviewDiscussion[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [replyOpen, setReplyOpen] = useState(0);
  const { sessionData, reviewDiscussion } = useWorkspace();
  return (
    <article className={styles.card}>
      <RemoteHeader
        comment={comment}
        selection={selection}
        item={{
          id: comment.id,
          repoId,
          discussionId: comment.id,
          body: codexTask({ root: comment, replies: [] }),
        }}
        queued={queued}
        onQueue={onQueue}
        expanded={expanded}
        onExpand={() => setExpanded(!expanded)}
        replies={replies.length}
        onReply={
          !comment.replyTo
            ? () => {
                setExpanded(true);
                setReplyOpen((n) => n + 1);
              }
            : undefined
        }
      />
      {expanded && (
        <div className={styles.details}>
          {sessionData && (
            <DiscussionThread
              thread={{ root: comment, replies }}
              sessionId={sessionData.id}
              onReply={reviewDiscussion.reply}
              onReact={reviewDiscussion.react}
              replyOpen={replyOpen}
            />
          )}
        </div>
      )}
    </article>
  );
}

/** A task for Codex made from a GitHub thread: what was asked and where, in the reviewer's words. */
function codexTask(thread: Pick<CodeDiscussion, 'root' | 'replies'>) {
  const quote = (comment: ReviewDiscussion) =>
    `@${comment.author}:\n${comment.body
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}`;
  const where = thread.root.location
    ? `${thread.root.location.path}${thread.root.location.line ? `:${thread.root.location.line}` : ''}`
    : '';
  return [
    where
      ? t('Address the review comment on GitHub at {0}.', where)
      : t('Address the review comment on GitHub.'),
    quote(thread.root),
    ...thread.replies.map(quote),
  ].join('\n\n');
}

/**
 * Every comment of the review in one place: what reviewers wrote on GitHub, with the code they
 * saw, and the reviewer's own comments and Codex tasks with their code. Any of them can be handed
 * to Codex, which then fixes it from the fix plan.
 */
export function CommentsPage() {
  const {
    session,
    sessionData,
    drafts,
    updateDraft,
    addComment,
    reviewDiscussion,
    reviewVersion,
    repoName,
    openSource,
    setFixChatOpen,
  } = useWorkspace();
  const completed = useFixCompletions(sessionData?.id);
  const selection = useCodexSelection();
  const [filter, setFilter] = useState<'all' | 'github' | 'own'>('all');
  if (!session || !sessionData) return null;
  const reviewed = sessionData.snapshots.filter((snapshot) => snapshot.pr || snapshot.local);
  const editable = !reviewVersion;
  const allDrafts = [
    ...drafts,
    ...(sessionData.history ?? []).flatMap((revision) => revision.drafts),
  ];
  const queued = new Set(
    drafts.flatMap((draft) =>
      draft.comments.flatMap((comment) =>
        comment.forCodex && comment.discussionId
          ? [`${draft.snapshotId}:${comment.discussionId}`]
          : [],
      ),
    ),
  );
  const groups = reviewed.map((snapshot) => {
    const comments = reviewDiscussion.comments.filter(
      (comment) => comment.repoId === snapshot.repoId,
    );
    const threads = reviewThreads(comments, snapshot, allDrafts);
    // Conversation comments and review summaries are not on a line.
    const general = comments.filter(
      (comment) =>
        !comment.id.startsWith('inline:') &&
        comment.body.trim() &&
        (!comment.replyTo || !comments.some((c) => c.id === comment.replyTo)),
    );
    const draft = drafts.find((item) => item.snapshotId === snapshot.id);
    return { snapshot, threads, general, draft };
  });
  const queue = (
    snapshot: Snapshot,
    thread: Pick<CodeDiscussion, 'root' | 'replies' | 'evidence'>,
  ) =>
    editable
      ? () =>
          addComment(codexTask(thread), thread.evidence ?? null, true, 'current', {
            repoId: snapshot.repoId,
            discussionId: thread.root.id,
          })
      : undefined;
  const githubCount = groups.reduce((n, g) => n + g.threads.length + g.general.length, 0);
  const ownCount = groups.reduce((n, g) => n + (g.draft?.comments.length ?? 0), 0);
  const isDone = (snapshot: Snapshot, comment: DraftComment) =>
    completed.some((step) => step.repoId === snapshot.repoId && step.commentId === comment.id);
  const openTasks = groups.reduce(
    (n, g) =>
      n +
      (g.draft?.comments.filter((comment) => comment.forCodex && !isDone(g.snapshot, comment))
        .length ?? 0),
    0,
  );
  const ownRow = (snapshot: Snapshot, draft: ReviewDraft, comment: DraftComment) => {
    const target = commentSource(sessionData, comment, draft.snapshotId);
    return (
      <ReviewCommentRow
        key={comment.id}
        comment={comment}
        disabled={selection.busy}
        selected={selection.has({ ...comment, repoId: snapshot.repoId })}
        onSelect={
          editable && draft.state === 'draft' && !isDone(snapshot, comment)
            ? () => selection.toggle({ ...comment, repoId: snapshot.repoId })
            : undefined
        }
        onRun={
          editable && draft.state === 'draft' && !isDone(snapshot, comment)
            ? () => selection.run(true, { ...comment, repoId: snapshot.repoId })
            : undefined
        }
        sentAt={draft.state === 'submitted' && comment.selected ? draft.submission?.at : undefined}
        author={reviewDiscussion.comments.find((item) => item.id === comment.discussionId)?.author}
        completion={
          comment.forCodex
            ? completed.find((s) => s.repoId === snapshot.repoId && s.commentId === comment.id)
            : undefined
        }
        onCode={target ? () => void openSource(target.evidence, target.versionId) : undefined}
        onChange={
          editable && draft.state === 'draft'
            ? (patch) =>
                updateDraft({
                  ...draft,
                  comments: draft.comments.map((item) =>
                    item.id === comment.id ? { ...item, ...patch } : item,
                  ),
                })
            : undefined
        }
      />
    );
  };
  return (
    <section className={styles.page} aria-label={t('Comments')}>
      <header className={styles.toolbar}>
        <h2>{t('Comments')}</h2>
        <div className={styles.filters} role="group" aria-label={t('Which comments')}>
          {(
            [
              ['all', t('All'), githubCount + ownCount],
              ['github', t('From reviewers'), githubCount],
              ['own', t('Mine and Codex tasks'), ownCount],
            ] as const
          ).map(([id, label, count]) => (
            <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label} <span>{count}</span>
            </button>
          ))}
        </div>
        {openTasks > 0 && (
          <button className={styles.plan} onClick={() => setFixChatOpen(true)}>
            {t('Codex queue · {0}', openTasks)}
          </button>
        )}
      </header>
      {reviewDiscussion.error && (
        <p className="alert error" role="alert">
          {reviewDiscussion.error}
        </p>
      )}
      {!githubCount && !ownCount && (
        <Empty title={t('No comments yet')}>
          {reviewDiscussion.loading
            ? t('Loading the discussion from GitHub…')
            : t('Comments from GitHub and your own comments on the code appear here.')}
        </Empty>
      )}
      {groups.map(({ snapshot, threads, general, draft }) => (
        <div key={snapshot.id} className={styles.repository}>
          {reviewed.length > 1 && (
            <h3 className={styles.repositoryName}>{repoName(snapshot.repoId)}</h3>
          )}
          {filter !== 'own' && (threads.length > 0 || general.length > 0) && (
            <section className={styles.group}>
              <h4>
                {t('From reviewers on GitHub')} <span>{threads.length + general.length}</span>
              </h4>
              {threads.map((thread) => (
                <ThreadCard
                  key={thread.root.id}
                  thread={thread}
                  selection={selection}
                  snapshot={snapshot}
                  queued={queued.has(`${snapshot.id}:${thread.root.id}`)}
                  onQueue={queue(snapshot, thread)}
                />
              ))}
              {general.map((comment) => (
                <GeneralComment
                  key={comment.id}
                  comment={comment}
                  selection={selection}
                  repoId={snapshot.repoId}
                  replies={reviewDiscussion.comments.filter(
                    (c) => c.repoId === snapshot.repoId && c.replyTo === comment.id,
                  )}
                  queued={queued.has(`${snapshot.id}:${comment.id}`)}
                  onQueue={queue(snapshot, { root: comment, replies: [] })}
                />
              ))}
            </section>
          )}
          {filter !== 'github' && draft && draft.comments.length > 0 && (
            <section className={styles.group}>
              <h4>
                {t('Mine and Codex tasks')} <span>{draft.comments.length}</span>
              </h4>
              {draft.comments
                .filter((comment) => !comment.forCodex || !isDone(snapshot, comment))
                .map((comment) => ownRow(snapshot, draft, comment))}
              {draft.comments.some((comment) => comment.forCodex && isDone(snapshot, comment)) && (
                <details className={rowStyles.history}>
                  <summary>
                    {t('History')} ·{' '}
                    {
                      draft.comments.filter(
                        (comment) => comment.forCodex && isDone(snapshot, comment),
                      ).length
                    }
                  </summary>
                  {draft.comments
                    .filter((comment) => comment.forCodex && isDone(snapshot, comment))
                    .map((comment) => ownRow(snapshot, draft, comment))}
                </details>
              )}
            </section>
          )}
        </div>
      ))}
      <CodexSelectionActions selection={selection} />
    </section>
  );
}
