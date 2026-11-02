import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Repository } from '../shared/model';
import { errorMessage } from '../shared/errors';
import { api } from './api';
import { queryKeys, useGitHubAccounts } from './queries';
import { GitHubLoginDialog } from './dialogs/GitHubLoginDialog';
import { t } from '../shared/i18n';

/**
 * The GitHub account that acts on a repository: one of the gh accounts, or the active one.
 * "Sign in…" adds an account or refreshes an expired login and selects it right away.
 */
export function GitHubAccountPicker({
  repo,
  disabled,
  onChange,
}: {
  repo: Repository;
  disabled?: boolean;
  onChange?: (repo: Repository) => void;
}) {
  const queryClient = useQueryClient();
  const github = useGitHubAccounts().data;
  const [saving, setSaving] = useState(false),
    [loggingIn, setLoggingIn] = useState(false),
    [error, setError] = useState('');
  if (repo.slug.startsWith('local/') || !github) return null;
  async function choose(githubUser: string | null) {
    setSaving(true);
    setError('');
    try {
      const updated = await api<Repository>(`/repositories/${repo.id}/github-user`, 'PUT', {
        githubUser,
      });
      queryClient.setQueryData<Repository[]>(queryKeys.repositories, (old = []) =>
        old.map((item) => (item.id === updated.id ? updated : item)),
      );
      onChange?.(updated);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  const logins = [...new Set([...github.accounts, ...(repo.githubUser ? [repo.githubUser] : [])])];
  return (
    <>
      <div className="repo-account">
        <label htmlFor={`github-user-${repo.id}`}>{t('GitHub account')}</label>
        <select
          id={`github-user-${repo.id}`}
          value={repo.githubUser ?? ''}
          disabled={disabled || saving}
          onChange={(e) => void choose(e.target.value || null)}
        >
          <option value="">
            {t('Active in gh')}
            {github.active ? ` · ${github.active}` : ''}
          </option>
          {logins.map((login) => (
            <option value={login} key={login}>
              {login}
              {github.accounts.includes(login) ? '' : t(' · not signed in to gh')}
            </option>
          ))}
        </select>
        <button disabled={disabled || saving} onClick={() => setLoggingIn(true)}>
          {t('Sign in…')}
        </button>
      </div>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {loggingIn && (
        <GitHubLoginDialog
          onClose={() => setLoggingIn(false)}
          onDone={(login) => {
            setLoggingIn(false);
            void choose(login);
          }}
        />
      )}
    </>
  );
}
