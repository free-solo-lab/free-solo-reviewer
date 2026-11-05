import { stepDescription } from './step-description.js';
import { evidenceService } from './source-service.js';
import type { Evidence, SourceIndex, Snapshot } from './model.js';
import {
  databaseCall,
  databaseFile,
  databaseOwner,
  overlaps,
  type SequenceScenario,
} from './sequence.js';
import { withExternalBoundary } from './sequence-boundary.js';
import { databaseMethod } from './sequence-method.js';
import { indexedCallChain, sameInvocation } from './sequence-calls.js';
import { t } from './i18n.js';

export interface SequenceParticipant {
  id: string;
  owner: string;
  label: string;
  kind: 'service' | 'class' | 'database' | 'external';
  evidence?: Evidence;
}
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fileClass = (e: Evidence) =>
  e.path
    .split('/')
    .pop()!
    .replace(/\.(java|kt)$/, '');

/** Presentation projection only. Original claims, code references and scope IDs stay intact. */
export function sequenceView(
  source: SequenceScenario,
  indexes: SourceIndex[],
  collapsed: ReadonlySet<string> = new Set(),
  snapshots: Snapshot[] = [],
) {
  source = withExternalBoundary(source, indexes);
  const participants = new Map<string, SequenceParticipant>();
  const service = (id: string) => {
    const owner = databaseOwner(id) ?? id;
    if (!participants.has(id))
      participants.set(id, {
        id,
        owner,
        label: id.startsWith('external:') ? t('External client') : id,
        kind: id.startsWith('external:') ? 'external' : databaseOwner(id) ? 'database' : 'service',
      });
    return id;
  };
  source.services.forEach(service);
  const classLane = (ref: Evidence) => {
    if (!/\.(java|kt)$/.test(ref.path)) return service(ref.repoId);
    const id = `class:${encodeURIComponent(ref.repoId)}:${encodeURIComponent(ref.path)}`;
    participants.set(id, {
      id,
      owner: ref.repoId,
      label: fileClass(ref),
      kind: 'class',
      evidence: { ...ref, startLine: 1, endLine: 1 },
    });
    return id;
  };
  const refsFor = (repoId: string, refs: Evidence[]) =>
    refs.filter((e) => e.repoId === repoId && /\.(java|kt)$/.test(e.path));
  const resolve = (repoId: string, hint: string, refs: Evidence[]) => {
    const local = refsFor(repoId, refs);
    const mentioned = local.filter((e) =>
      new RegExp(`\\b${escapeRegex(fileClass(e))}\\b`, 'i').test(hint),
    );
    const paths = [...new Set(mentioned.map((e) => e.path))];
    if (paths.length === 1) return classLane(mentioned[0]);
    // Only exact class names from this version's syntax index may add missing references.
    const indexed = indexes
      .filter((i) => i.repoId === repoId && local.some((e) => e.side === i.side))
      .flatMap((i) => i.methods.map((m) => m.evidence));
    const exact = indexed.filter(
      (e) =>
        hint
          .trim()
          .split(/[.:\s]/)[0]
          .toLowerCase() === fileClass(e).toLowerCase(),
    );
    if (new Set(exact.map((e) => e.path)).size === 1) return classLane(exact[0]);
    return local.length && new Set(local.map((e) => e.path)).size === 1
      ? classLane(local[0])
      : service(repoId);
  };
  const steps: SequenceScenario['steps'] = [];
  const transactionScopes = { ...source.transactionScopes };
  for (let step of source.steps) {
    step = { ...step, description: stepDescription(step) };
    let from = service(step.from),
      to = service(step.to);
    if (step.kind === 'database') {
      const refs = refsFor(step.from, step.evidence);
      const named = refs.filter((e) =>
        new RegExp(`\\b${escapeRegex(fileClass(e))}\\b`).test(step.label),
      );
      const databaseRefs = refs.filter(
        (e) =>
          databaseFile(e.path) ||
          indexes.some((index) =>
            index.methods.some(
              (method) =>
                overlaps(method.evidence, e) &&
                (method.callSites?.some(databaseCall) ||
                  method.calls.some((call) => /^(?:dsl\w*|jdbc\w*|entityManager)\./i.test(call))),
            ),
          ),
      );
      const candidates = databaseRefs.length ? databaseRefs : named.length ? named : refs;
      // Evidence order is not call direction. Ambiguous query owners stay on the service.
      const resolved = databaseMethod(step, indexes);
      const leaf =
        resolved?.evidence ??
        (new Set(candidates.map((e) => e.path)).size === 1 ? candidates[0] : undefined);
      if (leaf) {
        // A model can cite Service -> nested service -> repository while returning
        // only the SQL step. Restore proven intermediate invocations, not just its
        // immediate repository caller. The last edge is rendered by the DB bridge.
        const chain = resolved ? indexedCallChain(step.evidence, resolved, indexes) : [];
        for (const edge of chain.slice(0, -1)) {
          const callerId = classLane(edge.caller.evidence),
            calleeId = classLane(edge.callee.evidence);
          const alreadyShown = steps.some((previous) => {
            if (
              previous.kind !== 'call' ||
              previous.from !== callerId ||
              previous.to !== calleeId ||
              !new RegExp(`\\b${escapeRegex(edge.callee.name)}\\b`).test(previous.label)
            )
              return false;
            const sites = (edge.caller.callSites ?? []).filter(
              (call) =>
                call.name === edge.call.name &&
                call.receiver === edge.call.receiver &&
                previous.evidence.some((ref) => overlaps(ref, call.evidence)),
            );
            return sites.length === 1 && sameInvocation(sites[0].evidence, edge.call.evidence);
          });
          if (alreadyShown) continue;
          const call = edge.call.evidence;
          const id = `chain:${call.repoId}:${call.side}:${call.path}:${call.startLine}:${call.endLine}:${edge.callee.name}`;
          steps.push({
            ...step,
            id,
            description: undefined,
            from: callerId,
            to: calleeId,
            kind: 'call',
            label: `${fileClass(edge.caller.evidence)} → ${fileClass(edge.callee.evidence)}.${edge.callee.name}`,
            confidence: 'inferred',
            evidence: [call, edge.callee.evidence],
            branch: '',
          });
          transactionScopes[id] = edge.call.transactionIds;
        }
        const caller = refsFor(step.from, step.evidence).find(
          (e) =>
            e.path !== leaf.path &&
            (!resolved ||
              indexes
                .flatMap((index) => index.methods)
                .some(
                  (method) =>
                    overlaps(method.evidence, e) &&
                    (method.callSites
                      ? method.callSites.some(
                          (call) =>
                            call.name === resolved.name &&
                            call.receiver.toLowerCase() === fileClass(leaf).toLowerCase() &&
                            overlaps(call.evidence, e),
                        )
                      : !/Repository|Repo|Dao|DAO|\/utils\//.test(e.path)),
                )),
        );
        // Register the caller first so a newly discovered callee appears to its right.
        const callerId = caller ? classLane(caller) : undefined;
        from = classLane(leaf);
        if (caller && callerId) {
          const method = indexes.flatMap((i) => i.methods).find((m) => overlaps(m.evidence, leaf));
          const id = `internal:${step.id}`;
          const previous = steps.at(-1);
          if (!(previous?.from === callerId && previous?.to === from && previous.kind === 'call'))
            steps.push({
              ...step,
              id,
              description: undefined,
              from: callerId,
              to: from,
              label: `${fileClass(caller)} → ${fileClass(leaf)}${method ? `.${method.name}` : ''}`,
              kind: 'call',
              confidence: 'inferred',
              branch: t('Internal call rebuilt from code references'),
            });
          transactionScopes[id] = source.transactionScopes?.[step.id] ?? [];
        }
      }
    } else {
      const segments = step.label.split(/\s*(?:→|->)\s*/);
      // An arrow in prose (e.g. "inside putObject → HTTP PUT") is not a
      // caller/callee separator. Only a standalone owner/method may name the source.
      const parts =
        segments.length > 1 && /^[\w$]+(?:\.[\w$]+(?:\([^)]*\))?)?$/.test(segments[0].trim())
          ? segments
          : [step.label];
      from =
        databaseOwner(step.from) || step.from.startsWith('external:')
          ? from
          : resolve(step.from, parts[0], step.evidence);
      to =
        databaseOwner(step.to) || step.to.startsWith('external:')
          ? to
          : resolve(step.to, parts[1] ?? parts[0], step.evidence);
      if (step.kind === 'call' && step.from === step.to && parts.length === 1) {
        // A prose label can name the callee while evidence only cites its caller.
        // Resolve the actual indexed call, rather than mapping both ends to that file.
        const methods = indexes
          .filter((index) => index.repoId === step.to)
          .flatMap((index) => index.methods);
        const edges = methods.flatMap((caller) =>
          (caller.callSites ?? [])
            .filter((call) => step.evidence.some((ref) => overlaps(ref, call.evidence)))
            .flatMap((call) =>
              methods
                .filter(
                  (callee) =>
                    callee.evidence.side === caller.evidence.side &&
                    callee.evidence.path !== caller.evidence.path &&
                    callee.name === call.name &&
                    call.receiver.toLowerCase() === fileClass(callee.evidence).toLowerCase() &&
                    new RegExp(`\\b${escapeRegex(fileClass(callee.evidence))}\\b`, 'i').test(
                      step.label,
                    ),
                )
                .map((callee) => ({ caller, call, callee })),
            ),
        );
        if (edges.length === 1) {
          const { caller, call, callee } = edges[0];
          from = classLane(caller.evidence);
          to = classLane(callee.evidence);
          step = {
            ...step,
            label: `${fileClass(caller.evidence)} → ${fileClass(callee.evidence)}.${callee.name}`,
            evidence: [call.evidence, callee.evidence, ...step.evidence],
          };
        }
        const targets = indexes
          .filter(
            (index) =>
              index.repoId === step.to &&
              step.evidence.some((ref) => ref.repoId === index.repoId && ref.side === index.side),
          )
          .flatMap((index) => index.methods)
          .filter((method) => step.label.includes(`${fileClass(method.evidence)}.${method.name}`));
        if (!edges.length && targets.length === 1) to = classLane(targets[0].evidence);
      }
      // A local operation stays on its class lifeline; the service is a container, not a caller.
    }
    steps.push({ ...step, from, to });
  }
  for (const participant of [...participants.values()]) {
    if (participant.kind !== 'class' || !participant.evidence) continue;
    const owner = evidenceService(snapshots, participant.evidence);
    if (!owner || owner.id === participant.owner) continue;
    participant.owner = owner.id;
    if (!participants.has(owner.id))
      participants.set(owner.id, {
        id: owner.id,
        owner: owner.id,
        label: owner.name,
        kind: 'service',
      });
  }
  for (const step of steps) {
    const target = participants.get(step.to);
    if (target?.kind !== 'database') continue;
    const owner = participants.get(step.from)?.owner;
    if (!owner || owner === target.owner) continue;
    const id = `database:${owner}`;
    participants.set(id, {
      id,
      owner,
      label: participants.get(owner)?.label ?? owner,
      kind: 'database',
    });
    step.to = id;
  }
  const used = new Set(steps.flatMap((s) => [s.from, s.to]));
  const classOwners = new Set(
    [...participants.values()].filter((p) => p.kind === 'class').map((p) => p.owner),
  );
  for (const [id, p] of participants) {
    if (
      ((p.kind === 'service' && !classOwners.has(id)) || p.kind === 'database') &&
      !used.has(id) &&
      [...classOwners].some((owner) => owner.startsWith(`service:${databaseOwner(id) ?? id}:`))
    )
      participants.delete(id);
  }
  const owners = [...new Set([...participants.values()].map((p) => p.owner))];
  const internalCount = new Map<string, number>();
  const visible = steps
    .filter((step) => step.from !== step.to)
    .filter((s) => {
      const a = participants.get(s.from)!,
        b = participants.get(s.to)!;
      const internal = a.owner === b.owner && a.kind !== 'database' && b.kind !== 'database';
      if (internal) internalCount.set(a.owner, (internalCount.get(a.owner) ?? 0) + 1);
      return !(internal && collapsed.has(a.owner));
    })
    .map((s) => ({
      ...s,
      from:
        participants.get(s.from)!.kind === 'class' && collapsed.has(participants.get(s.from)!.owner)
          ? participants.get(s.from)!.owner
          : s.from,
      to:
        participants.get(s.to)!.kind === 'class' && collapsed.has(participants.get(s.to)!.owner)
          ? participants.get(s.to)!.owner
          : s.to,
    }));
  const lanes = owners.flatMap((owner) =>
    [...participants.values()]
      .filter((p) => p.owner === owner && (p.kind !== 'class' || !collapsed.has(owner)))
      .sort((a, b) => Number(a.kind === 'database') - Number(b.kind === 'database')),
  );
  return {
    scenario: { ...source, steps: visible, services: lanes.map((p) => p.id), transactionScopes },
    participants: lanes,
    owners,
    internalCount,
  };
}

/** Services/databases share the top row; class lifelines occupy a second row in their owner. */
export function sequenceParticipantLayout(participants: SequenceParticipant[]) {
  const positions = new Map<string, { x: number; y: number; width: number }>();
  let column = 0;
  const owners = [...new Set(participants.map((p) => p.owner))];
  for (const owner of owners) {
    const members = participants.filter((p) => p.owner === owner);
    const children = members.filter((p) => p.kind === 'class');
    const root = members.find((p) => p.kind === 'service' || p.kind === 'external');
    const start = column;
    if (children.length) {
      children.forEach((p) => positions.set(p.id, { x: 110 + column++ * 240, y: 94, width: 190 }));
      if (root)
        positions.set(root.id, {
          x: 110 + (start + (children.length - 1) / 2) * 240,
          y: 12,
          width: 190 + (children.length - 1) * 240,
        });
    } else if (root) positions.set(root.id, { x: 110 + column++ * 240, y: 12, width: 190 });
    members
      .filter((p) => p.kind === 'database')
      .forEach((p) => positions.set(p.id, { x: 110 + column++ * 240, y: 12, width: 190 }));
  }
  return {
    positions,
    width: Math.max(720, column * 240),
    hasClasses: participants.some((p) => p.kind === 'class'),
  };
}
