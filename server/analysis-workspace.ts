import { renderPrompt, type PromptOverrides } from '../shared/prompt-templates.js';
import { mkdir, writeFile, copyFile, lstat, readdir, constants } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { AnalysisInput } from './provider.js';
import { safePath } from './repository.js';
import { scenarioRoots } from '../shared/scenario-coverage.js';
import { reviewTestMethods } from '../shared/test-coverage.js';
import { sqlMethods } from '../shared/sql-coverage.js';
import { directlyChanged, affectedProductionMethods } from '../shared/analysis-scope.js';
import { toRef, wireRefs } from './wire-format.js';
import { scenarioSkeletons } from '../shared/scenario-skeleton.js';
import type { Evidence } from '../shared/model.js';

/** Patches that cost many tokens and rarely matter for behaviour: data dumps, locks, dashboards. */
const NOISE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|gradle\.lockfile|[^/]*\.min\.(js|css))$|(^|\/)(dashboards?|grafana|generated|__snapshots__)\/|\.(json|csv|svg|lock)$/i;
const MAX_PATCH = 24_000;

/** Clones where the file system allows it; files a previous stage already has are kept. */
async function copySources(source: string, target: string, paths: string[]) {
  const present = new Set(await readdir(target, { recursive: true }).catch(() => []));
  const files = (
    await Promise.all(
      paths.map(async (path) => {
        const from = safePath(source, path),
          to = safePath(target, path);
        if (present.has(path)) return;
        const stat = await lstat(from);
        return stat.isFile() && !stat.isSymbolicLink() ? { from, to } : undefined;
      }),
    )
  ).filter((file) => !!file);
  for (const directory of new Set(files.map((file) => dirname(file.to))))
    await mkdir(directory, { recursive: true, mode: 0o700 });
  for (let i = 0; i < files.length; i += 32)
    await Promise.all(
      files.slice(i, i + 32).map(async ({ from, to }) => {
        try {
          await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }),
    );
}
/** A pinned, sanitized local workspace. Source text and indexes stay on disk. */
export async function prepareAnalysisWorkspace(home: string, input: AnalysisInput) {
  const root = join(home, 'workspace');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const repositories = [];
  const scopedSnapshots = stageSnapshots(input);
  for (const [i, snapshot] of input.snapshots.entries()) {
    const directory = `repo-${i + 1}`;
    for (const side of ['base', 'head'] as const)
      await copySources(
        side === 'head' ? snapshot.headDir : snapshot.baseDir,
        join(root, directory, side),
        side === 'head' ? snapshot.headFiles : snapshot.baseFiles,
      );
    repositories.push({
      directory,
      name: snapshot.repoName,
      target: !!(snapshot.pr || snapshot.local),
    });
  }
  // One diff per changed file under its short id, read on demand, never embedded in the prompt.
  const refs = stageRefs(input);
  const ref = (evidence: Evidence) => toRef(evidence, refs);
  await mkdir(join(root, 'diffs'), { recursive: true, mode: 0o700 });
  const files = [];
  for (const [id, file] of refs.files) {
    const change = scopedSnapshots
      .find((snapshot) => snapshot.repoId === file.repoId)!
      .files.find((f) => f.path === file.path)!;
    const omitted = NOISE.test(change.path) || change.patch.length > MAX_PATCH;
    await writeFile(
      join(root, 'diffs', `${id}.diff`),
      omitted
        ? `Patch omitted (${change.patch.length} chars, data or generated file). Read the file only if a changed behaviour depends on it.\n`
        : change.patch,
    );
    files.push({
      id,
      repo: [...refs.repos].find(([, repoId]) => repoId === file.repoId)![0],
      path: change.path,
      ...(change.oldPath && { oldPath: change.oldPath }),
      status: change.status,
      lines: `+${change.addedLines.length} -${change.removedLines.length}`,
      ...(omitted && { omitted: true }),
    });
  }
  const stage = analysisStage(input);
  const testTargets = (
    input.testTargets ?? reviewTestMethods(scopedSnapshots, input.indexes)
  ).filter((method) => directlyChanged(method, scopedSnapshots));
  const sqlCatalog = sqlMethods(scopedSnapshots, input.indexes);
  const sqlTargets = (input.sqlTargets ?? sqlCatalog).filter((method) =>
    sqlCatalog.some(
      (target) => JSON.stringify(target.evidence) === JSON.stringify(method.evidence),
    ),
  );
  const production = affectedProductionMethods(scopedSnapshots, input.indexes);
  const selectedMethods = new Set(
    (stage === 'tests' ? testTargets : stage === 'database' ? sqlTargets : production).map(
      (method) => JSON.stringify(method.evidence),
    ),
  );
  const indexes = input.indexes
    .map((index) => ({
      repo: [...refs.repos].find(([, repoId]) => repoId === index.repoId)?.[0],
      side: index.side,
      methods: index.methods
        .filter((method) => selectedMethods.has(JSON.stringify(method.evidence)))
        .map(({ name, signature, calls, evidence }) => ({
          name,
          signature,
          calls,
          at: ref(evidence),
        })),
    }))
    .filter((index) => index.methods.length);
  await writeFile(join(root, 'index.json'), JSON.stringify(indexes));
  // Evidence of the previous review uses the same short refs as the answer.
  await writeFile(
    join(root, 'previous-review.json'),
    JSON.stringify(input.followUp ?? null, (_key, value) =>
      value && typeof value === 'object' && 'repoId' in value && 'startLine' in value
        ? ref(value as Evidence)
        : value,
    ),
  );
  const targets = (methods: { name: string; evidence: Evidence }[]) =>
    methods.map((m) => ({ name: m.name, at: ref(m.evidence) }));
  const manifest = {
    repositories,
    changes: files,
    ...(stage === 'review' || stage === 'scenarios'
      ? {
          scenarioRoots: stageRoots(input).map((root) => ({
            id: root.id,
            name: root.name,
            at: ref(root.evidence),
            chain: [...(refs.edges?.values() ?? [])]
              .filter((edge) => edge.rootId === root.id)
              .map(
                (edge) =>
                  `${edge.id} ${edge.caller} -> ${edge.callee} at ${ref(edge.evidence[0])}${edge.kind === 'database' ? ' database' : ''}${edge.changed ? ' changed' : ''}`,
              ),
          })),
        }
      : {}),
    ...(stage === 'review' && input.changeCards?.length
      ? {
          changeCards: input.changeCards.map((card) => ({
            at: ref(card.evidence),
            name: card.name,
            kind: card.kind,
            risk: card.risk,
            text: card.text,
          })),
        }
      : {}),
    ...(stage === 'tests'
      ? {
          testTargets: targets(testTargets),
        }
      : {}),
    ...(stage === 'database' ? { sqlTargets: targets(sqlTargets) } : {}),
    files: {
      diffs: 'diffs/<id>.diff',
      index: 'index.json',
      previousReview: 'previous-review.json',
    },
    scope:
      'DIFF ONLY. Test targets must intersect changed lines. Production targets are changed methods and callers leading to them, never unrelated outgoing branches. Unchanged source is supporting context only, not a separate review target.',
  };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  return root;
}

/** On a follow-up only the files changed since the previous review are in scope. */
export function stageSnapshots(input: AnalysisInput) {
  return input.followUp
    ? input.snapshots.map((snapshot) => ({
        ...snapshot,
        files:
          input.followUp!.changes.find((change) => change.repoId === snapshot.repoId)?.files ?? [],
      }))
    : input.snapshots;
}
const stageRoots = (input: AnalysisInput) =>
  input.scenariosOnly ?? scenarioRoots(stageSnapshots(input), input.indexes);
/** The short file ids and scenario edges the workspace and the model's answer share. */
export function stageRefs(input: AnalysisInput) {
  const snapshots = stageSnapshots(input);
  const refs = wireRefs(snapshots);
  const stage = analysisStage(input);
  if (stage === 'review' || stage === 'scenarios')
    refs.edges = new Map(
      scenarioSkeletons(stageRoots(input), snapshots, input.indexes).map((edge) => [edge.id, edge]),
    );
  if (stage === 'database')
    refs.methods = (input.sqlTargets ?? []).map((method) => method.evidence);
  return refs;
}

export function analysisStage(input: AnalysisInput) {
  return input.testsOnly
    ? 'tests'
    : input.sqlOnly
      ? 'database'
      : input.scenariosOnly
        ? 'scenarios'
        : 'review';
}

export function localAnalysisPrompt(
  input: AnalysisInput,
  messages: string[] = [],
  overrides: PromptOverrides = {},
) {
  const stage = analysisStage(input);
  const scenarioStage = stage === 'review' || stage === 'scenarios';
  const roots = scenarioStage ? stageRoots(input).length : 0;
  const chains = scenarioStage && !!stageRefs(input).edges?.size;
  return renderPrompt(
    'analysis',
    {
      stage,
      cardsContext:
        stage === 'review' && input.changeCards?.length
          ? renderPrompt('reuseCards', {}, overrides)
          : '',
      reviewInstructions:
        stage === 'review'
          ? renderPrompt(
              'review',
              {
                targets: roots
                  ? 'Use manifest.scenarioRoots as required entries. '
                  : 'There are no detected entry points; build scenarios only for changed behaviour you can trace, or none. ',
              },
              overrides,
            )
          : '',
      scenarioInstructions: stage === 'scenarios' ? renderPrompt('scenarios', {}, overrides) : '',
      databaseInstructions: stage === 'database' ? renderPrompt('database', {}, overrides) : '',
      chainInstructions: chains
        ? renderPrompt('sequenceChain', {}, overrides)
        : renderPrompt('sequenceFallback', {}, overrides),
      userMessages: JSON.stringify(messages),
    },
    overrides,
  );
}
