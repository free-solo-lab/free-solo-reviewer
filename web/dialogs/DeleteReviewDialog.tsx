import { api } from '../api';
import { clearDraftCache } from '../draft-cache';
import { useWorkspace } from '../workspace/state';
import { Dialog, DialogTitle } from '../ui/Dialog';
import { t } from '../../shared/i18n';

export function DeleteReviewDialog() {
  const {
    sessionData,
    deleteTarget,
    setDeleteTarget,
    navigate,
    dirty,
    busy,
    error,
    setNotice,
    refreshLists,
    task,
    closeSession,
  } = useWorkspace();
  if (!deleteTarget) return null;
  return (
    <Dialog
      className="modal delete-review-modal"
      dismissible={!busy}
      onClose={() => setDeleteTarget(null)}
    >
      <DialogTitle>{t('Delete the saved review?')}</DialogTitle>
      <p>
        <strong>{deleteTarget.title}</strong>
      </p>
      <p>
        {t(
          'The local analysis, version history, drafts and code snapshots of this review will be deleted. This cannot be undone. The PR and comments published on GitHub stay.',
        )}
      </p>
      {deleteTarget.id === sessionData?.id && dirty && (
        <p>{t('Unsaved draft changes will be deleted too.')}</p>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button autoFocus disabled={!!busy} onClick={() => setDeleteTarget(null)}>
          {t('Cancel')}
        </button>
        <button
          className="danger-button"
          disabled={!!busy}
          onClick={() =>
            void task(t('Deleting the saved review'), async () => {
              const removed = await api<{ ok: boolean; warnings: string[] }>(
                `/sessions/${deleteTarget.id}`,
                'DELETE',
                {},
              );
              try {
                clearDraftCache(deleteTarget.id);
              } catch {
                /* Deletion on server succeeded. */
              }
              if (sessionData?.id === deleteTarget.id) {
                closeSession();
                navigate('/');
              }
              setDeleteTarget(null);
              await refreshLists();
              setNotice(
                removed.warnings.length
                  ? t('Review deleted. {0}', removed.warnings.join(' '))
                  : t('Saved review deleted.'),
              );
              window.setTimeout(() => setNotice(''), 5000);
            })
          }
        >
          {t('Delete review')}
        </button>
      </div>
    </Dialog>
  );
}
