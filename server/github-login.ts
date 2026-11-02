import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { GitHubAccounts, GitHubLoginState } from '../shared/model.js';
import { errorMessage } from '../shared/errors.js';
import { AppError, command } from './process.js';
import { githubAccounts } from './github.js';
import { t } from '../shared/i18n.js';

const CODE_TIMEOUT_MS = 20_000;
/** GitHub device codes expire after 15 minutes; gh gives up then as well. */
const LOGIN_TIMEOUT_MS = 16 * 60_000;

export interface GitHubLoginTools {
  spawn(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams;
  accounts(): Promise<GitHubAccounts>;
  switchAccount(login: string): Promise<unknown>;
}
const ghTools: GitHubLoginTools = {
  spawn: (args, env) => spawn('gh', args, { env }),
  accounts: githubAccounts,
  switchAccount: (login) =>
    command('gh', ['auth', 'switch', '--hostname', 'github.com', '--user', login], {
      timeout: 15_000,
    }),
};

/**
 * Adds a `gh` account through GitHub's device flow: the app shows the one-time code and link,
 * the user confirms in a browser. The account that was active stays active for other repositories.
 */
export class GitHubLogin {
  private current: GitHubLoginState = { state: 'idle' };
  private child?: ChildProcessWithoutNullStreams;
  constructor(private tools: GitHubLoginTools = ghTools) {}
  status() {
    return this.current;
  }
  cancel() {
    this.child?.kill();
    this.child = undefined;
    this.current = { state: 'idle' };
  }
  async start(): Promise<GitHubLoginState> {
    if (this.current.state === 'waiting') return this.current;
    const before = await this.tools.accounts();
    // Without a terminal gh prints the code and link and waits; GH_BROWSER keeps it from opening one.
    const child = this.tools.spawn(['auth', 'login', '--hostname', 'github.com', '--web'], {
      ...process.env,
      GH_BROWSER: 'true',
      GH_PROMPT_DISABLED: '1',
    });
    this.child = child;
    let output = '';
    const timer = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS);
    const code = new Promise<GitHubLoginState>((resolve, reject) => {
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        const code = /one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output)?.[1];
        const url = /(https:\/\/github\.com\/login\/device)\b/.exec(output)?.[1];
        if (code && url) resolve({ state: 'waiting', code, url });
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('error', (error: NodeJS.ErrnoException) =>
        reject(
          error.code === 'ENOENT'
            ? new Error(
                t(
                  'GitHub CLI is not installed. Run brew install gh or get it from cli.github.com.',
                ),
              )
            : error,
        ),
      );
      child.on('close', () =>
        reject(new Error(output.trim() || t('gh finished without a sign-in code.'))),
      );
      setTimeout(() => reject(new Error(t('gh did not provide a sign-in code.'))), CODE_TIMEOUT_MS);
    });
    child.on('close', (exit) => {
      clearTimeout(timer);
      if (this.child !== child) return;
      this.child = undefined;
      if (exit !== 0) {
        this.current = {
          state: 'failed',
          error: output.trim().split('\n').at(-1) || t('Sign-in not completed.'),
        };
        return;
      }
      void this.finish(before.active).then(
        (login) => (this.current = { state: 'done', login }),
        (error) => (this.current = { state: 'failed', error: errorMessage(error) }),
      );
    });
    try {
      this.current = await code;
    } catch (error) {
      this.cancel();
      throw new AppError(t('Could not start the GitHub sign-in: {0}', errorMessage(error)), 502);
    }
    return this.current;
  }
  /** gh makes the new account active; the previously active one keeps serving the rest. */
  private async finish(previous: string | null) {
    const login = (await this.tools.accounts()).active;
    if (!login) throw new Error(t('gh did not report which account was signed in.'));
    if (previous && previous !== login) await this.tools.switchAccount(previous);
    return login;
  }
}
