import { t } from './i18n.js';

/** Shell words with quotes removed; good enough for the commands Codex runs to read code. */
function words(command: string) {
  const result: string[] = [];
  let current = '',
    quote = '',
    started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current) result.push(current);
      current = '';
      started = false;
    } else current += char;
  }
  if (started || current) result.push(current);
  return result;
}

/** Splits on pipes and command separators outside quotes. */
function segments(command: string) {
  const parts: string[] = [];
  let current = '',
    quote = '';
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '|' || char === ';' || char === '&') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      if (command[i + 1] === char) i++;
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** `/bin/zsh -lc "…"` and `bash -lc '…'` wrap the actual command. */
function unwrap(command: string) {
  const parts = words(command);
  const shell = parts.findIndex((word) => /^-l?c$/.test(word));
  return shell > 0 && /(^|\/)(ba|z)?sh$/.test(parts[0]) && parts[shell + 1]
    ? parts[shell + 1]
    : command;
}

const base = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;
const program = (word = '') => base(word);
/** Options of rg and grep that take the next word as their value. */
const valued = new Set(['-g', '--glob', '-t', '--type', '-e', '-A', '-B', '-C', '-m', '-f']);

function describe(segment: string, range?: [string, string]) {
  const parts = words(segment).filter((word) => !['then', 'do', 'else'].includes(word));
  const name = program(parts[0]);
  const args = parts.slice(1);
  const plain = args.filter((word) => !word.startsWith('-'));
  if (['nl', 'cat', 'sed', 'head', 'tail', 'bat', 'less', 'jq'].includes(name)) {
    const file = plain.filter((word) => !/^\d+(,\d+)?p$/.test(word) && !/^[{.]/.test(word)).at(-1);
    if (!file) return undefined;
    const head = name === 'head' && args[args.indexOf('-n') + 1];
    const lines = range ?? (head && /^\d+$/.test(head) ? ['1', head] : undefined);
    return lines
      ? t('Read {0}, lines {1}–{2}', base(file), lines[0], lines[1])
      : t('Read {0}', base(file));
  }
  if (name === 'rg' || name === 'grep' || name === 'ag') {
    const globs: string[] = [];
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (valued.has(args[i])) {
        if (args[i] === '-g' || args[i] === '--glob') globs.push(args[i + 1]);
        if (args[i] === '-e') rest.unshift(args[i + 1]);
        i++;
      } else if (!args[i].startsWith('-')) rest.push(args[i]);
    }
    if (args.includes('--files'))
      return t('Find files: {0}', (globs.length ? globs : rest).map(base).join(', ') || '*');
    const [pattern, ...paths] = rest;
    if (!pattern) return undefined;
    const short = pattern.length > 60 ? `${pattern.slice(0, 57)}…` : pattern;
    return paths.length
      ? t('Search for “{0}” in {1}', short, paths.map(base).join(', '))
      : t('Search for “{0}”', short);
  }
  if (['ls', 'find', 'tree', 'fd'].includes(name))
    return t('List {0}', plain.map(base).join(', ') || '.');
  if (name === 'wc') return t('Count lines in {0}', plain.map(base).join(', '));
  if (name === 'git') return ['git', ...args.slice(0, 3).map(base)].join(' ');
  return undefined;
}

/** One line telling what a command did, so its output never has to be read. */
export function commandSummary(command: string) {
  const inner = unwrap(command.split('\n')[0].trim());
  const parts = segments(inner);
  const sed = parts
    .map((part) => words(part))
    .find((part) => program(part[0]) === 'sed')
    ?.find((word) => /^\d+(,\d+)?p$/.test(word));
  const [from, to = from] = sed?.replace(/p$/, '').split(',') ?? [];
  const lines: [string, string] | undefined = from ? [from, to] : undefined;
  const described = [
    ...new Set(
      parts
        .filter((part) => !/^(if|fi|test|which|echo|true)\b|^\[/.test(part))
        .map((part) => describe(part, lines))
        .filter(Boolean),
    ),
  ];
  if (described.length) return described.slice(0, 2).join('; ');
  return inner.length > 90 ? `${inner.slice(0, 87)}…` : inner;
}

/** A command of a fix ends with its status line, e.g. `completed · code 0`. */
export function fixCommandSummary(text: string) {
  const status = text.trimEnd().split('\n').at(-1) ?? '';
  const code = Number(/(\d+)\s*$/.exec(status)?.[1] ?? 0);
  const failed = /^(failed|declined)/.test(status) || code > 0;
  const summary = commandSummary(text);
  if (!failed) return summary;
  return `${summary} · ${code ? t('failed with exit code {0}', code) : t('failed')}`;
}

/** File changes of a fix are `kind: path` lines followed by a status line. */
export function fileChangesSummary(text: string) {
  const files = text
    .split('\n')
    .map((line) => /^\w+: (.+)$/.exec(line)?.[1])
    .filter((path): path is string => !!path);
  return files.length ? files.map(base).join(', ') : text.split('\n')[0];
}
