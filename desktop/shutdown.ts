import type { ChildProcess } from 'node:child_process';
import { t } from '../shared/i18n.js';

/** Always wait for exit, including after escalating a stuck owned child. */
export async function stopChildProcess(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.removeListener('exit', exited);
      child.removeListener('error', failed);
      if (error) reject(error);
      else resolve();
    };
    const exited = () => finish();
    const failed = (error: Error) => finish(error);
    const kill = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal);
      } catch (error) {
        finish(error as Error);
      }
    };
    child.once('exit', exited);
    child.once('error', failed);
    timer = setTimeout(() => {
      timer = setTimeout(
        () => finish(new Error(t('The Reviewer server did not stop after SIGKILL.'))),
        2000,
      );
      kill('SIGKILL');
    }, 10_000);
    kill('SIGTERM');
  });
}

export interface ShutdownService {
  owned: boolean;
  close(): Promise<void>;
}

/** Quit and fatal failures share one cleanup; repeated Quit cannot bypass it. */
export function createDesktopShutdown(tools: {
  abort(): void;
  getService(): ShutdownService | undefined | Promise<ShutdownService | undefined>;
  log(error: unknown): void;
  quit(): void;
  exit(code: number): void;
}) {
  let stopping: Promise<void> | undefined;
  let complete = false;
  let exitCode: number | undefined;
  return {
    get stopping() {
      return stopping !== undefined;
    },
    get complete() {
      return complete;
    },
    stop(code?: number) {
      if (code !== undefined) exitCode = code;
      stopping ??= Promise.resolve().then(async () => {
        try {
          tools.abort();
          const service = await tools.getService();
          if (service?.owned) await service.close();
        } catch (error) {
          tools.log(error);
        } finally {
          complete = true;
          if (exitCode === undefined) tools.quit();
          else tools.exit(exitCode);
        }
      });
      return stopping;
    },
  };
}
