import { overlaps } from './sequence.js';
import { patchLines } from './patch.js';
import type { ScenarioRoot } from './scenario-coverage.js';
import { sequenceMethod } from './sequence-method.js';
import type { Evidence, ReviewUpdate, Scenario, SourceIndex, Snapshot } from './model.js';
export type RevisionChange = 'added' | 'modified' | 'removed';
export interface ScenarioChange {
  kind: RevisionChange;
  previous?: Scenario;
  steps: Map<string, RevisionChange>;
  removed: Scenario['steps'];
}
const refs = (evidence: Evidence[]) =>
  [...new Set(evidence.map((ref) => `${ref.repoId}:${ref.side}:${ref.path}`))].sort();
const meaning = (step: Scenario['steps'][number]) =>
  JSON.stringify([
    step.from,
    step.to,
    step.kind,
    step.label.replace(/\s+/g, ' ').trim(),
    step.branch,
    refs(step.evidence),
  ]);
export function scenarioStepMeaning(
  step: Scenario['steps'][number],
  indexes: SourceIndex[],
  snapshots: Snapshot[],
) {
  const method = sequenceMethod(step, indexes, snapshots);
  if (!method.evidence) return meaning(step);
  return JSON.stringify([
    step.kind,
    method.evidence.repoId,
    method.evidence.side,
    method.evidence.path,
    method.label,
    method.inputs.map((model) => model.name),
    method.outputs.map((model) => model.name),
  ]);
}
function changedHeadLines(file: ReviewUpdate['changes'][number]['files'][number]) {
  const lines = new Set(file.addedLines);
  for (const line of patchLines(file.patch)) {
    if (line.kind === 'deletion') lines.add(Math.max(1, line.newLine));
    else if (line.kind === 'addition') lines.add(line.newLine);
  }
  return lines;
}
export function touchesReviewChanges(evidence: Evidence[], changes: ReviewUpdate['changes']) {
  // ReviewUpdate patches compare two PR heads; base-side evidence is a merge-base.
  return evidence.some(
    (ref) =>
      ref.side === 'head' &&
      changes.some(
        (change) =>
          change.repoId === ref.repoId &&
          change.fromSha !== change.toSha &&
          change.files.some(
            (file) =>
              file.path === ref.path &&
              [...changedHeadLines(file)].some(
                (line) => line >= ref.startLine && line <= ref.endLine,
              ),
          ),
      ),
  );
}
export function scenarioChanges(
  current: Scenario[],
  previous: Scenario[],
  changes: ReviewUpdate['changes'] = [],
  roots?: { current: ScenarioRoot[]; previous: ScenarioRoot[] },
  fingerprints?: {
    current: (step: Scenario['steps'][number]) => string;
    previous: (step: Scenario['steps'][number]) => string;
  },
) {
  const result = new Map<string, ScenarioChange>();
  const used = new Set<Scenario>();
  const covered = (item: Scenario, catalog: ScenarioRoot[]) => {
    // Prefer the entry caller over references spanning adjacent entry methods or
    // shared callees. Generated scenario IDs and prose are not source identities.
    for (const step of item.steps.filter((step) => step.kind === 'call')) {
      const caller = step.label.split(/→|->/)[0].trim();
      const named = catalog.filter(
        (root) =>
          caller === root.name && step.evidence.some((ref) => ref.repoId === root.evidence.repoId),
      );
      if (named.length === 1) return named.map((root) => root.id);
      const direct = catalog.filter((root) =>
        step.evidence.some((ref) => overlaps(ref, root.evidence)),
      );
      if (direct.length === 1) return direct.map((root) => root.id);
    }
    return catalog
      .filter((root) =>
        item.steps.some((step) =>
          step.evidence.some((ref) => root.anchors.some((anchor) => overlaps(ref, anchor))),
        ),
      )
      .map((root) => root.id)
      .sort();
  };
  const currentMeaning = fingerprints?.current ?? meaning;
  const previousMeaning = fingerprints?.previous ?? meaning;
  for (const scenario of current) {
    const available = previous.filter((item) => !used.has(item));
    const byTitle = available.filter((item) => item.title === scenario.title);
    const currentRoots = roots ? covered(scenario, roots.current) : [];
    const byRoots =
      roots && currentRoots.length
        ? available.filter(
            (item) =>
              JSON.stringify(covered(item, roots.previous)) === JSON.stringify(currentRoots),
          )
        : [];
    const byCalls =
      !currentRoots.length && scenario.steps.length
        ? available.filter(
            (item) =>
              JSON.stringify(item.steps.map(previousMeaning)) ===
              JSON.stringify(scenario.steps.map(currentMeaning)),
          )
        : [];
    const prior =
      (byRoots.length === 1 ? byRoots[0] : undefined) ??
      available.find(
        (item) =>
          item.id === scenario.id &&
          (!roots ||
            !currentRoots.length ||
            covered(item, roots.previous).some((id) => currentRoots.includes(id))),
      ) ??
      (byTitle.length === 1 &&
      (!roots ||
        !currentRoots.length ||
        covered(byTitle[0], roots.previous).some((id) => currentRoots.includes(id)))
        ? byTitle[0]
        : undefined) ??
      (byCalls.length === 1 ? byCalls[0] : undefined);
    if (prior) used.add(prior);
    const steps = new Map<string, RevisionChange>();
    const matched = new Set<string>();
    let lastPosition = -1;
    for (const step of scenario.steps) {
      const exact = prior?.steps.find(
        (candidate) =>
          !matched.has(candidate.id) && previousMeaning(candidate) === currentMeaning(step),
      );
      const before =
        exact ??
        prior?.steps.find((candidate) => !matched.has(candidate.id) && candidate.id === step.id);
      if (before) matched.add(before.id);
      const sourceChanged = touchesReviewChanges(step.evidence, changes);
      const verifiedSources = !!(roots && fingerprints);
      if (!before && (!verifiedSources || sourceChanged)) steps.set(step.id, 'added');
      else if (
        before &&
        (!verifiedSources || sourceChanged) &&
        (previousMeaning(before) !== currentMeaning(step) ||
          touchesReviewChanges(step.evidence, changes) ||
          prior!.steps.indexOf(before) < lastPosition)
      )
        steps.set(step.id, 'modified');
      if (before) lastPosition = Math.max(lastPosition, prior!.steps.indexOf(before));
    }
    const removed =
      prior?.steps.filter(
        (step) =>
          !matched.has(step.id) &&
          (!(roots && fingerprints) ||
            step.evidence.some(
              (ref) =>
                ref.side === 'head' &&
                changes.some(
                  (change) =>
                    change.repoId === ref.repoId &&
                    change.fromSha !== change.toSha &&
                    change.files.some(
                      (file) =>
                        (file.oldPath ?? file.path) === ref.path &&
                        file.removedLines.some(
                          (line) => line >= ref.startLine && line <= ref.endLine,
                        ),
                    ),
                ),
            )),
      ) ?? [];
    const sourceChanged = touchesReviewChanges(
      [...scenario.evidence, ...scenario.steps.flatMap((step) => step.evidence)],
      changes,
    );
    // With pinned source catalogs, re-generated diagram detail is not a PR fix.
    // A newly discovered scenario for an already existing entry is not new code.
    const existingEntry =
      roots && currentRoots.some((id) => roots.previous.some((root) => root.id === id));
    const changed = prior
      ? sourceChanged || (!(roots && fingerprints) && (steps.size > 0 || removed.length > 0))
      : !(roots && fingerprints && existingEntry) || sourceChanged;
    if (changed) {
      result.set(scenario.id, {
        kind: prior || existingEntry ? 'modified' : 'added',
        previous: prior,
        steps,
        removed,
      });
    }
  }
  return result;
}
