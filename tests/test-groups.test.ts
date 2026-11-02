import { describe, expect, it } from 'vitest';
import { groupTests } from '../shared/test-groups';
import type { Evidence, IndexedMethod, ReviewTest, Scenario, SourceIndex } from '../shared/model';

const ref = (path: string, repoId = 'repo'): Evidence => ({
  repoId,
  side: 'head',
  path,
  startLine: 1,
  endLine: 10,
});
const method = (name: string, path: string, calls: [string, string][] = []): IndexedMethod => ({
  name,
  signature: `${name}()`,
  annotations: [],
  calls: [],
  evidence: ref(path),
  callSites: calls.map(([name, receiver]) => ({
    name,
    receiver,
    evidence: ref(path),
    database: false,
    transactionIds: [],
  })),
});
const test: ReviewTest = {
  id: 'test',
  title: 'Ошибка поиска',
  summary: 'Проверяет ошибку запроса.',
  method: 'rejects',
  confidence: 'inferred',
  evidence: [ref('HandlerTest.kt')],
  steps: [
    {
      id: 'assert',
      kind: 'assertion',
      from: 'HandlerTest',
      to: 'handler',
      label: 'assertThrows: search',
      evidence: [ref('HandlerTest.kt')],
      data: [],
    },
  ],
};
const scenario = (id: string, path: string): Scenario => ({
  id,
  title: id,
  summary: '',
  confidence: 'inferred',
  evidence: [ref(path)],
  services: ['repo'],
  steps: [],
});
const index: SourceIndex = {
  repoId: 'repo',
  side: 'head',
  methods: [
    method('rejects', 'HandlerTest.kt', [['search', 'handler']]),
    method('search', 'Handler.kt', [['search', 'queryService']]),
    method('search', 'QueryService.kt'),
  ],
  filesIndexed: 3,
  errors: [],
};

describe('test scenario menu groups', () => {
  it('connects an asserted call through a handler to the reviewed scenario', () => {
    const groups = groupTests([test], [scenario('Поиск', 'QueryService.kt')], [index]);
    expect(groups.map((group) => group.title)).toEqual(['Поиск']);
    expect(groups[0].tests).toEqual([test]);
  });

  it('keeps ambiguous scenarios in the source class group without duplicating tests', () => {
    const groups = groupTests(
      [test],
      [scenario('Первый', 'QueryService.kt'), scenario('Второй', 'QueryService.kt')],
      [index],
    );
    expect(groups.map((group) => group.title)).toEqual(['HandlerTest']);
    expect(groups.flatMap((group) => group.tests)).toEqual([test]);
  });

  it('does not connect equal class names in another repository or version', () => {
    const foreign = scenario('Другой репозиторий', 'QueryService.kt');
    foreign.evidence = [ref('QueryService.kt', 'other')];
    const base = scenario('Старая версия', 'QueryService.kt');
    base.evidence = [{ ...ref('QueryService.kt'), side: 'base' }];
    expect(groupTests([test], [foreign, base], [index])[0].title).toBe('HandlerTest');
  });
});
