import { useMemo } from 'react';
import {
  SQL_ANALYSIS_VERSION,
  TEST_ANALYSIS_VERSION,
  type AnalysisResult,
  type AnalysisRun,
  type ReviewSession,
} from '../../shared/model';
import { reviewScopeSnapshots } from '../../shared/analysis-scope';
import { comparisonReview } from '../../shared/review-display';
import { scenarioRoots, missingScenarios } from '../../shared/scenario-coverage';
import { missingSqlMethods } from '../../shared/sql-coverage';
import { missingTestMethods } from '../../shared/test-coverage';
import { testReviewMarks } from '../../shared/review-markers';
import {
  scenarioChanges,
  scenarioStepMeaning,
  type ScenarioChange,
} from '../../shared/scenario-changes';

/** What changed since the previous review and which parts of the analysis are incomplete. */
export function useAnalysisViews({
  sessionData,
  liveRun,
  canonicalSession = sessionData,
}: {
  sessionData: ReviewSession | null;
  session: ReviewSession | null;
  canonicalSession?: ReviewSession | null;
  result: AnalysisResult | undefined;
  liveRun: AnalysisRun | null | undefined;
}) {
  const comparisonRevision = comparisonReview(sessionData);
  const scenarioUpdates = useMemo(
    () =>
      comparisonRevision && sessionData?.run
        ? scenarioChanges(
            sessionData.run.result.scenarios,
            comparisonRevision.run.result.scenarios,
            sessionData.update?.changes ?? [],
            {
              current: scenarioRoots(sessionData.snapshots, sessionData.run.result.indexes),
              previous: scenarioRoots(
                comparisonRevision.snapshots,
                comparisonRevision.run.result.indexes,
              ),
            },
            {
              current: (step) =>
                scenarioStepMeaning(step, sessionData.run!.result.indexes, sessionData.snapshots),
              previous: (step) =>
                scenarioStepMeaning(
                  step,
                  comparisonRevision.run.result.indexes,
                  comparisonRevision.snapshots,
                ),
            },
          )
        : new Map<string, ScenarioChange>(),
    [sessionData?.run?.result.scenarios, comparisonRevision, sessionData?.update],
  );
  const scenarioMenuUpdates = new Map(scenarioUpdates);
  for (const change of scenarioUpdates.values())
    if (change.previous && !scenarioMenuUpdates.has(change.previous.id))
      scenarioMenuUpdates.set(change.previous.id, change);
  const postReviewChanges = comparisonRevision ? sessionData?.update?.changes : undefined;
  const testUpdates = useMemo(
    () =>
      comparisonRevision && sessionData?.run
        ? testReviewMarks(
            {
              snapshots: comparisonRevision.snapshots,
              indexes: comparisonRevision.run.result.indexes,
              tests: comparisonRevision.run.result.tests ?? [],
            },
            {
              snapshots: sessionData.snapshots,
              indexes: sessionData.run.result.indexes,
              tests: sessionData.run.result.tests ?? [],
            },
            sessionData.update?.changes ?? [],
          )
        : undefined,
    [
      comparisonRevision,
      sessionData?.run?.result.tests,
      sessionData?.run?.result.indexes,
      sessionData?.snapshots,
      sessionData?.update,
    ],
  );
  const coverageSession = canonicalSession;
  const coverageResult = canonicalSession?.run?.result;
  // Coverage checks walk the call graph; recompute them only when the analysis changes.
  const missingScenarioRoots = useMemo(
    () =>
      coverageSession && coverageResult
        ? missingScenarios(
            scenarioRoots(reviewScopeSnapshots(coverageSession), coverageResult.indexes),
            coverageResult.scenarios,
          )
        : [],
    [coverageSession?.snapshots, coverageResult?.indexes, coverageResult?.scenarios],
  );
  const missingScenarioCount = missingScenarioRoots.length;
  const testsReady = useMemo(
    () =>
      !!coverageSession &&
      coverageResult?.testAnalysisVersion === TEST_ANALYSIS_VERSION &&
      !missingTestMethods(
        reviewScopeSnapshots(coverageSession),
        coverageResult.indexes,
        coverageResult.tests ?? [],
      ).length,
    [
      coverageSession?.snapshots,
      coverageSession?.update,
      coverageResult?.indexes,
      coverageResult?.tests,
      coverageResult?.testAnalysisVersion,
    ],
  );
  const sqlComplete = useMemo(
    () =>
      !!coverageSession &&
      liveRun?.result.sqlAnalysisVersion === SQL_ANALYSIS_VERSION &&
      !missingSqlMethods(
        reviewScopeSnapshots(coverageSession),
        liveRun.result.indexes,
        liveRun.result.database,
      ).length,
    [
      coverageSession?.snapshots,
      coverageSession?.update,
      liveRun?.result.indexes,
      liveRun?.result.database,
      liveRun?.result.sqlAnalysisVersion,
    ],
  );
  return {
    comparisonRevision,
    scenarioUpdates,
    scenarioMenuUpdates,
    postReviewChanges,
    testUpdates,
    missingScenarioCount,
    missingScenarioRoots,
    testsReady,
    sqlComplete,
  };
}
