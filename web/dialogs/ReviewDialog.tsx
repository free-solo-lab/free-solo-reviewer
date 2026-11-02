import { useEffect } from 'react';
import type { DraftComment, PublishedReview, ReviewDraft } from '../../shared/model';
import { api } from '../api';
import { Icon, IconButton } from '../icons';
import { plural } from '../ui/plural';
import { useWorkspace } from '../workspace/state';
import { Dialog, DialogClose, DialogTitle } from '../ui/Dialog';
import styles from './ReviewDialog.module.css';
import { useFixCompletions, queryClient, queryKeys } from '../queries';
import { commentSource } from '../../shared/review-comment';
import { withoutRecheckMarker } from '../../shared/fix-chat';
import { ReviewCommentRow } from './ReviewCommentRow';
import { getLanguage, t } from '../../shared/i18n';
import { useCodexSelection, CodexSelectionActions } from '../workspace/useCodexSelection';

/** The three outcomes of a GitHub review, explained the way the PR author will read them. */
const decisions: [ReviewDraft['action'], string, string][] = [
  ['COMMENT', t('Comment'), t('Send remarks without a decision on the PR')],
  ['APPROVE', t('Approve'), t('Ready to merge')],
  ['REQUEST_CHANGES', t('Request changes'), t('Not ready to merge until the remarks are fixed')],
];

const outcomes: Record<ReviewDraft['action'], string> = {
  COMMENT: t('Comment'),
  APPROVE: t('Approved'),
  REQUEST_CHANGES: t('Changes requested'),
};

/** One review already sent to GitHub: what was decided, when, on which commit and where. */
function PublishedReviewItem({
  review,
  onCode,
}: {
  review: PublishedReview;
  onCode: (comment: DraftComment) => (() => void) | undefined;
}) {
  return (
    <details className={styles.published}>
      <summary className={styles.publishedTop}>
        <strong className={styles[review.action]}>{outcomes[review.action]}</strong>
        <time dateTime={review.submission.at}>
          {new Date(review.submission.at).toLocaleString(getLanguage(), {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
        <span>{plural(review.comments.length, 'comment', 'comments')}</span>
        <a href={review.submission.url} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
      </summary>
      {review.body && <p className={styles.publishedBody}>{review.body}</p>}
      {review.comments.map((comment) => (
        <ReviewCommentRow
          key={comment.id}
          comment={comment}
          sentAt={review.submission.at}
          onCode={onCode(comment)}
        />
      ))}
    </details>
  );
}

export function ReviewDialog() {
  const {
    sessionData: session,
    drafts,
    reviewRepo,
    setDraftDialog,
    setFixChatOpen,
    setDrafts,
    busy,
    setNotice,
    setPreview,
    task,
    saveDrafts,
    load,
    resetReviewRange,
    updateDraft,
    openReview,
    openSource,
    reviewView: view,
    setReviewView: setView,
    currentFixAttention,
  } = useWorkspace();
  const completed = useFixCompletions(session?.id);
  const selection = useCodexSelection(() => setDraftDialog(false));
  const currentSnapshot =
    session?.snapshots.find(
      (snapshot) => snapshot.repoId === reviewRepo || snapshot.id === reviewRepo,
    ) ?? session?.snapshots.find((snapshot) => snapshot.pr || snapshot.local);
  const currentDraft = drafts.find((draft) => draft.snapshotId === currentSnapshot?.id);
  // History belongs to one repository; the other tabs carry over when switching.
  useEffect(
    () => setView((current) => (current === 'history' ? 'comments' : current)),
    [currentSnapshot?.repoId],
  );
  if (!session || !currentDraft || !currentSnapshot) return null;
  const reviewComments = currentDraft.comments.filter((comment) => !comment.forCodex);
  const done = completed.filter((step) => step.repoId === currentSnapshot.repoId);
  // The history reads from the latest action back.
  const history = [...done].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  const completionFor = (id: string) => done.find((step) => step.commentId === id);
  const activeComments = currentDraft.comments.filter(
    (comment) => !comment.forCodex || !completionFor(comment.id),
  );
  const included = reviewComments.filter((comment) => comment.selected).length;
  const historyCount = done.length + (currentDraft.published?.length ?? 0);
  const codexSteps = activeComments.filter((comment) => comment.forCodex);
  const listed = view === 'codex' ? codexSteps : activeComments;
  const showHistory = view === 'history';
  const change = (comment: DraftComment, patch: Partial<DraftComment>) =>
    updateDraft({
      ...currentDraft,
      comments: currentDraft.comments.map((item) =>
        item.id === comment.id ? { ...item, ...patch } : item,
      ),
    });
  const onCode = (comment: DraftComment, snapshotId = currentSnapshot.id) => {
    const target = commentSource(session, comment, snapshotId);
    return target
      ? () => {
          setDraftDialog(false);
          void openSource(target.evidence, target.versionId);
        }
      : undefined;
  };
  const author = (comment: DraftComment) =>
    (session.threadDiscussion ?? session.discussion)?.find(
      (item) => item.id === comment.discussionId,
    )?.author;
  const skip = (comment: DraftComment, skipped: boolean) =>
    void task(t('Updating the fix plan'), async () => {
      await saveDrafts();
      await api(`/sessions/${session.id}/fix-chat/skip`, 'POST', {
        repoId: currentSnapshot.repoId,
        commentId: comment.id,
        skipped,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.fixCompletions(session.id) });
      setDrafts(await api<ReviewDraft[]>(`/sessions/${session.id}/drafts`));
    });
  const accept = (comment: DraftComment) =>
    void task(t('Accepting the fix'), async () => {
      await saveDrafts();
      const draft = await api<ReviewDraft>(
        `/sessions/${session.id}/drafts/${currentSnapshot.id}/comments/${comment.id}/accept-fix`,
        'POST',
        {},
      );
      setDrafts((ds) => ds.map((item) => (item.snapshotId === draft.snapshotId ? draft : item)));
    });
  const followUp = (comment: DraftComment) => {
    const { activity: _activity, ...original } = comment;
    updateDraft({
      ...currentDraft,
      comments: [
        ...currentDraft.comments,
        {
          ...original,
          id: crypto.randomUUID(),
          body: withoutRecheckMarker(comment.body),
          forCodex: true,
          selected: false,
        },
      ],
    });
    setView('codex');
  };
  return (
    <>
      {currentDraft && (
        <Dialog
          className={`modal review-draft-dialog ${styles.dialog}`}
          onClose={() => setDraftDialog(false)}
        >
          <div className="section-heading">
            <DialogTitle>
              {t('Review')} <span className={styles.titleCount}>{activeComments.length}</span>
            </DialogTitle>
            <DialogClose asChild>
              <IconButton autoFocus icon="close" label={t('Close review')} tooltip={false} />
            </DialogClose>
          </div>
          {session.snapshots.filter((snapshot) => snapshot.pr || snapshot.local).length > 1 && (
            <select
              aria-label={t('Review repository')}
              value={currentSnapshot.repoId}
              disabled={!!busy}
              onChange={(event) => void openReview(event.target.value)}
            >
              {session.snapshots
                .filter((snapshot) => snapshot.pr || snapshot.local)
                .map((snapshot) => (
                  <option key={snapshot.id} value={snapshot.repoId}>
                    {snapshot.repoName}
                  </option>
                ))}
            </select>
          )}
          <fieldset className="draft-panel">
            {currentDraft.state === 'submitted' ? (
              <div className="submission-success">
                {t('✓ Review published.')}{' '}
                <a href={currentDraft.submission?.url} target="_blank" rel="noreferrer">
                  {t('Open on GitHub ↗')}
                </a>
                <button onClick={() => void openReview()}>{t('Continue the review')}</button>
              </div>
            ) : currentDraft.state === 'uncertain' || currentDraft.state === 'submitting' ? (
              <div className="unknowns">
                <p>
                  {t(
                    'The submission result is unknown. Publishing again is blocked to avoid a duplicate.',
                  )}
                </p>
                <button
                  onClick={() =>
                    void task(t('Checking with GitHub'), async () => {
                      const d = await api<ReviewDraft>(
                        `/sessions/${session.id}/drafts/${currentDraft.snapshotId}/reconcile`,
                        'POST',
                        {},
                      );
                      const active =
                        d.state === 'submitted'
                          ? await api<ReviewDraft>(
                              `/sessions/${session.id}/drafts/${d.snapshotId}/continue`,
                              'POST',
                              {},
                            )
                          : d;
                      setDrafts((ds) =>
                        ds.map((x) => (x.snapshotId === active.snapshotId ? active : x)),
                      );
                      if (d.state !== 'submitted')
                        setNotice(
                          t(
                            'The sent review has not been found yet. Check GitHub and verify again later.',
                          ),
                        );
                    })
                  }
                >
                  {t('Verify with GitHub')}
                </button>
              </div>
            ) : (
              <>
                {currentFixAttention && (
                  <div className="alert notice" role="status">
                    <span>
                      {currentFixAttention.kind === 'approval'
                        ? t('Codex is waiting for approval')
                        : t('Codex is waiting for your answer')}
                    </span>
                    <button
                      className="primary"
                      onClick={() => {
                        setDraftDialog(false);
                        setFixChatOpen(true);
                      }}
                    >
                      {currentFixAttention.kind === 'approval' ? t('View request') : t('Answer')}
                    </button>
                  </div>
                )}
                <div className={styles.tabs} role="group" aria-label={t('Review comments')}>
                  <button aria-pressed={view === 'comments'} onClick={() => setView('comments')}>
                    {t('Open comments')} <span>{activeComments.length}</span>
                  </button>
                  <button aria-pressed={view === 'codex'} onClick={() => setView('codex')}>
                    <Icon name="sparkles" />
                    {t('Codex steps')} <span>{codexSteps.length}</span>
                  </button>
                  <button aria-pressed={showHistory} onClick={() => setView('history')}>
                    <Icon name="history" />
                    {t('History')} <span>{historyCount}</span>
                  </button>
                </div>
                <div className={styles.items}>
                  {showHistory ? (
                    <>
                      {history.map((completion) => {
                        const editable = currentDraft.comments.find(
                          (c) => c.id === completion.commentId,
                        );
                        const archived = session.history
                          ?.flatMap((r) => r.drafts)
                          .find((d) => d.comments.some((c) => c.id === completion.commentId));
                        const comment = editable ??
                          archived?.comments.find((c) => c.id === completion.commentId) ?? {
                            id: completion.commentId,
                            body: completion.body,
                            evidence: completion.evidence ?? null,
                            forCodex: true,
                            selected: false,
                          };
                        return (
                          <ReviewCommentRow
                            key={completion.commentId}
                            comment={comment}
                            completion={completion}
                            disabled={!!busy}
                            author={author(comment)}
                            onCode={
                              editable || archived
                                ? onCode(
                                    comment,
                                    editable ? currentSnapshot.id : archived!.snapshotId,
                                  )
                                : undefined
                            }
                            onChange={editable ? (patch) => change(comment, patch) : undefined}
                            onDelete={
                              editable
                                ? () =>
                                    updateDraft({
                                      ...currentDraft,
                                      comments: currentDraft.comments.filter(
                                        (c) => c.id !== comment.id,
                                      ),
                                    })
                                : undefined
                            }
                            onAccept={
                              editable && !completion.skipped ? () => accept(comment) : undefined
                            }
                            onRestore={
                              editable?.forCodex && completion.skipped
                                ? () => skip(comment, false)
                                : undefined
                            }
                            onFollowUp={() => followUp(comment)}
                          />
                        );
                      })}
                      {!!currentDraft.published?.length && (
                        <details className={styles.history}>
                          <summary>
                            {t('Sent reviews ·')} {currentDraft.published.length}
                          </summary>
                          {[...currentDraft.published].reverse().map((review) => (
                            <PublishedReviewItem
                              key={review.submission.id}
                              review={review}
                              onCode={(comment) => onCode(comment, review.snapshotId)}
                            />
                          ))}
                        </details>
                      )}
                      {!historyCount && (
                        <p className={styles.empty}>{t('No completed actions yet.')}</p>
                      )}
                    </>
                  ) : (
                    <>
                      {listed.map((comment) => (
                        <ReviewCommentRow
                          key={comment.id}
                          comment={comment}
                          selected={selection.has({ ...comment, repoId: currentSnapshot.repoId })}
                          onSelect={
                            !completionFor(comment.id)
                              ? () =>
                                  selection.toggle({ ...comment, repoId: currentSnapshot.repoId })
                              : undefined
                          }
                          onRun={
                            !completionFor(comment.id)
                              ? () =>
                                  selection.run(true, {
                                    ...comment,
                                    repoId: currentSnapshot.repoId,
                                  })
                              : undefined
                          }
                          completion={completionFor(comment.id)}
                          disabled={!!busy || selection.busy}
                          author={author(comment)}
                          onCode={onCode(comment)}
                          onChange={(patch) => change(comment, patch)}
                          onDelete={() =>
                            updateDraft({
                              ...currentDraft,
                              comments: currentDraft.comments.filter((c) => c.id !== comment.id),
                            })
                          }
                          onSkip={comment.forCodex ? () => skip(comment, true) : undefined}
                          onFollowUp={
                            completionFor(comment.id) ? () => followUp(comment) : undefined
                          }
                        />
                      ))}
                      {!listed.length && (
                        <p className={styles.empty}>
                          {view === 'codex'
                            ? done.length
                              ? t('All Codex steps are done; they are in the history.')
                              : t(
                                  'No steps for Codex yet. Add a task for Codex in the code, or press ▶ on a comment to hand it over.',
                                )
                            : currentDraft.comments.length
                              ? t('All actions are in the history.')
                              : t('No comments yet: select lines in the code to add one.')}
                        </p>
                      )}
                    </>
                  )}
                </div>
                <details className={styles.summaryDetails}>
                  <summary>
                    {t('Overall review comment')}
                    {currentDraft.body.trim() && <Icon name="message" size={13} />}
                  </summary>
                  <textarea
                    id="review-body"
                    aria-label={t('Overall review comment')}
                    disabled={!!busy}
                    className={styles.summary}
                    value={currentDraft.body}
                    onChange={(event) => updateDraft({ ...currentDraft, body: event.target.value })}
                    placeholder={t('Optional…')}
                  />
                </details>
                <div className={`draft-footer ${styles.footer}`}>
                  <span className={styles.footerCount}>
                    {t('In the review')} · {included}
                  </span>
                  {!currentSnapshot.local && (
                    <>
                      <button
                        className={styles.codexButton}
                        disabled={!!busy}
                        title={t('Open the Codex chat')}
                        onClick={() => {
                          setDraftDialog(false);
                          setFixChatOpen(true);
                        }}
                      >
                        <Icon name="sparkles" />
                        Codex
                      </button>
                      <select
                        aria-label={t('Decision on the PR')}
                        disabled={!!busy}
                        value={currentDraft.action}
                        onChange={(event) =>
                          updateDraft({
                            ...currentDraft,
                            action: event.target.value as ReviewDraft['action'],
                          })
                        }
                      >
                        {decisions.map(([action, label, hint]) => (
                          <option key={action} value={action} title={hint}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  <button
                    className="primary"
                    disabled={!!busy}
                    onClick={() =>
                      void task(t('Preparing the review'), async () => {
                        const saved = await saveDrafts();
                        setDraftDialog(false);
                        if (currentSnapshot?.local) {
                          await api(`/sessions/${session.id}/fix-chat`, 'POST', {
                            repoId: currentSnapshot.repoId,
                            action: 'plan',
                            message: '',
                          });
                          await load(session.id);
                          resetReviewRange();
                          setFixChatOpen(true);
                          return;
                        }
                        setPreview(
                          saved?.find((d) => d.snapshotId === currentDraft.snapshotId) ??
                            currentDraft,
                        );
                      })
                    }
                  >
                    {currentSnapshot?.local ? t('Plan fixes') : t('Send review')}
                  </button>
                </div>
                {!showHistory && <CodexSelectionActions selection={selection} />}
              </>
            )}
          </fieldset>
        </Dialog>
      )}
    </>
  );
}
