import { IconButton } from '../icons';
import { Gaps } from '../components';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../workspace/state';
import { queryKeys } from '../queries';
import { CodexLoginDialog } from '../dialogs/CodexLoginDialog';
import { GitHubLoginDialog } from '../dialogs/GitHubLoginDialog';
import { t } from '../../shared/i18n';

export function Notices() {
  const {
    sessions,
    sessionData,
    session,
    openSession,
    status,
    error,
    setError,
    notice,
    setSetup,
    fileViews,
  } = useWorkspace();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState<'github' | 'codex' | null>(null);
  // Both sign-ins can be done from here, so a fresh install needs no terminal.
  const missing = status &&
    !status.demo && [!status.login && 'github', !status.codexAuth && 'codex'];
  return (
    <>
      <div className="mobile-sessions">
        <select
          aria-label={t('Open session')}
          value={session?.id ?? ''}
          onChange={(e) => {
            if (e.target.value) openSession(e.target.value);
          }}
        >
          <option value="">{t('Choose a review')}</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button onClick={() => setSetup(true)}>{t('＋ New')}</button>
      </div>
      {connecting === 'codex' && <CodexLoginDialog onClose={() => setConnecting(null)} />}
      {connecting === 'github' && (
        <GitHubLoginDialog
          onClose={() => setConnecting(null)}
          onDone={() => {
            setConnecting(null);
            void queryClient.invalidateQueries({ queryKey: queryKeys.status });
          }}
        />
      )}
      {/* One stack, so a notice never covers an error shown at the same corner. */}
      <div className="alerts">
        {status?.demo && (
          <div className="alert notice">
            {t(
              'Demo mode. Analysis data is prepared in advance; sending a review is simulated and does not contact GitHub.',
            )}
          </div>
        )}
        {missing && missing.some(Boolean) && (
          <div className="alert notice" role="status">
            <span>
              {missing[0] && missing[1]
                ? t('Connect GitHub and Codex to review pull requests.')
                : missing[0]
                  ? t('Connect GitHub to load pull requests and publish reviews.')
                  : t('Connect Codex to run the analysis.')}
            </span>
            {missing[0] && (
              <button onClick={() => setConnecting('github')}>{t('Sign in to GitHub')}</button>
            )}
            {missing[1] && (
              <button className="primary" onClick={() => setConnecting('codex')}>
                {t('Connect Codex')}
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="alert error" role="alert">
            <span>{error}</span>
            <IconButton
              icon="close"
              label={t('Hide error')}
              tooltip={false}
              onClick={() => setError('')}
            />
          </div>
        )}
        {fileViews.error && (
          <div className="alert error" role="alert">
            <span>{fileViews.error}</span>
            <button onClick={() => void fileViews.reload()}>{t('Retry')}</button>
          </div>
        )}
        {notice && (
          <div className="alert notice" role="status">
            {notice}
          </div>
        )}
      </div>
      {!!sessionData?.refreshWarnings?.length && <Gaps gaps={sessionData.refreshWarnings} />}
    </>
  );
}
