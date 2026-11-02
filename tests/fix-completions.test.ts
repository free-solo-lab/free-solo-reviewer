import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { completedFixSteps, type FixChat } from '../shared/fix-chat';
import type { DraftComment } from '../shared/model';
import { FixPlan } from '../web/FixPlan';

const comments: DraftComment[] = [
  { id: 'a', body: 'Исправь обработку ошибок', forCodex: true, selected: false, evidence: null },
];
const chat = (value: Partial<FixChat> = {}): FixChat => ({
  sessionId: 's',
  repoId: 'r',
  snapshotId: 'old',
  state: 'complete',
  turnId: 'turn',
  commentsHash: '',
  events: [],
  ...value,
});

it('retains completion independently of the current snapshot and repository of the chat', () => {
  const completed = completedFixSteps(
    chat({ steps: [{ commentId: 'a', state: 'done', result: 'Исправлено' }] }),
    comments,
  );
  expect(completed[0]).toMatchObject({
    repoId: 'r',
    commentId: 'a',
    body: comments[0].body,
    result: 'Исправлено',
  });
  expect(
    completedFixSteps(
      chat({ repoId: 'another-repo', snapshotId: 'new', completedSteps: completed }),
      [],
    ),
  ).toEqual(completed);
});
it('restores lost flags from successful step events, stripping the old recheck prefix', () => {
  const events: FixChat['events'] = [
    {
      id: 'turn:user',
      kind: 'user',
      text: 'Шаг 1: Исправь обработку ошибок',
      at: '2026-10-27T00:00:00Z',
    },
    {
      id: 'turn:message',
      kind: 'assistant',
      text: 'Ошибки обрабатываются',
      at: '2026-10-27T00:00:01Z',
    },
    {
      id: 'turn:done',
      kind: 'status',
      text: 'Все шаги выполнены. Обновите ревью.',
      at: '2026-10-27T00:00:02Z',
    },
  ];
  const oldComments = comments.map((comment) => ({
    ...comment,
    body: `[Требуется перепроверка после обновления PR]\n${comment.body}`,
  }));
  const completed = completedFixSteps(chat({ events }), oldComments);
  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({
    commentId: 'a',
    body: comments[0].body,
    result: 'Ошибки обрабатываются',
  });
  expect(completedFixSteps(chat({ events: events.slice(0, 2) }), oldComments)).toEqual([]);
  expect(
    completedFixSteps(chat({ events }), [...oldComments, { ...oldComments[0], id: 'ambiguous' }]),
  ).toEqual([]);
});
it('puts completed steps and their results into a collapsed history with no execute action', () => {
  const completed = completedFixSteps(
    chat({ steps: [{ commentId: 'a', state: 'done', result: 'Проверка пройдена' }] }),
    comments,
  );
  const html = renderToStaticMarkup(
    React.createElement(FixPlan, {
      tasks: [],
      completed,
      stepOf: () => undefined,
      disabled: false,
      skipDisabled: false,
      onRun() {},
      onSkip() {},
      onCode() {},
    }),
  );
  expect(html).toContain('История · выполнено 1');
  expect(html).toContain('Проверка пройдена');
  expect(html).not.toMatch(/<details[^>]* open/);
  expect(html).not.toContain('Выполнить');
  expect(html).not.toContain('Вернуть в план');
  expect(html).not.toContain('осталось');
});
it('offers to skip open steps and to return skipped ones from the history', () => {
  const html = renderToStaticMarkup(
    React.createElement(FixPlan, {
      tasks: comments,
      completed: [
        { repoId: 'repo', commentId: 'a', body: 'Лишний шаг', skipped: true, at: '2026-10-29' },
      ],
      stepOf: () => undefined,
      disabled: false,
      skipDisabled: false,
      onRun() {},
      onSkip() {},
      onCode() {},
    }),
  );
  expect(html).toContain('Пропустить');
  expect(html).toContain('Выполнить');
  expect(html).toContain('История · пропущено 1');
  expect(html).toContain('Пропущен · ');
  expect(html).toContain('Вернуть в план');
});
