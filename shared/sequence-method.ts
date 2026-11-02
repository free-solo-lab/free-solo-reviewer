import type { Evidence, IndexedMethod, Scenario, Snapshot, SourceIndex } from './model.js';
import { overlaps } from './sequence.js';

export interface SequenceModelLink {
  name: string;
  evidence?: Evidence;
}
export interface SequenceMethod {
  label: string;
  evidence?: Evidence;
  inputs: SequenceModelLink[];
  outputs: SequenceModelLink[];
}

const splitParameters = (text: string) => {
  const parts: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < text.length; i++) {
    if ('<(['.includes(text[i])) depth++;
    if ('>)]'.includes(text[i])) depth--;
    if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) parts.push(text.slice(start));
  return parts;
};
const sqlKinds: Record<string, string> = {
  select: 'SELECT',
  selectFrom: 'SELECT',
  selectDistinct: 'SELECT',
  selectCount: 'SELECT',
  selectOne: 'SELECT',
  insertInto: 'INSERT',
  update: 'UPDATE',
  deleteFrom: 'DELETE',
  mergeInto: 'MERGE',
};

/** A broad reference may span adjacent methods. Prefer the actual SQL operation. */
export function databaseMethod(
  step: Scenario['steps'][number],
  indexes: SourceIndex[],
): IndexedMethod | undefined {
  const methods = indexes
    .flatMap((index) => index.methods)
    .filter(
      (method) =>
        step.evidence.some((ref) => overlaps(ref, method.evidence)) &&
        (/(?:Repository|Repo|Dao|DAO)\.(kt|java)$/.test(method.evidence.path) ||
          method.callSites?.some((call) => call.database)),
    );
  const verb = step.label.match(/\b(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i)?.[1]?.toUpperCase();
  const names = new Set(step.label.match(/\b[\w$]+\b/g) ?? []);
  const named = methods.filter((method) => names.has(method.name));
  let candidates = named.length ? named : methods;
  if (verb) {
    const matching = candidates.filter((method) =>
      method.callSites
        ? method.callSites.some((call) => sqlKinds[call.name] === verb)
        : method.calls.some((call) => sqlKinds[call.split('.').at(-1)!.trim()] === verb),
    );
    if (matching.length) candidates = matching;
    else if (candidates.some((method) => method.callSites?.some((call) => sqlKinds[call.name])))
      return undefined;
  }
  const direct = candidates.filter((method) =>
    method.callSites?.some(
      (call) =>
        (!verb || sqlKinds[call.name] === verb) &&
        call.database &&
        step.evidence.some((ref) => overlaps(ref, call.evidence)),
    ),
  );
  if (direct.length) candidates = direct;
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Presentation derived from pinned signatures; ambiguous model files are never guessed. */
export function sequenceMethod(
  step: Scenario['steps'][number],
  indexes: SourceIndex[],
  snapshots: Snapshot[],
): SequenceMethod {
  const methods = indexes.flatMap((index) => index.methods);
  const referenced = methods.filter((method) =>
    step.evidence.some((ref) => overlaps(ref, method.evidence)),
  );
  const named = methods.filter(
    (method) =>
      step.evidence.some(
        (ref) => ref.repoId === method.evidence.repoId && ref.side === method.evidence.side,
      ) && new Set<string>(step.label.match(/\b[\w$]+\b/g) ?? []).has(method.name),
  );
  const targetName = step.label.split(/→|->/).at(-1)!;
  const exact = named.filter((method) => {
    const owner = method.evidence.path
      .split('/')
      .pop()!
      .replace(/\.(kt|java)$/, '');
    return targetName.includes(`${owner}.${method.name}`);
  });
  const queryMethods =
    step.kind === 'database'
      ? referenced.filter(
          (method) =>
            /(?:Repository|Repo|Dao|DAO)\.(kt|java)$/.test(method.evidence.path) ||
            method.callSites?.some((call) => call.database),
        )
      : [];
  const candidates = exact.length
    ? exact
    : queryMethods.length
      ? queryMethods
      : named.length
        ? named.filter((m) => referenced.includes(m))
        : referenced;
  const method =
    step.kind === 'database'
      ? databaseMethod(step, indexes)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
  const fallback = targetName.match(/\b[\w$]+\.([\w$]+)\s*(?=\(|$)/)?.[1];
  if (!method)
    return { label: fallback ? `${fallback}()` : targetName.trim(), inputs: [], outputs: [] };
  const signature = method.signature;
  const start =
    signature.indexOf(`${method.name}(`) >= 0
      ? signature.indexOf(`${method.name}(`) + method.name.length
      : signature.indexOf('(', signature.indexOf(method.name));
  let end = start + 1,
    depth = 1;
  while (end < signature.length && depth) {
    if (signature[end] === '(') depth++;
    if (signature[end] === ')') depth--;
    end++;
  }
  const kotlin = method.evidence.path.endsWith('.kt');
  const parameters = start < 0 ? [] : splitParameters(signature.slice(start + 1, end - 1));
  const inputTypes = parameters.map((parameter) =>
    kotlin
      ? parameter
          .slice(parameter.indexOf(':') + 1)
          .split('=')[0]
          .trim()
      : parameter
          .replace(/@[\w.]+(?:\([^)]*\))?\s*/g, '')
          .replace(/\bfinal\s+/g, '')
          .replace(/\s+[\w$]+\s*$/, '')
          .trim(),
  );
  const outputType = kotlin
    ? signature
        .slice(end)
        .match(/^\s*:\s*([^={]+)/)?.[1]
        ?.trim()
    : signature
        .slice(0, signature.lastIndexOf(method.name, start))
        .replace(/@[\w.]+(?:\([^)]*\))?/g, '')
        .trim()
        .match(/([\w$.?<>\[\],]+)\s*$/)?.[1];
  const snapshot = snapshots.find((s) => s.repoId === method.evidence.repoId);
  const files = method.evidence.side === 'head' ? snapshot?.headFiles : snapshot?.baseFiles;
  const links = (types: string[]): SequenceModelLink[] =>
    types.flatMap((type) => {
      const names = [...new Set(type.match(/\b[A-Z][\w$]*\b/g) ?? [])];
      const models = names.flatMap((name) => {
        const paths =
          files?.filter(
            (path) =>
              path.endsWith(`/${name}.kt`) ||
              path.endsWith(`/${name}.java`) ||
              path === `${name}.kt` ||
              path === `${name}.java`,
          ) ?? [];
        return paths.length === 1
          ? [{ name, evidence: { ...method.evidence, path: paths[0], startLine: 1, endLine: 1 } }]
          : [];
      });
      return models.length ? models : type ? [{ name: type }] : [];
    });
  return {
    label: `${method.name}()`,
    evidence: method.evidence,
    inputs: step.kind === 'return' ? [] : links(inputTypes),
    outputs: links(outputType ? [outputType] : []),
  };
}
