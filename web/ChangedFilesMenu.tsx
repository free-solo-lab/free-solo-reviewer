import React, { useMemo, useState } from 'react';
import {
  changedFileTree,
  snapshotTreeFiles,
  snapshotRole,
  type FileTreeNode,
} from '../shared/file-tree';
import type { Snapshot } from '../shared/model';
import { fileExtension } from '../shared/viewed-files';

export function ChangedFilesMenu({
  snapshots,
  snapshot,
  selectedPath,
  onSelect,
  isViewed,
  isViewPending,
  viewLoading,
  onViewed,
}: {
  snapshots: Snapshot[];
  snapshot?: Snapshot;
  selectedPath?: string;
  onSelect: (snapshotId: string, path: string) => void;
  isViewed: (snapshot: Snapshot, path: string) => boolean;
  isViewPending: (snapshot: Snapshot, path: string) => boolean;
  viewLoading: boolean;
  onViewed: (snapshot: Snapshot, path: string, viewed: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [hideViewed, setHideViewed] = useState(false);
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
          const files = allFiles.filter(
            (file) =>
              (!onlyChanged || file.status !== 'unchanged') &&
              (!hideViewed || !isViewed(item, file.path)) &&
              (extension === 'all' ||
                fileExtension(file.path) === (extension === '__none__' ? '' : extension)) &&
              `${item.repoName} ${file.path} ${file.oldPath ?? ''}`
                .toLowerCase()
                .includes(search.toLowerCase()),
          );
          return { snapshot: item, total: allFiles.length, tree: changedFileTree(files) };
        })
        .filter((root) => root.tree.length),
    [snapshots, search, onlyChanged, hideViewed, extension, isViewed],
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
                      ? 'Без изменений'
                      : `Статус: ${node.file.status}`
                  }
                >
                  {node.file.status === 'unchanged' ? '·' : node.file.status[0].toUpperCase()}
                </span>
                <span className="file-tree-name">{node.name}</span>
                {node.file.status !== 'unchanged' && (
                  <span className="file-tree-counts">
                    <span>+{node.file.addedLines.length}</span>
                    <span>−{node.file.removedLines.length}</span>
                  </span>
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
                aria-label={`${node.path}: просмотрен`}
                title={
                  isViewed(owner, node.path)
                    ? 'Снять отметку «Просмотрен»'
                    : 'Отметить файл просмотренным'
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
    <aside className="secondary-menu changed-files-menu" aria-label="Меню проекта">
      <div className="tests-menu-heading">
        <h2>Проект</h2>
        <span>{snapshots.length}</span>
      </div>
      <div className="tests-filter">
        <input
          aria-label="Поиск файла или сервиса"
          placeholder="Найти файл или сервис…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setCollapsed(new Set());
            setClosedRepos(new Set());
          }}
        />
        <label className="file-tree-filter">
          <input
            type="checkbox"
            checked={onlyChanged}
            onChange={(event) => setOnlyChanged(event.target.checked)}
          />
          Только изменения PR
        </label>
        <label className="file-tree-filter">
          <input
            type="checkbox"
            checked={hideViewed}
            onChange={(event) => setHideViewed(event.target.checked)}
          />
          Скрыть просмотренные
        </label>
        <select
          aria-label="Тип файла"
          value={extension}
          onChange={(event) => {
            setExtension(event.target.value);
            setCollapsed(new Set());
            setClosedRepos(new Set());
          }}
        >
          <option value="all">Все типы файлов</option>
          {extensions.map((value) => (
            <option key={value || 'none'} value={value || '__none__'}>
              {value || 'Без расширения'}
            </option>
          ))}
        </select>
      </div>
      <nav className="review-file-tree" aria-label="Сервисы, протоколы и файлы">
        {roots.map(({ snapshot: owner, total, tree }) => (
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
                  {owner.pr ? ` · PR #${owner.pr.number}` : ' · контекст'}
                </small>
              </span>
              <small title={`${owner.files.length} изменено · ${total} файлов в снимке`}>
                {owner.files.length}/{total}
              </small>
            </button>
            {!closedRepos.has(owner.id) && renderNodes(tree, owner)}
          </section>
        ))}
        {!roots.length && (
          <p className="tests-menu-empty">
            {search || hideViewed || extension !== 'all'
              ? 'Нет файлов, подходящих под фильтры'
              : 'Нет изменённых файлов'}
          </p>
        )}
      </nav>
    </aside>
  );
}
