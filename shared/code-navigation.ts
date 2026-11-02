import type { Evidence, IndexedMethod, IndexedType, SourceIndex, Snapshot } from './model.js';
import { directlyChanged } from './analysis-scope.js';

/** PR markers use the selected snapshot's diff, not changes to generated analysis text. */
export function definitionReviewChange(method: IndexedMethod, snapshots: Snapshot[]) {
  const file = snapshots
    .find((snapshot) => snapshot.repoId === method.evidence.repoId)
    ?.files.find(
      (file) =>
        (method.evidence.side === 'head' ? file.path : (file.oldPath ?? file.path)) ===
        method.evidence.path,
    );
  if (!file || file.status === 'unchanged') return undefined;
  return {
    scope: directlyChanged(method, snapshots) ? ('method' as const) : ('file' as const),
    kind: /^(A|added)$/.test(file.status)
      ? 'added'
      : /^(D|deleted|removed)$/.test(file.status)
        ? 'removed'
        : 'modified',
  };
}
export interface MethodLink {
  start: number;
  end: number;
  name: string;
  line: number;
  targets: IndexedMethod[];
  requiresChoice: boolean;
}
const stem = (path: string) =>
  path
    .split('/')
    .pop()!
    .replace(/\.(java|kt)$/, '');

type DefinitionGraph = {
  indexes: SourceIndex[];
  edges: string[][];
  methods: IndexedMethod[];
  results: Map<IndexedMethod, IndexedMethod[]>;
};
const graphs = new WeakMap<SourceIndex, DefinitionGraph>();
function definitionGraph(scoped: SourceIndex[]): DefinitionGraph {
  const cached = graphs.get(scoped[0]);
  if (
    cached &&
    cached.indexes.length === scoped.length &&
    cached.indexes.every((index, i) => index === scoped[i])
  )
    return cached;
  const types = scoped.flatMap((i) => i.types ?? []);
  const resolve = (name: string, child: IndexedType) => {
    const imported = child.imports.find((i) => i.endsWith(`.${name}`));
    const qualified =
      imported ??
      `${child.qualifiedName.slice(0, child.qualifiedName.lastIndexOf('.') + 1)}${name}`;
    const candidates = types.filter(
      (t) => t.qualifiedName === name || t.qualifiedName === qualified,
    );
    if (candidates.length === 1) return candidates[0];
    const wildcard = types.filter((t) =>
      child.imports.some((i) => i.endsWith('.*') && `${i.slice(0, -1)}${name}` === t.qualifiedName),
    );
    return wildcard.length === 1 ? wildcard[0] : undefined;
  };
  const edges = types.flatMap((t) =>
    t.parents.flatMap((p) => {
      const parent = resolve(p, t);
      return parent ? [[t.qualifiedName, parent.qualifiedName]] : [];
    }),
  );
  const graph: DefinitionGraph = {
    indexes: scoped,
    edges,
    methods: scoped.flatMap((i) => i.methods),
    results: new Map(),
  };
  graphs.set(scoped[0], graph);
  return graph;
}

/** Declaration and implementations from the same frozen repository version. */
export function methodDefinitions(method: IndexedMethod, indexes: SourceIndex[]): IndexedMethod[] {
  if (!method.owner) return [method];
  const scoped = indexes.filter(
    (i) => i.repoId === method.evidence.repoId && i.side === method.evidence.side,
  );
  if (!scoped.length) return [method];
  const graph = definitionGraph(scoped);
  const cached = graph.results.get(method);
  if (cached) return cached;
  const { edges } = graph;
  // Start with ancestors, then include their descendants (sibling implementations).
  const roots = new Set([method.owner]);
  let size = -1;
  while (size !== roots.size) {
    size = roots.size;
    for (const [child, parent] of edges) if (roots.has(child)) roots.add(parent);
  }
  size = -1;
  while (size !== roots.size) {
    size = roots.size;
    for (const [child, parent] of edges) if (roots.has(parent)) roots.add(child);
  }
  const candidates = graph.methods.filter(
    (m) => m.name === method.name && m.owner && roots.has(m.owner),
  );
  const result = candidates.length ? candidates : [method];
  graph.results.set(method, result);
  return result;
}

export function evidenceMethodLink(evidence: Evidence, indexes: SourceIndex[]): MethodLink | null {
  const methods = indexes
    .filter((i) => i.repoId === evidence.repoId && i.side === evidence.side)
    .flatMap((i) => i.methods);
  const exact = methods.filter(
    (m) =>
      m.evidence.path === evidence.path &&
      m.evidence.startLine === evidence.startLine &&
      m.evidence.endLine === evidence.endLine,
  );
  if (exact.length !== 1) return null;
  const method = exact[0];
  const targets = methodDefinitions(method, indexes);
  return targets.length > 1
    ? {
        start: 0,
        end: 0,
        name: method.name,
        line: evidence.startLine,
        targets,
        requiresChoice: true,
      }
    : null;
}

/** Resolve only within the pinned repository and code side. Ambiguity is kept for the picker. */
export function methodLinks(
  text: string,
  origin: Evidence,
  indexes: SourceIndex[],
): MethodLink[][] {
  const methods = indexes
    .filter((i) => i.repoId === origin.repoId && i.side === origin.side)
    .flatMap((i) => i.methods);
  const local = methods.filter((m) => m.evidence.path === origin.path);
  return text.split('\n').map((line, row) => {
    const links: MethodLink[] = [];
    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?=\()/g)) {
      const name = match[1];
      const callers = local.filter(
        (m) => m.evidence.startLine <= row + 1 && m.evidence.endLine >= row + 1,
      );
      const calls = callers
        .flatMap((m) => m.callSites ?? [])
        .filter(
          (c) =>
            c.name === name && c.evidence.startLine <= row + 1 && c.evidence.endLine >= row + 1,
        );
      if (!calls.length) continue;
      const prefix = line.slice(0, match.index).match(/([\w$]+)\s*[?.]\s*$/)?.[1] ?? '';
      const receiver = prefix || (calls.length === 1 ? calls[0].receiver : '');
      let targets = methods.filter((m) => m.name === name);
      let requiresChoice = false;
      const sameFile = targets.filter((m) => m.evidence.path === origin.path);
      if (!receiver || receiver === 'this' || receiver === 'super') {
        if (sameFile.length && receiver !== 'super') targets = sameFile;
        else requiresChoice = true;
      } else {
        const receiverTypes = [
          ...new Set(
            calls
              .filter((c) => c.receiver.replace(/^this\./, '') === receiver)
              .map((c) => c.receiverType)
              .filter(Boolean),
          ),
        ];
        const receiverType = receiverTypes.length === 1 ? receiverTypes[0] : receiver;
        const typedName = targets.filter(
          (m) =>
            (m.owner?.split('.').at(-1) ?? stem(m.evidence.path)).toLowerCase() ===
            receiverType?.split('.').at(-1)?.toLowerCase(),
        );
        if (typedName.length) targets = typedName;
        else {
          // A custom field name cannot be treated as proof of its receiver type.
          // Keep possible definitions for explicit selection, even when only one exists.
          requiresChoice = true;
        }
      }
      if (targets.length)
        links.push({
          start: match.index!,
          end: match.index! + name.length,
          name,
          line: row + 1,
          targets: [...new Set(targets.flatMap((m) => methodDefinitions(m, indexes)))],
          requiresChoice,
        });
    }
    return links;
  });
}
export const needsDefinitionPicker = (link: MethodLink) =>
  link.targets.length !== 1 || link.requiresChoice;
