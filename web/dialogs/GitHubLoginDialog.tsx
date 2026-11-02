import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { GitHubLoginState } from '../../shared/model';
import { errorMessage } from '../../shared/errors';
import { api } from '../api';
import { queryKeys } from '../queries';
import { Dialog, DialogTitle } from '../ui/Dialog';
import styles from './GitHubLoginDialog.module.css';
import { t } from '../../shared/i18n';

/** Adds a GitHub account to gh: shows the one-time code and waits for confirmation on github.com. */
export function GitHubLoginDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (login: string) => void;
}) {
  const queryClient = useQueryClient();
  const [login, setLogin] = useState<GitHubLoginState | null>(null),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const opened = useRef(false);
  /** Like `gh auth login --web`: the code goes to the clipboard and GitHub opens in the browser. */
  const continueOnGitHub = (code: string, url: string) => {
    void navigator.clipboard.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false),
    );
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  useEffect(() => {
    let active = true;
    api<GitHubLoginState>('/github/login', 'POST', {}).then(
      (state) => active && setLogin(state),
      (cause) => active && setError(errorMessage(cause)),
    );
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (login?.state !== 'waiting' || opened.current) return;
    opened.current = true;
    continueOnGitHub(login.code, login.url);
  }, [login?.state]);
  useEffect(() => {
    if (login?.state !== 'waiting') return;
    const timer = setInterval(() => {
      void api<GitHubLoginState>('/github/login').then(setLogin, (cause) =>
        setError(errorMessage(cause)),
      );
    }, 2000);
    return () => clearInterval(timer);
  }, [login?.state]);
  useEffect(() => {
    if (login?.state !== 'done') return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.githubAccounts });
    onDone(login.login);
  }, [login?.state]);
  const close = () => {
    if (login?.state === 'waiting') void api('/github/login/cancel', 'POST', {}).catch(() => {});
    onClose();
  };
  const failure = error || (login?.state === 'failed' ? login.error : '');
  return (
    <Dialog className="modal" closeOnOutsideClick={false} onClose={close}>
      <DialogTitle>{t('Add a GitHub account')}</DialogTitle>
      {login?.state === 'waiting' ? (
        <>
          <ol className={styles.steps}>
            <li>
              {t('The GitHub sign-in page opened in your browser')}
              {copied ? t(', the code is already copied') : ''}
              {t(
                '. Sign in with the account you need. If the browser is signed in with another one, sign out or use a private window.',
              )}
            </li>
            <li>{t('Paste the code and confirm access for GitHub CLI.')}</li>
          </ol>
          <div className={styles.code}>
            {login.code}
            <button
              onClick={() =>
                void navigator.clipboard.writeText(login.code).then(() => setCopied(true))
              }
            >
              {copied ? t('Copied') : t('Copy')}
            </button>
          </div>
          <p className={styles.waiting}>{t('Waiting for confirmation on GitHub…')}</p>
        </>
      ) : (
        !failure && <p className={styles.waiting}>{t('Requesting a sign-in code from gh…')}</p>
      )}
      {failure && (
        <p className="alert error" role="alert">
          {failure}
        </p>
      )}
      <div className="modal-actions">
        <button onClick={close}>{t('Cancel')}</button>
        {login?.state === 'waiting' && (
          <button className="primary" onClick={() => continueOnGitHub(login.code, login.url)}>
            {t('Open GitHub again ↗')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
