import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type {
  Evidence,
  IndexedMethod,
  ReviewTest,
  Scenario,
  Snapshot,
  SourceIndex,
} from '../shared/model';
import { scenarioCodeEntries, scopedSourceRows, testCodeEntries } from '../shared/scenario-code';
import { sourceDiffRows } from '../shared/source-diff';
import { SourceCode } from '../web/components';
import { OverviewView } from '../web/Overview';

const ref = (
  path: string,
  startLine: number,
  endLine = startLine,
  side: 'head' | 'base' = 'head',
): Evidence => ({ repoId: 'repo', path, side, startLine, endLine });
const method = (
  owner: string,
  name: string,
  start: number,
  end: number,
  side: 'head' | 'base' = 'head',
): IndexedMethod => ({
  owner,
  name,
  signature: `void ${name}()`,
  annotations: [],
  calls: [],
  evidence: ref(`${owner}.java`, start, end, side),
});
const methods = [
  method('Controller', 'run', 2, 7),
  method('Controller', 'unrelated', 10, 15),
  method('Service', 'save', 3, 8),
  method('Service', 'unchanged', 11, 14),
];
const snapshot = {
  id: 'snap',
  repoId: 'repo',
  repoName: 'repo',
  headFiles: ['Controller.java', 'Service.java'],
  baseFiles: ['Controller.java', 'Service.java'],
  files: [
    { path: 'Controller.java', status: 'M', patch: '', addedLines: [4, 12], removedLines: [4, 12] },
    { path: 'Service.java', status: 'M', patch: '', addedLines: [5], removedLines: [5] },
  ],
} as Snapshot;
const indexes: SourceIndex[] = [
  { repoId: 'repo', side: 'head', methods, filesIndexed: 2, errors: [] },
];
const scenario = {
  id: 'flow',
  title: 'Регистрация',
  summary: '',
  confidence: 'extracted',
  services: ['repo'],
  evidence: [],
  steps: [
    {
      id: 'a',
      from: 'client',
      to: 'repo',
      label: 'Controller.run()',
      kind: 'call',
      change: 'modified',
      branch: '',
      confidence: 'extracted',
      evidence: [ref('Controller.java', 2, 7)],
    },
    {
      id: 'b',
      from: 'repo',
      to: 'repo',
      label: 'Service.save()',
      kind: 'call',
      change: 'modified',
      branch: '',
      confidence: 'extracted',
      evidence: [ref('Controller.java', 4), ref('Service.java', 3, 8)],
    },
  ],
} as Scenario;

it('shows only the changed methods of the call chain, in order, without repeated calls or unrelated file changes', () => {
  const repeated = {
    ...scenario,
    steps: [
      ...scenario.steps,
      scenario.steps[1],
      {
        ...scenario.steps[1],
        id: 'unchanged',
        label: 'Service.unchanged()',
        evidence: [ref('Service.java', 11, 14)],
      },
    ],
  };
  expect(scenarioCodeEntries(repeated, [snapshot], indexes).map((entry) => entry.label)).toEqual([
    'Controller.run()',
    'Service.save()',
  ]);
  expect(
    scenarioCodeEntries(
      { ...scenario, steps: [], evidence: [ref('Controller.java', 1, 100)] },
      [snapshot],
      indexes,
    ),
  ).toEqual([]);
});
it('includes directly referenced protocol changes but excludes unrelated files', () => {
  const protocol = {
    ...snapshot,
    files: [
      ...snapshot.files,
      { path: 'api.thrift', status: 'A', patch: '', addedLines: [1, 2], removedLines: [] },
    ],
  };
  const entries = scenarioCodeEntries(
    { ...scenario, evidence: [ref('api.thrift', 1, 2)] },
    [protocol],
    indexes,
  );
  expect(entries.map((entry) => entry.evidence.path)).toEqual([
    'Controller.java',
    'Service.java',
    'api.thrift',
  ]);
});
it('includes precise changed class fields outside methods without expanding the entire Java file', () => {
  const changed = {
    ...snapshot,
    files: snapshot.files.map((file) =>
      file.path === 'Controller.java' ? { ...file, addedLines: [1, 4, 12] } : file,
    ),
  };
  const entries = scenarioCodeEntries(
    { ...scenario, evidence: [ref('Controller.java', 1)] },
    [changed],
    indexes,
  );
  expect(entries.at(-1)?.ranges).toEqual([ref('Controller.java', 1)]);
  expect(entries.some((entry) => entry.label === 'Controller.unrelated()')).toBe(false);
});
it('includes changed implementations of an interface call while omitting unchanged alternatives', () => {
  const declaration = method('Tracer', 'beforeCall', 2, 3),
    changed = method('ContextTracer', 'beforeCall', 4, 8),
    untouched = method('CompositeTracer', 'beforeCall', 4, 8);
  const traced = {
    ...snapshot,
    files: [
      { path: 'ContextTracer.java', status: 'M', addedLines: [6], removedLines: [6], patch: '' },
    ],
    headFiles: ['Tracer.java', 'ContextTracer.java', 'CompositeTracer.java'],
  };
  const index: SourceIndex = {
    ...indexes[0],
    methods: [declaration, changed, untouched],
    types: [
      {
        name: 'Tracer',
        qualifiedName: 'Tracer',
        kind: 'interface',
        parents: [],
        imports: [],
        evidence: declaration.evidence,
      },
      {
        name: 'ContextTracer',
        qualifiedName: 'ContextTracer',
        kind: 'class',
        parents: ['Tracer'],
        imports: [],
        evidence: changed.evidence,
      },
      {
        name: 'CompositeTracer',
        qualifiedName: 'CompositeTracer',
        kind: 'class',
        parents: ['Tracer'],
        imports: [],
        evidence: untouched.evidence,
      },
    ],
  };
  const flow = {
    ...scenario,
    steps: [
      { ...scenario.steps[0], label: 'Tracer.beforeCall()', evidence: [declaration.evidence] },
    ],
  };
  expect(scenarioCodeEntries(flow, [traced], [index]).map((entry) => entry.label)).toEqual([
    'ContextTracer.beforeCall()',
  ]);
});
it('keeps old and new method ranges for deletion-only changes and prefers a surviving head method', () => {
  const head = method('Service', 'save', 3, 6),
    base = method('Service', 'save', 3, 8, 'base');
  const changes = {
    ...snapshot,
    files: [
      {
        path: 'Service.java',
        status: 'M',
        patch: '@@ -4,2 +4,0 @@\n-delete();\n-deleteAgain();',
        addedLines: [],
        removedLines: [4, 5],
      },
    ],
  };
  const entry = scenarioCodeEntries(
    {
      ...scenario,
      steps: [{ ...scenario.steps[0], label: 'Service.save()', evidence: [base.evidence] }],
    },
    [changes],
    [
      { ...indexes[0], methods: [head] },
      { ...indexes[0], side: 'base', methods: [base] },
    ],
  )[0];
  expect(entry.evidence.side).toBe('head');
  expect(entry.ranges).toContainEqual(base.evidence);
  expect(entry.ranges).toContainEqual(head.evidence);
});
it('scopes the shared diff and its comments while preserving absolute line numbers and removed lines', () => {
  const text = 'outside\nmethod() {\nnew();\n}\nunrelated();\n';
  const file = {
    path: 'A.java',
    status: 'M',
    addedLines: [3, 5],
    removedLines: [3, 5],
    patch: '@@ -1,5 +1,5 @@\n outside\n method() {\n-old();\n+new();\n }\n-other();\n+unrelated();',
  };
  const evidence = ref('A.java', 2, 4),
    ranges = [evidence, ref('A.java', 2, 4, 'base')];
  const rows = scopedSourceRows(sourceDiffRows(text, evidence, file), ranges);
  expect(rows.map((row) => row.text)).toEqual(['method() {', 'old();', 'new();', '}']);
  const html = renderToStaticMarkup(
    React.createElement(SourceCode, {
      text,
      evidence,
      changedFile: file,
      ranges,
      autoScroll: false,
      onSelect() {},
      comments: [
        { id: 'in', body: 'Relevant comment', selected: true, evidence: ref('A.java', 3) },
        { id: 'out', body: 'Unrelated comment', selected: true, evidence: ref('A.java', 5) },
      ],
    }),
  );
  expect(html).toContain('Relevant comment');
  expect(html).not.toContain('Unrelated comment');
  expect(html).not.toContain('unrelated();');
  expect(html).toContain('data-source-line="3"');
});
it('places Code between Description and Diagram and makes it available without a drawable diagram', () => {
  const html = renderToStaticMarkup(
    React.createElement(OverviewView, {
      summary: '',
      scenarios: [scenario],
      snapshots: [],
      service: 'all',
      onService() {},
      selectedId: 'flow',
      onSelect() {},
      view: 'description',
      onView() {},
      diagram: () => null,
      code: () => null,
      hasDiagram: () => false,
      missingCount: 0,
      running: false,
      canAnalyze: false,
      onAnalyze: async () => {},
      children: null,
    }),
  );
  const switcher = html.slice(html.indexOf('aria-label="Вид сценария"'));
  expect(switcher.indexOf('Описание')).toBeLessThan(switcher.indexOf('Код'));
  expect(switcher.indexOf('Код')).toBeLessThan(switcher.indexOf('Диаграмма'));
  expect(switcher).toContain('disabled=""');
});

it('shows each test method whole, once, even when the analysis cites lines inside it', () => {
  const testMethods = [
    method('OrderTest', 'Nested', 1, 40),
    method('OrderTest', 'createsOrder', 5, 20),
    method('OrderTest', 'rejectsOrder', 22, 35),
  ];
  const index = { repoId: 'repo', side: 'head', methods: testMethods } as unknown as SourceIndex;
  const test = {
    evidence: [ref('OrderTest.java', 8, 9), ref('OrderTest.java', 12), ref('Fixture.json', 1, 4)],
  } as ReviewTest;
  expect(testCodeEntries(test, [index]).map((entry) => [entry.label, entry.ranges])).toEqual([
    ['OrderTest.createsOrder()', [ref('OrderTest.java', 5, 20)]],
    ['Fixture.json', [ref('Fixture.json', 1, 4)]],
  ]);
});
