import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { t } from '../shared/i18n';
import styles from './AnalysisChat.module.css';

type Output =
  { type: 'ready'; cwd: string } | { type: 'data'; data: string } | { type: 'exit'; code: number };

/** ANSI colours readable on the panel's own background in each theme. */
const palettes: Record<'light' | 'dark', ITheme> = {
  light: {
    black: '#1f1f1f',
    red: '#b8412f',
    green: '#3f7a34',
    yellow: '#8a6a12',
    blue: '#2f5fa8',
    magenta: '#8a4f9e',
    cyan: '#2d7a83',
    white: '#80807d',
    brightBlack: '#6b6b68',
    brightRed: '#c04f3a',
    brightGreen: '#4c8c40',
    brightYellow: '#9c7a1a',
    brightBlue: '#3a6fc0',
    brightMagenta: '#9d5fb2',
    brightCyan: '#358b95',
    brightWhite: '#555553',
  },
  dark: {
    black: '#3a3a38',
    red: '#ec8470',
    green: '#9ccc84',
    yellow: '#e6c46e',
    blue: '#7fa8e6',
    magenta: '#c79ae0',
    cyan: '#7cc6cc',
    white: '#d6d6d3',
    brightBlack: '#92928f',
    brightRed: '#f29c8a',
    brightGreen: '#b3dc9d',
    brightYellow: '#f0d48a',
    brightBlue: '#9cbdf0',
    brightMagenta: '#d6b2ea',
    brightCyan: '#99d6db',
    brightWhite: '#ffffff',
  },
};
function theme(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    ...palettes[dark ? 'dark' : 'light'],
    background: style.backgroundColor,
    foreground: style.color,
    cursor: style.color,
    cursorAccent: style.backgroundColor,
    selectionBackground: dark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(0, 0, 0, 0.16)',
  };
}

/**
 * A shell in the repository folder, kept by the server: closing the panel or switching to the
 * Codex tab does not stop it, and its recent output comes back when the view connects again.
 */
export default function TerminalView({
  sessionId,
  repoId,
  visible,
  onCwd,
}: {
  sessionId: string;
  repoId: string;
  visible: boolean;
  onCwd: (cwd: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<{ terminal: Terminal; fit: FitAddon } | null>(null);
  const [state, setState] = useState<'connecting' | 'open' | 'exited' | 'closed'>('connecting');
  const [attempt, setAttempt] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const send = (message: object) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  };
  const exited = useRef(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const terminal = new Terminal({
      fontFamily: "'IBM Plex Mono', Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      macOptionIsMeta: true,
      theme: theme(element),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    view.current = { terminal, fit };
    let disposed = false;
    // Metrics are taken from the font, so it must be loaded before the terminal opens.
    void document.fonts
      .load("12px 'IBM Plex Mono'")
      .catch(() => undefined)
      .then(() => {
        if (disposed) return;
        terminal.open(element);
        if (element.offsetParent) fit.fit();
      });
    const input = terminal.onData((data) => {
      if (exited.current) {
        if (data === '\r') {
          exited.current = false;
          terminal.reset();
          send({ type: 'restart' });
          setState('open');
        }
        return;
      }
      send({ type: 'input', data });
    });
    const resize = terminal.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
    const recolour = () => {
      terminal.options.theme = theme(element);
    };
    const themes = new MutationObserver(recolour);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const sizes = new ResizeObserver(() => {
      if (element.offsetParent && terminal.element) fit.fit();
    });
    sizes.observe(element);
    return () => {
      disposed = true;
      themes.disconnect();
      sizes.disconnect();
      input.dispose();
      resize.dispose();
      terminal.dispose();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const current = view.current;
    if (!current) return;
    const { terminal } = current;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${scheme}://${location.host}/api/sessions/${encodeURIComponent(sessionId)}/terminal?repoId=${encodeURIComponent(repoId)}`,
    );
    socket.current = ws;
    setState('connecting');
    exited.current = false;
    terminal.reset();
    ws.onopen = () => {
      setState('open');
      send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Output;
      if (message.type === 'ready') onCwd(message.cwd);
      else if (message.type === 'data') terminal.write(message.data);
      else {
        exited.current = true;
        setState('exited');
        terminal.write(
          `\r\n\x1b[2m${t('[Process finished. Press Enter to start a new shell.]')}\x1b[0m\r\n`,
        );
      }
    };
    ws.onclose = () => {
      if (socket.current === ws) setState((value) => (value === 'exited' ? value : 'closed'));
    };
    return () => {
      socket.current = null;
      ws.close();
    };
  }, [sessionId, repoId, attempt]);

  useEffect(() => {
    const current = view.current;
    if (!visible || !current?.terminal.element) return;
    current.fit.fit();
    current.terminal.focus();
  }, [visible]);

  return (
    <div className={styles.terminal} hidden={!visible}>
      <div className={styles.terminalHost} ref={host} />
      {state === 'closed' && (
        <p className={styles.terminalNotice} role="status">
          {t('The connection to the terminal was lost.')}{' '}
          <button className="text-button" onClick={() => setAttempt((value) => value + 1)}>
            {t('Reconnect')}
          </button>
        </p>
      )}
    </div>
  );
}
