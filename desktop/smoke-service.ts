/** Tests the packaged backend in a disposable store, without model or GitHub requests. */
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { connectOrStartService } from './service-controller.js';
import { command } from '../server/process.js';
const { values } = parseArgs({ options: { app: { type: 'string' } } });
const app = resolve(
  values.app ?? `release/Reviewer-darwin-${process.arch}/Reviewer.app`,
  'Contents/Resources/app',
);
const root = await mkdtemp(join(tmpdir(), 'reviewer-packaged-smoke-'));
const node = join(app, 'runtime', 'node');
let owned: Awaited<ReturnType<typeof connectOrStartService>> | undefined;
let terminal: WebSocket | undefined;
try {
  const dependencies = join(app, 'runtime/node_modules');
  for (const name of [
    'react',
    'react-dom',
    'swagger-ui-react',
    '@xterm/xterm',
    '@fontsource/manrope',
  ]) {
    assert(!existsSync(join(dependencies, name)), `Unexpected UI dependency: ${name}`);
  }
  assert.deepEqual(await readdir(join(dependencies, 'node-pty/prebuilds')), [
    `darwin-${process.arch}`,
  ]);
  assert.deepEqual(
    (await readdir(join(dependencies, 'tree-sitter-wasms/out')))
      .filter((name) => name.endsWith('.wasm'))
      .sort(),
    ['tree-sitter-java.wasm', 'tree-sitter-kotlin.wasm'],
  );
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const env = {
    ...process.env,
    REVIEW_DATA_DIR: join(root, 'data'),
    REVIEW_STATE_DIR: join(root, 'state'),
    REVIEW_PORT: String(port),
    CODEX_HOME: join(root, 'codex'),
  };
  await mkdir(env.CODEX_HOME, { recursive: true });
  owned = await connectOrStartService({
    node,
    entry: join(app, 'runtime', 'server.mjs'),
    webDir: join(app, 'ui'),
    env,
    cwd: root,
  });
  assert(owned.owned);
  const request = async (path: string, body?: unknown) => {
    const result = await fetch(
      owned!.url + '/api' + path,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    const value = await result.json();
    assert(result.ok, JSON.stringify(value));
    return value;
  };
  assert.equal((await request('/health')).ok, true);
  assert.match(await (await fetch(owned.url)).text(), /<div id="root">/);
  const repo = join(root, 'repo');
  await mkdir(repo);
  await command('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'Demo.java'), 'class Demo { String run() { return "ok"; } }\n');
  await writeFile(join(repo, 'Example.kt'), 'class Example { fun kotlinRun(): String = "ok" }\n');
  await command('git', ['add', 'Demo.java', 'Example.kt'], { cwd: repo });
  await command(
    'git',
    [
      '-c',
      'user.name=Reviewer smoke',
      '-c',
      'user.email=smoke@localhost',
      'commit',
      '-m',
      'fixture',
    ],
    { cwd: repo },
  );
  const repository = await request('/repositories', { path: repo });
  const review = await request('/sessions', {
    title: 'Packaged runtime smoke',
    repositories: [{ repoId: repository.id, prNumber: null, localBase: 'HEAD' }],
  });
  const index = await request(
    `/sessions/${review.id}/navigation-index?${new URLSearchParams({ snapshotId: review.snapshots[0].id, side: 'head' })}`,
  );
  assert(index.methods.some((method: { name: string }) => method.name === 'run'));
  assert(index.methods.some((method: { name: string }) => method.name === 'kotlinRun'));
  terminal = new WebSocket(
    `${owned.url.replace('http:', 'ws:')}/api/sessions/${review.id}/terminal?repoId=${repository.id}`,
    { origin: owned.url },
  );
  // Build the marker in the shell so its echoed input cannot be mistaken for successful output.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged terminal did not respond')), 15000);
    let output = '';
    terminal!.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    terminal!.on('open', () =>
      terminal!.send(
        JSON.stringify({
          type: 'input',
          data: "printf 'REVIEWER_%s\\n' 'PTY_OK'\r",
        }),
      ),
    );
    terminal!.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'data') output += message.data;
      if (output.includes('REVIEWER_PTY_OK')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  terminal.close();
  const cli = await command(
    node,
    [join(app, 'runtime', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '--version'],
    { env },
  );
  assert.match(cli, /codex-cli/);
  const browser = await connectOrStartService({
    node,
    entry: join(app, 'runtime', 'server.mjs'),
    webDir: join(app, 'ui'),
    env,
    cwd: root,
  });
  assert.equal(browser.owned, false);
  await browser.close();
  assert.equal((await request('/health')).ok, true);
  console.log(
    JSON.stringify({
      packagedNode: (await command(node, ['--version'])).trim(),
      codex: cli.trim(),
      sqlite: true,
      sourceIndex: true,
      kotlinIndex: true,
      terminal: true,
      runtimeContents: true,
      browserReuse: true,
      paidRequests: 0,
    }),
  );
} finally {
  terminal?.terminate();
  await owned?.close();
  await rm(root, { recursive: true, force: true });
}
