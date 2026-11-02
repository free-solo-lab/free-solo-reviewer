import { describe, expect, it } from 'vitest';
import { changeUnits, patchLines } from '../shared/change-units';
import {
  changeCards,
  cardKey,
  cardsPrompt,
  parseCards,
  type CardDraft,
} from '../server/change-cards';
import { scenarioSkeletons } from '../shared/scenario-skeleton';
import { fromWire, wireRefs } from '../server/wire-format';
import { decodeModelResult } from '../server/validation';
import type { IndexedMethod, Snapshot, SourceIndex } from '../shared/model';

const path = 'src/main/kotlin/OrderService.kt';
const patch = [
  '@@ -1,12 +1,13 @@',
  ' import a.B',
  '-import a.C',
  '+import a.D',
  ' class OrderService {',
  '   fun create(order: Order) {',
  '-    repository.save(order)',
  '+    repository.save(order.copy(status = NEW))',
  '+    payments.charge(order.id)',
  '   }',
  '   fun list() = repository.all()',
  ' }',
].join('\n');
const method = (
  name: string,
  side: 'base' | 'head',
  start: number,
  end: number,
  extra: Partial<IndexedMethod> = {},
): IndexedMethod => ({
  name,
  signature: `fun ${name}()`,
  annotations: [],
  calls: [],
  evidence: { repoId: 'r', side, path, startLine: start, endLine: end },
  ...extra,
});
const snapshot = {
  repoId: 'r',
  headFiles: [path],
  baseFiles: [path],
  files: [{ path, status: 'M', patch, addedLines: [2, 6, 7], removedLines: [2, 5] }],
} as unknown as Snapshot;
const indexes = [
  {
    repoId: 'r',
    side: 'head',
    methods: [method('create', 'head', 4, 7), method('list', 'head', 8, 8)],
  },
  { repoId: 'r', side: 'base', methods: [method('create', 'base', 4, 6)] },
] as SourceIndex[];

describe('change cards', () => {
  it('numbers patch lines on both sides', () => {
    expect(
      patchLines(patch)
        .filter((l) => l.type !== ' ')
        .map((l) => [l.type, l.oldLine, l.newLine]),
    ).toEqual([
      ['-', 2, 2],
      ['+', 3, 2],
      ['-', 5, 5],
      ['+', 6, 5],
      ['+', 6, 6],
    ]);
  });

  it('cuts one unit per changed method with only its diff and skips import-only changes', () => {
    const units = changeUnits([snapshot], indexes);
    expect(units.map((unit) => unit.name)).toEqual(['OrderService.create']);
    expect(units[0].diff).toEqual([
      ' 4   fun create(order: Order) {',
      '-5     repository.save(order)',
      '+5     repository.save(order.copy(status = NEW))',
      '+6     payments.charge(order.id)',
      ' 7   }',
    ]);
  });

  it('describes only unknown changes, caches them and keys them without line numbers', async () => {
    const units = changeUnits([snapshot], indexes);
    const moved = {
      ...units[0],
      diff: units[0].diff.map((line) =>
        line.replace(/^([ +-])(\d+)/, (_, t, n) => `${t}${Number(n) + 10}`),
      ),
    };
    expect(cardKey(moved)).toBe(cardKey(units[0]));
    const cache = new Map<string, CardDraft>();
    const asked: number[] = [];
    const describe = async (batch: typeof units) => {
      asked.push(batch.length);
      return parseCards(
        { cards: [{ id: 'C1', kind: 'logic', risk: 'check', text: 'Оплата при создании.' }] },
        batch.length,
      );
    };
    const store = {
      get: (key: string) => cache.get(key),
      set: (key: string, card: CardDraft) => void cache.set(key, card),
    };
    const first = await changeCards(units, store, describe, () => {});
    expect(first[0]).toMatchObject({
      name: 'OrderService.create',
      kind: 'logic',
      risk: 'check',
      evidence: { side: 'head', startLine: 4 },
    });
    await changeCards([moved], store, describe, () => {});
    expect(asked).toEqual([1]);
  });
});

describe('scenario skeleton', () => {
  const controller = 'src/main/kotlin/OrderController.kt';
  const call = (line: number, receiver: string, name: string, database = false) => ({
    name,
    receiver,
    evidence: {
      repoId: 'r',
      side: 'head' as const,
      path: controller,
      startLine: line,
      endLine: line,
    },
    transactionIds: [],
    database,
  });
  const entry: IndexedMethod = {
    ...method('post', 'head', 3, 9),
    evidence: { repoId: 'r', side: 'head', path: controller, startLine: 3, endLine: 9 },
    calls: ['audit.log', 'orderService.create'],
    callSites: [
      call(4, 'audit', 'log'),
      call(5, 'orderService', 'create'),
      call(6, 'dsl', 'selectFrom', true),
    ],
  };
  const audit = {
    ...method('log', 'head', 1, 2),
    evidence: { ...entry.evidence, path: 'src/main/kotlin/Audit.kt', startLine: 1, endLine: 2 },
  };
  const head = [entry, audit, method('create', 'head', 4, 7)];
  const idx = [{ repoId: 'r', side: 'head', methods: head }] as SourceIndex[];
  const root = {
    id: 'root',
    name: 'OrderController.post',
    evidence: entry.evidence,
    anchors: [entry.evidence],
    paths: [],
  };

  it('walks through same-class helpers without drawing them', () => {
    const helper = {
      ...method('prepare', 'head', 11, 12),
      evidence: { ...entry.evidence, startLine: 11, endLine: 12 },
      calls: ['orderService.create'],
      callSites: [call(12, 'orderService', 'create')],
    };
    const viaHelper = { ...entry, calls: ['prepare'], callSites: [call(4, '', 'prepare')] };
    const edges = scenarioSkeletons([{ ...root, evidence: viaHelper.evidence }], [snapshot], [
      { repoId: 'r', side: 'head', methods: [viaHelper, helper, head[2]] },
    ] as SourceIndex[]);
    expect(edges.map((e) => [e.caller, e.callee])).toEqual([
      ['OrderController.prepare', 'OrderService.create'],
    ]);
  });
  it('keeps calls that lead to changed code and the database calls on the way', () => {
    const edges = scenarioSkeletons([root], [snapshot], idx);
    expect(edges.map((e) => [e.id, e.caller, e.callee, e.kind, e.changed])).toEqual([
      ['E1', 'OrderController.post', 'OrderService.create', 'call', true],
      ['E2', 'OrderController.post', 'dsl.selectFrom', 'database', false],
    ]);
  });

  it('expands a step that names an edge into endpoints, kind and evidence', () => {
    const refs = wireRefs([snapshot]);
    refs.edges = new Map(scenarioSkeletons([root], [snapshot], idx).map((e) => [e.id, e]));
    const step = {
      edge: 'E1',
      from: '',
      to: '',
      label: 'создать заказ',
      kind: 'call',
      change: 'modified',
      branch: '',
      evidence: [],
    };
    const decoded = decodeModelResult(
      fromWire(
        {
          summary: '',
          findings: [],
          scenarios: [
            {
              id: 's',
              title: 'T',
              summary: '',
              confidence: 'extracted',
              evidence: ['F1:4-8'],
              services: ['repo-1'],
              steps: [step],
            },
          ],
          database: [],
          gaps: [],
          followUp: null,
        },
        refs,
      ),
    );
    expect(decoded.scenarios[0].steps[0]).toMatchObject({
      from: 'r',
      to: 'r',
      label: 'OrderController.post -> OrderService.create: создать заказ',
      evidence: [
        { path: controller, startLine: 5 },
        { path, startLine: 4 },
      ],
    });
  });
});

describe('user interface cards', () => {
  const form = 'web/src/components/OrderForm.tsx';
  const patch = [
    '@@ -10,8 +10,9 @@ export function OrderForm({ order }: Props) {',
    '   return (',
    '     <form>',
    '-      <button>Сохранить</button>',
    '+      <input name="email" />',
    '+      <button>Отправить</button>',
    '     </form>',
    '   );',
    ' }',
    ' export function OrderSummary() {',
    '-  return <p>Итого</p>;',
    '+  return <p>Итого: {total}</p>;',
    ' }',
  ].join('\n');
  const locale = 'web/src/locales/ru.json';
  const snapshot = {
    repoId: 'web',
    headFiles: [form, locale],
    baseFiles: [form, locale],
    files: [
      { path: form, status: 'M', patch, addedLines: [13, 14, 19], removedLines: [12, 17] },
      {
        path: locale,
        status: 'M',
        patch: '@@ -3,1 +3,1 @@\n-  "save": "Сохранить"\n+  "save": "Отправить"',
        addedLines: [3],
        removedLines: [3],
      },
      {
        path: 'web/package-lock.json',
        status: 'M',
        patch: '@@ -1 +1 @@\n-a\n+b',
        addedLines: [1],
        removedLines: [1],
      },
    ],
  } as unknown as Snapshot;

  it('splits a UI file by component, keeps translations and marks both as interface changes', () => {
    const units = changeUnits([snapshot], []);
    expect(units.map((unit) => [unit.name, unit.ui, unit.evidence.startLine])).toEqual([
      ['OrderForm.tsx · OrderForm', true, 12],
      ['OrderForm.tsx · OrderSummary', true, 18],
      ['ru.json', true, 3],
    ]);
    expect(units[0].diff.join('\n')).toContain('+12       <input name="email" />');
    expect(units[1].diff.join('\n')).not.toContain('<button>');
  });

  it('asks for what the user sees and keeps those cards apart in the cache', () => {
    const units = changeUnits([snapshot], []);
    const prompt = cardsPrompt(units);
    expect(prompt).toContain('### C1 OrderForm.tsx · OrderForm (UI)');
    expect(prompt).toContain('what the user sees');
    expect(cardKey(units[0])).not.toBe(cardKey({ ...units[0], ui: undefined }));
  });
});
