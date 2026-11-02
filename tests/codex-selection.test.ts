import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { CodexSelectionActions, type useCodexSelection } from '../web/workspace/useCodexSelection';

it('offers explicit acceptance after a single-comment launch even without a bulk selection', () => {
  const continueWithFiles = vi.fn();
  const selection = {
    selected: [],
    busy: false,
    conflict: {
      packet: { sessionId: 's', snapshotId: 'v', repoId: 'r', commentIds: ['one'], together: true },
      message: 'Working folder changed',
    },
    continueWithFiles,
    dismissConflict: vi.fn(),
  } as unknown as ReturnType<typeof useCodexSelection>;
  const html = renderToStaticMarkup(React.createElement(CodexSelectionActions, { selection }));
  expect(html).toContain('role="alert"');
  expect(html).toContain('Working folder changed');
  expect(html).toContain('Продолжить с текущими файлами');
  expect(html).toContain('Отмена');
  expect(continueWithFiles).not.toHaveBeenCalled();
});
