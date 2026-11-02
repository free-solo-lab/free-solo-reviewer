import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { IPty } from 'node-pty';
import { z } from 'zod';
import { t } from '../shared/i18n.js';
import { shellIntegration } from './shell-integration.js';

/** What the page sends: keystrokes, the size of the view, or a new shell after an exit. */
export const terminalInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(100_000) }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(2).max(500),
  }),
  z.object({ type: z.literal('restart') }),
]);
export type TerminalOutput =
  { type: 'ready'; cwd: string } | { type: 'data'; data: string } | { type: 'exit'; code: number };

interface Client {
  send(message: TerminalOutput): void;
}
interface Shell {
  cwd: string;
  pty: IPty | null;
  /** The recent output, replayed when the panel connects again. */
  buffer: string;
  clients: Set<Client>;
  size: { cols: number; rows: number };
}
const BUFFER = 400_000;

const require = createRequire(import.meta.url);
let loaded: typeof import('node-pty') | undefined;
/** node-pty ships its macOS helper without the execute bit; the shell cannot start without it. */
function nodePty() {
  if (loaded) return loaded;
  const module = require('node-pty') as typeof import('node-pty');
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const dir of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
    const helper = join(root, dir, 'spawn-helper');
    if (!existsSync(helper)) continue;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      chmodSync(helper, 0o755);
    }
  }
  return (loaded = module);
}

/**
 * A plain shell in the folder of a reviewed repository, one per folder. It keeps running while
 * the panel is closed or another review is open, so its history and running commands survive.
 */
export class Terminals {
  private shells = new Map<string, Shell>();
  /** `integrationDir` holds the zsh startup files that turn on completion. */
  constructor(private integrationDir?: string) {}

  attach(key: string, cwd: string, client: Client) {
    let shell = this.shells.get(key);
    if (!shell) {
      shell = { cwd, pty: null, buffer: '', clients: new Set(), size: { cols: 100, rows: 24 } };
      this.shells.set(key, shell);
    }
    shell.clients.add(client);
    client.send({ type: 'ready', cwd: shell.cwd });
    if (shell.buffer) client.send({ type: 'data', data: shell.buffer });
    if (!shell.pty) this.start(shell);
    const current = shell;
    return {
      receive: (message: z.infer<typeof terminalInput>) => {
        if (message.type === 'input') current.pty?.write(message.data);
        else if (message.type === 'resize') {
          current.size = { cols: message.cols, rows: message.rows };
          current.pty?.resize(message.cols, message.rows);
        } else if (!current.pty) {
          current.buffer = '';
          this.start(current);
        }
      },
      detach: () => current.clients.delete(client),
    };
  }

  private start(shell: Shell) {
    const broadcast = (message: TerminalOutput) => {
      for (const client of shell.clients) client.send(message);
    };
    // A login shell: the desktop app starts without the user's PATH and shell setup.
    const program = process.env.SHELL || '/bin/zsh';
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !entry[0].startsWith('REVIEW_'),
      ),
    );
    let pty: IPty;
    try {
      pty = nodePty().spawn(program, ['-l'], {
        name: 'xterm-256color',
        cwd: existsSync(shell.cwd) ? shell.cwd : process.env.HOME,
        cols: shell.size.cols,
        rows: shell.size.rows,
        env: {
          ...env,
          ...(this.integrationDir ? shellIntegration(program, this.integrationDir, env) : {}),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          LANG: env.LANG || 'en_US.UTF-8',
        },
      });
    } catch (error) {
      const text = t('The terminal did not start: {0}', (error as Error).message);
      shell.buffer += `${text}\r\n`;
      broadcast({ type: 'data', data: `${text}\r\n` });
      broadcast({ type: 'exit', code: -1 });
      return;
    }
    shell.pty = pty;
    pty.onData((data) => {
      shell.buffer = (shell.buffer + data).slice(-BUFFER);
      broadcast({ type: 'data', data });
    });
    pty.onExit(({ exitCode }) => {
      if (shell.pty !== pty) return;
      shell.pty = null;
      broadcast({ type: 'exit', code: exitCode });
    });
  }

  stopAll() {
    for (const shell of this.shells.values()) {
      const pty = shell.pty;
      shell.pty = null;
      try {
        pty?.kill();
      } catch {
        /* Already gone. */
      }
    }
    this.shells.clear();
  }
}
