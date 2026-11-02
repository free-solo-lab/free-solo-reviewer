import type { Evidence, Snapshot, SourceIndex } from './model';

export interface CodeSearchEntry {
  id: string;
  kind: 'file' | 'class' | 'method';
  name: string;
  detail: string;
  repoName: string;
  evidence: Evidence;
}

/** Search is scoped to the frozen versions in this review, including context repositories. */
export function codeSearchEntries(
  snapshots: Snapshot[],
  indexes: SourceIndex[],
): CodeSearchEntry[] {
  const entries: CodeSearchEntry[] = [];
  for (const snapshot of snapshots) {
    const common = { repoId: snapshot.repoId, side: 'head' as const, startLine: 1, endLine: 1 };
    for (const path of snapshot.headFiles) {
      entries.push({
        id: `file:${snapshot.id}:${path}`,
        kind: 'file',
        name: path.split('/').pop()!,
        detail: path,
        repoName: snapshot.repoName,
        evidence: { ...common, path },
      });
    }
    const index = indexes.find((item) => item.repoId === snapshot.repoId && item.side === 'head');
    for (const type of index?.types ?? []) {
      entries.push({
        id: `class:${snapshot.id}:${type.qualifiedName}:${type.evidence.startLine}`,
        kind: 'class',
        name: type.name,
        detail: type.qualifiedName,
        repoName: snapshot.repoName,
        evidence: { ...type.evidence, endLine: type.evidence.startLine },
      });
    }
    for (const method of index?.methods ?? []) {
      entries.push({
        id: `method:${snapshot.id}:${method.evidence.path}:${method.evidence.startLine}:${method.signature}`,
        kind: 'method',
        name: method.name,
        detail: method.signature,
        repoName: snapshot.repoName,
        evidence: { ...method.evidence, endLine: method.evidence.startLine },
      });
    }
  }
  return entries;
}

const normalized = (value: string) => value.toLocaleLowerCase().replace(/\\/g, '/');
function score(entry: CodeSearchEntry, query: string): number {
  const name = normalized(entry.name);
  const initials = (entry.name.match(/(?:^|[_\-.])\w|[A-Z]/g) ?? [])
    .join('')
    .replace(/[_\-.]/g, '')
    .toLowerCase();
  const haystack = normalized(
    `${entry.name} ${entry.detail} ${entry.evidence.path} ${entry.repoName}`,
  );
  const parts = query.split(/\s+/);
  if (!parts.every((part) => haystack.includes(part) || initials.startsWith(part))) return -1;
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (initials === query) return 70;
  if (name.includes(query)) return 60;
  return 20;
}

export function searchCode(
  entries: CodeSearchEntry[],
  input: string,
  limit = 80,
): CodeSearchEntry[] {
  const query = normalized(input.trim());
  if (!query) return [];
  return entries
    .map((entry) => ({ entry, score: score(entry, query) }))
    .filter((item) => item.score >= 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.name.localeCompare(b.entry.name) ||
        a.entry.id.localeCompare(b.entry.id),
    )
    .slice(0, limit)
    .map(({ entry }) => entry);
}

/** Two standalone Shift taps; holding Shift or using Shift with another key is not a tap. */
export function doubleShift(onOpen: () => void, now = () => performance.now()) {
  let down = false,
    candidate = false,
    pressed = 0,
    last = -Infinity;
  return {
    reset() {
      down = candidate = false;
      last = -Infinity;
    },
    keydown(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey'>) {
      if (event.key !== 'Shift' || event.altKey || event.ctrlKey || event.metaKey) {
        candidate = false;
        last = -Infinity;
        return;
      }
      if (event.repeat || down) return;
      down = candidate = true;
      pressed = now();
    },
    keyup(event: Pick<KeyboardEvent, 'key'>) {
      if (event.key !== 'Shift') return;
      const time = now();
      down = false;
      if (!candidate || time - pressed > 350) {
        last = -Infinity;
        candidate = false;
        return;
      }
      candidate = false;
      if (time - last <= 450) {
        last = -Infinity;
        onOpen();
      } else last = time;
    },
  };
}
