import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PORT, isReviewerRuntime, type ReviewerRuntime } from '../shared/runtime.js';

export interface ServiceLocation extends ReviewerRuntime {
  port: number;
}
export function reviewerStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir(),
) {
  if (env.REVIEW_STATE_DIR) return resolve(env.REVIEW_STATE_DIR);
  return platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Reviewer')
    : platform === 'win32'
      ? join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Reviewer')
      : join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'reviewer');
}
export async function readServiceLocation(stateDir: string): Promise<ServiceLocation | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(stateDir, 'service.json'), 'utf8'));
    if (
      isReviewerRuntime(value) &&
      Number.isInteger((value as ServiceLocation).port) &&
      (value as ServiceLocation).port > 0 &&
      (value as ServiceLocation).port < 65536
    )
      return value as ServiceLocation;
  } catch {
    /* A first launch has no service registry. */
  }
}
export async function writeServiceLocation(stateDir: string, location: ServiceLocation) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temporary = join(stateDir, `.service-${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(location), { mode: 0o600 });
  await rename(temporary, join(stateDir, 'service.json'));
}
export async function serviceConfiguration(
  options: { env?: NodeJS.ProcessEnv; cwd?: string; stateDir?: string } = {},
) {
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? reviewerStateDir(env);
  const registered = await readServiceLocation(stateDir);
  const legacy = join(options.cwd ?? process.cwd(), '.review');
  // Existing checkouts keep their absolute snapshot paths. Both launchers remember this store.
  const dataDir = resolve(
    env.REVIEW_DATA_DIR ??
      (existsSync(join(legacy, 'review.sqlite'))
        ? legacy
        : (registered?.dataDir ?? join(stateDir, 'data'))),
  );
  const port = Number(
    env.REVIEW_PORT ?? (registered?.dataDir === dataDir ? registered.port : DEFAULT_PORT),
  );
  return { stateDir, dataDir, port };
}
