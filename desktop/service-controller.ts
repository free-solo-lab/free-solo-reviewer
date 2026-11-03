import { spawn, type ChildProcess } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { serviceConfiguration } from '../server/runtime-paths.js';
import { probeReviewer } from '../server/service-client.js';
import { serviceUrl } from '../shared/runtime.js';
import { t } from '../shared/i18n.js';
import { stopChildProcess } from './shutdown.js';

export function toolEnvironment(
  env: NodeJS.ProcessEnv,
  nodePath: string,
  home = homedir(),
): NodeJS.ProcessEnv {
  const paths = [
    dirname(nodePath),
    join(dirname(nodePath), 'node_modules', '.bin'),
    ...(env.PATH ?? '').split(':'),
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return { ...env, PATH: [...new Set(paths.filter(Boolean))].join(':') };
}
export async function connectOrStartService(options: {
  node: string;
  entry: string;
  webDir: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUnexpectedExit?: (details: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
}) {
  options.signal?.throwIfAborted();
  const env = toolEnvironment(options.env ?? process.env, options.node);
  const config = await serviceConfiguration({ env, cwd: options.cwd });
  const existing = await probeReviewer(config.port);
  if (existing) {
    if (existing.dataDir !== config.dataDir)
      throw new Error(
        t('The running Reviewer uses another data folder. Check REVIEW_DATA_DIR and REVIEW_PORT.'),
      );
    return { url: serviceUrl(config.port), owned: false, close: async () => {} };
  }
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const log = await open(join(config.stateDir, 'server.log'), 'a', 0o600);
  let child: ChildProcess;
  let error: Error | undefined;
  let exit: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
  let ownedReady = false;
  let closing = false;
  try {
    child = spawn(options.node, [options.entry], {
      cwd: config.stateDir,
      env: {
        ...env,
        REVIEW_DATA_DIR: config.dataDir,
        REVIEW_STATE_DIR: config.stateDir,
        REVIEW_PORT: String(config.port),
        REVIEW_WEB_DIR: options.webDir,
      },
      stdio: ['ignore', log.fd, log.fd],
      windowsHide: true,
    });
    // Attach before awaiting log.close(): an executable may fail on the next tick.
    child.on('error', (value) => {
      error = value;
    });
    child.on('exit', (exitCode, signal) => {
      exit = { exitCode, signal };
      if (ownedReady && !closing && !options.signal?.aborted) options.onUnexpectedExit?.(exit);
    });
  } finally {
    await log.close();
  }
  let stopping: Promise<void> | undefined;
  const closeChild = () => {
    closing = true;
    return (stopping ??= stopChildProcess(child));
  };
  const until = Date.now() + (options.timeoutMs ?? 45000);
  try {
    while (Date.now() < until) {
      options.signal?.throwIfAborted();
      if (error) throw error;
      const ready = await probeReviewer(config.port);
      if (exit && (!ready || ready.pid === child.pid))
        throw new Error(
          t(
            'The Reviewer server exited ({0}). Details: {1}',
            exit.signal ?? exit.exitCode,
            join(config.stateDir, 'server.log'),
          ),
        );
      if (ready) {
        options.signal?.throwIfAborted();
        if (ready.dataDir !== config.dataDir)
          throw new Error(t('The server runs with another database.'));
        // If another launcher won the race, never stop its server on desktop exit.
        const owned = ready.pid === child.pid;
        ownedReady = owned;
        if (!owned) await closeChild();
        return {
          url: serviceUrl(config.port),
          owned,
          close: owned ? closeChild : async () => {},
        };
      }
      await delay(200);
    }
    throw new Error(
      t('The Reviewer server did not start. Details: {0}', join(config.stateDir, 'server.log')),
    );
  } catch (failure) {
    try {
      await closeChild();
    } catch (cleanupFailure) {
      throw new AggregateError(
        [failure, cleanupFailure],
        t('Reviewer startup failed and its server could not be stopped.'),
      );
    }
    throw failure;
  }
}
