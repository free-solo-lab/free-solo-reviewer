import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  formatLogEntries,
  redactSecrets,
  type LogEntry,
  type LogLevel,
  type LogSource,
} from '../shared/system-log.js';
import { reviewerStateDir } from './runtime-paths.js';

const LIMIT = 2000;
const MESSAGE_LIMIT = 2000;
const DETAILS_LIMIT = 8000;

/**
 * The diagnostic journal of this server process, shown in the "Logs" tab. It keeps the latest
 * entries in memory and, once `print` is on, also writes them to stdout, which the desktop app
 * saves to server.log.
 */
export class SystemLog {
  private entries: LogEntry[] = [];
  private seq = 0;
  private listeners = new Set<(entry: LogEntry) => void>();
  print = false;

  add(
    level: LogLevel,
    source: LogSource,
    message: string,
    details?: string,
    /** False when the text already went to the console. */
    print = this.print,
  ) {
    const entry: LogEntry = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      level,
      source,
      message: redactSecrets(message).slice(0, MESSAGE_LIMIT),
      ...(details?.trim() && { details: redactSecrets(details.trim()).slice(0, DETAILS_LIMIT) }),
    };
    this.entries.push(entry);
    if (this.entries.length > LIMIT) this.entries.splice(0, this.entries.length - LIMIT);
    if (print)
      (level === 'error' ? process.stderr : process.stdout).write(`${formatLogEntries([entry])}\n`);
    for (const listener of this.listeners) listener(entry);
    return entry;
  }
  info(source: LogSource, message: string, details?: string) {
    return this.add('info', source, message, details);
  }
  warn(source: LogSource, message: string, details?: string) {
    return this.add('warn', source, message, details);
  }
  error(source: LogSource, message: string, details?: string) {
    return this.add('error', source, message, details);
  }
  list(after = 0) {
    return this.entries.filter((entry) => entry.seq > after);
  }
  clear() {
    this.entries = [];
  }
  subscribe(listener: (entry: LogEntry) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

export const systemLog = new SystemLog();

export const errorDetails = (error: unknown) =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

/**
 * Process-wide failures of the real server: crashes, rejected promises Node turns into crashes,
 * runtime warnings and console errors. Called by the entry point, not by tests.
 */
export function logProcess(log = systemLog) {
  log.print = true;
  process.on('uncaughtExceptionMonitor', (error, origin) =>
    log.error(
      'process',
      origin === 'unhandledRejection' ? `Unhandled rejection: ${error}` : `Crash: ${error}`,
      errorDetails(error),
    ),
  );
  process.on('warning', (warning) => {
    // Node marks its own experimental APIs; they are not problems of the app.
    if (warning.name !== 'ExperimentalWarning')
      log.warn('process', `${warning.name}: ${warning.message}`, warning.stack);
  });
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => {
      log.add(
        level,
        'process',
        values.map((value) => (value instanceof Error ? value.message : String(value))).join(' '),
        values.find((value): value is Error => value instanceof Error)?.stack,
        false,
      );
      original(...values);
    };
  }
}

/** The desktop shell's own journal: launches, window events and failures before the server. */
export async function desktopLogEntries(
  stateDir = reviewerStateDir(),
  limit = 200,
): Promise<LogEntry[]> {
  let text: string;
  try {
    text = await readFile(join(stateDir, 'desktop.log'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .flatMap((line, i) => {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const stage = String(record.stage ?? 'event');
        const failure = /error|fail|crash|exit/i.test(stage) || 'error' in record;
        const { timestamp, stage: _stage, ...rest } = record;
        const extra = Object.entries(rest)
          .filter(([key]) => !['version', 'osVersion', 'arch', 'appPath', 'logPath'].includes(key))
          .map(
            ([key, value]) =>
              `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
          )
          .join('\n');
        return [
          {
            // Negative numbers keep them apart from this server's own sequence.
            seq: -limit + i,
            at: typeof timestamp === 'string' ? timestamp : new Date(0).toISOString(),
            level: failure ? 'error' : 'info',
            source: 'desktop',
            message: `${stage}${record.version ? ` · v${record.version}` : ''}`,
            ...(extra && { details: redactSecrets(extra) }),
          } satisfies LogEntry,
        ];
      } catch {
        return [];
      }
    });
}
