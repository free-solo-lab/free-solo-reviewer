import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '../shared/i18n.js';

export type DesktopStage =
  'launch' | 'server' | 'window' | 'window-ready' | 'renderer' | 'unhandled';
export interface DesktopContext {
  version: string;
  osVersion: string;
  arch: string;
  appPath: string;
  logPath: string;
}
export interface DesktopDiagnostic extends DesktopContext {
  timestamp: string;
  stage: DesktopStage;
  message?: string;
  exitCode?: number | string | null;
  signal?: string | null;
  durationMs?: number;
  timeoutMs?: number;
}

export function redactDiagnosticText(text: string, env: NodeJS.ProcessEnv = process.env) {
  let result = text;
  for (const key of ['OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const secret = env[key];
    if (secret) result = result.split(secret).join('[redacted]');
  }
  return result
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, '[redacted]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|token)\s*[=:]\s*)[^\s&"']+/gi, '$1[redacted]');
}

/** Only a small allowlist of metadata is copied; no environment, stderr, stack or repository data. */
export function desktopDiagnostic(
  context: DesktopContext,
  stage: DesktopStage,
  error?: unknown,
): DesktopDiagnostic {
  const record: DesktopDiagnostic = { ...context, timestamp: new Date().toISOString(), stage };
  if (error === undefined) return record;
  record.message = redactDiagnosticText(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 1500);
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    if (
      typeof value.exitCode === 'number' ||
      typeof value.exitCode === 'string' ||
      value.exitCode === null
    )
      record.exitCode =
        typeof value.exitCode === 'string'
          ? redactDiagnosticText(value.exitCode).slice(0, 100)
          : value.exitCode;
    if (
      value.signal === null ||
      (typeof value.signal === 'string' && /^SIG[A-Z0-9]+$/.test(value.signal))
    )
      record.signal = value.signal;
    if (typeof value.durationMs === 'number') record.durationMs = value.durationMs;
    if (typeof value.timeoutMs === 'number') record.timeoutMs = value.timeoutMs;
  }
  return record;
}

export function createDesktopLog(stateDir: string, maxBytes = 5 * 1024 * 1024) {
  const path = join(stateDir, 'desktop.log');
  return {
    path,
    write(record: DesktopDiagnostic) {
      try {
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const line = JSON.stringify(record) + '\n';
        let size = 0;
        try {
          size = statSync(path).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
          rmSync(path + '.1', { force: true });
          renameSync(path, path + '.1');
        }
        appendFileSync(path, line, { mode: 0o600 });
        return true;
      } catch {
        // A read-only data folder must not prevent the native error dialog from opening.
        return false;
      }
    },
  };
}

export function desktopFailureMessage(stage: DesktopStage) {
  if (stage === 'server') return t('Reviewer could not start or connect to its local server.');
  if (stage === 'window') return t('Reviewer could not load its window.');
  if (stage === 'renderer') return t('The Reviewer window stopped unexpectedly.');
  return t('Reviewer encountered an unexpected error.');
}

/** A failed Finder action is recoverable, including when used from the failure dialog. */
export async function openDesktopLogs(
  path: string,
  tools: {
    openPath(path: string): Promise<string>;
    showErrorBox(title: string, detail: string): void;
  },
) {
  try {
    const failure = await tools.openPath(path);
    if (failure) throw new Error(failure);
  } catch (error) {
    tools.showErrorBox(
      t('Could not open the logs folder'),
      `${path}\n\n${redactDiagnosticText(error instanceof Error ? error.message : String(error)).slice(0, 1500)}`,
    );
  }
}

export interface FailureDialog {
  type: 'error';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}
export function createFailureReporter(tools: {
  diagnostic(stage: DesktopStage, error: unknown): DesktopDiagnostic;
  log(record: DesktopDiagnostic): unknown;
  show(options: FailureDialog): Promise<number>;
  showLogs(): Promise<void>;
  copy(text: string): void;
  close(): void;
}) {
  let active = false;
  return async (stage: DesktopStage, error: unknown) => {
    const record = tools.diagnostic(stage, error);
    tools.log(record);
    if (active) return;
    active = true;
    try {
      const detail = JSON.stringify(record, null, 2);
      for (;;) {
        const response = await tools.show({
          type: 'error',
          title: t('Could not open Reviewer'),
          message: desktopFailureMessage(stage),
          detail,
          buttons: [t('Show logs'), t('Copy diagnostics'), t('Close')],
          defaultId: 2,
          cancelId: 2,
        });
        if (response === 0) await tools.showLogs();
        else if (response === 1) tools.copy(detail);
        else {
          tools.close();
          return;
        }
      }
    } finally {
      active = false;
    }
  };
}
