import { execFile } from 'node:child_process';
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export class CommandError extends AppError {
  constructor(
    message: string,
    public stdout: string,
    public stderr: string,
  ) {
    super(message, 502);
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
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      {
        cwd: options.cwd,
        signal: options.signal,
        timeout: options.timeout ?? 60_000,
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
            ),
          );
        else resolve(stdout);
      },
    );
    child.stdin?.end(options.input);
  });
}
export const git = (cwd: string, args: string[], options: CommandOptions = {}) =>
  command('git', ['-c', 'core.hooksPath=/dev/null', ...args], { ...options, cwd });
