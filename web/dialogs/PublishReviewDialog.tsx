import type { ReviewDraft } from '../../shared/model';
import { api } from '../api';
import { IconButton } from '../icons';
import { commentLocation } from '../components';
import { useWorkspace } from '../workspace/state';
import { Dialog, DialogClose, DialogTitle } from '../ui/Dialog';
import { GitHubAccountPicker } from '../GitHubAccountPicker';
import { t } from '../../shared/i18n';

export function PublishReviewDialog() {
  const {
    sessionData: session,
    setDrafts,
    load,
    resetReviewRange,
    status,
    busy,
    setNotice,
    preview,
    setPreview,
    task,
    reviewDiscussion,
    repos,
  } = useWorkspace();
  if (!preview || !session) return null;
  const repoId = session.snapshots.find((s) => s.id === preview.snapshotId)?.repoId;
  const repo = repos.find((item) => item.id === repoId);
  const account = repo?.githubUser ?? status?.login;
  return (
    <Dialog
      className="modal review-preview"
      dismissible={!busy}
      closeOnOutsideClick={false}
      onClose={() => setPreview(null)}
    >
      <div className="section-heading">
        <DialogTitle>{t('Publish review')}</DialogTitle>
        <DialogClose asChild>
          <IconButton icon="close" label={t('Close')} tooltip={false} />
        </DialogClose>
      </div>
      <p>
        {t('The review will be sent as')} <strong>{account ?? t('the gh user')}</strong>{' '}
        {t('for commit')} <code>{preview.headSha.slice(0, 7)}</code>.
      </p>
      {repo && <GitHubAccountPicker repo={repo} disabled={!!busy} />}
      <div className="preview-action">{preview.action}</div>
      {session.run?.state === 'partial' && (
        <div className="unknowns">
          {t('The analysis is partial. Check “Unknowns and limitations” before deciding.')}
        </div>
      )}
      <p className="preserve">{preview.body || t('No overall comment')}</p>
      {preview.comments
        .filter((c) => c.selected && !c.forCodex)
        .map((c) => (
          <div className="preview-comment" key={c.id}>
            <small>
              {commentLocation(
                session.snapshots.find((s) => s.id === preview.snapshotId)!,
                c.evidence,
              )}
            </small>
            <p>{c.body}</p>
          </div>
        ))}
      <div className="draft-footer">
        <button onClick={() => setPreview(null)}>{t('Back to editing')}</button>
        <button
          className="primary"
          disabled={!!busy}
          onClick={() =>
            void task(t('Sending the review'), async () => {
              try {
                const d = await api<ReviewDraft>(
                  `/sessions/${session.id}/drafts/${preview.snapshotId}/submit`,
                  'POST',
                  { round: preview.round },
                );
                setDrafts((ds) => ds.map((x) => (x.snapshotId === d.snapshotId ? d : x)));
                setNotice(t('Review published on GitHub.'));
                if (d.state === 'submitted') {
                  await load(session.id);
                  resetReviewRange();
                  const next = await api<ReviewDraft>(
                    `/sessions/${session.id}/drafts/${d.snapshotId}/continue`,
                    'POST',
                    {},
                  );
                  setDrafts((ds) => ds.map((x) => (x.snapshotId === next.snapshotId ? next : x)));
                  void reviewDiscussion.reload();
                }
              } finally {
                setPreview(null);
                const ds = await api<ReviewDraft[]>(`/sessions/${session.id}/drafts`);
                setDrafts(ds);
              }
            })
          }
        >
          {t('Send')} {preview.action === 'APPROVE' ? 'Approve' : t('review')}
        </button>
      </div>
    </Dialog>
  );
}
