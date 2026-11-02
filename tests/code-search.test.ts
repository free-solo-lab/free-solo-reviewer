import { describe, expect, it } from 'vitest';
import type { Snapshot, SourceIndex } from '../shared/model';
import { codeSearchEntries, doubleShift, searchCode } from '../shared/code-search';

const evidence = {
  repoId: 'r',
  path: 'src/PaymentService.java',
  side: 'head' as const,
  startLine: 17,
  endLine: 22,
};
const snapshots = [
  {
    id: 's',
    repoId: 'r',
    repoName: 'billing',
    headFiles: ['src/PaymentService.java', 'api/payment.thrift', 'docs/README.md'],
  },
] as Snapshot[];
const indexes = [
  {
    repoId: 'r',
    side: 'head',
    methods: [
      {
        name: 'registerPayment',
        signature: 'String PaymentService.registerPayment(Request request)',
        evidence,
      },
      {
        name: 'registerPayment',
        signature: 'String PaymentService.registerPayment(String id)',
        evidence: { ...evidence, startLine: 30, endLine: 35 },
      },
    ],
    types: [
      {
        name: 'PaymentService',
        qualifiedName: 'billing.PaymentService',
        evidence: { ...evidence, startLine: 5 },
      },
    ],
  },
] as SourceIndex[];
describe('code search', () => {
  it('finds all review files and indexed declarations without needing an analysis result', () => {
    const entries = codeSearchEntries(snapshots, indexes);
    expect(searchCode(entries, 'payment.thrift')[0].kind).toBe('file');
    expect(searchCode(entries, 'README')[0].evidence.path).toBe('docs/README.md');
    expect(searchCode(entries, 'PaymentService')[0].kind).toBe('class');
    const methods = searchCode(entries, 'registerPayment');
    expect(methods).toHaveLength(2);
    expect(new Set(methods.map((item) => item.id)).size).toBe(2);
    expect(methods.map((item) => item.evidence.startLine)).toEqual([17, 30]);
    expect(methods.every((item) => item.evidence.startLine === item.evidence.endLine)).toBe(true);
    expect(searchCode(entries, 'billing payment.thrift')).toHaveLength(1);
    expect(searchCode(entries, 'PS').some((item) => item.kind === 'class')).toBe(true);
    expect(searchCode(entries, '')).toEqual([]);
    expect(searchCode(codeSearchEntries(snapshots, []), 'thrift')).toHaveLength(1);
  });
  it('requires two standalone Shift taps and ignores normal shifted typing, holds and blur', () => {
    let time = 0,
      opened = 0;
    const detector = doubleShift(
      () => opened++,
      () => time,
    );
    const key = (name: string) => ({
      key: name,
      repeat: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    });
    const tap = () => {
      detector.keydown(key('Shift'));
      time += 40;
      detector.keyup(key('Shift'));
      time += 80;
    };
    tap();
    tap();
    expect(opened).toBe(1);
    detector.keydown(key('Shift'));
    detector.keydown(key('A'));
    detector.keyup(key('A'));
    detector.keyup(key('Shift'));
    tap();
    expect(opened).toBe(1);
    detector.reset();
    detector.keydown(key('Shift'));
    time += 500;
    detector.keyup(key('Shift'));
    tap();
    expect(opened).toBe(1);
    detector.reset();
    tap();
    detector.reset();
    tap();
    expect(opened).toBe(1);
    detector.reset();
    tap();
    time += 500;
    tap();
    expect(opened).toBe(1);
    tap();
    expect(opened).toBe(2);
  });
});
