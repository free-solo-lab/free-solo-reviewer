import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { FixChatWindow } from './FixChat';
import { useWorkspace } from './workspace/state';
import type { FixChat } from '../shared/fix-chat';
import type { AnalysisRun, ReviewSession, Snapshot } from '../shared/model';
import { api } from './api';
import { fetchSession } from './sessions';
import { Markdown } from './Markdown';
import { IconButton } from './icons';
import { cx } from './ui/cx';
import styles from './AnalysisChat.module.css';
import { errorMessage } from '../shared/errors';
import { getLanguage, t } from '../shared/i18n';

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
    input = useRef<HTMLTextAreaElement>(null),
    follow = useRef(true);
  useEffect(() => {
    if (!text && input.current) input.current.style.height = '';
  }, [text]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [run?.events.length, run?.messages?.length, open]);
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
  const analysisEvents = analysisHistory.flatMap((run) => [
    ...(run.events ?? []).map((event) => ({
      id: `event:${run.id}:${event.seq}`,
      at: event.at,
      kind: event.kind ?? 'progress',
      text: event.message,
    })),
    ...(run.messages ?? []).map((message) => ({ ...message, kind: 'user' })),
  ]);
  const timeline = [...analysisEvents, ...(fixChat?.events ?? [])].sort((a, b) =>
    a.at.localeCompare(b.at),
  );
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
            <button
              className="text-button"
              onClick={() => {
                setFixChatOpen(!fixChatOpen);
                setOpen(true);
              }}
            >
              {fixChatOpen ? t('Analysis') : t('Fixes with Codex')}
            </button>
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
      {open && tab === 'codex' && fixChatOpen && (
        <FixChatWindow
          embedded
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
          history={analysisEvents.map((event) => ({
            ...event,
            kind:
              event.kind === 'user'
                ? 'user'
                : event.kind === 'assistant'
                  ? 'assistant'
                  : event.kind === 'tool'
                    ? 'command'
                    : 'status',
          }))}
        />
      )}
      {open && tab === 'codex' && !fixChatOpen && (
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
            {timeline.map((item) => (
              <article
                key={item.id}
                className={cx(
                  styles.analysisChatEntry,
                  item.kind === 'user' && styles.user,
                  item.kind === 'tool' && styles.tool,
                )}
              >
                <small>
                  {item.kind === 'user'
                    ? t('You')
                    : item.kind === 'tool'
                      ? t('Reading local code')
                      : 'Codex'}{' '}
                  ·{' '}
                  {new Date(item.at).toLocaleTimeString(getLanguage(), {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </small>
                {item.kind === 'assistant' || item.kind === 'user' ? (
                  <Markdown>{item.text}</Markdown>
                ) : (
                  <pre>{item.text}</pre>
                )}
              </article>
            ))}
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
