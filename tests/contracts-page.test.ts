import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../web/workspace/state', () => ({ useWorkspace: () => state.value }));
vi.mock('../web/workspace/SourcePanel', () => ({
  SourcePanel: ({ inline }: { inline: boolean }) =>
    React.createElement(
      'div',
      { 'data-shared-source-panel': inline ? 'inline' : 'drawer' },
      'Shared review comments',
    ),
}));
import { ContractsPage } from '../web/pages/ContractsPage';
it('shows the saved semantic explanation and the shared full-width review panel under a collapsible description', () => {
  const evidence = { repoId: 'r', path: 'api.thrift', side: 'head', startLine: 1, endLine: 1 };
  const contract = {
    id: 'c',
    repoId: 'r',
    path: 'api.thrift',
    title: 'Thrift',
    format: 'thrift',
    source: {
      before: 'struct A {}',
      after: 'struct A {1: optional string id}',
      patch: '+1: optional string id',
    },
    changes: ['Добавлено: 1: optional string id'],
    evidence: [evidence],
  };
  state.value = {
    session: {
      id: 's',
      snapshots: [
        {
          id: 'snapshot',
          repoId: 'r',
          repoName: 'Repo',
          files: [{ path: 'api.thrift', status: 'M', patch: contract.source.patch }],
        },
      ],
      contracts: [contract],
    },
    result: {
      changes: [{ evidence, text: 'В запросе появился необязательный идентификатор клиента.' }],
    },
    service: 'all',
    source: { evidence },
    openSource: vi.fn(),
    setSource: vi.fn(),
    sourceKeyboard: vi.fn(),
  };
  const markup = renderToStaticMarkup(React.createElement(ContractsPage));
  expect(markup).toContain('В запросе появился необязательный идентификатор клиента.');
  expect(markup).not.toContain('Добавлено:');
  expect(markup).toContain('Описание изменений</summary>');
  expect(markup).toContain('data-shared-source-panel="inline"');
  expect(markup).toContain('aria-label="Код и комментарии к контракту"');
});
