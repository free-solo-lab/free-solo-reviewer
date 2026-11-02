import React, { useMemo, useState } from 'react';
import {
  changedFileTree,
  snapshotTreeFiles,
  snapshotRole,
  type FileTreeNode,
} from '../shared/file-tree';
import { fileReviewMarks, reviewFileKey, reviewMarkLabels } from '../shared/review-markers';
import type { ReviewUpdate } from '../shared/model';
import type { Snapshot } from '../shared/model';
import { fileExtension } from '../shared/viewed-files';
import { isTestPath } from '../shared/test-coverage';
import styles from './ChangedFilesMenu.module.css';
import { t } from '../shared/i18n';

export function ChangedFilesMenu({
  snapshots,
  snapshot,
  selectedPath,
  onSelect,
  isViewed,
  isViewPending,
  viewLoading,
  onViewed,
  revisionChanges,
  onLatest,
  showingPrevious,
  sinceReview = false,
}: {
  revisionChanges?: ReviewUpdate['changes'];
  /** The version shows what changed since the last review: "changed" means changed since then. */
  sinceReview?: boolean;
  onLatest?: () => void;
  showingPrevious?: boolean;
  snapshots: Snapshot[];
  snapshot?: Snapshot;
  selectedPath?: string;
  onSelect: (snapshotId: string, path: string) => void;
  isViewed: (snapshot: Snapshot, path: string) => boolean;
  isViewPending: (snapshot: Snapshot, path: string) => boolean;
  viewLoading: boolean;
  onViewed: (snapshot: Snapshot, path: string, viewed: boolean) => void;
}) {
  const revisionMarks = useMemo(() => fileReviewMarks(revisionChanges ?? []), [revisionChanges]);
  const changedCount = (repoId: string, folder?: string) =>
    revisionChanges
      ?.find((change) => change.repoId === repoId)
      ?.files.filter(
        (file) =>
          !folder || [file.path, file.oldPath].some((path) => path?.startsWith(`${folder}/`)),
      ).length ?? 0;
  const markFor = (repoId: string, path: string) => revisionMarks.get(reviewFileKey(repoId, path));
  const isChanged = (repoId: string, file: { path: string; oldPath?: string; status: string }) =>
    sinceReview
      ? [file.path, file.oldPath].some((path) => path && markFor(repoId, path))
      : file.status !== 'unchanged';
  const [search, setSearch] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [hideViewed, setHideViewed] = useState(true);
  const [extension, setExtension] = useState('all');
  const extensions = useMemo(
    () =>
      [
        ...new Set(
          snapshots.flatMap((item) =>
            snapshotTreeFiles(item).map((file) => fileExtension(file.path)),
          ),
        ),
      ].sort(),
    [snapshots],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [closedRepos, setClosedRepos] = useState<Set<string>>(new Set());
  const roots = useMemo(
    () =>
      snapshots
        .map((item) => {
          const allFiles = snapshotTreeFiles(item);
          for (const file of revisionChanges?.find((change) => change.repoId === item.repoId)
            ?.files ?? []) {
            if (
              file.status[0].toUpperCase() === 'D' &&
              !allFiles.some((existing) => existing.path === file.path)
            )
              allFiles.push(file);
          }
          const files = allFiles.filter(
            (file) =>
              (!onlyChanged || isChanged(item.repoId, file)) &&
              (!hideViewed || !isViewed(item, file.path)) &&
              (extension === 'all' ||
                fileExtension(file.path) === (extension === '__none__' ? '' : extension)) &&
              `${item.repoName} ${file.path} ${file.oldPath ?? ''}`
                .toLowerCase()
                .includes(search.toLowerCase()),
          );
          // Tests get their own group below the working code of the service.
          const tests = files.filter((file) => isTestPath(file.path));
          return {
            snapshot: item,
            total: allFiles.length,
            tree: changedFileTree(files.filter((file) => !isTestPath(file.path))),
            tests: changedFileTree(tests),
            testCount: tests.length,
            changedTests: tests.filter((file) => isChanged(item.repoId, file)).length,
          };
        })
        .filter((root) => root.tree.length || root.tests.length),
    [snapshots, search, onlyChanged, hideViewed, extension, isViewed, revisionChanges, sinceReview],
  );
  const toggle = (path: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const renderNodes = (nodes: FileTreeNode[], owner: Snapshot, depth = 0): React.ReactNode => (
    <ul>
      {nodes.map((node) => (
        <li key={node.path}>
          {node.file ? (
            <div className={`file-tree-file-row ${isViewed(owner, node.path) ? 'viewed' : ''}`}>
              <button
                data-menu-item
                className={`file-tree-file ${snapshot?.id === owner.id && selectedPath === node.path ? 'active' : ''}`}
                style={{ paddingLeft: 10 + depth * 12 }}
                aria-current={
                  snapshot?.id === owner.id && selectedPath === node.path ? 'page' : undefined
                }
                title={node.file.oldPath ? `${node.file.oldPath} → ${node.path}` : node.path}
                onClick={() => onSelect(owner.id, node.path)}
              >
                <span
                  className={`file-tree-status status-${node.file.status === 'unchanged' ? 'unchanged' : node.file.status[0].toUpperCase()}`}
                  aria-label={
                    node.file.status === 'unchanged'
                      ? t('Unchanged')
                      : t('Status: {0}', node.file.status)
                  }
                >
                  {node.file.status === 'unchanged' ? '·' : node.file.status[0].toUpperCase()}
                </span>
                <span className="file-tree-caption">
                  <span className="file-tree-name">{node.name}</span>
                </span>
                {node.file.status !== 'unchanged' && (
                  <span className="file-tree-counts">
                    <span>+{node.file.addedLines.length}</span>
                    <span>−{node.file.removedLines.length}</span>
                  </span>
                )}
                {markFor(owner.repoId, node.path) && (
                  <span
                    className={`review-revision-dot ${markFor(owner.repoId, node.path)}`}
                    title={t(
                      '{0} since the last review',
                      reviewMarkLabels[markFor(owner.repoId, node.path)!],
                    )}
                    aria-label={t(
                      '{0} since the last review',
                      reviewMarkLabels[markFor(owner.repoId, node.path)!],
                    )}
                  />
                )}
              </button>
              <input
                className="file-tree-view-toggle"
                type="checkbox"
                checked={isViewed(owner, node.path)}
                disabled={
                  viewLoading ||
                  isViewPending(owner, node.path) ||
                  (!owner.headFiles.includes(node.path) &&
                    !owner.baseFiles.includes(node.file.oldPath ?? node.path))
                }
                onChange={(event) => onViewed(owner, node.path, event.target.checked)}
                aria-label={t('{0}: viewed', node.path)}
                title={
                  isViewed(owner, node.path) ? t('Unmark as viewed') : t('Mark file as viewed')
                }
              />
            </div>
          ) : (
            <>
              <button
                className="file-tree-folder"
                style={{ paddingLeft: 10 + depth * 12 }}
                aria-expanded={!collapsed.has(`${owner.id}:${node.path}`)}
                title={node.path}
                onClick={() => toggle(`${owner.id}:${node.path}`)}
              >
                <span aria-hidden="true">
                  {collapsed.has(`${owner.id}:${node.path}`) ? '▸' : '▾'}
                </span>
                <span className="file-tree-name">{node.name}</span>
                <small>{node.count}</small>
                {changedCount(owner.repoId, node.path) > 0 && (
                  <span
                    className="review-revision-dot"
                    title={t(
                      'Changed since the last review: {0}',
                      changedCount(owner.repoId, node.path),
                    )}
                    aria-label={t(
                      'Changed since the last review: {0}',
                      changedCount(owner.repoId, node.path),
                    )}
                  />
                )}
              </button>
              {!collapsed.has(`${owner.id}:${node.path}`) &&
                renderNodes(node.children, owner, depth + 1)}
            </>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <aside className="secondary-menu changed-files-menu" aria-label={t('Project menu')}>
      <div className="tests-menu-heading">
        <h2>{t('Project')}</h2>
        <span>{snapshots.length}</span>
      </div>
      <div className={styles.filters}>
        <input
          className={styles.search}
          aria-label={t('Search files or services')}
          placeholder={t('Find a file or service…')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setCollapsed(new Set());
            setClosedRepos(new Set());
          }}
        />
        <div className={styles.controls}>
          <label
            className={styles.toggle}
            title={
              sinceReview
                ? t('Show only files changed since the review')
                : t('Show only changed files')
            }
          >
            <input
              type="checkbox"
              aria-label={t('Changed files only')}
              checked={onlyChanged}
              onChange={(event) => setOnlyChanged(event.target.checked)}
            />
            {sinceReview ? t('Since the review') : t('Changed')}
          </label>
          <label className={styles.toggle} title={t('Hide viewed files')}>
            <input
              type="checkbox"
              aria-label={t('Hide viewed files')}
              checked={hideViewed}
              onChange={(event) => setHideViewed(event.target.checked)}
            />
            {t('Not viewed')}
          </label>
          <select
            aria-label={t('File type')}
            value={extension}
            onChange={(event) => {
              setExtension(event.target.value);
              setCollapsed(new Set());
              setClosedRepos(new Set());
            }}
          >
            <option value="all">{t('All types')}</option>
            {extensions.map((value) => (
              <option key={value || 'none'} value={value || '__none__'}>
                {value || t('No extension')}
              </option>
            ))}
          </select>
        </div>
      </div>
      {revisionChanges && (
        <div className="menu-revision-summary">
          {t('Since the last review ·')}{' '}
          {revisionChanges.reduce((count, change) => count + change.files.length, 0)} {t('files')}
          {showingPrevious && (
            <button className="text-button" onClick={onLatest}>
              {t('Show the latest version →')}
            </button>
          )}
        </div>
      )}
      <nav className="review-file-tree" aria-label={t('Services, protocols and files')}>
        {roots.map(({ snapshot: owner, total, tree, tests, testCount, changedTests }) => (
          <section className="file-tree-repository" key={owner.id}>
            <button
              className={`file-tree-root ${snapshot?.id === owner.id ? 'selected-repository' : ''}`}
              aria-expanded={!closedRepos.has(owner.id)}
              onClick={() =>
                setClosedRepos((previous) => {
                  const next = new Set(previous);
                  if (next.has(owner.id)) next.delete(owner.id);
                  else next.add(owner.id);
                  return next;
                })
              }
              title={owner.slug}
            >
              <span aria-hidden="true">{closedRepos.has(owner.id) ? '▸' : '▾'}</span>
              <span className="file-tree-root-name">
                <strong>{owner.repoName}</strong>
                <small>
                  {snapshotRole(owner)}
                  {owner.pr
                    ? ` · PR #${owner.pr.number}`
                    : owner.local
                      ? t(' · before PR')
                      : t(' · context')}
                </small>
              </span>
              <small
                title={t(
                  '{0} changed · {1} files in snapshot',
                  sinceReview ? changedCount(owner.repoId) : owner.files.length,
                  total,
                )}
              >
                {sinceReview ? changedCount(owner.repoId) : owner.files.length}/{total}
              </small>
              {changedCount(owner.repoId) > 0 && (
                <span
                  className="review-revision-dot"
                  title={t('Changed since the last review: {0}', changedCount(owner.repoId))}
                  aria-label={t('Changed since the last review: {0}', changedCount(owner.repoId))}
                />
              )}
            </button>
            {!closedRepos.has(owner.id) && (
              <>
                {renderNodes(tree, owner)}
                {tests.length > 0 && (
                  <div className="file-tree-tests">
                    <button
                      className="file-tree-folder file-tree-tests-heading"
                      aria-expanded={!collapsed.has(`${owner.id}:__tests__`)}
                      onClick={() => toggle(`${owner.id}:__tests__`)}
                    >
                      <span aria-hidden="true">
                        {collapsed.has(`${owner.id}:__tests__`) ? '▸' : '▾'}
                      </span>
                      <span className="file-tree-name">{t('Tests')}</span>
                      <small title={t('{0} changed · {1} listed', changedTests, testCount)}>
                        {changedTests && changedTests !== testCount
                          ? `${changedTests}/${testCount}`
                          : testCount}
                      </small>
                    </button>
                    {!collapsed.has(`${owner.id}:__tests__`) && renderNodes(tests, owner, 1)}
                  </div>
                )}
              </>
            )}
          </section>
        ))}
        {!roots.length && (
          <p className="tests-menu-empty">
            {search || hideViewed || extension !== 'all'
              ? t('No files match the filters')
              : t('No changed files')}
          </p>
        )}
      </nav>
    </aside>
  );
}
