import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReviewerService } from '../server/service';
import { probeReviewer } from '../server/service-client';
import { readServiceLocation } from '../server/runtime-paths';
import { connectOrStartService } from '../desktop/service-controller';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as { port: number }).port;
}
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-bootstrap-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const env = {
    REVIEW_STATE_DIR: join(root, 'support'),
    REVIEW_DATA_DIR: join(root, 'data'),
    REVIEW_PORT: String(await freePort()),
  };
  return { root, env };
}
it('starts one shared server for simultaneous launchers and does not stop it when a client disconnects', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([
    startReviewerService({ env: f.env, cwd: f.root }),
    startReviewerService({ env: f.env, cwd: f.root }),
  ]);
  const owner = a.reused ? b : a,
    client = a.reused ? a : b;
  cleanup.push(() => owner.close());
  expect(owner.reused).toBe(false);
  expect(client.reused).toBe(true);
  expect(a.url).toBe(b.url);
  expect((await probeReviewer(+f.env.REVIEW_PORT))?.dataDir).toBe(f.env.REVIEW_DATA_DIR);
  expect((await readServiceLocation(f.env.REVIEW_STATE_DIR))?.port).toBe(+f.env.REVIEW_PORT);
  const desktop = await connectOrStartService({
    node: '/not-used/node',
    entry: '/not-used/server.mjs',
    webDir: f.root,
    env: f.env,
    cwd: f.root,
  });
  expect(desktop.owned).toBe(false);
  await desktop.close();
  await client.close();
  expect(await probeReviewer(+f.env.REVIEW_PORT)).toBeDefined();
  await owner.close();
  expect(await probeReviewer(+f.env.REVIEW_PORT)).toBeUndefined();
});
it('refuses another server on the port and protects the same database on a second port', async () => {
  const foreign = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  const port = await listen(foreign);
  cleanup.push(() => new Promise<void>((resolve) => foreign.close(() => resolve())));
  await expect(probeReviewer(port)).rejects.toThrow('занят другим');
  const f = await fixture();
  const owner = await startReviewerService({ env: f.env, cwd: f.root });
  cleanup.push(() => owner.close());
  await expect(
    startReviewerService({
      env: { ...f.env, REVIEW_PORT: String(await freePort()) },
      cwd: f.root,
      lockTimeoutMs: 0,
    }),
  ).rejects.toThrow('база Reviewer уже открыта');
  await expect(
    startReviewerService({
      env: { ...f.env, REVIEW_DATA_DIR: join(f.root, 'other') },
      cwd: f.root,
    }),
  ).rejects.toThrow('другую папку данных');
});
it('serves the same built interface from an explicit path independent of the current working directory', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'index.html'), '<html>shared reviewer UI</html>');
  const service = await startReviewerService({ env: f.env, cwd: f.root, webDir: f.root });
  cleanup.push(() => service.close());
  expect(await (await fetch(service.url + '/settings/prompts')).text()).toContain(
    'shared reviewer UI',
  );
  expect((await fetch(service.url + '/api/not-a-route')).status).toBe(404);
});
