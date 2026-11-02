import type { ChangedFile, Snapshot } from './model.js';
import { t } from './i18n.js';

/** Head files plus removed files retain a place in the review tree. */
export function snapshotTreeFiles(snapshot: Snapshot): ChangedFile[] {
  const changes = new Map(snapshot.files.map((file) => [file.path, file]));
  return [...new Set([...snapshot.headFiles, ...changes.keys()])].map(
    (path) =>
      changes.get(path) ?? {
        path,
        status: 'unchanged',
        patch: '',
        addedLines: [],
        removedLines: [],
      },
  );
}

export function snapshotRole(snapshot: Snapshot): string {
  const paths = [...snapshot.headFiles, ...snapshot.files.map((file) => file.path)];
  const protocols = paths.some(
    (path) =>
      /\.(proto|thrift|avdl|graphql|gql)$/i.test(path) ||
      /(?:^|\/)(?:openapi|swagger)[^/]*\.ya?ml$/i.test(path),
  );
  const service = paths.some((path) => /(?:^|\/)src\/main\/.*\.(java|kt)$/i.test(path));
  return protocols
    ? service
      ? t('Service · protocols')
      : t('Protocols')
    : service
      ? t('Service')
      : t('Repository');
}

export interface FileTreeNode {
  name: string;
  path: string;
  children: FileTreeNode[];
  count: number;
  file?: ChangedFile;
}

/** Keep full Git paths for selection while compacting single-child directory chains. */
export function changedFileTree(files: ChangedFile[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', children: [], count: 0 };
  for (const file of files) {
    const parts = file.path.split('/');
    let parent = root;
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join('/');
      let node = parent.children.find((child) => child.path === path);
      if (!node) {
        node = { name: parts[index], path, children: [], count: 0 };
        parent.children.push(node);
      }
      if (index === parts.length - 1) node.file = file;
      parent = node;
    }
  }
  const compact = (node: FileTreeNode): FileTreeNode => {
    const children = node.children
      .map(compact)
      .sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
    if (!node.file && children.length === 1 && !children[0].file) {
      return { ...children[0], name: `${node.name}/${children[0].name}` };
    }
    return {
      ...node,
      children,
      count: node.file ? 1 : children.reduce((sum, child) => sum + child.count, 0),
    };
  };
  return root.children
    .map(compact)
    .sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
}
