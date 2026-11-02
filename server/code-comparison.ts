import type { ReviewSession } from '../shared/model.js';
import type { CodeComparison } from '../shared/code-comparison.js';
import { reviewFilePath } from '../shared/viewed-files.js';
import { changedFiles, readSource } from './repository.js';
import { Store } from './store.js';
import { AppError } from './process.js';

export async function codeComparison(
  store: Store,
  session: ReviewSession,
  revisionId: string,
  repoId: string,
  requestedPath: string,
): Promise<CodeComparison> {
  const revision = session.history?.find((revision) => revision.id === revisionId);
  const previous = revision?.snapshots.find((snapshot) => snapshot.repoId === repoId);
  const current = session.snapshots.find((snapshot) => snapshot.repoId === repoId);
  if (!revision || !previous || !current || previous.pr?.number !== current.pr?.number)
    throw new AppError('Ревью для сравнения не найдено.', 404);
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
    throw new AppError('Репозиторий не найден.', 404);
  const changes =
    previous.headSha === current.headSha
      ? []
      : (saved?.files ?? (await changedFiles(repo!, previous.headSha, current.headSha)));
  const file = changes.find((file) => file.path === path || file.oldPath === path);
  const currentPath = file?.path ?? path,
    previousPath = file?.oldPath ?? file?.path ?? path;
  if (!current.headFiles.includes(currentPath) && !previous.headFiles.includes(previousPath))
    throw new AppError('Файл отсутствует в сравниваемых версиях.', 404);
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
