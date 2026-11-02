import { expect, it } from 'vitest';
import { reviewPeriod } from '../shared/review-period';
import { emptyModelResult, type AnalysisRun, type ReviewSession } from '../shared/model';
const run = (
  id: string,
  items: NonNullable<AnalysisRun['result']['followUp']>['items'],
): AnalysisRun => ({
  id,
  sessionId: 's',
  state: 'complete',
  version: 'test',
  fingerprint: id,
  startedAt: id,
  events: [],
  result: { ...emptyModelResult(), indexes: [], contracts: [], followUp: { summary: id, items } },
});
it('shows fixes from all analyses after the selected human review and no delta on an unchanged version', () => {
  const first = run('a', []),
    second = run('b', [
      { previousId: 'remark', status: 'fixed', summary: 'Fixed earlier', evidence: [] },
    ]),
    third = run('c', [
      { previousId: 'other', status: 'answered', summary: 'Answered later', evidence: [] },
    ]);
  const session: ReviewSession = {
    id: 's',
    title: 'S',
    createdAt: 'a',
    snapshots: [],
    history: [
      { id: 'a', savedAt: 'a', run: first, snapshots: [], drafts: [] },
      { id: 'b', savedAt: 'b', run: second, snapshots: [], drafts: [] },
    ],
    run: third,
    workflow: {
      version: 1,
      initial: { at: 'a', snapshots: [] },
      versions: [],
      checkpoints: [
        {
          id: 'human',
          key: 'sent',
          kind: 'local',
          repoId: 'r',
          at: 'a',
          analysisId: 'a',
          snapshotIds: [],
          commentIds: [],
        },
      ],
    },
  };
  expect(reviewPeriod(session, 'human').items.map((i) => i.status)).toEqual(['fixed', 'answered']);
  expect(reviewPeriod(session, 'b').items.map((i) => i.status)).toEqual(['answered']);
  expect(reviewPeriod(session, 'human', false).items).toEqual([]);
  expect(reviewPeriod(session, 'human', false).summaries).toEqual([]);
});
