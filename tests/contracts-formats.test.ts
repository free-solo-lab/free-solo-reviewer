import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractContracts } from '../server/contracts';
import type { Snapshot } from '../shared/model';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('extracts changed Thrift, protobuf, grammar and split OpenAPI models without requiring a root spec', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contracts-test-'));
  roots.push(root);
  const paths = ['api.thrift', 'api.proto', 'Rules.g4', 'openapi/components/schemas/Customer.yaml'];
  const texts = [
    'struct Customer { 1: string userId }',
    'message Customer { string user_id = 1; }',
    'grammar Rules; identity: USER_ID;',
    'type: object\nproperties:\n  userId:\n    type: string\n',
  ];
  for (const [i, path] of paths.entries()) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), texts[i]);
  }
  const snapshot = {
    repoId: 'r',
    headDir: root,
    baseDir: root,
    headFiles: paths,
    baseFiles: [],
    files: paths.map((path, i) => ({
      path,
      status: 'A',
      patch: `+${texts[i]}`,
      addedLines: [1],
      removedLines: [],
    })),
  } as unknown as Snapshot;
  const contracts = await extractContracts(snapshot);
  expect(contracts.map((c) => c.format)).toEqual([
    'thrift',
    'protobuf',
    'antlr',
    'openapi-fragment',
  ]);
  expect(contracts[0].source?.after).toContain('userId');
  expect(contracts[3].source?.patch).toContain('userId');
  expect(contracts.every((c) => !c.reconstructed && c.evidence.length)).toBe(true);
});
