import { reviewContext } from '../shared/review-timeline.js';
import { lineage, sourceIdentity } from '../shared/review-workflow.js';
import { snapshotDiff } from './snapshot-diff.js';
import type { ReviewSession } from '../shared/model.js';
import type { CodeComparison } from '../shared/code-comparison.js';
import { reviewFilePath } from '../shared/viewed-files.js';
import { changedFiles, readSource } from './repository.js';
import { Store } from './store.js';
import { AppError } from './process.js';
import { t } from '../shared/i18n.js';

export async function codeComparison(
  store: Store,
  session: ReviewSession,
  revisionId: string,
  repoId: string,
  requestedPath: string,
): Promise<CodeComparison> {
  const revision = reviewContext(session, revisionId);
  const previous = revision?.snapshots.find((snapshot) => snapshot.repoId === repoId);
  const current = session.snapshots.find((snapshot) => snapshot.repoId === repoId);
  if (!revision || !previous || !current || lineage(previous) !== lineage(current))
    throw new AppError(t('The review to compare with was not found.'), 404);
  let path = requestedPath;
  if (!current.headFiles.includes(path) && !previous.headFiles.includes(path))
    path = reviewFilePath(current, path);
  const saved = session.update?.changes.find(
    (change) =>
      change.repoId === repoId &&
      change.fromSha === previous.headSha &&
      change.toSha === current.headSha,
  );
  const repo = store.repository(repoId);
  if (!saved && previous.headSha !== current.headSha && !repo)
    throw new AppError(t('Repository not found.'), 404);
  const changes =
    sourceIdentity(previous) === sourceIdentity(current)
      ? []
      : (saved?.files ??
        (await changedFiles(
          current.local ? { ...repo!, path: current.local.gitDir } : repo!,
          previous.headSha,
          current.headSha,
        ).catch(() => snapshotDiff(previous, current))));
  const file = changes.find((file) => file.path === path || file.oldPath === path);
  const currentPath = file?.path ?? path,
    previousPath = file?.oldPath ?? file?.path ?? path;
  if (!current.headFiles.includes(currentPath) && !previous.headFiles.includes(previousPath))
    throw new AppError(t('The file is missing in the compared versions.'), 404);
  return {
    previousRevisionId: revision.id,
    previousSnapshotId: previous.id,
    previousSha: previous.headSha,
    currentSnapshotId: current.id,
    currentSha: current.headSha,
    previousPath,
    path: currentPath,
    text: current.headFiles.includes(currentPath)
      ? await readSource(current, { path: currentPath, side: 'head' })
      : '',
    file: file ?? {
      path: currentPath,
      status: 'unchanged',
      patch: '',
      addedLines: [],
      removedLines: [],
    },
  };
}
