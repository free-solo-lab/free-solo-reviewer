/** Launch the real installed Electron app with a disposable profile and no account credentials. */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { command } from '../server/process.js';
import { readServiceLocation } from '../server/runtime-paths.js';
import { probeReviewer } from '../server/service-client.js';
import { verifyApplicationSignature } from './signing.js';

const { values } = parseArgs({ options: { app: { type: 'string' } } });
const app = resolve(values.app ?? `release/Reviewer-darwin-${process.arch}/Reviewer.app`);
await verifyApplicationSignature(app);
const root = await mkdtemp(join(tmpdir(), 'reviewer-gui-smoke-'));
const stateDir = join(root, 'state');
const dataDir = join(root, 'data');
try {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REVIEW_STATE_DIR: stateDir,
    REVIEW_DATA_DIR: dataDir,
    REVIEW_PORT: String(port),
    CODEX_HOME: join(root, 'codex'),
    GH_CONFIG_DIR: join(root, 'gh'),
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    OPENAI_API_KEY: '',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  await mkdir(env.CODEX_HOME!, { recursive: true });
  await mkdir(env.GH_CONFIG_DIR!, { recursive: true });
  await command(
    join(app, 'Contents/MacOS/Reviewer'),
    ['--user-data-dir=' + join(root, 'profile'), '--reviewer-smoke'],
    { cwd: root, env, timeout: 90000 },
  );
  const events = (await readFile(join(stateDir, 'desktop.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(events.some((event) => event.stage === 'launch'));
  const ready = events.find((event) => event.stage === 'window-ready');
  assert(ready, 'Electron must open a window and render React before exiting');
  assert(!events.some((event) => event.message), 'No desktop failure should be logged');
  console.log(
    JSON.stringify({ electronWindow: true, react: true, version: ready.version, arch: ready.arch }),
  );
} finally {
  // Also clean up an owned backend if the desktop process had to be timed out.
  const location = await readServiceLocation(stateDir);
  if (location?.dataDir === dataDir) {
    const live = await probeReviewer(location.port).catch(() => undefined);
    if (live?.pid === location.pid && live.dataDir === dataDir) {
      try {
        process.kill(live.pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      for (let attempt = 0; attempt < 50; attempt++) {
        if (!(await probeReviewer(location.port).catch(() => undefined))) break;
        await delay(100);
      }
    }
  }
  await rm(root, { recursive: true, force: true });
}
