import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FixChatWindow } from './FixChat';
import { useWorkspace } from './workspace/state';
import type { FixChat, FixChatEvent } from '../shared/fix-chat';
import type { AnalysisRun, ReviewSession, Snapshot } from '../shared/model';
import { api } from './api';
import { fetchSession } from './sessions';
import { Markdown } from './Markdown';
import { Icon, IconButton, type IconName } from './icons';
import { cx } from './ui/cx';
import styles from './AnalysisChat.module.css';
import { errorMessage } from '../shared/errors';
import { getLanguage, t } from '../shared/i18n';
import { commandSummary, fileChangesSummary, fixCommandSummary } from '../shared/command-summary';

import { LogsView, useSystemLog } from './LogsView';

const TerminalView = lazy(() => import('./TerminalView'));
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
  const [tab, setTab] = useState<'codex' | 'terminal' | 'logs'>('codex');
  const systemLog = useSystemLog();
  // Errors that arrived while the log was not on screen are counted on its tab.
  const [logsSeenAt, setLogsSeenAt] = useState(() => new Date().toISOString());
  const [terminalUsed, setTerminalUsed] = useState(false);
  const folders = snapshots.filter(
    (s, i) => snapshots.findIndex((other) => other.repoId === s.repoId) === i,
  );
  const [terminalRepo, setTerminalRepo] = useState(
    (folders.find((s) => s.pr || s.local) ?? folders[0])?.repoId ?? '',
  );
  const [cwd, setCwd] = useState('');
  const logsOpen = open && tab === 'logs';
  useEffect(() => {
    if (logsOpen) setLogsSeenAt(new Date().toISOString());
  }, [logsOpen, systemLog.entries.length]);
  const unseenErrors = logsOpen
    ? 0
    : systemLog.entries.filter((entry) => entry.level === 'error' && entry.at > logsSeenAt).length;
  const show = (next: 'codex' | 'terminal' | 'logs') => {
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
  // One icon in the Codex tab tells whether Codex works, waits for you or has finished.
  const fixRunning =
    fixChat?.state === 'planning' ||
    fixChat?.state === 'applying' ||
    (fixChat?.state === 'stepped' && !!fixChat.autoSteps);
  const fixLatest = (fixChat?.events.at(-1)?.at ?? '') > (run?.finishedAt ?? run?.startedAt ?? '');
  const status: { tone: string; icon: IconName; label: string } | undefined =
    running || fixRunning
      ? { tone: 'running', icon: 'refresh', label: t('Codex is working') }
      : fixChat?.state === 'waiting_input'
        ? { tone: 'attention', icon: 'alert', label: t('Codex is waiting for your answer') }
        : fixChat?.state === 'waiting_approval'
          ? { tone: 'attention', icon: 'alert', label: t('Codex is waiting for approval') }
          : run?.state === 'failed' || (fixLatest && fixChat?.state === 'failed')
            ? { tone: 'failed', icon: 'alert', label: t('Finished with an error') }
            : run?.state === 'partial' || run?.state === 'cancelled'
              ? { tone: 'stopped', icon: 'stop', label: t('Codex stopped') }
              : run
                ? { tone: 'done', icon: 'check', label: t('Done') }
                : undefined;
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
            title={status?.label}
          >
            Codex
            {status && (
              <span
                className={styles.codexStatus}
                data-tone={status.tone}
                role="img"
                aria-label={status.label}
              >
                <Icon name={status.icon} size={12} />
              </span>
            )}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'terminal'}
            className={cx(styles.panelTab, tab === 'terminal' && styles.active)}
            onClick={() => show('terminal')}
          >
            {t('Terminal')}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'logs'}
            className={cx(styles.panelTab, tab === 'logs' && styles.active)}
            onClick={() => show('logs')}
            title={t('System logs: failed requests, commands, analysis and interface errors')}
          >
            {t('Logs')}
            {unseenErrors > 0 && (
              <span className={styles.logsBadge} aria-label={t('New errors: {0}', unseenErrors)}>
                {unseenErrors}
              </span>
            )}
          </button>
        </div>
        {tab === 'logs' ? null : tab === 'terminal' ? (
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
            {run?.usage && (
              <small className={styles.usage} title={t('Input includes cached tokens')}>
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
      {logsOpen && (
        <LogsView entries={systemLog.entries} error={systemLog.error} onClear={systemLog.clear} />
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
