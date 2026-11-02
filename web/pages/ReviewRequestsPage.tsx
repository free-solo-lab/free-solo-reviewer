import { useState } from 'react';
import type { Repository, ReviewRequest, ReviewSession } from '../../shared/model';
import { errorMessage } from '../../shared/errors';
import { isStaleRequest } from '../../shared/review-requests';
import { api } from '../api';
import { Icon } from '../icons';
import { chooseRepositoryDirectory } from '../platform';
import { useGitHubAccounts, useReviewRequests } from '../queries';
import { useWorkspace } from '../workspace/state';
import { SkeletonRows } from '../ui/Skeleton';
import styles from './ReviewRequestsPage.module.css';
import { getLanguage, t } from '../../shared/i18n';

const requestKey = (request: ReviewRequest) => `${request.slug}#${request.number}`;
function byRepository(requests: ReviewRequest[]) {
  const groups = new Map<string, ReviewRequest[]>();
  for (const request of requests)
    groups.set(request.slug, [...(groups.get(request.slug) ?? []), request]);
  return [...groups];
}

/** Pull requests that wait for the current GitHub user's review, grouped by repository. */
export function ReviewRequestsPage() {
  const { repos, addRepository, refreshLists, openSession } = useWorkspace();
  const github = useGitHubAccounts().data;
  const query = useReviewRequests();
  const [starting, setStarting] = useState(''),
    [error, setError] = useState('');
  const now = Date.now();
  const recent = (query.data ?? []).filter((request) => !isStaleRequest(request, now)),
    old = (query.data ?? []).filter((request) => isStaleRequest(request, now));

  /** A local clone of the PR's repository: the connected one or a folder the user picks now. */
  async function localRepository(request: ReviewRequest): Promise<Repository | null> {
    const known = repos.find((repo) => repo.id === request.repoId);
    if (known) return known;
    const path = await chooseRepositoryDirectory();
    if (!path) return null;
    const repo = await api<Repository>('/repositories', 'POST', { path });
    addRepository(repo);
    if (repo.slug.toLowerCase() !== request.slug.toLowerCase())
      throw new Error(
        t(
          'The folder is a clone of {0}, but the PR is from {1}. Choose a clone of {2}.',
          repo.slug,
          request.slug,
          request.slug,
        ),
      );
    return repo;
  }
  async function start(request: ReviewRequest) {
    setStarting(requestKey(request));
    setError('');
    try {
      let repo = await localRepository(request);
      if (!repo) return;
      // The review was requested from the current user: the repository keeps acting as them.
      if (!repo.githubUser && github?.current) {
        repo = await api<Repository>(`/repositories/${repo.id}/github-user`, 'PUT', {
          githubUser: github.current,
        });
        addRepository(repo);
      }
      const session = await api<ReviewSession>('/sessions', 'POST', {
        title: request.title.slice(0, 200),
        repositories: [{ repoId: repo.id, prNumber: request.number }],
      });
      await refreshLists();
      openSession(session.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStarting('');
    }
  }

  const list = (requests: ReviewRequest[]) =>
    byRepository(requests).map(([slug, group]) => (
      <section key={slug} className={styles.group} aria-label={slug}>
        <h2>
          {slug}
          {!group[0].repoId && <span>{t('not connected')}</span>}
        </h2>
        {group.map((request) => (
          <article key={request.number} className={styles.request}>
            <div className={styles.summary}>
              <a href={request.url} target="_blank" rel="noreferrer">
                #{request.number} · {request.title}
              </a>
              <small>
                {request.author} {t('· updated')}{' '}
                {new Date(request.updatedAt).toLocaleDateString(getLanguage())}
                {request.direct ? t(' · you personally') : t(' · your team')}
                {request.draft && t(' · draft')}
              </small>
            </div>
            <button
              className={request.repoId ? 'primary' : undefined}
              disabled={!!starting}
              onClick={() => void start(request)}
            >
              {starting === requestKey(request)
                ? t('Creating the review…')
                : request.repoId
                  ? t('Start review')
                  : t('Choose a folder and start…')}
            </button>
          </article>
        ))}
      </section>
    ));

  return (
    <section className={styles.page} aria-label={t('Review requests')}>
      <header className={styles.header}>
        <div>
          <h1>{t('Review requests')}</h1>
          <p>
            {t('Open PRs waiting for a review from')}{' '}
            {github?.current ? <strong>{github.current}</strong> : t('you')}{' '}
            {t('personally or from your team. Switch the user in the menu at the bottom left.')}
          </p>
        </div>
        <button disabled={query.isFetching} onClick={() => void query.refetch()}>
          <Icon name="refresh" size={14} />
          {query.isFetching ? t('Refreshing…') : t('Refresh')}
        </button>
      </header>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {query.error && (
        <p className="alert error" role="alert">
          {query.error.message}
        </p>
      )}
      {query.isPending && (
        <SkeletonRows
          count={6}
          uniform
          label={t('Loading review requests from GitHub')}
          className={styles.skeleton}
          rowClassName={styles.skeletonRow}
        />
      )}
      {query.data && !query.data.length && (
        <p className={styles.empty}>{t('Nobody is waiting for your review right now.')}</p>
      )}
      {!!old.length && !recent.length && (
        <p className={styles.empty}>{t('No new requests in the last 2 weeks.')}</p>
      )}
      {list(recent)}
      {!!old.length && (
        <details className={styles.stale}>
          <summary>
            {t('No activity for over 2 weeks ·')} {old.length}
          </summary>
          {list(old)}
        </details>
      )}
    </section>
  );
}
