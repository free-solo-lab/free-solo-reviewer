import type { AnalysisResult, Evidence, IndexedMethod, Scenario } from './model.js';
import { databaseParticipant, overlaps, type SequenceScenario } from './sequence.js';
import { sequenceActivations } from './sequence-activations.js';
import { t } from './i18n.js';

export interface TransactionRegion {
  id: string;
  title: string;
  repoId: string;
  start: number;
  end: number;
  propagation: string;
  mode: 'transaction' | 'conditional' | 'non-transactional' | 'uncertain';
  description: string;
  rollback: string;
  unknowns: string[];
  evidence: Evidence[];
  participants?: string[];
}
const descriptions: Record<string, string> = {
  REQUIRED: t('Joins the outer transaction; a new one is created only when there is none.'),
  REQUIRES_NEW: t(
    'A separate transaction; the outer one is suspended when called through the Spring proxy.',
  ),
  NESTED: t('A nested scope with a savepoint, if the transaction manager supports this mode.'),
  SUPPORTS: t('The transaction applies only when there is an outer one.'),
  MANDATORY: t('An outer transaction is required; no new one is created here.'),
  NOT_SUPPORTED: t(
    'Runs without a transaction; the outer one is suspended when called through a proxy.',
  ),
  NEVER: t('Runs without a transaction; an outer one causes an error.'),
};
const annotation = (method: IndexedMethod) =>
  method.annotations.find((a) => /@(?:[\w]+\.)*Transactional\b/.test(a));
const ownerName = (m: IndexedMethod) =>
  `${m.evidence.path
    .split('/')
    .pop()
    ?.replace(/\.(java|kt)$/, '')}.${m.name}`;
const methodKey = (method: IndexedMethod) =>
  `${method.evidence.repoId}:${method.evidence.side}:${method.evidence.path}:${method.evidence.startLine}`;
const classPath = (id: string) =>
  id.startsWith('class:') ? decodeURIComponent(id.split(':').slice(2).join(':')) : null;
const stem = (path: string) =>
  path
    .split('/')
    .pop()!
    .replace(/\.(java|kt)$/, '')
    .toLowerCase();
function reachableMethods(root: IndexedMethod, methods: IndexedMethod[]) {
  const reached = new Map<string, IndexedMethod>();
  const visit = (method: IndexedMethod) => {
    if (reached.has(methodKey(method)) || reached.size >= 200) return;
    reached.set(methodKey(method), method);
    for (const call of method.calls) {
      const parts = call.split('.'),
        name = parts.at(-1)!,
        receiver = parts.slice(0, -1).join('.');
      const owner = receiver.toLowerCase();
      const targets = methods.filter(
        (candidate) =>
          candidate.name === name &&
          candidate.evidence.repoId === method.evidence.repoId &&
          candidate.evidence.side === method.evidence.side &&
          (!receiver || receiver === 'this'
            ? candidate.evidence.path === method.evidence.path
            : // A Spring bean is usually injected as its interface; the code runs in its Impl.
              [owner, `${owner}impl`].includes(stem(candidate.evidence.path))),
      );
      // The interface declaration and its Impl are one call, not an ambiguous overload.
      if (
        targets.length === 1 ||
        new Set(targets.map((target) => stem(target.evidence.path))).size === 2
      )
        targets.forEach(visit);
    }
  };
  visit(root);
  return [...reached.values()];
}
function scopedParticipants(
  scenario: Scenario,
  start: number,
  end: number,
  repoId: string,
  paths: Set<string>,
  /** Steps that run inside the transactional call on the diagram, whatever class they are in. */
  nested: ReadonlySet<number> = new Set(),
) {
  const inside = new Set(
    scenario.steps.flatMap((step, i) =>
      i >= start && i <= end && nested.has(i)
        ? step.kind === 'return'
          ? [step.from]
          : [step.from, step.to]
        : [],
    ),
  );
  return [
    ...new Set(scenario.steps.slice(start, end + 1).flatMap((step) => [step.from, step.to])),
  ].filter((id) => {
    if (inside.has(id)) return true;
    const path = classPath(id);
    return path
      ? paths.has(path) && id.startsWith(`class:${encodeURIComponent(repoId)}:`)
      : id === repoId || id === databaseParticipant(repoId);
  });
}

/** These are annotated code scopes, never observed BEGIN/COMMIT events. */
export function transactionRegions(
  scenario: SequenceScenario,
  result: Pick<AnalysisResult, 'indexes' | 'transactions'>,
): TransactionRegion[] {
  const methods = result.indexes.flatMap((i) => i.methods),
    regions: TransactionRegion[] = [];
  const activations = sequenceActivations(scenario.steps);
  for (const method of methods) {
    const mark = annotation(method);
    if (!mark) continue;
    const tx = result.transactions.find((t) =>
      t.evidence.some((e) => overlaps(e, method.evidence)),
    );
    const matching = scenario.steps.flatMap((step, i) =>
      step.evidence.some((e) => overlaps(e, method.evidence)) ||
      (step.to.startsWith(`class:${encodeURIComponent(method.evidence.repoId)}:`) &&
        classPath(step.to) === method.evidence.path &&
        step.label.includes(`.${method.name}`) &&
        step.evidence.some(
          (ref) => ref.repoId === method.evidence.repoId && ref.side === method.evidence.side,
        ))
        ? [i]
        : [],
    );
    if (!matching.length) continue;
    const propagation =
      /\bpropagation\s*=\s*(?:[\w]+\.)*([A-Z_]+)/.exec(mark)?.[1] ??
      /TxType\.([A-Z_]+)/.exec(mark)?.[1] ??
      'REQUIRED';
    const selfCall = methods.some(
      (caller) =>
        caller.evidence.repoId === method.evidence.repoId &&
        caller.evidence.side === method.evidence.side &&
        caller.evidence.path === method.evidence.path &&
        caller.evidence.startLine !== method.evidence.startLine &&
        caller.calls.some((c) => c === `this.${method.name}` || c === method.name) &&
        scenario.steps.some(
          (step) =>
            step.kind !== 'return' && step.evidence.some((e) => overlaps(e, caller.evidence)),
        ),
    );
    const mode: TransactionRegion['mode'] = selfCall
      ? 'uncertain'
      : ['NOT_SUPPORTED', 'NEVER'].includes(propagation)
        ? 'non-transactional'
        : ['SUPPORTS', 'MANDATORY'].includes(propagation)
          ? 'conditional'
          : Object.hasOwn(descriptions, propagation)
            ? 'transaction'
            : 'uncertain';
    const unknowns = [
      ...(tx?.unknowns ?? []),
      t('Boundaries are rebuilt from sources; actual commits and rollbacks were not observed.'),
    ];
    if (selfCall)
      unknowns.unshift(
        t('Possible self-invocation: a call within the same class may bypass the Spring proxy.'),
      );
    const groups: number[][] = [];
    const reachable = reachableMethods(method, methods);
    const paths = new Set(reachable.map((candidate) => candidate.evidence.path));
    // On the diagram the method runs until it returns: everything it calls in between,
    // e.g. queries of a DAO Impl the index cannot link to the injected interface, is inside.
    const nested = new Set(
      matching.flatMap((i) => {
        const step = scenario.steps[i];
        if (step.kind !== 'call' || classPath(step.to) !== method.evidence.path) return [];
        const bar = activations.find((a) => a.start === i && a.lane === step.to);
        return bar ? Array.from({ length: bar.end - i }, (_, n) => i + 1 + n) : [];
      }),
    );
    const scoped = scenario.steps.flatMap((step, i) =>
      i >= matching[0] &&
      (matching.includes(i) ||
        nested.has(i) ||
        (!(step.kind === 'call' && classPath(step.from) && !paths.has(classPath(step.from)!)) &&
          step.evidence.some((ref) =>
            reachable.some((candidate) => overlaps(ref, candidate.evidence)),
          )))
        ? [i]
        : [],
    );
    for (const index of scoped) {
      const last = groups.at(-1);
      if (last && index === last.at(-1)! + 1) last.push(index);
      else groups.push([index]);
    }
    groups
      .filter((group) => group.some((index) => matching.includes(index)))
      .forEach((group, part) =>
        regions.push({
          id: `${method.evidence.repoId}:${method.evidence.side}:${method.evidence.path}:${method.evidence.startLine}:${part}`,
          title: ownerName(method),
          repoId: method.evidence.repoId,
          start: group[0],
          end: group.at(-1)!,
          propagation,
          mode,
          description: selfCall
            ? t('The boundary is not confirmed: the Spring proxy may be bypassed.')
            : (descriptions[propagation] ?? t('The transaction mode is unknown.')),
          rollback:
            tx?.rollback ??
            t(
              'By default Spring rolls back on RuntimeException and Error; rollbackFor/noRollbackFor and the transaction manager need checking.',
            ),
          unknowns,
          evidence: [method.evidence],
          participants: scopedParticipants(
            scenario,
            group[0],
            group.at(-1)!,
            method.evidence.repoId,
            paths,
            nested,
          ),
        }),
      );
  }
  for (const method of methods) {
    for (const tx of method.programmaticTransactions ?? []) {
      const matching = scenario.steps.flatMap((step, i) => {
        const recorded = scenario.transactionScopes?.[step.id];
        // Exact AST scope membership wins over broad, method-level model references.
        const inside =
          recorded !== undefined
            ? recorded.includes(tx.id)
            : tx.callback &&
              step.evidence.some(
                (e) =>
                  overlaps(e, tx.evidence) &&
                  e.startLine >= tx.evidence.startLine &&
                  e.endLine <= tx.evidence.endLine &&
                  tx.evidence.startLine !== tx.evidence.endLine,
              );
        return inside ? [i] : [];
      });
      const groups: number[][] = [];
      for (const i of matching) {
        const last = groups.at(-1);
        if (last && i === last.at(-1)! + 1) last.push(i);
        else groups.push([i]);
      }
      groups.forEach((group, part) =>
        regions.push({
          id: `${tx.id}:${part}`,
          title: `${ownerName(method)} · ${tx.api}`,
          repoId: method.evidence.repoId,
          start: group[0],
          end: group.at(-1)!,
          propagation: `jOOQ · ${tx.api}`,
          mode: 'transaction',
          description: t(
            'Programmatic transaction: the callback scope. A call within the same Spring bean does not need the annotation to be intercepted by a proxy.',
          ),
          rollback: t(
            'An unhandled exception from the callback causes a rollback. A caught exception alone does not prove a rollback.',
          ),
          unknowns: [
            t(
              'Actual commits and rollbacks were not observed. Query participation depends on Configuration/DSLContext and the TransactionProvider; an outer DSLContext needs checking.',
            ),
            ...(tx.nested
              ? [
                  t(
                    'Nested call: the savepoint and nesting behavior depend on the TransactionProvider.',
                  ),
                ]
              : []),
            ...(tx.asynchronous
              ? [
                  t(
                    'Asynchronous/reactive scope: the end of the callback does not confirm the transaction finished; a Publisher needs a subscription.',
                  ),
                ]
              : []),
          ],
          evidence: [tx.evidence],
          participants: scopedParticipants(
            scenario,
            group[0],
            group.at(-1)!,
            method.evidence.repoId,
            new Set(reachableMethods(method, methods).map((candidate) => candidate.evidence.path)),
          ),
        }),
      );
    }
  }
  return regions.sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
}

export function sequenceLayout(
  scenario: Scenario,
  regions: TransactionRegion[],
  startY = 126,
  /** Extra room after a step, e.g. for several answers returning there. */
  gaps: number[] = [],
) {
  const rows: number[] = [];
  let cursor = startY;
  scenario.steps.forEach((_step, index) => {
    cursor += regions.filter((r) => r.start === index).length * 32;
    rows.push(cursor);
    cursor += 112 + (gaps[index] ?? 0);
    cursor += regions.filter((r) => r.end === index).length * 24;
  });
  const frames = regions.map((region, index) => {
    const opening = regions.filter((r) => r.start === region.start);
    const rank = opening.findIndex((r) => r.id === region.id);
    const closing = regions.filter((r) => r.end === region.end);
    const closeRank = closing.findIndex((r) => r.id === region.id);
    const participants = region.participants?.length
      ? region.participants
      : [
          region.repoId,
          ...(scenario.services.includes(databaseParticipant(region.repoId))
            ? [databaseParticipant(region.repoId)]
            : []),
        ];
    const entry = scenario.steps[region.start];
    // Include the incoming local arrow in the frame geometry without treating
    // its caller as a method that executes inside this transaction.
    const boundaryParticipants = [
      ...new Set([
        ...participants,
        ...(entry?.kind === 'call' &&
        participants.includes(entry.to) &&
        entry.from.startsWith(`class:${encodeURIComponent(region.repoId)}:`)
          ? [entry.from]
          : []),
      ]),
    ];
    return {
      ...region,
      lane: regions
        .slice(0, index)
        .filter((r) => r.start <= region.end && r.end >= region.start && r.repoId === region.repoId)
        .length,
      top: rows[region.start] - 55 - (opening.length - rank) * 32,
      bottom: rows[region.end] + 70 + closeRank * 24,
      participants,
      boundaryParticipants,
    };
  });
  return { rows, frames, height: Math.max(230, cursor + 20) };
}
