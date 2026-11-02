import type { Scenario } from './model.js';
/** Strongly connected services remain together; components follow call direction. */
export function serviceGroups(scenario: Pick<Scenario, 'services' | 'steps'>): string[][] {
  const nodes = [
    ...new Set([...scenario.services, ...scenario.steps.flatMap((s) => [s.from, s.to])]),
  ];
  const edges = new Map(nodes.map((n) => [n, new Set<string>()]));
  for (const step of scenario.steps)
    if (step.kind !== 'return' && step.from !== step.to) edges.get(step.from)?.add(step.to);
  let next = 0;
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    on = new Set<string>(),
    groups: string[][] = [];
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    on.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        group.push(w);
      } while (w !== v);
      groups.push(group.sort());
    }
  };
  for (const n of nodes) if (!index.has(n)) visit(n);
  const owner = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((n) => owner.set(n, i)));
  const degree = groups.map(() => 0),
    dag = groups.map(() => new Set<number>());
  for (const [a, targets] of edges)
    for (const b of targets) {
      const x = owner.get(a)!,
        y = owner.get(b)!;
      if (x !== y && !dag[x].has(y)) {
        dag[x].add(y);
        degree[y]++;
      }
    }
  const ready = degree.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0),
    result: string[][] = [];
  while (ready.length) {
    const i = ready.shift()!;
    result.push(groups[i]);
    for (const j of dag[i]) if (--degree[j] === 0) ready.push(j);
  }
  return result;
}
