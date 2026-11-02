import { expect, it } from 'vitest';
import { contractSourceSummary } from '../shared/contract-summary';

it('summarizes Thrift enum and optional data additions without copying diff lines', () => {
  const before = 'struct Template { 1: string id }\nstruct Binding { 1: string id }';
  const after =
    'enum OperationType { payment = 0, payout = 1 }\nstruct Template { 1: string id, 2: optional OperationType operation_type, 3: optional string wallet_id }\nstruct Binding { 1: string id, 2: optional OperationType operation_type }';
  const summary = contractSourceSummary('thrift', before, after);
  expect(summary.join(' ')).toContain('OperationType с вариантами payment, payout');
  expect(summary.join(' ')).toContain('необязательными полями');
  expect(summary.join(' ')).toContain('Эти данные можно не передавать');
  expect(summary.join(' ')).not.toContain('Добавлено:');
  expect(summary.join(' ')).not.toContain('optional OperationType');
  expect(summary.find((s) => s.includes('wallet_id'))).toContain('Template');
  expect(summary.find((s) => s.includes('wallet_id'))).not.toContain('Binding');
});
it('describes repeated protobuf data and keeps nested message fields out of their parent', () => {
  const before = 'message Request { string id = 1; }';
  const after =
    'message Request { string id = 1; repeated string issue_types = 20; message Nested { string own = 3; } }';
  const text = contractSourceSummary('protobuf', before, after).join(' ');
  expect(text).toContain('повторяемыми полями: issue_types');
  expect(text).toContain('Nested');
  expect(text).not.toContain('полями: own');
});
it('does not turn comments and formatting into API changes and identifies removal', () => {
  expect(
    contractSourceSummary(
      'thrift',
      'struct A {1: string id}',
      '// enum Fake {x=1}\nstruct A { 1: string id }',
    ),
  ).toEqual([
    'Уточнены комментарии или оформление контракта; определения API и моделей не изменились.',
  ]);
  expect(
    contractSourceSummary(
      'thrift',
      'struct A {1: string id,2: optional string name}',
      'struct A {1: string id}',
    ).join(' '),
  ).toContain('удалены поля name');
});
