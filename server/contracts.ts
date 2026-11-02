import { parseDocument } from 'yaml';
import { readSource } from './repository.js';
import { attachBuilds } from './contract-builds.js';
import type { Contract, Snapshot } from '../shared/model.js';
import { contractSourceSummary } from '../shared/contract-summary.js';
import { t } from '../shared/i18n.js';
export const CONTRACTS_VERSION = '4-semantic-summary';
function spec(text: string): Record<string, unknown> | null {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  const data = doc.toJS({ maxAliasCount: 50 }) as Record<string, unknown> | null;
  return data && typeof data === 'object' && ('openapi' in data || 'swagger' in data) ? data : null;
}
function changes(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  if (!before) return [t('Contract added')];
  if (!after) return [t('Contract removed')];
  const result: string[] = [];
  const bp = (before.paths ?? {}) as Record<string, unknown>,
    ap = (after.paths ?? {}) as Record<string, unknown>;
  for (const path of new Set([...Object.keys(bp), ...Object.keys(ap)])) {
    if (!(path in ap)) result.push(t('Endpoint {0} removed: check compatibility', path));
    else if (!(path in bp)) result.push(t('Endpoint {0} added', path));
    else if (JSON.stringify(bp[path]) !== JSON.stringify(ap[path]))
      result.push(t('Endpoint {0} changed: check parameters, responses and compatibility', path));
  }
  if (
    JSON.stringify(before.components ?? before.definitions) !==
    JSON.stringify(after.components ?? after.definitions)
  )
    result.push(t('Model schemas changed: compatibility needs checking'));
  return result.length ? result : [t('Contract metadata or general settings changed')];
}
export async function extractContracts(s: Snapshot): Promise<Contract[]> {
  const result: Contract[] = [];
  for (const file of s.files.filter((f) =>
    /\.(json|ya?ml|thrift|proto|graphql|gql|g4)$/i.test(f.path),
  )) {
    let before: Record<string, unknown> | null = null,
      after: Record<string, unknown> | null = null;
    try {
      const beforeText = s.baseFiles.includes(file.oldPath ?? file.path)
        ? await readSource(s, { side: 'base', path: file.oldPath ?? file.path })
        : null;
      const afterText = s.headFiles.includes(file.path)
        ? await readSource(s, { side: 'head', path: file.path })
        : null;
      const extension = file.path.split('.').at(-1)!.toLowerCase();
      const idl: Contract['format'] =
        extension === 'thrift'
          ? 'thrift'
          : extension === 'proto'
            ? 'protobuf'
            : /^(graphql|gql)$/.test(extension)
              ? 'graphql'
              : extension === 'g4'
                ? 'antlr'
                : undefined;
      const fragment =
        !idl &&
        /(?:openapi|swagger)/i.test(file.path) &&
        ![beforeText, afterText].some((text) => text && spec(text));
      if (idl || fragment) {
        result.push({
          id: `contract:${s.repoId}:${file.path}`,
          repoId: s.repoId,
          path: file.path,
          title: `${idl === 'antlr' ? 'ANTLR' : idl === 'thrift' ? 'Thrift' : idl === 'protobuf' ? 'Protobuf' : idl === 'graphql' ? 'GraphQL' : 'OpenAPI'} · ${file.path.split('/').at(-1)}`,
          format: idl ?? 'openapi-fragment',
          source: { before: beforeText, after: afterText, patch: file.patch },
          before: null,
          after: null,
          reconstructed: false,
          changes: contractSourceSummary(idl ?? 'openapi-fragment', beforeText, afterText),
          evidence: [
            {
              repoId: s.repoId,
              side: afterText !== null ? 'head' : 'base',
              path: afterText !== null ? file.path : (file.oldPath ?? file.path),
              startLine: 1,
              endLine: 1,
            },
          ],
        });
        continue;
      }
      if (beforeText !== null) before = spec(beforeText);
      if (afterText !== null) after = spec(afterText);
      if (!before && !after) continue;
      const side = after ? 'head' : 'base';
      const path = after ? file.path : (file.oldPath ?? file.path);
      result.push({
        id: `contract:${s.repoId}:${file.path}`,
        repoId: s.repoId,
        path: file.path,
        title: String(((after ?? before)?.info as { title?: string })?.title ?? file.path),
        before,
        after,
        reconstructed: false,
        format: 'openapi',
        changes: changes(before, after),
        evidence: [{ repoId: s.repoId, side, path, startLine: 1, endLine: 1 }],
      });
    } catch (e) {
      if (/openapi|swagger/i.test(file.path))
        result.push({
          id: `contract:${s.repoId}:${file.path}`,
          repoId: s.repoId,
          path: file.path,
          title: file.path,
          before,
          after,
          reconstructed: false,
          changes: [],
          evidence: [],
          error: String(e),
        });
    }
  }
  return result;
}

/** Contracts of all services in a review, with the build modules that own and use them. */
export async function extractAllContracts(snapshots: Snapshot[]) {
  const contracts = (await Promise.all(snapshots.map(extractContracts))).flat();
  await attachBuilds(snapshots, contracts);
  return contracts;
}
