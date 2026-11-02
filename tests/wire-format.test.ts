import { describe, expect, it } from 'vitest';
import { fromRef, fromWire, toRef, wireRefs } from '../server/wire-format';
import { decodeModelResult } from '../server/validation';
import { testOutline } from '../server/test-outline';
import type { IndexedMethod, Snapshot } from '../shared/model';

const snapshots = [
  {
    repoId: 'orders-uuid',
    files: [{ path: 'src/Order.kt', oldPath: 'src/OldOrder.kt', status: 'R' }],
  },
  { repoId: 'payments-uuid', files: [{ path: 'src/Pay.kt', status: 'M' }] },
] as unknown as Snapshot[];
const refs = wireRefs(snapshots);

describe('compact model answers', () => {
  it('round-trips evidence through short refs on both sides and for unchanged files', () => {
    const head = {
      repoId: 'orders-uuid',
      side: 'head',
      path: 'src/Order.kt',
      startLine: 4,
      endLine: 9,
    } as const;
    const base = {
      ...head,
      side: 'base',
      path: 'src/OldOrder.kt',
      startLine: 3,
      endLine: 3,
    } as const;
    const other = { ...head, repoId: 'payments-uuid', path: 'src/Util.kt' };
    expect(toRef(head, refs)).toBe('F1:4-9');
    expect(toRef(base, refs)).toBe('F1@base:3');
    expect(toRef(other, refs)).toBe('repo-2/head/src/Util.kt:4-9');
    for (const evidence of [head, base, other])
      expect(fromRef(toRef(evidence, refs), refs)).toEqual(evidence);
    for (const bad of [
      'F9:1',
      'F1:0',
      'F1:5-2',
      'repo-3/head/A.kt:1',
      'repo-1/head/../x:1',
      'Order.kt:4',
    ])
      expect(fromRef(bad, refs)).toBeNull();
  });

  it('expands services, step ids and evidence, and reports refs it cannot resolve', () => {
    const decoded = decodeModelResult(
      fromWire(
        {
          summary: 'S',
          findings: [
            {
              id: 'f1',
              title: 'T',
              summary: 'S',
              confidence: 'inferred',
              severity: 'low',
              evidence: ['F2:7', 'nope'],
            },
          ],
          scenarios: [
            {
              id: 'pay',
              title: 'Pay',
              summary: '',
              confidence: 'extracted',
              evidence: ['F1:4-9'],
              services: ['repo-1', 'repo-2'],
              steps: [
                {
                  from: 'repo-1',
                  to: 'repo-2',
                  label: 'charge',
                  kind: 'call',
                  change: 'added',
                  branch: '',
                  evidence: ['F1:6'],
                },
              ],
            },
          ],
          database: [],
          gaps: [],
          followUp: null,
        },
        refs,
      ),
    );
    expect(decoded.findings[0].evidence).toEqual([
      { repoId: 'payments-uuid', side: 'head', path: 'src/Pay.kt', startLine: 7, endLine: 7 },
    ]);
    expect(decoded.scenarios[0].services).toEqual(['orders-uuid', 'payments-uuid']);
    expect(decoded.scenarios[0].steps[0]).toMatchObject({
      id: 'pay.1',
      from: 'orders-uuid',
      to: 'payments-uuid',
      confidence: 'extracted',
    });
    expect(decoded.gaps).toContain('Отброшены ссылки модели в неизвестном формате.');
    expect(decoded.followUp).toBeUndefined();
  });

  it('keeps a query whose ref lists several ranges and files, at the lines of its method', () => {
    const method = {
      repoId: 'orders-uuid',
      side: 'head',
      path: 'src/Order.kt',
      startLine: 46,
      endLine: 69,
    } as const;
    const operation = (evidence: string) => ({
      id: 'DB1',
      title: 'Aggregate',
      summary: '',
      confidence: 'extracted',
      evidence: [],
      kind: 'sql',
      dialect: 'ClickHouse',
      sql: 'SELECT 1',
      tables: [],
      unknowns: [],
      query: { method: 'Order.aggregate', framework: 'jdbc', evidence, parameters: [] },
    });
    const decoded = decodeModelResult(
      fromWire(
        {
          summary: '',
          findings: [],
          scenarios: [],
          database: [operation('F1:19-41,40-67; F2:30-50,84-97'), operation('F1:50')],
          gaps: [],
          followUp: null,
        },
        { ...refs, methods: [method] },
      ),
    );
    expect(decoded.database[0].query?.evidence).toEqual({ ...method, startLine: 46, endLine: 67 });
    // The other places stay as the operation's evidence.
    expect(decoded.database[0].evidence.map((item) => item.startLine)).toEqual([19, 40, 30, 84]);
    expect(decoded.database[1].query?.evidence).toEqual({ ...method, startLine: 50, endLine: 50 });
    expect(decoded.gaps).toEqual([]);
  });
});

describe('local test outline', () => {
  const source = [
    'class ReaderTest {',
    '  @Test fun reads() {',
    '    val request = Request.builder().id(1).build()',
    '    whenever(repository.find(1)).thenReturn(row)',
    '    val result = reader.read(request)',
    '    assertThat(result.id).isEqualTo(1)',
    '    verify(repository).find(1)',
    '  }',
    '}',
  ];
  const at = (line: number, end = line) => ({
    repoId: 'r',
    side: 'head' as const,
    path: 'src/test/ReaderTest.kt',
    startLine: line,
    endLine: end,
  });
  const call = (line: number, receiver: string, name: string) => ({
    name,
    receiver,
    evidence: at(line),
    transactionIds: [],
    database: false,
  });
  const method: IndexedMethod = {
    name: 'reads',
    signature: 'fun reads()',
    annotations: ['@Test'],
    calls: [],
    evidence: at(2, 8),
    callSites: [
      call(3, 'Request.builder().id(1)', 'build'),
      call(3, 'Request.builder()', 'id'),
      call(3, 'Request', 'builder'),
      call(4, '', 'whenever'),
      call(4, 'whenever(repository.find(1))', 'thenReturn'),
      call(4, 'repository', 'find'),
      call(5, 'reader', 'read'),
      call(6, 'assertThat(result.id)', 'isEqualTo'),
      call(6, '', 'assertThat'),
      call(7, 'verify(repository)', 'find'),
      call(7, '', 'verify'),
    ],
  };
  it('turns each source line into one step with its kind and the line as the label', () => {
    expect(
      testOutline(method, source).map((step) => [
        step.kind,
        step.label,
        step.evidence[0].startLine,
      ]),
    ).toEqual([
      ['setup', 'val request = Request.builder().id(1).build()', 3],
      ['mock', 'whenever(repository.find(1)).thenReturn(row)', 4],
      ['call', 'val result = reader.read(request)', 5],
      ['assertion', 'assertThat(result.id).isEqualTo(1)', 6],
      ['assertion', 'verify(repository).find(1)', 7],
    ]);
    expect(testOutline(method, source)[2]).toMatchObject({ from: 'ReaderTest', to: 'reader.read' });
  });
});
