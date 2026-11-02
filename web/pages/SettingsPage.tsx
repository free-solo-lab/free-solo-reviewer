import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMatch } from 'react-router';
import { api } from '../api';
import { queryClient, queryKeys, useAppStatus, useGitHubAccounts } from '../queries';
import { errorMessage } from '../../shared/errors';
import { CodexLoginDialog } from '../dialogs/CodexLoginDialog';
import { GitHubLoginDialog } from '../dialogs/GitHubLoginDialog';
import { Icon } from '../icons';
import { AnalysisSettings } from './AnalysisSettings';
import { IssuesSettings } from './IssuesSettings';
import styles from './SettingsPage.module.css';
import { getLanguage, t, type Language } from '../../shared/i18n';
import { APP_VERSION, RELEASE_NOTES_URL } from '../../shared/version';

/** `/settings` and `/settings/general` show the general settings; older links lead to analysis. */
export function SettingsPage() {
  // Both hooks run on every render: a short-circuit would change the hook order.
  const generalPage = !!useMatch('/settings/general'),
    settingsRoot = !!useMatch('/settings');
  const issues = !!useMatch('/settings/issues');
  const general = generalPage || settingsRoot;
  return issues ? <IssuesSettings /> : general ? <GeneralSettings /> : <AnalysisSettings />;
}

function GeneralSettings() {
  const status = useAppStatus().data;
  const accounts = useGitHubAccounts().data;
  const [connecting, setConnecting] = useState<'github' | 'codex' | null>(null);
  const github = accounts?.current ?? status?.login;
  return (
    <section className={styles.page} aria-label={t('General')}>
      <header className={styles.header}>
        <h1>{t('General')}</h1>
        <p>{t('Settings are stored locally and apply to all your reviews.')}</p>
      </header>
      <div className={styles.card}>
        <LanguagePicker />
      </div>
      <h2 className={styles.sectionTitle}>{t('Connections')}</h2>
      <div className={styles.card}>
        <div className={styles.row}>
          <Icon name="user" />
          <div>
            <strong>GitHub</strong>
            <p className={styles.muted}>
              {github
                ? t(
                    'Signed in as {0}. Accounts in GitHub CLI: {1}.',
                    github,
                    accounts?.accounts.length ?? 1,
                  )
                : t('Not connected. Pull requests cannot be loaded or reviewed.')}
            </p>
          </div>
          <button onClick={() => setConnecting('github')}>
            {github ? t('Add account…') : t('Sign in to GitHub')}
          </button>
        </div>
        <div className={styles.row}>
          <Icon name="sparkles" />
          <div>
            <strong>Codex</strong>
            <p className={styles.muted}>
              {status?.codexAuth === 'api-key'
                ? t('Connected with the OPENAI_API_KEY of the server.')
                : status?.codexAuth
                  ? t('Connected. The sign-in is kept by Codex in ~/.codex.')
                  : t('Not connected. The analysis cannot run.')}
            </p>
          </div>
          <button
            className={status?.codexAuth ? undefined : 'primary'}
            onClick={() => setConnecting('codex')}
          >
            {status?.codexAuth ? t('Change…') : t('Connect Codex')}
          </button>
        </div>
      </div>
      {status?.dataDir && (
        <>
          <h2 className={styles.sectionTitle}>{t('Data')}</h2>
          <div className={styles.card}>
            <div className={styles.row}>
              <Icon name="box" />
              <div>
                <strong>{t('Review data folder')}</strong>
                <p className={styles.muted}>
                  {t('The database and code snapshots of all reviews. Nothing here is published.')}
                </p>
                <code className={styles.path}>{status.dataDir}</code>
              </div>
            </div>
          </div>
        </>
      )}
      <h2 className={styles.sectionTitle}>{t('About')}</h2>
      <div className={styles.card}>
        <div className={styles.row}>
          <Icon name="sparkles" />
          <div>
            <strong>{t('Reviewer {0} · alpha', APP_VERSION)}</strong>
            <p className={styles.muted}>
              {t(
                'Patch releases (0.1.x) only fix problems; minor releases (0.x.0) add features and may change data or settings.',
              )}
            </p>
          </div>
          <a href={RELEASE_NOTES_URL} target="_blank" rel="noreferrer">
            {t('What’s new')} <Icon name="externalLink" size={14} />
          </a>
        </div>
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
    </section>
  );
}

/** Switches the interface and the language Codex writes in; the page reloads in the new one. */
function LanguagePicker() {
  const options = useQuery({
    queryKey: ['settings', 'language'],
    queryFn: () =>
      api<{ language: Language; languages: { id: Language; label: string }[] }>(
        '/settings/language',
      ),
  });
  const [error, setError] = useState('');
  return (
    <div className={styles.row}>
      <Icon name="message" />
      <div>
        <label htmlFor="settings-language">
          <strong>{t('Language')}</strong>
        </label>
        <p className={styles.muted}>
          {t('Menus, messages and the descriptions Codex writes use this language.')}
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
      <select
        id="settings-language"
        className={styles.mode}
        value={getLanguage()}
        disabled={!options.data}
        onChange={(event) => {
          setError('');
          api('/settings/language', 'PUT', { language: event.target.value }).then(
            () => window.location.reload(),
            (cause) => setError(errorMessage(cause)),
          );
        }}
      >
        {options.data?.languages.map((language) => (
          <option key={language.id} value={language.id}>
            {language.label}
          </option>
        ))}
      </select>
    </div>
  );
}
