import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reviewerStateDir,
  readServiceLocation,
  serviceConfiguration,
  writeServiceLocation,
} from '../server/runtime-paths';
import { SERVICE_NAME, SERVICE_PROTOCOL } from '../shared/runtime';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('shares a persistent store between desktop and browser and preserves existing absolute snapshot paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-service-paths-'));
  roots.push(root);
  const project = join(root, 'project'),
    stateDir = join(root, 'support');
  await mkdir(join(project, '.review'), { recursive: true });
  await writeFile(join(project, '.review/review.sqlite'), 'existing');
  const browser = await serviceConfiguration({ env: {}, cwd: project, stateDir });
  expect(browser.dataDir).toBe(join(project, '.review'));
  await writeServiceLocation(stateDir, {
    service: SERVICE_NAME,
    protocol: SERVICE_PROTOCOL,
    pid: 1,
    instanceId: 'test',
    dataDir: browser.dataDir,
    port: 4318,
  });
  const desktop = await serviceConfiguration({ env: {}, cwd: join(root, 'application'), stateDir });
  expect(desktop.dataDir).toBe(browser.dataDir);
  expect(desktop.port).toBe(browser.port);
  const custom = await serviceConfiguration({
    env: { REVIEW_DATA_DIR: join(root, 'custom'), REVIEW_PORT: '4320' },
    cwd: project,
    stateDir,
  });
  expect(custom.dataDir).toBe(join(root, 'custom'));
  expect(custom.port).toBe(4320);
});
it('uses a durable default for a new install and rejects malformed discovery records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-service-empty-'));
  roots.push(root);
  expect(reviewerStateDir({}, 'darwin', '/user')).toBe(
    '/user/Library/Application Support/Reviewer',
  );
  const config = await serviceConfiguration({ env: {}, cwd: root, stateDir: root });
  expect(config.dataDir).toBe(join(root, 'data'));
  await writeFile(
    join(root, 'service.json'),
    JSON.stringify({ service: 'another-service', dataDir: '/wrong', port: 4318 }),
  );
  expect(await readServiceLocation(root)).toBeUndefined();
});
