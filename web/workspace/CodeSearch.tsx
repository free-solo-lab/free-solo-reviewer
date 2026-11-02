import { useEffect, useMemo, useRef, useState } from 'react';
import type { Evidence, SourceIndex } from '../../shared/model';
import { codeSearchEntries, doubleShift, searchCode } from '../../shared/code-search';
import { loadNavigationIndex } from '../sessions';
import { Dialog, DialogTitle } from '../ui/Dialog';
import { IconButton } from '../icons';
import { useWorkspace } from './state';
import styles from './CodeSearch.module.css';
import { t } from '../../shared/i18n';

const labels = { file: t('File'), class: t('Class'), method: t('Method') };
export function CodeSearch() {
  const { session, goToCode } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [indexes, setIndexes] = useState<SourceIndex[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const version = session?.snapshots.map((snapshot) => snapshot.id).join(',') ?? '';
  useEffect(() => {
    setOpen(false);
    setIndexes([]);
  }, [session?.id, version]);
  useEffect(() => {
    if (!session) return;
    const shortcut = doubleShift(() => {
      setQuery('');
      setActive(0);
      setOpen(true);
    });
    // Shift in the terminal is typing, not a shortcut.
    const inTerminal = (event: KeyboardEvent) =>
      event.target instanceof Element && !!event.target.closest('.xterm');
    const down = (event: KeyboardEvent) => !inTerminal(event) && shortcut.keydown(event);
    const up = (event: KeyboardEvent) => !inTerminal(event) && shortcut.keyup(event);
    const show = () => {
      setQuery('');
      setActive(0);
      setOpen(true);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', shortcut.reset);
    window.addEventListener('reviewer:code-search', show);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', shortcut.reset);
      window.removeEventListener('reviewer:code-search', show);
    };
  }, [session?.id]);
  useEffect(() => {
    if (!open || !session) return;
    let disposed = false;
    setLoading(true);
    setError('');
    void Promise.allSettled(
      session.snapshots.map(async (snapshot) => {
        const index = await loadNavigationIndex(session.id, snapshot.id, 'head');
        if (!disposed)
          setIndexes((current) => [
            ...current.filter((item) => item.repoId !== index.repoId),
            index,
          ]);
      }),
    ).then((results) => {
      if (disposed) return;
      setLoading(false);
      if (results.some((item) => item.status === 'rejected'))
        setError(t('Some classes and methods could not be loaded. File search is available.'));
    });
    return () => {
      disposed = true;
    };
  }, [open, session?.id, version]);
  const entries = useMemo(
    () => codeSearchEntries(session?.snapshots ?? [], indexes),
    [version, indexes],
  );
  const results = useMemo(() => searchCode(entries, query), [entries, query]);
  const selected = Math.min(active, Math.max(0, results.length - 1));
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, results]);
  if (!open || !session) return null;
  const choose = (evidence: Evidence) => {
    goToCode(evidence);
    setOpen(false);
  };
  return (
    <Dialog className={styles.dialog} onClose={() => setOpen(false)} label={t('Code search')}>
      <header>
        <DialogTitle>{t('Code search')}</DialogTitle>
        <small>Shift Shift</small>
        <IconButton icon="close" label={t('Close search')} onClick={() => setOpen(false)} />
      </header>
      <input
        autoFocus
        placeholder={t('Class, method or file name…')}
        value={query}
        role="combobox"
        aria-label={t('Class, method or file name')}
        aria-expanded
        aria-controls="code-search-results"
        aria-activedescendant={results[selected] ? `code-search-${selected}` : undefined}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(
              Math.max(
                0,
                Math.min(results.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)),
              ),
            );
          } else if (event.key === 'Enter' && results[selected]) {
            event.preventDefault();
            choose(results[selected].evidence);
          }
        }}
      />
      <div
        className={styles.results}
        ref={list}
        id="code-search-results"
        role="listbox"
        aria-label={t('Search results')}
      >
        {results.map((entry, index) => (
          <button
            key={entry.id}
            id={`code-search-${index}`}
            role="option"
            aria-selected={index === selected}
            onMouseMove={() => setActive(index)}
            onClick={() => choose(entry.evidence)}
          >
            <span className={styles.kind}>{labels[entry.kind]}</span>
            <div>
              <strong>
                {entry.name}
                {entry.kind === 'method' ? '()' : ''}
              </strong>
              <small>
                {entry.repoName} · {entry.evidence.path}:{entry.evidence.startLine}
              </small>
              {entry.kind === 'method' && <small>{entry.detail}</small>}
            </div>
          </button>
        ))}
        {!results.length && (
          <p>
            {query.trim()
              ? loading
                ? t('Searching classes and methods…')
                : t('Nothing found')
              : t('Type a name · ↑↓ to choose · Enter to open in “Code and review”')}
          </p>
        )}
      </div>
      <footer aria-live="polite">
        {error ||
          (loading
            ? t('Loading the local index…')
            : t('Search all files of the selected review version'))}
      </footer>
    </Dialog>
  );
}
