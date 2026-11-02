import { setTimeout as delay } from 'node:timers/promises';
import { probeReviewer } from './service-client.js';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { createApp } from './app.js';
import {
  SERVICE_NAME,
  SERVICE_PROTOCOL,
  serviceUrl,
  type ReviewerRuntime,
} from '../shared/runtime.js';
import { serviceConfiguration, writeServiceLocation } from './runtime-paths.js';
import { t } from '../shared/i18n.js';

/** The only production bootstrap: lock the store before any recovery or writes to SQLite. */
export async function startReviewerService(
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    webDir?: string;
    stateDir?: string;
    lockTimeoutMs?: number;
  } = {},
) {
  const config = await serviceConfiguration(options);
  const existing = await probeReviewer(config.port);
  if (existing) {
    if (existing.dataDir !== config.dataDir)
      throw new Error(
        t('Reviewer uses another data folder on this port. Choose another REVIEW_PORT.'),
      );
    await writeServiceLocation(config.stateDir, { ...existing, port: config.port });
    return { url: serviceUrl(config.port), reused: true, close: async () => {} };
  }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  let release: (() => Promise<void>) | undefined;
  const until = Date.now() + (options.lockTimeoutMs ?? 20000);
  while (!release) {
    try {
      release = await lockfile.lock(config.dataDir, {
        lockfilePath: `${config.dataDir}/.server.lock`,
        realpath: true,
        retries: 0,
        stale: 15000,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
      const ready = await probeReviewer(config.port);
      if (ready?.dataDir === config.dataDir) {
        await writeServiceLocation(config.stateDir, { ...ready, port: config.port });
        return { url: serviceUrl(config.port), reused: true, close: async () => {} };
      }
      if (Date.now() >= until)
        throw new Error(
          t(
            'This Reviewer database is already open in another server. Wait for it to start or stop it before changing the port.',
          ),
        );
      await delay(200);
    }
  }
  let instance: ReturnType<typeof createApp> | undefined;
  try {
    // A second launcher may have won while this process waited on the file lock.
    const ready = await probeReviewer(config.port);
    if (ready) {
      if (ready.dataDir !== config.dataDir)
        throw new Error(t('The Reviewer port is tied to another database.'));
      await release();
      return { url: serviceUrl(config.port), reused: true, close: async () => {} };
    }
    const runtime: ReviewerRuntime = {
      service: SERVICE_NAME,
      protocol: SERVICE_PROTOCOL,
      pid: process.pid,
      dataDir: config.dataDir,
      instanceId: randomUUID(),
    };
    instance = createApp({
      dataDir: config.dataDir,
      port: config.port,
      webDir: options.webDir ?? (options.env ?? process.env).REVIEW_WEB_DIR,
      runtime,
    });
    await instance.app.listen({ port: config.port, host: '127.0.0.1' });
    await writeServiceLocation(config.stateDir, { ...runtime, port: config.port });
    const owned = instance;
    let closing: Promise<void> | undefined;
    return {
      url: serviceUrl(config.port),
      reused: false,
      close: () => (closing ??= owned.app.close().finally(release!)),
    };
  } catch (error) {
    await instance?.app.close().catch(() => {});
    await release().catch(() => {});
    throw error;
  }
}
