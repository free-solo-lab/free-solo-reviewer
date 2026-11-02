import { ChangedFilesMenu } from '../ChangedFilesMenu';
import { SourcePanel } from '../workspace/SourcePanel';
import { useWorkspace } from '../workspace/state';
import styles from './ReviewPage.module.css';
import { t } from '../../shared/i18n';

export function ReviewPage() {
  const {
    setRevisionId,
    reviewVersion,
    session,
    busy,
    source,
    openSource,
    fileViews,
    currentSnapshot,
    selectedPath,
    comparisonRevision,
    postReviewChanges,
    sourceComparisonId,
    rangeComparison,
    sourceKeyboard,
  } = useWorkspace();
  if (!session) return null;
  return (
    <>
      <ChangedFilesMenu
        key={session.snapshots.map((snapshot) => snapshot.id).join(',')}
        snapshots={session.snapshots}
        snapshot={currentSnapshot}
        selectedPath={selectedPath}
        revisionChanges={postReviewChanges}
        // The changes since the review are known for the latest one; an older review keeps the PR view.
        sinceReview={
          (!!rangeComparison && rangeComparison.from !== 'base') ||
          (!reviewVersion && !!comparisonRevision && sourceComparisonId === comparisonRevision.id)
        }
        showingPrevious={!!reviewVersion && !rangeComparison}
        onLatest={() => setRevisionId('current')}
        isViewed={fileViews.isViewed}
        isViewPending={fileViews.isPending}
        viewLoading={fileViews.loading}
        onViewed={(snapshot, path, viewed) => void fileViews.setViewed(snapshot, path, viewed)}
        onSelect={(id, path) => {
          const snapshot = session.snapshots.find((item) => item.id === id);
          if (
            snapshot &&
            !snapshot.headFiles.includes(path) &&
            !snapshot.baseFiles.includes(path) &&
            comparisonRevision
          ) {
            const prior = comparisonRevision.snapshots.find(
              (item) => item.repoId === snapshot.repoId,
            );
            if (prior?.headFiles.includes(path))
              void openSource(
                {
                  repoId: snapshot.repoId,
                  path,
                  side: 'head',
                  startLine: 1,
                  endLine: 1,
                },
                comparisonRevision.id,
              );
          } else if (snapshot)
            void openSource({
              repoId: snapshot.repoId,
              path,
              side: snapshot.headFiles.includes(path) ? 'head' : 'base',
              startLine: 1,
              endLine: 1,
            });
        }}
      />
      <section
        className="inline-source-panel"
        aria-label={t('Code review area')}
        onKeyDownCapture={sourceKeyboard}
      >
        {source ? (
          <SourcePanel />
        ) : (
          <div className={styles.empty}>
            <span>{busy ? t('Loading code…') : t('Choose a file in the project tree')}</span>
          </div>
        )}
      </section>
    </>
  );
}
