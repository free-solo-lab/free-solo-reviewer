export type LogLevel = 'info' | 'warn' | 'error';
/** Where an entry comes from: the HTTP API, a command such as git, gh or codex, the analysis,
 * the server process itself, the interface in the browser or the desktop shell. */
export type LogSource = 'http' | 'command' | 'analysis' | 'process' | 'client' | 'desktop';

export interface LogEntry {
  seq: number;
  at: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  /** A stack trace or a command's error output. */
  details?: string;
}

export const logLevels: readonly LogLevel[] = ['info', 'warn', 'error'];
export const logSources: readonly LogSource[] = [
  'http',
  'command',
  'analysis',
  'process',
  'client',
  'desktop',
];

/** Plain text for copying into an issue or a chat; one entry per paragraph. */
export function formatLogEntries(entries: LogEntry[]) {
  return entries
    .map(
      (entry) =>
        `${entry.at} ${entry.level.toUpperCase()} [${entry.source}] ${entry.message}${entry.details ? `\n${entry.details}` : ''}`,
    )
    .join('\n');
}

/** Tokens and passwords never reach the log, even inside a command's arguments or output. */
export function redactSecrets(text: string) {
  return text
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g, '[secret]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[secret]')
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [secret]')
    .replace(
      /\b((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"'&]+/gi,
      '$1[secret]',
    )
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1[secret]@');
}
