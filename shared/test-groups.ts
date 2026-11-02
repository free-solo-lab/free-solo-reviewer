import type { Evidence, IndexedMethod, ReviewTest, Scenario, SourceIndex } from './model.js';
import { t } from './i18n.js';

export interface TestGroup {
  id: string;
  title: string;
  tests: ReviewTest[];
}

const className = (path: string) =>
  path
    .split('/')
    .pop()
    ?.replace(/\.(java|kt|kts)$/, '') ?? '';
const identifiers = (text: string) => new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);

/** Match explicit tested calls, not prose similarity or shared repository names. */
export function groupTests(
  tests: ReviewTest[],
  scenarios: Scenario[],
  indexes: SourceIndex[] = [],
): TestGroup[] {
  const groups = new Map<string, TestGroup>();
  for (const test of tests) {
    const calls = test.steps.filter((step) => step.kind === 'call');
    const overlaps = (a: Evidence, b: Evidence) =>
      a.repoId === b.repoId &&
      a.side === b.side &&
      a.path === b.path &&
      a.startLine <= b.endLine &&
      b.startLine <= a.endLine;
    const methods = indexes
      .filter((index) =>
        test.evidence.some((ref) => ref.repoId === index.repoId && ref.side === index.side),
      )
      .flatMap((index) => index.methods);
    const resolve = (
      name: string,
      receiver: string,
      origin: Evidence,
    ): IndexedMethod | undefined => {
      let targets = methods.filter(
        (method) =>
          method.name === name &&
          method.evidence.repoId === origin.repoId &&
          method.evidence.side === origin.side,
      );
      if (!receiver || receiver === 'this')
        targets = targets.filter((method) => method.evidence.path === origin.path);
      else
        targets = targets.filter(
          (method) => className(method.evidence.path).toLowerCase() === receiver.toLowerCase(),
        );
      return targets.length === 1 ? targets[0] : undefined;
    };
    const relevantRefs = test.steps
      .filter((step) => step.kind === 'call' || step.kind === 'assertion')
      .flatMap((step) => step.evidence);
    const queue = methods.flatMap((method) =>
      (method.callSites ?? [])
        .filter((call) => relevantRefs.some((ref) => overlaps(ref, call.evidence)))
        .flatMap((call) => {
          const target = resolve(call.name, call.receiver, call.evidence);
          return target ? [{ method: target, depth: 0 }] : [];
        }),
    );
    const reached = new Map<IndexedMethod, number>();
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { method, depth } = queue[cursor];
      if (reached.has(method)) continue;
      reached.set(method, depth);
      if (depth >= 3) continue;
      for (const call of method.callSites ?? []) {
        const target = resolve(call.name, call.receiver, call.evidence);
        if (target) queue.push({ method: target, depth: depth + 1 });
      }
    }
    const scores = scenarios
      .map((scenario) => {
        const refs = [
          ...scenario.evidence,
          ...scenario.steps.flatMap((step) => step.evidence),
        ].filter((ref) =>
          test.evidence.some((origin) => origin.repoId === ref.repoId && origin.side === ref.side),
        );
        if (!refs.length) return { scenario, score: 0 };
        const classes = new Set(refs.map((ref) => className(ref.path)));
        const words = identifiers(
          scenario.steps.map((step) => `${step.from} ${step.to} ${step.label}`).join(' '),
        );
        const indexedScore = Math.max(
          0,
          ...[...reached]
            .filter(([method]) => scenario.evidence.some((ref) => overlaps(ref, method.evidence)))
            .map(([, depth]) => 100 - depth),
        );
        const score =
          indexedScore ||
          calls.reduce((sum, call) => {
            const owners = [...identifiers(call.to)].filter((name) => classes.has(name));
            if (!owners.length) return sum;
            const methods = [...call.label.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(
              (match) => match[1],
            );
            return sum + (methods.some((method) => words.has(method)) ? 3 : 1);
          }, 0);
        return { scenario, score };
      })
      .sort((a, b) => b.score - a.score);
    const match =
      scores[0]?.score > 0 && scores[0].score > (scores[1]?.score ?? 0)
        ? scores[0].scenario
        : undefined;
    const source = test.evidence[0];
    const subject = className(source?.path ?? '') || t('Other checks');
    const id = match ? `scenario:${match.id}` : `class:${source?.repoId}:${source?.path}`;
    const group = groups.get(id) ?? { id, title: match?.title ?? subject, tests: [] };
    group.tests.push(test);
    groups.set(id, group);
  }
  const order = new Map(scenarios.map((scenario, index) => [`scenario:${scenario.id}`, index]));
  return [...groups.values()].sort(
    (a, b) => (order.get(a.id) ?? scenarios.length) - (order.get(b.id) ?? scenarios.length),
  );
}
