import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { cx } from './ui/cx';
import styles from './LogsView.module.css';
import { formatLogEntries, type LogEntry, type LogSource } from '../shared/system-log';
import { getLanguage, t } from '../shared/i18n';

const LIMIT = 2000;
const levelClass = { info: undefined, warn: styles.levelWarn, error: styles.levelError };
const key = (entry: LogEntry) => `${entry.source === 'desktop' ? 'd' : 's'}:${entry.seq}`;

/** The server's journal, live: the history first, then each new entry as it happens. */
export function useSystemLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const merge = (incoming: LogEntry[]) =>
      setEntries((previous) => {
        const seen = new Set(previous.map(key));
        const added = incoming.filter((entry) => !seen.has(key(entry)));
        return added.length
          ? [...previous, ...added]
              .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq)
              .slice(-LIMIT)
          : previous;
      });
    // Subscribe before reading the history, so nothing falls between the two.
    const stream = new EventSource('/api/logs/stream');
    stream.onmessage = (event) => merge([JSON.parse(event.data) as LogEntry]);
    stream.onopen = () => setError('');
    stream.onerror = () =>
      setError(t('The server does not answer; new entries will appear once it is back.'));
    void api<{ entries: LogEntry[] }>('/logs')
      .then((data) => active && merge(data.entries))
      .catch((cause: Error) => active && setError(cause.message));
    return () => {
      active = false;
      stream.close();
    };
  }, []);
  const clear = async () => {
    await api('/logs', 'DELETE', {});
    setEntries([]);
  };
  return { entries, error, clear };
}

const levelFilters = {
  all: () => true,
  problems: (entry: LogEntry) => entry.level !== 'info',
  errors: (entry: LogEntry) => entry.level === 'error',
};
const sourceNames: Record<LogSource, string> = {
  http: 'API',
  command: t('Commands'),
  analysis: t('Analysis'),
  process: t('Server'),
  client: t('Interface'),
  desktop: t('Desktop app'),
};

/** Diagnostic journal of the app: failed requests and commands, analysis and interface errors. */
export function LogsView({
  entries,
  error,
  onClear,
}: {
  entries: LogEntry[];
  error: string;
  onClear: () => Promise<void>;
}) {
  const [level, setLevel] = useState<keyof typeof levelFilters>('all');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const visible = useMemo(() => {
    const text = query.trim().toLowerCase();
    return entries.filter(
      (entry) =>
        levelFilters[level](entry) &&
        (!text ||
          `${entry.message}\n${entry.details ?? ''}\n${entry.source}`.toLowerCase().includes(text)),
    );
  }, [entries, level, query]);
  const scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  // Like a terminal: it stays at the newest entry unless you scrolled up to read.
  useLayoutEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [visible.length]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatLogEntries(visible));
      setNotice(t('Copied: {0}', visible.length));
    } catch {
      setNotice(t('Could not copy to the clipboard.'));
    }
    window.setTimeout(() => setNotice(''), 2500);
  };
  return (
    <div className={styles.logs}>
      <div className={styles.toolbar}>
        <select
          aria-label={t('Log level')}
          value={level}
          onChange={(event) => setLevel(event.target.value as keyof typeof levelFilters)}
        >
          <option value="all">{t('All entries')}</option>
          <option value="problems">{t('Warnings and errors')}</option>
          <option value="errors">{t('Errors only')}</option>
        </select>
        <input
          type="search"
          aria-label={t('Search the log')}
          placeholder={t('Search the log…')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className={styles.count} aria-live="polite">
          {notice || `${visible.length}/${entries.length}`}
        </span>
        <button
          className="text-button"
          title={t('Copy the shown entries')}
          disabled={!visible.length}
          onClick={() => void copy()}
        >
          {t('Copy')}
        </button>
        <button
          className="text-button"
          title={t('Clear the log')}
          disabled={!entries.length}
          onClick={() => void onClear().catch((cause: Error) => setNotice(cause.message))}
        >
          {t('Clear')}
        </button>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div
        className={styles.list}
        ref={scroll}
        role="log"
        aria-label={t('System logs')}
        onScroll={() => {
          const node = scroll.current!;
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
        }}
      >
        {!visible.length && (
          <p className={styles.empty}>
            {entries.length
              ? t('No entries match the filter.')
              : t(
                  'No entries yet. Failed requests and commands, analysis errors and interface errors appear here.',
                )}
          </p>
        )}
        {visible.map((entry) => {
          const line = (
            <>
              <time dateTime={entry.at} title={new Date(entry.at).toLocaleString(getLanguage())}>
                {new Date(entry.at).toLocaleString(getLanguage(), {
                  // Older entries, e.g. earlier launches of the desktop app, show their date.
                  ...(new Date(entry.at).toDateString() !== new Date().toDateString() && {
                    day: 'numeric',
                    month: 'short',
                  }),
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </time>
              <span className={styles.level} data-level={entry.level}>
                {entry.level}
              </span>
              <span className={styles.source}>{sourceNames[entry.source]}</span>
              <span className={styles.message}>{entry.message}</span>
            </>
          );
          return entry.details ? (
            <details key={key(entry)} className={cx(styles.entry, levelClass[entry.level])}>
              <summary>{line}</summary>
              <pre>{entry.details}</pre>
            </details>
          ) : (
            <div key={key(entry)} className={cx(styles.entry, levelClass[entry.level])}>
              {line}
            </div>
          );
        })}
      </div>
    </div>
  );
}
