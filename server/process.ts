import { execFile } from 'node:child_process';
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    /** A stable reason the page can offer a way out for. */
    public code?: string,
  ) {
    super(message);
  }
}
export interface CommandDiagnostics {
  exitCode?: number | string | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  durationMs?: number;
  timeoutMs?: number;
}
export class CommandError extends AppError implements CommandDiagnostics {
  readonly exitCode?: number | string | null;
  readonly signal?: NodeJS.Signals | null;
  readonly killed?: boolean;
  readonly durationMs?: number;
  readonly timeoutMs?: number;
  constructor(
    message: string,
    public stdout: string,
    public stderr: string,
    diagnostics: CommandDiagnostics = {},
  ) {
    super(message, 502);
    Object.assign(this, diagnostics);
  }
}
export interface CommandOptions {
  cwd?: string;
  input?: string;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}
export async function command(
  binary: string,
  args: string[],
  options: CommandOptions = {},
): Promise<string> {
  const timeoutMs = options.timeout ?? 60_000;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      {
        cwd: options.cwd,
        signal: options.signal,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
        env: options.env ?? process.env,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new CommandError(
              `${binary}: ${(stderr || error.message).trim().slice(0, 1500)}`,
              stdout,
              stderr,
              {
                exitCode: error.code,
                signal: error.signal,
                killed: error.killed,
                durationMs: Math.round(performance.now() - started),
                timeoutMs,
              },
            ),
          );
        else resolve(stdout);
      },
    );
    child.stdin?.end(options.input);
  });
}
/** Repository configuration must not run programs: no hooks and no file-system monitor. */
export const SAFE_GIT_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
export const git = (cwd: string, args: string[], options: CommandOptions = {}) =>
  command('git', [...SAFE_GIT_CONFIG, ...args], { ...options, cwd });
