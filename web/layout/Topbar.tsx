import { useEffect, useState } from 'react';
import { CreatePullRequestDialog } from '../dialogs/CreatePullRequestDialog';
import type { ReviewSession } from '../../shared/model';
import { api } from '../api';
import { fetchSession, hydrateSession } from '../sessions';
import { hasRefreshCodeChanges } from '../../shared/review-display';
import { Icon, IconButton } from '../icons';
import { states } from '../workspace/Badge';
import { useWorkspace } from '../workspace/state';
import { cx } from '../ui/cx';
import { ReviewTimeline } from './ReviewTimeline';
import styles from './Topbar.module.css';
import { useFixCompletions } from '../queries';
import { errorMessage } from '../../shared/errors';
import { t } from '../../shared/i18n';

export function Topbar() {
  const {
    sessionData,
    refreshLists,
    setSession,
    setRevisionId,
    currentFixAttention,
    drafts,
    session,
    liveRun,
    setTab,
    dirty,
    busy,
    setError,
    setNotice,
    setSource,
    liveSession,
    load,
    task,
    saveDrafts,
    canAnalyze,
    prLabel,
    openReview,
    currentSnapshot,
    reviewRange,
    changeReviewRange,
    comparisonLoading,
    comment,
  } = useWorkspace();
  const [refreshing, setRefreshing] = useState(false);
  const [publish, setPublish] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  useEffect(() => setEditingTitle(false), [sessionData?.id]);
  const completed = useFixCompletions(sessionData?.id);
  const reviewSnapshot =
    sessionData?.snapshots.find((snapshot) => snapshot.repoId === currentSnapshot?.repoId) ??
    sessionData?.snapshots.find((snapshot) => snapshot.pr || snapshot.local);
  const remote = sessionData?.workflow?.remote?.find((r) => r.repoId === reviewSnapshot?.repoId);
  const currentDraft = drafts.find((draft) => draft.snapshotId === reviewSnapshot?.id);
  const pendingComments =
    currentDraft?.state === 'draft'
      ? currentDraft.comments.filter((comment) => comment.selected && !comment.forCodex).length
      : 0;
  const codexTasks = drafts
    .filter((draft) => draft.state === 'draft')
    .reduce(
      (n, draft) =>
        n +
        draft.comments.filter(
          (comment) => comment.forCodex && !completed.some((step) => step.commentId === comment.id),
        ).length,
      0,
    );
  /**
   * Pulls PR updates; when only the discussion moved, nothing else on the screen is touched.
   * For a local review it can also move the comparison to another base branch.
   */
  const refresh = async (localBases?: Record<string, string>) => {
    if (!session || !sessionData) return;
    setRefreshing(true);
    try {
      if (dirty) await saveDrafts();
      const updated = await hydrateSession(
        await api<ReviewSession>(`/sessions/${session.id}/refresh`, 'POST', {
          ...(localBases ? { localBases } : {}),
          analyze: true,
        }),
      );
      if (liveSession.current !== updated.id) return;
      if (!hasRefreshCodeChanges(sessionData, updated)) {
        const repliesChanged = sessionData.discussionRevision !== updated.discussionRevision;
        {
          setSession(updated);
          setSource((current) =>
            current &&
            current.versionId !== 'current' &&
            !updated.history?.some((revision) => revision.id === current.versionId)
              ? { ...current, versionId: 'current' }
              : current,
          );
        }
        setNotice(
          updated.refreshWarnings?.length
            ? t('Could not check all GitHub replies.')
            : repliesChanged
              ? t('New replies loaded.')
              : t('No new changes.'),
        );
        window.setTimeout(() => setNotice(''), 4000);
        return;
      }
      await task(t('Loading PR changes'), async () => {
        await load(session.id);
        setRevisionId('');
        setNotice(
          updated.refreshWarnings?.length
            ? t('The PR is updated, but the GitHub discussion did not load completely.')
            : localBases
              ? updated.update && !updated.run
                ? t('The base is changed. Analysis has started; the previous review is kept.')
                : t('The base is changed.')
              : updated.update && !updated.run
                ? t(
                    'Updates loaded. A follow-up analysis has started; the previous review is kept.',
                  )
                : t('PR updated.'),
        );
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <header className={styles.topbar}>
      <div className={styles.actionRow}>
        <div className={styles.identity}>
          <div className={styles.breadcrumb}>
            {session && prLabel && (
              <>
                <button className={styles.breadcrumbLink} onClick={() => setTab('overview')}>
                  <Icon name="pullRequest" size={14} />
                  {prLabel}
                </button>
                <span>/</span>
              </>
            )}
            {editingTitle && sessionData ? (
              <form
                className={styles.renameForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  void task(t('Renaming review'), async () => {
                    const renamed = await api<{ title: string }>(
                      `/sessions/${sessionData.id}`,
                      'PATCH',
                      { title: newTitle },
                    );
                    setSession((current) =>
                      current?.id === sessionData.id
                        ? { ...current, title: renamed.title }
                        : current,
                    );
                    setEditingTitle(false);
                    await refreshLists();
                  });
                }}
              >
                <input
                  autoFocus
                  aria-label={t('Review name')}
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setEditingTitle(false);
                  }}
                  maxLength={200}
                />
                <IconButton
                  icon="check"
                  label={t('Save review name')}
                  type="submit"
                  disabled={!!busy || !newTitle.trim()}
                />
                <IconButton
                  icon="close"
                  label={t('Cancel')}
                  onClick={() => setEditingTitle(false)}
                />
              </form>
            ) : (
              <button
                className={styles.renameTitle}
                title={t('Rename review')}
                disabled={!sessionData}
                onClick={() => {
                  setNewTitle(sessionData?.title ?? '');
                  setEditingTitle(true);
                }}
              >
                <strong>{session?.title ?? t('Getting started')}</strong>
                {sessionData && <Icon name="edit" size={13} />}
              </button>
            )}
          </div>
          {session && (
            <div className={styles.meta}>
              <span className={styles.runState}>
                <span className={`status-dot ${liveRun?.state ?? 'ready'}`} />
                {liveRun?.state === 'cancelled'
                  ? t('Analysis stopped.')
                  : states[liveRun?.state ?? 'ready']}
              </span>
              {liveRun && reviewSnapshot && (
                <span className={styles.branch} title={reviewSnapshot.headSha}>
                  {t(
                    'Analyzed: {0} → {1}',
                    liveRun.sourceChanges || liveRun.previousReviewId
                      ? t('Previous analysis')
                      : (reviewSnapshot.pr?.baseRefName ?? reviewSnapshot.local?.baseRef ?? 'base'),
                    reviewSnapshot.headSha.slice(0, 7),
                  )}
                </span>
              )}
              {remote && (
                <span className={styles.branch}>
                  {remote.state === 'merged'
                    ? t('Merged')
                    : remote.state === 'closed'
                      ? t('Closed')
                      : reviewSnapshot?.working
                        ? t('Unpublished local changes')
                        : remote.headSha !== reviewSnapshot?.headSha
                          ? t('New commits on GitHub')
                          : remote.decision === 'approved'
                            ? t('Approved on GitHub')
                            : remote.decision === 'changes_requested'
                              ? t('Changes requested on GitHub')
                              : remote.decision === 'review_required'
                                ? t('Review required on GitHub')
                                : t('Open on GitHub')}
                </span>
              )}
              {reviewSnapshot?.local?.branchName && (
                <span className={styles.branch} title={reviewSnapshot.local.branchName}>
                  {reviewSnapshot.local.branchName}
                </span>
              )}
            </div>
          )}
        </div>
        {session && (
          <div className={styles.topbarActions}>
            <IconButton
              icon="refresh"
              label={
                refreshing
                  ? t('Checking for updates…')
                  : t('Update the PR: new commits and replies')
              }
              className={cx(styles.refresh, refreshing && styles.spinning)}
              disabled={refreshing || !!busy || liveRun?.state === 'running'}
              onClick={() => void refresh()}
            />
            {sessionData?.snapshots.some((snapshot) => snapshot.pr || snapshot.local) && (
              <button
                className={cx(styles.codex, currentFixAttention && styles.fixNeedsAttention)}
                title={
                  currentFixAttention
                    ? t('Codex is waiting for an answer')
                    : t('Steps for Codex: run fixes from the review comments')
                }
                disabled={!!busy}
                onClick={() => void openReview(undefined, 'codex')}
              >
                <Icon name="sparkles" size={14} />
                Codex
                {codexTasks > 0 && <span className={styles.taskCount}>{codexTasks}</span>}
              </button>
            )}
            {liveRun?.state === 'running' ? (
              <button
                className="compact"
                disabled={!!busy}
                onClick={() =>
                  void task(t('Cancelling the analysis'), async () => {
                    await api(`/sessions/${session.id}/cancel`, 'POST', {});
                  })
                }
              >
                <Icon name="stop" size={14} />
                {t('Stop')}
              </button>
            ) : (
              canAnalyze && (
                <button
                  className="compact"
                  disabled={!!busy}
                  onClick={() =>
                    void task(
                      liveRun ? t('Continuing the analysis') : t('Starting the analysis'),
                      async () => {
                        if (dirty) await saveDrafts();
                        await api(
                          `/sessions/${session.id}/${liveRun && liveRun.state !== 'complete' ? 'resume-analysis' : 'analyze'}`,
                          'POST',
                          {},
                        );
                        const updated = await fetchSession(session.id);
                        if (liveSession.current === updated.id) setSession(updated);
                      },
                    )
                  }
                >
                  <Icon name="play" size={14} />
                  {sessionData?.update && !liveRun
                    ? t('Analyze updates')
                    : liveRun
                      ? t('Continue analysis')
                      : t('Analyze')}
                </button>
              )
            )}
            {sessionData?.snapshots.some(
              (s) => (s.local || s.working) && !s.slug.startsWith('local/'),
            ) && (
              <button
                className="compact"
                disabled={!!busy || refreshing || liveRun?.state === 'running'}
                onClick={() => setPublish(true)}
              >
                {t(
                  sessionData.snapshots.some((s) => s.working)
                    ? 'Publish fixes'
                    : 'Create pull request',
                )}
              </button>
            )}
            <button
              className={`primary compact ${styles.review}`}
              disabled={!!busy}
              title={
                pendingComments
                  ? t('Check the comments, choose a decision and send the review')
                  : t('Write an overall comment, approve the PR or request changes')
              }
              onClick={() => void openReview(undefined, 'comments')}
            >
              <Icon name="message" size={14} />
              {t('Review')}
              {pendingComments > 0 && (
                <span
                  className={styles.reviewCount}
                  aria-label={t('comments: {0}', pendingComments)}
                >
                  {pendingComments}
                </span>
              )}
              <Icon name="chevronDown" size={13} />
            </button>
          </div>
        )}
      </div>
      {sessionData && reviewRange && (
        <ReviewTimeline
          points={reviewRange.points}
          from={reviewRange.from.id}
          disabled={!!busy || refreshing || comparisonLoading || !!comment.trim()}
          onChange={async (from) => {
            try {
              await changeReviewRange(from);
            } catch (error) {
              setError(errorMessage(error));
              throw error;
            }
          }}
        />
      )}
      {publish && <CreatePullRequestDialog onClose={() => setPublish(false)} />}
    </header>
  );
}
