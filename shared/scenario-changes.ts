import { overlaps } from './sequence.js';
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
    step.from,
    step.to,
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
  let line = 0,
    inHunk = false;
  for (const text of file.patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (text.startsWith('-')) lines.add(Math.max(1, line));
    else if (text.startsWith('+')) {
      lines.add(line);
      line++;
    } else if (text.startsWith(' ')) line++;
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
  for (const scenario of current) {
    const byTitle = previous.filter((item) => item.title === scenario.title);
    const covered = (item: Scenario, catalog: ScenarioRoot[]) =>
      catalog
        .filter((root) =>
          item.steps.some((step) =>
            step.evidence.some((ref) => root.anchors.some((anchor) => overlaps(ref, anchor))),
          ),
        )
        .map((root) => root.id)
        .sort();
    const currentRoots = roots ? covered(scenario, roots.current) : [];
    const byRoots =
      roots && currentRoots.length
        ? previous.filter(
            (item) =>
              JSON.stringify(covered(item, roots.previous)) === JSON.stringify(currentRoots),
          )
        : [];
    const prior =
      (byRoots.length === 1 ? byRoots[0] : undefined) ??
      previous.find(
        (item) =>
          item.id === scenario.id &&
          (!roots ||
            !currentRoots.length ||
            covered(item, roots.previous).some((id) => currentRoots.includes(id))),
      ) ??
      (byTitle.length === 1 ? byTitle[0] : undefined);
    const steps = new Map<string, RevisionChange>();
    const matched = new Set<string>();
    const currentMeaning = fingerprints?.current ?? meaning;
    const previousMeaning = fingerprints?.previous ?? meaning;
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
      if (!before) steps.set(step.id, 'added');
      else if (
        previousMeaning(before) !== currentMeaning(step) ||
        touchesReviewChanges(step.evidence, changes) ||
        prior!.steps.indexOf(before) < lastPosition
      )
        steps.set(step.id, 'modified');
      if (before) lastPosition = Math.max(lastPosition, prior!.steps.indexOf(before));
    }
    const removed = prior?.steps.filter((step) => !matched.has(step.id)) ?? [];
    if (
      !prior ||
      steps.size ||
      removed.length ||
      scenario.summary !== prior.summary ||
      scenario.title !== prior.title ||
      touchesReviewChanges(scenario.evidence, changes)
    ) {
      result.set(scenario.id, {
        kind: prior ? 'modified' : 'added',
        previous: prior,
        steps,
        removed,
      });
    }
  }
  return result;
}
