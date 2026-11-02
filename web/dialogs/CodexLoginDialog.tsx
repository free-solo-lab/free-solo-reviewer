import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CodexLoginState } from '../../shared/model';
import { errorMessage } from '../../shared/errors';
import { api } from '../api';
import { queryKeys } from '../queries';
import { Dialog, DialogTitle } from '../ui/Dialog';
import styles from './GitHubLoginDialog.module.css';
import { t } from '../../shared/i18n';

/** Connects Codex: a ChatGPT sign-in with a one-time code, or an OpenAI API key. */
export function CodexLoginDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [login, setLogin] = useState<CodexLoginState | null>(null),
    [key, setKey] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const opened = useRef(false);
  const continueOnOpenAI = (code: string, url: string) => {
    void navigator.clipboard.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false),
    );
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  const run = (request: Promise<CodexLoginState>) => {
    setBusy(true);
    setError('');
    request.then(setLogin, (cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  useEffect(() => {
    if (login?.state !== 'waiting' || opened.current) return;
    opened.current = true;
    continueOnOpenAI(login.code, login.url);
  }, [login?.state]);
  useEffect(() => {
    if (login?.state !== 'waiting') return;
    const timer = setInterval(() => {
      void api<CodexLoginState>('/codex/login').then(setLogin, (cause) =>
        setError(errorMessage(cause)),
      );
    }, 2000);
    return () => clearInterval(timer);
  }, [login?.state]);
  useEffect(() => {
    if (login?.state !== 'done') return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.status });
    onClose();
  }, [login?.state]);
  const close = () => {
    if (login?.state === 'waiting') void api('/codex/login/cancel', 'POST', {}).catch(() => {});
    onClose();
  };
  const failure = error || (login?.state === 'failed' ? login.error : '');
  return (
    <Dialog className="modal" closeOnOutsideClick={false} dismissible={!busy} onClose={close}>
      <DialogTitle>{t('Connect Codex')}</DialogTitle>
      {login?.state === 'waiting' ? (
        <>
          <ol className={styles.steps}>
            <li>
              {t('The OpenAI sign-in page opened in your browser')}
              {copied ? t(', the code is already copied') : ''}
              {t('. Sign in with your ChatGPT account.')}
            </li>
            <li>{t('Paste the code and confirm access for Codex.')}</li>
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
          <p className={styles.waiting}>{t('Waiting for confirmation on OpenAI…')}</p>
        </>
      ) : (
        <>
          <p className={styles.intro}>
            {t(
              'Reviewer analyzes code with Codex. Sign in with a ChatGPT plan that includes Codex, or use an OpenAI API key with usage billing. The sign-in is stored by Codex in ~/.codex, not by Reviewer.',
            )}
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => run(api<CodexLoginState>('/codex/login', 'POST', {}))}
          >
            {busy && !key ? t('Requesting a sign-in code…') : t('Sign in with ChatGPT')}
          </button>
          <form
            className={styles.apiKey}
            onSubmit={(event) => {
              event.preventDefault();
              run(api<CodexLoginState>('/codex/api-key', 'POST', { key }));
            }}
          >
            <label>
              {t('Or an OpenAI API key')}
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-…"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                disabled={busy}
              />
            </label>
            <button type="submit" disabled={busy || key.trim().length < 20}>
              {t('Save key')}
            </button>
          </form>
        </>
      )}
      {failure && (
        <p className="alert error" role="alert">
          {failure}
        </p>
      )}
      <div className="modal-actions">
        <button onClick={close} disabled={busy}>
          {t('Cancel')}
        </button>
        {login?.state === 'waiting' && (
          <button className="primary" onClick={() => continueOnOpenAI(login.code, login.url)}>
            {t('Open OpenAI again ↗')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
