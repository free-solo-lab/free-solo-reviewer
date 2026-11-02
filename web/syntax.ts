import { createLowlight } from 'lowlight';
import java from 'highlight.js/lib/languages/java';
import kotlin from 'highlight.js/lib/languages/kotlin';
import sql from 'highlight.js/lib/languages/sql';
import pgsql from 'highlight.js/lib/languages/pgsql';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import groovy from 'highlight.js/lib/languages/groovy';
import properties from 'highlight.js/lib/languages/properties';
import ini from 'highlight.js/lib/languages/ini';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import markdown from 'highlight.js/lib/languages/markdown';
import protobuf from 'highlight.js/lib/languages/protobuf';
import graphql from 'highlight.js/lib/languages/graphql';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';
import swift from 'highlight.js/lib/languages/swift';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import { patchLines } from '../shared/patch';
import { t } from '../shared/i18n';

const highlighter = createLowlight({
  java,
  kotlin,
  sql,
  pgsql,
  javascript,
  typescript,
  json,
  yaml,
  xml,
  css,
  scss,
  python,
  bash,
  go,
  rust,
  groovy,
  properties,
  ini,
  dockerfile,
  markdown,
  protobuf,
  graphql,
  csharp,
  cpp,
  swift,
  ruby,
  php,
});
export const languageLabels: Record<string, string> = {
  plaintext: t('Text'),
  java: 'Java',
  kotlin: 'Kotlin',
  sql: 'SQL',
  pgsql: 'PostgreSQL',
  javascript: 'JavaScript / JSX',
  typescript: 'TypeScript / TSX',
  json: 'JSON',
  yaml: 'YAML',
  xml: 'XML / HTML',
  css: 'CSS',
  scss: 'SCSS',
  python: 'Python',
  bash: 'Shell',
  go: 'Go',
  rust: 'Rust',
  groovy: 'Groovy / Gradle',
  properties: 'Properties',
  ini: 'INI / TOML',
  dockerfile: 'Dockerfile',
  markdown: 'Markdown',
  protobuf: 'Protobuf',
  graphql: 'GraphQL',
  csharp: 'C#',
  cpp: 'C / C++',
  swift: 'Swift',
  ruby: 'Ruby',
  php: 'PHP',
};
const extensions: Record<string, string> = {
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  sql: 'sql',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  go: 'go',
  rs: 'rust',
  groovy: 'groovy',
  gradle: 'groovy',
  properties: 'properties',
  ini: 'ini',
  toml: 'ini',
  md: 'markdown',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
  cs: 'csharp',
  c: 'cpp',
  h: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  swift: 'swift',
  rb: 'ruby',
  php: 'php',
};
export function languageForPath(path: string): string {
  const name = path.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile'))
    return 'dockerfile';
  if (name === 'pom.xml') return 'xml';
  if (name.startsWith('.bash') || name === '.zshrc') return 'bash';
  return extensions[name.split('.').pop() ?? ''] ?? 'plaintext';
}
export function sqlLanguage(dialect: string): string {
  return /postgres|pgsql/i.test(dialect) ? 'pgsql' : 'sql';
}
export interface CodeToken {
  text: string;
  className: string;
}
export type CodeLine = CodeToken[];
export function highlightLines(text: string, language: string): CodeLine[] {
  const plain = () => text.split('\n').map((line) => [{ text: line, className: '' }]);
  // Keep very large files responsive. Never guess a grammar for an unknown file.
  if (!highlighter.registered(language) || text.length > 300_000) return plain();
  try {
    const root = highlighter.highlight(language, text);
    const lines: CodeLine[] = [[]];
    type Node = typeof root | (typeof root.children)[number];
    const visit = (node: Node, classes: string[]) => {
      if (node.type === 'text') {
        const chunks = node.value.split('\n');
        chunks.forEach((chunk, i) => {
          if (i) lines.push([]);
          if (chunk) lines.at(-1)!.push({ text: chunk, className: classes.join(' ') });
        });
      } else if (node.type === 'element') {
        const own = Array.isArray(node.properties.className)
          ? node.properties.className.map(String)
          : [];
        for (const child of node.children) visit(child, [...classes, ...own]);
      } else if (node.type === 'root') {
        for (const child of node.children) visit(child, classes);
      }
    };
    visit(root, []);
    return lines;
  } catch {
    return plain();
  }
}

export interface DiffRow {
  kind: 'meta' | 'hunk' | 'context' | 'addition' | 'deletion';
  text: string;
  left: number | null;
  right: number | null;
  tokens: CodeLine;
}
/** Highlight each side of each hunk separately so +/- never changes grammar state. */
export function highlightDiff(patch: string, path: string, oldPath?: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let group: DiffRow[] = [];
  const flush = () => {
    if (!group.length) return;
    const before = group.filter((r) => r.kind !== 'addition');
    const after = group.filter((r) => r.kind !== 'deletion');
    const baseTokens = highlightLines(
      before.map((r) => r.text.slice(1)).join('\n'),
      languageForPath(oldPath ?? path),
    );
    const headTokens = highlightLines(
      after.map((r) => r.text.slice(1)).join('\n'),
      languageForPath(path),
    );
    let b = 0,
      a = 0;
    for (const row of group) {
      if (row.kind === 'deletion') row.tokens = baseTokens[b++] ?? [];
      else if (row.kind === 'addition') row.tokens = headTokens[a++] ?? [];
      else {
        row.tokens = headTokens[a++] ?? [];
        b++;
      }
    }
    group = [];
  };
  for (const line of patchLines(patch)) {
    if (line.kind === 'hunk' || line.kind === 'meta') {
      if (line.kind === 'hunk') flush();
      rows.push({ kind: line.kind, text: line.raw, left: null, right: null, tokens: [] });
      continue;
    }
    const row: DiffRow = {
      kind: line.kind,
      text: line.raw,
      left: line.kind === 'addition' ? null : line.oldLine,
      right: line.kind === 'deletion' ? null : line.newLine,
      tokens: [],
    };
    rows.push(row);
    group.push(row);
  }
  flush();
  return rows;
}
