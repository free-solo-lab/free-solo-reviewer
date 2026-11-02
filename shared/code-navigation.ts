import type { Evidence, IndexedMethod, SourceIndex } from './model.js';
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
        const typedName = targets.filter(
          (m) => stem(m.evidence.path).toLowerCase() === receiver.toLowerCase(),
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
          targets,
          requiresChoice,
        });
    }
    return links;
  });
}
export const needsDefinitionPicker = (link: MethodLink) =>
  link.targets.length !== 1 || link.requiresChoice;
