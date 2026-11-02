import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import {
  analysisStageNames,
  elapsedMs,
  addTokens,
  emptyTokens,
  type AnalysisStatistic,
  type AnalysisStatisticSummary,
  type TokenUsage,
} from '../../shared/analysis-statistics';
import styles from './StatisticsPage.module.css';
import { getLanguage, t } from '../../shared/i18n';

const statuses = {
  running: t('In progress'),
  complete: t('Complete'),
  partial: t('Partial'),
  failed: t('Error'),
  cancelled: t('Stopped'),
};
const number = (value: number | undefined) =>
  value === undefined ? '—' : value.toLocaleString(getLanguage());
const date = (value: string) =>
  new Date(value).toLocaleString(getLanguage(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
function duration(ms: number) {
  const sec = Math.floor(ms / 1000);
  return sec >= 3600
    ? t('{0} h {1} min', Math.floor(sec / 3600), Math.floor((sec % 3600) / 60))
    : sec >= 60
      ? t('{0} min {1} s', Math.floor(sec / 60), sec % 60)
      : t('{0} s', sec);
}
const total = (usage?: TokenUsage | null) => (usage ? number(usage.input + usage.output) : '—');
export function StatisticsPage() {
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const list = useQuery({
    queryKey: ['settings', 'statistics'],
    queryFn: () => api<AnalysisStatisticSummary[]>('/settings/statistics'),
    refetchInterval: 5000,
  });
  const filtered =
    list.data?.filter((s) =>
      `${s.title} ${statuses[s.status]}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  const current = filtered.find((s) => s.id === selected) ?? filtered[0];
  const detail = useQuery({
    queryKey: ['settings', 'statistics', current?.id, current?.status, current?.finishedAt],
    queryFn: () =>
      api<AnalysisStatistic>(`/settings/statistics/${encodeURIComponent(current!.id)}`),
    enabled: !!current,
    refetchInterval: current?.status === 'running' ? 3000 : false,
  });
  const stat = detail.data;
  return (
    <section className={styles.page} aria-label={t('Analysis statistics')}>
      <aside className={styles.history}>
        <h1>{t('Analysis history')}</h1>
        <input
          aria-label={t('Find a run')}
          placeholder={t('Find a review…')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {list.isPending && <p role="status">{t('Loading history…')}</p>}
        {list.error && (
          <p role="alert">
            {list.error.message} <button onClick={() => void list.refetch()}>{t('Retry')}</button>
          </p>
        )}
        <nav aria-label={t('Analysis runs')}>
          {filtered.map((s) => (
            <button
              key={s.id}
              aria-pressed={s.id === current?.id}
              onClick={() => setSelected(s.id)}
            >
              <strong>{s.title}</strong>
              <small>{date(s.startedAt)}</small>
              <span>
                {statuses[s.status]}
                {s.continued ? t(' · continuation') : ''}
                {s.cacheRestored ? t(' · from cache') : ''}
              </span>
              <small>
                {total(s.usage)} {t('tokens ·')} {duration(s.durationMs)}
              </small>
            </button>
          ))}
        </nav>
        {!list.isPending && !list.error && !filtered.length && (
          <p>{search ? t('Nothing found.') : t('No analysis runs yet.')}</p>
        )}
      </aside>
      <section className={styles.content}>
        <header>
          <h2>{current?.title ?? t('Analysis statistics')}</h2>
          <p>
            {t(
              'History of requests and run time. Cached tokens are part of the input; total = input + output. A dash means the counter was not recorded.',
            )}
          </p>
        </header>
        {current && (
          <div className={styles.summary}>
            <div>
              <small>{t('Total tokens')}</small>
              <strong>{total(current.usage)}</strong>
            </div>
            <div>
              <small>{t('Input / cached')}</small>
              <strong>
                {number(current.usage?.input)} / {number(current.usage?.cached)}
              </strong>
            </div>
            <div>
              <small>{t('Output')}</small>
              <strong>{number(current.usage?.output)}</strong>
            </div>
            <div>
              <small>{t('Run time')}</small>
              <strong>{duration(current.durationMs)}</strong>
            </div>
          </div>
        )}
        {detail.isFetching && !stat && current && <p role="status">{t('Loading stages…')}</p>}
        {detail.error && (
          <p role="alert">
            {detail.error.message}{' '}
            <button onClick={() => void detail.refetch()}>{t('Retry')}</button>
          </p>
        )}
        {stat && (
          <>
            <p>
              {date(stat.startedAt)}
              {stat.finishedAt ? ` → ${date(stat.finishedAt)}` : ''} · {statuses[stat.status]}
              {stat.continued ? t(' · continuation') : ''}
              {stat.provider ? ` · ${stat.provider}` : ''}
              {stat.model ? ` · ${stat.model}` : ''}
            </p>
            {stat.approximate && (
              <p className={styles.note}>
                {t(
                  'Historical run: stages and timing are approximated from the log and may include pauses. Individual requests and their duration were not recorded then.',
                )}
              </p>
            )}
            {stat.cacheRestored && (
              <p className={styles.note}>
                {t('The result was restored from the cache. No new model requests were made.')}
              </p>
            )}
            {!stat.approximate && stat.requests.some((r) => !r.usage) && (
              <p className={styles.note}>
                {t(
                  'For some requests the provider did not report tokens. The total includes only received counters.',
                )}
              </p>
            )}
            <div className={styles.stages}>
              {Object.entries(analysisStageNames).map(([stage, label]) => {
                const intervals = stat.stages.filter((s) => s.stage === stage);
                const requests = stat.requests.filter((r) => r.stage === stage);
                if (!intervals.length && !requests.length) return null;
                const values = stat.approximate
                  ? intervals.flatMap((s) => (s.usage ? [s.usage] : []))
                  : requests.flatMap((r) => (r.usage ? [r.usage] : []));
                const usage = values.length ? values.reduce(addTokens, emptyTokens()) : undefined;
                return (
                  <details key={stage} open className={styles.stage}>
                    <summary>
                      <strong>{label}</strong>
                      <span>
                        {duration(
                          intervals.reduce(
                            (sum, s) => sum + elapsedMs(s.startedAt, s.finishedAt),
                            0,
                          ),
                        )}{' '}
                        · {total(usage)} {t('tokens')}
                        {!stat.approximate ? t(' · requests: {0}', requests.length) : ''}
                      </span>
                    </summary>
                    {requests.length ? (
                      <div className={styles.table}>
                        <table>
                          <thead>
                            <tr>
                              <th>{t('Request')}</th>
                              <th>{t('Start')}</th>
                              <th>{t('Time')}</th>
                              <th>{t('Input')}</th>
                              <th>{t('Cached')}</th>
                              <th>{t('Exit')}</th>
                              <th>{t('Status')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {requests.map((r, i) => (
                              <tr key={r.id}>
                                <td>
                                  #{i + 1}
                                  {r.targets !== undefined && (
                                    <small>
                                      {t('Targets:')} {r.targets}
                                    </small>
                                  )}
                                </td>
                                <td>{date(r.startedAt)}</td>
                                <td>{duration(elapsedMs(r.startedAt, r.finishedAt))}</td>
                                <td>{number(r.usage?.input)}</td>
                                <td>{number(r.usage?.cached)}</td>
                                <td>{number(r.usage?.output)}</td>
                                <td>
                                  {statuses[r.status]}
                                  {r.error && <small className={styles.error}>{r.error}</small>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p>
                        {stat.approximate
                          ? t(
                              'Input: {0} · cached: {1} · output: {2}',
                              number(usage?.input),
                              number(usage?.cached),
                              number(usage?.output),
                            )
                          : t('No model requests at this stage.')}
                      </p>
                    )}
                  </details>
                );
              })}
            </div>
          </>
        )}
      </section>
    </section>
  );
}
