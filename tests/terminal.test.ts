import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { git } from '../server/process';
import { connectRepository } from '../server/repository';
import { createApp } from '../server/app';
import type { PullRequest, ReviewSession } from '../shared/model';
import { FakeGitHub } from './fixtures';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('opens a shell in the folder of the reviewed repository only for the app itself', async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'project');
  await mkdir(path);
  await git(path, ['init', '-b', 'main']);
  await git(path, ['config', 'user.name', 'Local test']);
  await git(path, ['config', 'user.email', 'test@localhost']);
  await writeFile(join(path, 'Handler.java'), 'class Handler {}\n');
  await git(path, ['add', '.']);
  await git(path, ['commit', '-m', 'base']);
  const repo = await connectRepository(path);
  const { app, store } = createApp({
    dataDir: join(root, 'data'),
    github: new FakeGitHub({} as PullRequest),
  });
  cleanup.push(() => app.close());
  store.saveRepository(repo);
  const session = (
    await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        title: 'Local',
        repositories: [{ repoId: repo.id, prNumber: null, localBase: 'HEAD' }],
      },
    })
  ).json<ReviewSession>();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const url = (repoId: string) =>
    `${address.replace('http', 'ws')}/api/sessions/${session.id}/terminal?repoId=${repoId}`;
  const connect = (repoId: string, origin?: string) =>
    new WebSocket(url(repoId), origin ? { origin } : {});
  const refused = (socket: WebSocket) =>
    new Promise<string>((resolve) => {
      // With this listener, ws leaves aborting the refused request to the caller.
      socket.on('unexpected-response', (req, res) => {
        req.destroy();
        resolve(`http ${res.statusCode}`);
      });
      socket.on('close', (code) => resolve(`close ${code}`));
      socket.on('error', () => undefined);
    });

  expect(await refused(connect(repo.id))).toBe('close 1008');
  expect(await refused(connect(repo.id, 'https://example.com'))).toBe('http 403');
  expect(await refused(connect('unknown', 'http://127.0.0.1:4318'))).toBe('close 1008');

  const socket = connect(repo.id, 'http://127.0.0.1:4318');
  let output = '',
    cwd = '';
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === 'ready') cwd = message.cwd;
    if (message.type === 'data') output += message.data;
  });
  await new Promise((resolve) => socket.on('open', resolve));
  socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 30 }));
  socket.send(JSON.stringify({ type: 'input', data: 'echo "dir=$(pwd) cols=$(tput cols)"\r' }));
  const real = await realpath(path);
  await expect
    .poll(() => output, { timeout: 15_000 })
    .toMatch(new RegExp(`dir=(${real}|${path}) cols=120`));
  expect(cwd).toBe(repo.path);
  socket.close();

  // The shell outlives the connection; a new one sees what happened before.
  const again = connect(repo.id, 'http://127.0.0.1:4318');
  let replay = '';
  again.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === 'data') replay += message.data;
  });
  await expect.poll(() => replay, { timeout: 5_000 }).toContain('cols=120');
  again.close();
}, 30_000);
