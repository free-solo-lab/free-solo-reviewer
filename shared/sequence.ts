import type { AnalysisResult, Evidence, IndexedMethod, Scenario } from './model.js';
import { t } from './i18n.js';

const prefix = 'database:';
export const databaseParticipant = (repoId: string) => `${prefix}${repoId}`;
export const databaseOwner = (id: string) =>
  id.startsWith(prefix) ? id.slice(prefix.length) : null;
export const overlaps = (a: Evidence, b: Evidence) =>
  a.repoId === b.repoId &&
  a.side === b.side &&
  a.path === b.path &&
  a.startLine <= b.endLine &&
  b.startLine <= a.endLine;
const stem = (path: string) =>
  path
    .split('/')
    .pop()!
    .replace(/\.(java|kt)$/, '');
const methodKey = (m: IndexedMethod) =>
  `${m.evidence.repoId}:${m.evidence.side}:${m.evidence.path}:${m.evidence.startLine}`;
const sqlVerbs: Record<string, string> = {
  select: 'SELECT',
  selectFrom: 'SELECT',
  selectDistinct: 'SELECT',
  selectCount: 'SELECT',
  selectOne: 'SELECT',
  insertInto: 'INSERT',
  update: 'UPDATE',
  deleteFrom: 'DELETE',
  mergeInto: 'MERGE',
  executeQuery: 'SQL',
  executeUpdate: 'SQL',
  batchUpdate: 'SQL',
};
const databaseCode = (m: IndexedMethod) =>
  /repository|dao|persistence/i.test(m.evidence.path) ||
  m.calls.some((c) => /^(?:dsl\w*|jdbc\w*|entityManager)\./i.test(c));
export type SequenceScenario = Scenario & { transactionScopes?: Record<string, string[]> };
interface Candidate {
  scopes?: string[];
  key: string;
  label: string;
  evidence: Evidence[];
  anchor: number;
  depth: number;
}

/** Derive presentation only: the persisted analysis and its SHA remain untouched. */
export function withDatabaseInteractions(
  scenario: Scenario,
  result: Pick<AnalysisResult, 'indexes' | 'database' | 'transactions'>,
): SequenceScenario {
  const original = scenario.steps.map((s) =>
    s.kind === 'database' ? { ...s, to: databaseParticipant(s.from) } : { ...s },
  );
  const methods = result.indexes.flatMap((i) => i.methods);
  const chosen = new Map<string, Candidate>();
  const explicit = original.filter((s) => s.kind === 'database');
  const offer = (candidate: Candidate) => {
    if (
      explicit.some((s) => s.evidence.some((e) => candidate.evidence.some((c) => overlaps(e, c))))
    )
      return;
    const old = chosen.get(candidate.key);
    if (
      !old ||
      candidate.depth < old.depth ||
      (candidate.depth === old.depth && candidate.anchor > old.anchor)
    )
      chosen.set(candidate.key, candidate);
  };
  const resolveCall = (caller: IndexedMethod, call: string) => {
    const parts = call.split('.'),
      name = parts.at(-1)!;
    const receiver = parts.length > 1 ? parts[0] : null;
    let options = methods.filter(
      (m) =>
        m.name === name &&
        m.evidence.repoId === caller.evidence.repoId &&
        m.evidence.side === caller.evidence.side,
    );
    if (receiver && receiver !== 'this') {
      options = options.filter((m) =>
        stem(m.evidence.path).toLowerCase().endsWith(receiver.toLowerCase()),
      );
    } else {
      const local = options.filter((m) => m.evidence.path === caller.evidence.path);
      if (local.length) options = local;
    }
    return options.length === 1 ? options[0] : null;
  };
  const walk = (
    method: IndexedMethod,
    anchor: number,
    depth: number,
    seen: Set<string>,
    trail: Evidence[],
    scopes: string[] = [],
    occurrence = '',
  ) => {
    const key = methodKey(method);
    if (seen.has(key) || depth > 6 || seen.size >= 100) return;
    seen = new Set(seen);
    seen.add(key);
    if (method.callSites) {
      method.callSites.forEach((call, index) => {
        const active = [...new Set([...scopes, ...call.transactionIds])];
        const location = `${key}:${index}:${active.join(',')}`;
        if (Object.hasOwn(sqlVerbs, call.name) && (call.database || databaseCode(method))) {
          offer({
            key: `${location}:${occurrence}`,
            label: `${sqlVerbs[call.name]} · ${stem(method.evidence.path)}.${method.name}`,
            evidence: [call.evidence, ...trail],
            anchor,
            depth,
            scopes: active,
          });
        } else {
          const target = resolveCall(method, [call.receiver, call.name].filter(Boolean).join('.'));
          if (target)
            walk(target, anchor, depth + 1, seen, [...trail, call.evidence], active, location);
          else if (
            /(?:repository|repo|dao)$/i.test(call.receiver) &&
            /^(find|get|save|insert|upsert|update|delete|count|exists)\w*/.test(call.name)
          ) {
            offer({
              key: location,
              label: `${call.receiver}.${call.name}`,
              evidence: [call.evidence, ...trail],
              anchor,
              depth,
              scopes: active,
            });
          }
        }
      });
      if (method.callSites.length) return;
    }
    const verbs = [
      ...new Set(
        method.calls
          .map((c) => {
            const key = c.split('.').at(-1)!;
            return Object.hasOwn(sqlVerbs, key) ? sqlVerbs[key] : undefined;
          })
          .filter((v): v is string => typeof v === 'string'),
      ),
    ];
    if (
      (databaseCode(method) && verbs.length) ||
      method.annotations.some((a) => /^@(Query|Insert|Update|Delete)\b/.test(a))
    ) {
      offer({
        key,
        label: `${verbs.join(' / ') || t('Request')} · ${stem(method.evidence.path)}.${method.name}`,
        evidence: [method.evidence, ...trail],
        anchor,
        depth,
      });
      return;
    }
    for (const call of method.calls) {
      const target = resolveCall(method, call);
      if (target) {
        walk(target, anchor, depth + 1, seen, [...trail, method.evidence]);
      } else if (
        /(?:repository|repo|dao)\.(?:find\w*|get\w*|save\w*|insert\w*|upsert\w*|update\w*|delete\w*|count\w*|exists\w*)$/i.test(
          call,
        )
      ) {
        offer({
          key: `${key}:${call}`,
          label: call,
          evidence: [method.evidence, ...trail],
          anchor,
          depth,
        });
      }
    }
  };
  const anchors = original.length
    ? original.map((s, i) => ({
        evidence: s.evidence,
        anchor: i,
        eligible: s.kind !== 'return' && s.kind !== 'database',
      }))
    : [{ evidence: scenario.evidence, anchor: -1, eligible: true }];
  for (const anchor of anchors) {
    if (!anchor.eligible) continue;
    const roots = methods.filter((m) => anchor.evidence.some((e) => overlaps(e, m.evidence)));
    for (const root of roots) walk(root, anchor.anchor, 0, new Set(), []);
  }
  // Old or partial analyses may have transaction facts but no usable syntax index.
  const extras = [
    ...result.transactions.flatMap((t) =>
      t.operations
        .filter((o) => o.kind === 'database')
        .map((o, i) => ({ key: `tx:${t.id}:${i}`, label: o.label, evidence: o.evidence })),
    ),
    ...result.database
      .filter((d) => d.kind !== 'migration')
      .map((d) => ({ key: `op:${d.id}`, label: d.title, evidence: d.evidence })),
  ];
  for (const extra of extras) {
    if (
      [...chosen.values()].some((c) =>
        c.evidence.some((e) => extra.evidence.some((ref) => overlaps(e, ref))),
      )
    )
      continue;
    const anchor = [...anchors]
      .reverse()
      .find(
        (a) => a.eligible && a.evidence.some((e) => extra.evidence.some((ref) => overlaps(e, ref))),
      );
    if (anchor) offer({ ...extra, anchor: anchor.anchor, depth: 100 });
  }
  const additions = [...chosen.values()];
  const steps: Scenario['steps'] = [];
  const transactionScopes: Record<string, string[]> = {};
  const addAt = (anchor: number) => {
    for (const entry of additions.filter((c) => c.anchor === anchor)) {
      const repoId = entry.evidence[0]?.repoId;
      if (!repoId) continue;
      transactionScopes[`db:${entry.key}`] = entry.scopes ?? [];
      steps.push({
        id: `db:${entry.key}`,
        from: repoId,
        to: databaseParticipant(repoId),
        label: entry.label,
        kind: 'database',
        change: 'unknown',
        branch: t('From static code; order and branches need checking'),
        confidence: 'inferred',
        evidence: entry.evidence,
      });
    }
  };
  if (!original.length) addAt(-1);
  original.forEach((step, i) => {
    steps.push(step);
    addAt(i);
  });
  return {
    ...scenario,
    transactionScopes,
    services: [
      ...new Set([
        ...scenario.services,
        ...steps.filter((s) => s.kind === 'database').map((s) => s.to),
      ]),
    ],
    steps,
  };
}
