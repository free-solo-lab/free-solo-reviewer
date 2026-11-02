import type { AnalysisResult, Evidence, IndexedMethod, Scenario } from './model.js';
import { databaseParticipant, overlaps, type SequenceScenario } from './sequence.js';

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
  REQUIRED: 'Присоединение к внешней транзакции; новая создаётся только при её отсутствии.',
  REQUIRES_NEW: 'Отдельная транзакция; внешняя приостанавливается при вызове через Spring proxy.',
  NESTED: 'Вложенная область с savepoint, если transaction manager поддерживает этот режим.',
  SUPPORTS: 'Транзакция действует только при наличии внешней.',
  MANDATORY: 'Требуется внешняя транзакция; новая здесь не создаётся.',
  NOT_SUPPORTED: 'Выполнение без транзакции; внешняя приостанавливается при вызове через proxy.',
  NEVER: 'Выполнение без транзакции; наличие внешней приводит к ошибке.',
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
function reachableMethods(root: IndexedMethod, methods: IndexedMethod[]) {
  const reached = new Map<string, IndexedMethod>();
  const visit = (method: IndexedMethod) => {
    if (reached.has(methodKey(method)) || reached.size >= 200) return;
    reached.set(methodKey(method), method);
    for (const call of method.calls) {
      const parts = call.split('.'),
        name = parts.at(-1)!,
        receiver = parts.slice(0, -1).join('.');
      const targets = methods.filter(
        (candidate) =>
          candidate.name === name &&
          candidate.evidence.repoId === method.evidence.repoId &&
          candidate.evidence.side === method.evidence.side &&
          (!receiver || receiver === 'this'
            ? candidate.evidence.path === method.evidence.path
            : candidate.evidence.path
                .split('/')
                .pop()!
                .replace(/\.(java|kt)$/, '')
                .toLowerCase() === receiver.toLowerCase()),
      );
      if (targets.length === 1) visit(targets[0]);
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
) {
  return [
    ...new Set(scenario.steps.slice(start, end + 1).flatMap((step) => [step.from, step.to])),
  ].filter((id) => {
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
      'Границы восстановлены по исходникам; фактические commit/rollback не наблюдались.',
    ];
    if (selfCall)
      unknowns.unshift(
        'Возможен self-invocation: вызов внутри того же класса может обойти Spring proxy.',
      );
    const groups: number[][] = [];
    const reachable = reachableMethods(method, methods);
    const paths = new Set(reachable.map((candidate) => candidate.evidence.path));
    const scoped = scenario.steps.flatMap((step, i) =>
      i >= matching[0] &&
      (matching.includes(i) ||
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
            ? 'Граница не подтверждена: возможен обход Spring proxy.'
            : (descriptions[propagation] ?? 'Режим транзакции не определён.'),
          rollback:
            tx?.rollback ??
            'По умолчанию Spring откатывает RuntimeException и Error; rollbackFor/noRollbackFor и transaction manager требуют проверки.',
          unknowns,
          evidence: [method.evidence],
          participants: scopedParticipants(
            scenario,
            group[0],
            group.at(-1)!,
            method.evidence.repoId,
            paths,
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
          description:
            'Программная транзакция: область callback. Вызов внутри того же Spring-бина не требует перехвата аннотации через proxy.',
          rollback:
            'Необработанное исключение из callback приводит к rollback. Перехваченное исключение само по себе не доказывает откат.',
          unknowns: [
            'Фактические commit/rollback не наблюдались. Участие запросов зависит от Configuration/DSLContext и TransactionProvider; внешний DSLContext требует проверки.',
            ...(tx.nested
              ? [
                  'Вложенный вызов: savepoint и поведение вложенности зависят от TransactionProvider.',
                ]
              : []),
            ...(tx.asynchronous
              ? [
                  'Асинхронная/реактивная область: окончание callback не подтверждает завершение транзакции; для Publisher требуется подписка.',
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

export function sequenceLayout(scenario: Scenario, regions: TransactionRegion[], startY = 126) {
  const rows: number[] = [];
  let cursor = startY;
  scenario.steps.forEach((_step, index) => {
    cursor += regions.filter((r) => r.start === index).length * 32;
    rows.push(cursor);
    cursor += 112;
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
