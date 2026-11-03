import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FixChatWindow } from './FixChat';
import { useWorkspace } from './workspace/state';
import type { FixChat, FixChatEvent } from '../shared/fix-chat';
import type { AnalysisRun, ReviewSession, Snapshot } from '../shared/model';
import { api } from './api';
import { fetchSession } from './sessions';
import { Markdown } from './Markdown';
import { IconButton } from './icons';
import { cx } from './ui/cx';
import styles from './AnalysisChat.module.css';
import { errorMessage } from '../shared/errors';
import { getLanguage, t } from '../shared/i18n';
import { commandSummary, fileChangesSummary, fixCommandSummary } from '../shared/command-summary';

const TerminalView = lazy(() => import('./TerminalView'));
const labels: Record<string, string> = {
  prepare: t('Preparation'),
  review: t('Diagrams and changes'),
  scenarios: t('Diagrams'),
  sql: t('Database'),
  tests: t('Tests'),
  done: t('Done'),
};
export function AnalysisChat({
  sessionId,
  run,
  snapshots,
  onUpdate,
}: {
  sessionId: string;
  snapshots: Snapshot[];
  run: AnalysisRun | null;
  onUpdate: (session: ReviewSession) => void;
}) {
  const { fixChatOpen, setFixChatOpen, sessionData, saveDrafts, load } = useWorkspace();
  const [fixChat, setFixChat] = useState<FixChat | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (fixChatOpen) {
      setOpen(true);
      setTab('codex');
    }
  }, [fixChatOpen]);
  const observedFixUpdate = useRef('');
  useEffect(() => {
    let active = true;
    const sync = async () => {
      try {
        const chat = await api<FixChat | null>(`/sessions/${sessionId}/fix-chat`);
        if (active) setFixChat(chat);
        if (
          active &&
          chat?.postFix?.state === 'complete' &&
          observedFixUpdate.current !== chat.postFix.turnId
        ) {
          observedFixUpdate.current = chat.postFix.turnId;
          onUpdate(await fetchSession(sessionId));
        }
      } catch {
        /* The ordinary session status remains available offline. */
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);
  // The terminal mounts on first use and stays, so switching tabs keeps its screen.
  const [tab, setTab] = useState<'codex' | 'terminal'>('codex');
  const [terminalUsed, setTerminalUsed] = useState(false);
  const folders = snapshots.filter(
    (s, i) => snapshots.findIndex((other) => other.repoId === s.repoId) === i,
  );
  const [terminalRepo, setTerminalRepo] = useState(
    (folders.find((s) => s.pr || s.local) ?? folders[0])?.repoId ?? '',
  );
  const [cwd, setCwd] = useState('');
  const show = (next: 'codex' | 'terminal') => {
    if (next === 'terminal') setTerminalUsed(true);
    if (tab === next) setOpen(!open);
    else {
      setTab(next);
      setOpen(true);
    }
  };
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scroll = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    follow = useRef(true);
  useEffect(() => {
    if (!text && input.current) input.current.style.height = '';
  }, [text]);
  const logOpen = open && tab === 'codex';
  // The log follows the latest action unless you scrolled up to read; it opens at the end.
  const toEnd = () => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  };
  useLayoutEffect(() => {
    follow.current = true;
    toEnd();
  }, [logOpen]);
  useLayoutEffect(() => {
    if (!logOpen || !content.current) return;
    const observer = new ResizeObserver(toEnd);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [logOpen]);
  const running = run?.state === 'running';
  const canSend = !busy && !!run && !!text.trim() && run.state !== 'complete';
  const action = async (endpoint: string, body: object = {}) => {
    setBusy(true);
    setError('');
    try {
      await api(`/sessions/${sessionId}/${endpoint}`, 'POST', body);
      onUpdate(await fetchSession(sessionId));
      if (endpoint === 'analysis-message') setText('');
      follow.current = true;
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const analysisHistory = [
    ...(sessionData?.history?.map((r) => r.run) ?? []),
    ...(run ? [run] : []),
  ].filter((r, i, all) => all.findLastIndex((other) => other.id === r.id) === i);
  const analysisEvents = analysisHistory.flatMap((run) => {
    const events = run.events ?? [];
    return [
      ...events
        // A finished command repeats the started one with its output; keep only the latest.
        .filter(
          (event, i) =>
            event.kind !== 'tool' ||
            !events
              .slice(i + 1)
              .some(
                (later) => later.kind === 'tool' && later.message.startsWith(`${event.message}\n`),
              ),
        )
        .map((event) => ({
          id: `event:${run.id}:${event.seq}`,
          at: event.at,
          kind: event.kind ?? 'progress',
          text: event.message,
        })),
      ...(run.messages ?? []).map((message) => ({ ...message, kind: 'user' })),
    ];
  });
  const timeline: (Omit<FixChatEvent, 'kind'> & { kind: string })[] = [
    ...analysisEvents,
    ...(fixChat?.events ?? []),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const title = (item: (typeof timeline)[number]) =>
    item.kind === 'user'
      ? t('You')
      : item.kind === 'tool'
        ? t('Reading local code')
        : item.kind === 'command'
          ? t('Execution and checks')
          : item.kind === 'files'
            ? t('File changes')
            : item.kind === 'rollback'
              ? t('Summary of changes and rollback point')
              : item.kind === 'request'
                ? item.request?.kind === 'question'
                  ? t('Question from Codex')
                  : t('Approval needed')
                : 'Codex';
  const body = (item: (typeof timeline)[number]) => {
    const command = item.text.split('\n')[0];
    if (item.kind === 'assistant' || item.kind === 'user') return <Markdown>{item.text}</Markdown>;
    if (item.kind === 'tool')
      return (
        <p className={styles.action} title={command}>
          {commandSummary(item.text)}
        </p>
      );
    if (item.kind === 'command')
      return (
        <p className={styles.action} title={command}>
          {fixCommandSummary(item.text)}
        </p>
      );
    if (item.kind === 'files')
      return <p className={styles.action}>{fileChangesSummary(item.text)}</p>;
    if (item.kind === 'request' && item.request) return <Markdown>{item.request.prompt}</Markdown>;
    if (item.kind === 'plan' && item.tasks)
      return (
        <ul className={styles.plan}>
          {item.tasks.map((task, index) => (
            <li key={index}>
              {task.completed ? '✓' : '○'} {task.text}
            </li>
          ))}
        </ul>
      );
    if (item.kind === 'rollback')
      return (
        <details>
          <summary>{item.text.split('\n')[0]}</summary>
          <pre>{item.text.split('\n').slice(1).join('\n')}</pre>
        </details>
      );
    return <pre>{item.text}</pre>;
  };
  return (
    <section
      className={cx(styles.analysisChat, open && styles.expanded)}
      aria-label={t('Codex analysis chat')}
    >
      <header>
        <IconButton
          icon={open ? 'chevronDown' : 'chevronUp'}
          label={open ? t('Collapse chat') : t('Expand chat')}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        />
        <div className={styles.panelTabs} role="tablist" aria-label={t('Bottom panel')}>
          <button
            role="tab"
            aria-selected={tab === 'codex'}
            className={cx(styles.panelTab, tab === 'codex' && styles.active)}
            onClick={() => show('codex')}
          >
            Codex
          </button>
          <button
            role="tab"
            aria-selected={tab === 'terminal'}
            className={cx(styles.panelTab, tab === 'terminal' && styles.active)}
            onClick={() => show('terminal')}
          >
            {t('Terminal')}
          </button>
        </div>
        {tab === 'terminal' ? (
          <>
            {folders.length > 1 && (
              <select
                className={styles.terminalRepo}
                aria-label={t('Repository of the terminal')}
                value={terminalRepo}
                onChange={(event) => setTerminalRepo(event.target.value)}
              >
                {folders.map((s) => (
                  <option key={s.repoId} value={s.repoId}>
                    {s.repoName}
                  </option>
                ))}
              </select>
            )}
            <span className={styles.analysisChatScope} title={cwd}>
              {cwd}
            </span>
          </>
        ) : (
          <>
            <span className={styles.analysisChatStage} role="status">
              {running && <span className="status-dot running" />}
              {labels[run?.checkpoint?.stage ?? ''] ?? t('Ready to analyze')}
              {run?.state === 'cancelled'
                ? t(' · stopped')
                : run?.state === 'partial'
                  ? t(' · paused')
                  : ''}
            </span>
            <span className={styles.analysisChatScope}>
              {snapshots
                .filter((s) => s.pr || s.local)
                .map((s) =>
                  t(
                    '{0} · {1} · {2} files',
                    s.repoName,
                    s.local
                      ? `${s.local.baseRef} → ${s.local.branchName ?? t('working copy')}`
                      : `PR #${s.pr!.number}`,
                    s.files.length,
                  ),
                )
                .join('; ')}
            </span>
            {run?.usage && (
              <small title={t('Input includes cached tokens')}>
                {t('Input')} {run.usage.input.toLocaleString(getLanguage())} {t('· Cache')}{' '}
                {run.usage.cached.toLocaleString(getLanguage())} {t('· Output')}{' '}
                {run.usage.output.toLocaleString(getLanguage())}
              </small>
            )}
          </>
        )}
      </header>
      {terminalUsed && terminalRepo && (
        <Suspense fallback={null}>
          <TerminalView
            sessionId={sessionId}
            repoId={terminalRepo}
            visible={open && tab === 'terminal'}
            onCwd={setCwd}
          />
        </Suspense>
      )}
      {fixChatOpen && (
        <FixChatWindow
          sessionId={sessionId}
          snapshots={snapshots}
          analysisRunning={!!running}
          onClose={() => setFixChatOpen(false)}
          onSave={async () => {
            await saveDrafts();
          }}
          onRefresh={async () => {
            await api(`/sessions/${sessionId}/refresh`, 'POST', { analyze: true });
            await load(sessionId);
          }}
        />
      )}
      {logOpen && (
        <>
          <div
            className={styles.analysisChatLog}
            ref={scroll}
            role="log"
            aria-label={t('Analysis progress')}
            onScroll={() => {
              const node = scroll.current!;
              follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
            }}
          >
            {!timeline.length && (
              <p className="muted">
                {t(
                  'Changed scenarios and diagrams come first, then the database, and related tests last. Codex progress appears here.',
                )}
              </p>
            )}
            <div ref={content}>
              {timeline.map((item) => (
                <article
                  key={item.id}
                  className={cx(
                    styles.analysisChatEntry,
                    item.kind === 'user' && styles.user,
                    (item.kind === 'tool' || item.kind === 'command') && styles.tool,
                  )}
                >
                  <small>
                    {title(item)} ·{' '}
                    {new Date(item.at).toLocaleTimeString(getLanguage(), {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </small>
                  {body(item)}
                </article>
              ))}
            </div>
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <form
            className={styles.analysisChatCompose}
            onSubmit={(event) => {
              event.preventDefault();
              if (canSend) void action('analysis-message', { text });
            }}
          >
            <textarea
              ref={input}
              aria-label={t('Note for the analysis')}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${e.target.scrollHeight + 2}px`;
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }}
              rows={1}
              maxLength={12000}
              placeholder={
                run && run.state !== 'complete'
                  ? t('Add context or clarify the task…')
                  : t('Notes can be added while the analysis is running')
              }
              disabled={!run || run.state === 'complete'}
            />
            <IconButton
              type="submit"
              icon="arrowUp"
              label={t('Add context (Enter)')}
              className={styles.analysisChatSend}
              disabled={!canSend}
            />
          </form>
          <small className={styles.analysisChatHint}>
            {running
              ? t(
                  'A note pauses the current stage. Press “Continue” to include it in the same conversation.',
                )
              : t(
                  'History and finished results are kept. Continuing does not start the review over.',
                )}
          </small>
        </>
      )}
    </section>
  );
}
