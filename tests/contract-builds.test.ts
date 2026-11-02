import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractAllContracts } from '../server/contracts';
import type { Snapshot } from '../shared/model';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function repo(repoId: string, files: Record<string, string>, changed: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'contract-builds-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return {
    repoId,
    repoName: repoId,
    headDir: root,
    baseDir: root,
    headFiles: Object.keys(files),
    baseFiles: [],
    files: changed.map((path) => ({
      path,
      status: 'A',
      patch: `+${files[path]}`,
      addedLines: [1],
      removedLines: [],
    })),
  } as unknown as Snapshot;
}
const spec = 'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: 1.0.0\npaths: {}\n';
const contract = 'api/src/main/resources/openapi.yaml';

it('shows the module that builds a contract and the modules that build with it', async () => {
  const orders = await repo(
    'orders',
    {
      'settings.gradle': "include 'api', 'service', 'client', 'other'",
      'build.gradle': "subprojects { apply plugin: 'java' }\nproject(':api') { version = '1' }",
      'api/build.gradle': "plugins {\n  id 'org.openapi.generator'\n}",
      [contract]: spec,
      'service/build.gradle': "dependencies {\n  implementation project(':api')\n}",
      'client/build.gradle.kts': `plugins { id("org.openapi.generator") }\nopenApiGenerate {\n  inputSpec.set("$rootDir/${contract}")\n}`,
      'other/build.gradle': "dependencies { implementation project(':apiary') }",
      'web/build.gradle': "dependencies {\n  implementation project(':service')\n}",
    },
    [contract],
  );
  const billing = await repo('billing', {
    'pom.xml':
      '<project><artifactId>billing</artifactId><dependencies>\n<dependency><groupId>com.acme</groupId><artifactId>billing-core</artifactId></dependency></dependencies></project>',
    'build.gradle': '',
  });
  const payments = await repo('payments', {
    'build.gradle': 'dependencies {\n  implementation "com.acme:api:1.2.0"\n}',
  });
  const [found] = await extractAllContracts([orders, billing, payments]);
  expect(found.build?.module).toMatchObject({ name: ':api', dir: 'api', tool: 'gradle' });
  expect(found.build?.generators).toEqual(['openapi-generator']);
  expect(
    found.build?.consumers.map(({ repoId, name, via, generators, evidence }) => [
      repoId,
      name,
      via,
      generators,
      evidence.startLine,
    ]),
  ).toEqual([
    ['orders', ':service', 'dependency', [], 2],
    ['orders', ':client', 'path', ['openapi-generator'], 3],
    ['payments', 'payments', 'dependency', [], 2],
    ['orders', ':web', 'transitive', [], 2],
  ]);
  expect(found.build?.consumers.at(-1)?.through).toBe(':service');
});

it('names Maven and npm modules by their artifacts and leaves loose files without a module', async () => {
  const shop = await repo(
    'shop',
    {
      'contracts/pom.xml':
        '<project><parent><artifactId>shop-parent</artifactId></parent><artifactId>shop-contracts</artifactId><build><plugins><plugin><artifactId>protobuf-maven-plugin</artifactId></plugin></plugins></build></project>',
      'contracts/src/main/proto/shop.proto': 'message Order {}',
      'web/package.json': '{"name": "@shop/web", "dependencies": {"ts-proto": "1"}}',
      'web/src/shop.proto': 'message Cart {}',
      'app/pom.xml':
        '<project><artifactId>shop-app</artifactId><dependencies>\n  <dependency>\n    <artifactId>shop-contracts</artifactId>\n  </dependency>\n</dependencies></project>',
      'loose.graphql': 'type Query { a: Int }',
    },
    ['contracts/src/main/proto/shop.proto', 'web/src/shop.proto', 'loose.graphql'],
  );
  const [proto, web, loose] = await extractAllContracts([shop]);
  expect(proto.build?.module?.name).toBe('shop-contracts');
  expect(proto.build?.generators).toEqual(['protobuf']);
  expect(proto.build?.consumers.map((c) => [c.name, c.evidence.startLine])).toEqual([
    ['shop-app', 2],
  ]);
  expect(web.build?.module).toMatchObject({ name: '@shop/web', tool: 'npm' });
  expect(web.build?.generators).toEqual(['protobuf']);
  expect(loose.build).toEqual({ module: null, generators: [], consumers: [] });
});
