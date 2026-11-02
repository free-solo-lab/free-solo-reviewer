import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexAuth, CodexLoginState } from '../shared/model.js';
import { errorMessage } from '../shared/errors.js';
import { AppError } from './process.js';
import { t } from '../shared/i18n.js';

const CODE_TIMEOUT_MS = 30_000;
/** Codex device codes expire after 15 minutes. */
const LOGIN_TIMEOUT_MS = 16 * 60_000;
/** The analysis copies auth.json into its private home, so the login must not go to the keychain. */
const FILE_STORE = ['-c', 'cli_auth_credentials_store="file"'];

/** The folder Codex keeps its login in; the analysis reads auth.json from here. */
export const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex');
export const codexAuth = (): CodexAuth =>
  process.env.OPENAI_API_KEY
    ? 'api-key'
    : existsSync(join(codexHome(), 'auth.json'))
      ? 'login'
      : null;

/** The CLI bundled with the SDK, so a sign-in needs no separate Codex installation. */
function codexCommand(args: string[]): [string, string[]] {
  if (process.env.REVIEW_CODEX_BIN) return [process.env.REVIEW_CODEX_BIN, args];
  const launcher = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
  return [process.execPath, [launcher, ...args]];
}
export interface CodexLoginTools {
  spawn(args: string[]): ChildProcessWithoutNullStreams;
}
const codexTools: CodexLoginTools = {
  spawn: (args) => {
    const [file, argv] = codexCommand(args);
    return spawn(file, argv, { env: { ...process.env, NO_COLOR: '1' } });
  },
};
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
const lastLine = (text: string) => plain(text).trim().split('\n').at(-1) ?? '';

/**
 * Signs Codex in to ChatGPT through the device flow, or stores an API key, with the same
 * `codex login` the CLI uses: the credentials stay in the Codex folder, never in the app.
 */
export class CodexLogin {
  private current: CodexLoginState = { state: 'idle' };
  private child?: ChildProcessWithoutNullStreams;
  constructor(private tools: CodexLoginTools = codexTools) {}
  status() {
    return this.current;
  }
  cancel() {
    this.child?.kill();
    this.child = undefined;
    this.current = { state: 'idle' };
  }
  async start(): Promise<CodexLoginState> {
    if (this.current.state === 'waiting') return this.current;
    const child = this.tools.spawn(['login', '--device-auth', ...FILE_STORE]);
    this.child = child;
    let output = '';
    const timer = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS);
    const code = new Promise<CodexLoginState>((resolve, reject) => {
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        const text = plain(output);
        const url = /(https:\/\/auth\.openai\.com\/\S+)/.exec(text)?.[1];
        const code = /one-time code[^\n]*\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/.exec(text)?.[1];
        if (code && url) resolve({ state: 'waiting', code, url });
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('error', reject);
      child.on('close', () =>
        reject(new Error(lastLine(output) || t('Codex finished without a sign-in code.'))),
      );
      setTimeout(
        () => reject(new Error(t('Codex did not provide a sign-in code.'))),
        CODE_TIMEOUT_MS,
      );
    });
    child.on('close', (exit) => {
      clearTimeout(timer);
      if (this.child !== child) return;
      this.child = undefined;
      this.current =
        exit === 0
          ? { state: 'done' }
          : { state: 'failed', error: lastLine(output) || t('Sign-in not completed.') };
    });
    try {
      this.current = await code;
    } catch (error) {
      this.cancel();
      throw new AppError(t('Could not start the Codex sign-in: {0}', errorMessage(error)), 502);
    }
    return this.current;
  }
  /** The key goes to `codex login --with-api-key` through stdin, never through arguments. */
  async apiKey(key: string) {
    const child = this.tools.spawn(['login', '--with-api-key', ...FILE_STORE]);
    let output = '';
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end(key + '\n');
    }).catch((error) => {
      throw new AppError(t('Could not save the API key: {0}', errorMessage(error)), 502);
    });
    if (exit !== 0)
      throw new AppError(
        t('Could not save the API key: {0}', lastLine(output) || String(exit)),
        400,
      );
    this.current = { state: 'done' };
    return this.current;
  }
}
