import type { Evidence, IndexedMethod, Snapshot, SourceIndex } from './model.js';
import { activeMethods, directlyChanged } from './analysis-scope.js';
import { isTestPath } from './test-coverage.js';
import { t } from './i18n.js';

/** One changed method, or the changed lines of a file outside methods, with only its diff. */
export interface ChangeUnit {
  key: string;
  name: string;
  evidence: Evidence;
  /** Diff lines of this unit: ` 12 text`, `+13 text`, `-12 text` with head or base numbers. */
  diff: string[];
  /** A user interface change: its card says what the user sees, not what the code does. */
  ui?: boolean;
}
interface PatchLine {
  type: ' ' | '+' | '-';
  oldLine: number;
  newLine: number;
  text: string;
  /** The text after the `@@` of its hunk: Git's guess of the enclosing declaration. */
  heading: string;
}
const MAX_LINES = 80;
const CODE = /\.(java|kt)$/;
/** Files whose diff says little about behaviour; they are covered elsewhere or not at all. */
const SKIP =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|gradle\.lockfile)$|\.(json|csv|svg|lock|md|txt|png|jpg)$/i;
/** Translations are data files, but their changes are texts the user reads. */
const TEXTS = /(^|\/)(locales?|i18n|translations?|lang|messages)\/[^/]+\.(json|ya?ml|properties)$/i;
const UI_FILE = /\.(tsx|jsx|vue|svelte|html|css|scss|sass|less)$/i;
const UI_DIR = /(^|\/)(components?|pages|views|screens|layouts?|ui|frontend|web|client|app)\//i;
export const isUiPath = (path: string) =>
  !isTestPath(path) &&
  (UI_FILE.test(path) || TEXTS.test(path) || (/\.(ts|js|mjs)$/i.test(path) && UI_DIR.test(path)));
/** Components, hooks and Vue sections: the parts a UI diff is split into. */
const DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Z][\w$]*|use[A-Z][\w$]*)|(?:const|let)\s+([A-Z][\w$]*|use[A-Z][\w$]*)\s*[:=]|class\s+([A-Z][\w$]*))|^<(template|script|style)\b/;
const declared = (text: string) => {
  const match = text.match(DECLARATION);
  return match ? (match[1] ?? match[2] ?? match[3] ?? match[4]) : undefined;
};

export function patchLines(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let oldLine = 0,
    newLine = 0,
    heading = '';
  for (const text of patch.split('\n')) {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      heading = hunk[3];
      continue;
    }
    if (!oldLine && !newLine) continue;
    const type = text[0];
    if (type === '+' && !text.startsWith('+++'))
      lines.push({ type, oldLine, newLine: newLine++, text: text.slice(1), heading });
    else if (type === '-' && !text.startsWith('---'))
      lines.push({ type, oldLine: oldLine++, newLine, text: text.slice(1), heading });
    else if (type === ' ')
      lines.push({ type, oldLine: oldLine++, newLine: newLine++, text: text.slice(1), heading });
  }
  return lines;
}
const show = (line: PatchLine) =>
  `${line.type}${line.type === '-' ? line.oldLine : line.newLine} ${line.text}`;
const trivial = (lines: PatchLine[]) =>
  lines.every((line) => line.type === ' ' || /^\s*(import\s|package\s|$)/.test(line.text));
const owner = (path: string) =>
  path
    .split('/')
    .pop()!
    .replace(/\.\w+$/, '');

/**
 * Production changes of a review split into small units: each changed method with the diff lines
 * inside it, and per file the changed lines outside methods. Tests have their own stage.
 */
export function changeUnits(snapshots: Snapshot[], indexes: SourceIndex[]): ChangeUnit[] {
  const methods = activeMethods(snapshots, indexes).filter((m) => !isTestPath(m.evidence.path));
  const units: ChangeUnit[] = [];
  for (const snapshot of snapshots)
    for (const file of snapshot.files) {
      if (isTestPath(file.path) || (SKIP.test(file.path) && !TEXTS.test(file.path))) continue;
      const lines = patchLines(file.patch);
      if (isUiPath(file.path)) {
        units.push(...uiUnits(snapshot.repoId, file.path, file.oldPath ?? file.path, lines));
        continue;
      }
      const basePath = file.oldPath ?? file.path;
      const inFile = (m: IndexedMethod) =>
        m.evidence.repoId === snapshot.repoId &&
        m.evidence.path === (m.evidence.side === 'head' ? file.path : basePath);
      const changed = CODE.test(file.path)
        ? methods.filter((m) => inFile(m) && directlyChanged(m, [snapshot]))
        : [];
      // The same method in the old version supplies its removed lines.
      const baseOf = (m: IndexedMethod) =>
        indexes
          .filter((i) => i.repoId === snapshot.repoId && i.side === 'base')
          .flatMap((i) => i.methods)
          .find((b) => b.evidence.path === basePath && b.name === m.name);
      const used = new Set<PatchLine>();
      for (const method of changed) {
        const base = method.evidence.side === 'head' ? baseOf(method) : method;
        const head = method.evidence.side === 'head' ? method : undefined;
        const own = lines.filter((line) =>
          line.type === '-'
            ? !!base &&
              line.oldLine >= base.evidence.startLine &&
              line.oldLine <= base.evidence.endLine
            : !!head &&
              line.newLine >= head.evidence.startLine &&
              line.newLine <= head.evidence.endLine,
        );
        own.forEach((line) => used.add(line));
        if (!own.some((line) => line.type !== ' ') || trivial(own)) continue;
        units.push({
          key: `${snapshot.repoId}:${method.evidence.side}:${method.evidence.path}:${method.name}:${method.evidence.startLine}`,
          name: `${owner(method.evidence.path)}.${method.name}`,
          evidence: method.evidence,
          diff: own.slice(0, MAX_LINES).map(show),
        });
      }
      // Outside methods only the changed lines and one line around them matter.
      const rest = lines.filter(
        (line, i) =>
          !used.has(line) &&
          lines.slice(Math.max(0, i - 1), i + 2).some((near) => near.type !== ' '),
      );
      if (!rest.some((line) => line.type !== ' ') || trivial(rest)) continue;
      const first = rest.find((line) => line.type !== ' ')!;
      const side = first.type === '-' ? 'base' : 'head';
      units.push({
        key: `${snapshot.repoId}:file:${file.path}`,
        name: CODE.test(file.path)
          ? t('{0} (outside methods)', owner(file.path))
          : file.path.split('/').pop()!,
        evidence: {
          repoId: snapshot.repoId,
          side,
          path: side === 'base' ? basePath : file.path,
          startLine: side === 'base' ? first.oldLine : first.newLine,
          endLine: side === 'base' ? first.oldLine : first.newLine,
        },
        diff: rest.slice(0, MAX_LINES).map(show),
      });
    }
  return units;
}

/** Changed lines of a UI file grouped by the component, hook or Vue section they belong to. */
function uiUnits(repoId: string, path: string, basePath: string, lines: PatchLine[]): ChangeUnit[] {
  const file = path.split('/').pop()!;
  const groups = new Map<string, PatchLine[]>();
  let current = '',
    heading: string | undefined;
  lines.forEach((line, i) => {
    // A new hunk starts in the declaration Git found above it, if it is a component.
    if (line.heading !== heading) {
      heading = line.heading;
      current = declared(heading) ?? '';
    }
    current = (line.type !== '-' && declared(line.text)) || current;
    const near = lines.slice(Math.max(0, i - 1), i + 2).some((other) => other.type !== ' ');
    if (!near) return;
    groups.set(current, [...(groups.get(current) ?? []), line]);
  });
  return [...groups].flatMap(([component, own]) => {
    if (!own.some((line) => line.type !== ' ') || trivial(own)) return [];
    // The new version is the one to open, unless the component only lost lines.
    const first = own.find((line) => line.type === '+') ?? own.find((line) => line.type === '-')!;
    const side = first.type === '-' ? 'base' : 'head';
    const line = side === 'base' ? first.oldLine : first.newLine;
    return [
      {
        key: `${repoId}:ui:${path}:${component}`,
        name: component ? `${file} · ${component}` : file,
        evidence: {
          repoId,
          side,
          path: side === 'base' ? basePath : path,
          startLine: line,
          endLine: line,
        },
        diff: own.slice(0, MAX_LINES).map(show),
        ui: true,
      },
    ];
  });
}
