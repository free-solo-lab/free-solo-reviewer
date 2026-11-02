import { useEffect, useState } from 'react';
import type { PullRequestPreview } from '../../shared/pull-request-workflow';
import type { ReviewSession } from '../../shared/model';
import { api } from '../api';
import { hydrateSession } from '../sessions';
import { Dialog, DialogTitle } from '../ui/Dialog';
import { useWorkspace } from '../workspace/state';
import { t } from '../../shared/i18n';
import { errorMessage } from '../../shared/errors';
export function CreatePullRequestDialog({ onClose }: { onClose: () => void }) {
  const { sessionData, setSession, refreshLists } = useWorkspace();
  const local = sessionData!.snapshots.filter((s) => s.local || s.working);
  const [repoId, setRepoId] = useState(local[0]?.repoId ?? ''),
    [preview, setPreview] = useState<PullRequestPreview | null>(null);
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setError('');
    setBusy(true);
    void api<PullRequestPreview>(`/sessions/${sessionData!.id}/pull-request/prepare`, 'POST', {
      repoId,
    })
      .then((p) => {
        if (active) {
          setPreview(p);
          setTitle(p.title);
          setBody(p.body);
        }
      })
      .catch((e) => active && setError(errorMessage(e)))
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, [repoId]);
  return (
    <Dialog onClose={onClose} className="draft-dialog">
      <DialogTitle>
        {t(local.some((s) => s.working) ? 'Publish fixes' : 'Create pull request')}
      </DialogTitle>
      <select
        value={repoId}
        disabled={busy}
        aria-label={t('Repository')}
        onChange={(e) => setRepoId(e.target.value)}
      >
        {local.map((s) => (
          <option key={s.repoId} value={s.repoId}>
            {s.repoName}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      {preview && (
        <>
          <p>
            <code>{preview.branch}</code> → <code>{preview.base}</code>
          </p>
          <ul>
            {preview.files.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
          <label>
            {t('Title')}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy || preview.state !== 'prepared' || !!preview.existingPr}
            />
          </label>
          <label>
            {t('Description')}
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={busy || preview.state !== 'prepared' || !!preview.existingPr}
              rows={8}
            />
          </label>
          <button
            className="primary"
            disabled={busy || !title.trim()}
            onClick={() => {
              setBusy(true);
              setError('');
              void api<{ session: ReviewSession; preview: PullRequestPreview }>(
                `/sessions/${sessionData!.id}/pull-request/create`,
                'POST',
                { previewId: preview.id, title, body },
              )
                .then(async (value) => {
                  setSession(await hydrateSession(value.session));
                  await refreshLists();
                  onClose();
                })
                .catch(async (e) => {
                  setError(errorMessage(e));
                  try {
                    const value = await api<{
                      session: ReviewSession;
                      preview: PullRequestPreview;
                    }>(`/sessions/${sessionData!.id}/pull-request/${preview.id}`);
                    setPreview(value.preview);
                    if (value.preview.state === 'complete') {
                      setSession(await hydrateSession(value.session));
                      await refreshLists();
                      onClose();
                    }
                  } catch {
                    /* Keep the failed publication visible until it can be checked. */
                  }
                })
                .finally(() => setBusy(false));
            }}
          >
            {busy
              ? t('Publishing…')
              : preview.state === 'uncertain'
                ? t('Check publication')
                : preview.existingPr
                  ? t('Publish fixes')
                  : t('Publish pull request')}
          </button>
        </>
      )}
      <button onClick={onClose}>{t('Close')}</button>
    </Dialog>
  );
}
