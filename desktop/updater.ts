import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, constants, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AvailableUpdate, UpdateState } from '../shared/platform.js';
import { errorMessage } from '../shared/errors.js';
import { t } from '../shared/i18n.js';
import {
  compareVersions,
  RELEASES_URL,
  updateKind,
  verifyManifest,
  type UpdateManifest,
} from './update-manifest.js';

export interface UpdaterOptions {
  currentVersion: string;
  arch: string;
  /** The running Reviewer.app, or null when the app is not packaged. */
  bundlePath: string | null;
  /** Downloads, the unpacked release and the replaced app live here. */
  workDir: string;
  manifestUrl: string;
  publicKey: string;
  fetch: (url: string) => Promise<Response>;
  unzip: (archive: string, destination: string) => Promise<void>;
  bundleVersion: (app: string) => Promise<string>;
  /** The data folder of the server this app owns; it is copied before a minor update. */
  dataDir: () => Promise<string | undefined>;
  spawnDetached: (command: string, args: string[]) => void;
  quit: () => void;
  onChange: (state: UpdateState) => void;
  now?: () => Date;
}

/**
 * Replaces the app once it has quit and opens the new version. If the new copy cannot be moved
 * into place, the old one is put back and opened, so a failed update never leaves no app.
 */
export const INSTALL_SCRIPT = `#!/bin/sh
# System tools by full path: a PATH from Homebrew or Anaconda may shadow them.
pid="$1" app="$2" next="$3" previous="$4" data="$5" backup="$6"
open="\${REVIEWER_OPEN:-/usr/bin/open}"
waited=0
while kill -0 "$pid" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 600 ]; then echo "Reviewer did not quit"; exit 1; fi
  /bin/sleep 0.1
done
if [ -n "$data" ]; then
  /bin/mkdir -p "$backup" || { echo "Could not create $backup"; "$open" "$app"; exit 1; }
  for file in review.sqlite review.sqlite-wal review.sqlite-shm; do
    if [ -f "$data/$file" ]; then
      /bin/cp -p "$data/$file" "$backup/$file" ||
        { echo "Could not back up $file"; "$open" "$app"; exit 1; }
    fi
  done
fi
/bin/rm -rf "$previous"
/bin/mkdir -p "$(/usr/bin/dirname "$previous")"
/bin/mv "$app" "$previous" || { echo "Could not move the old app"; "$open" "$app"; exit 1; }
if ! /bin/mv "$next" "$app"; then
  echo "Could not move the new app; restoring the old one"
  /bin/mv "$previous" "$app"
  "$open" "$app"
  exit 1
fi
/usr/bin/xattr -dr com.apple.quarantine "$app" 2>/dev/null
"$open" "$app"
`;

export class Updater {
  private current: UpdateState = { state: 'idle' };
  private ready?: { update: AvailableUpdate; app: string };
  private running?: Promise<UpdateState>;
  constructor(private options: UpdaterOptions) {}

  get state() {
    return this.current;
  }
  private set(state: UpdateState) {
    this.current = state;
    this.options.onChange(state);
    return state;
  }

  /** Removes what an installed update left behind: the replaced app and older downloads. */
  async cleanup() {
    await rm(join(this.options.workDir, 'previous'), { recursive: true, force: true });
    for (const entry of await readdir(this.options.workDir).catch(() => [])) {
      if (entry.startsWith('.') || entry === 'install.log' || entry === 'install.sh') continue;
      if (compareVersions(entry, this.options.currentVersion) <= 0)
        await rm(join(this.options.workDir, entry), { recursive: true, force: true });
    }
  }

  /** Why this copy cannot replace itself, or undefined when it can. */
  async manualReason() {
    const bundle = this.options.bundlePath;
    if (!bundle) return 'not packaged';
    // macOS runs quarantined apps opened from Downloads from a random read-only copy.
    if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/'))
      return 'read-only location';
    try {
      await access(dirname(bundle), constants.W_OK);
      return undefined;
    } catch {
      return 'not writable';
    }
  }

  /** Checks once at a time; a newer verified release is downloaded right away. */
  check() {
    this.running ??= this.run().finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(): Promise<UpdateState> {
    if (this.current.state === 'ready' || this.current.state === 'installing') return this.current;
    const update = this.current.state === 'error' ? this.current.update : undefined;
    this.set({ state: 'checking' });
    let manifest: UpdateManifest;
    try {
      const response = await this.options.fetch(this.options.manifestUrl);
      if (response.status === 404) return this.set({ state: 'idle', checkedAt: this.stamp() });
      if (!response.ok) throw new Error(t('GitHub answered {0}.', response.status));
      manifest = verifyManifest(await response.json(), this.options.publicKey);
    } catch (error) {
      return this.set({
        state: 'error',
        message: t('Could not check for updates: {0}', errorMessage(error)),
        update,
      });
    }
    if (compareVersions(manifest.version, this.options.currentVersion) <= 0)
      return this.set({ state: 'idle', checkedAt: this.stamp() });
    const available: AvailableUpdate = {
      version: manifest.version,
      notes: manifest.notes,
      notesUrl: manifest.notesUrl,
      kind: updateKind(this.options.currentVersion, manifest.version),
    };
    const asset = manifest.assets.find((item) => item.arch === this.options.arch);
    if (!asset || (await this.manualReason()))
      return this.set({
        state: 'manual',
        downloadUrl: manifest.notesUrl || RELEASES_URL,
        ...available,
      });
    try {
      const app = await this.download(asset, available);
      this.ready = { update: available, app };
      return this.set({ state: 'ready', ...available });
    } catch (error) {
      return this.set({
        state: 'error',
        message: t('Could not download version {0}: {1}', manifest.version, errorMessage(error)),
        update: available,
      });
    }
  }

  private async download(asset: UpdateManifest['assets'][number], update: AvailableUpdate) {
    const folder = join(this.options.workDir, update.version);
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    const archive = join(folder, 'Reviewer.zip');
    const response = await this.options.fetch(asset.url);
    if (!response.ok || !response.body) throw new Error(t('GitHub answered {0}.', response.status));
    const hash = createHash('sha256');
    let received = 0,
      reported = 0;
    this.set({ state: 'downloading', received, total: asset.size, ...update });
    const progress = new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        hash.update(chunk);
        received += chunk.length;
        if (received > asset.size)
          return done(new Error(t('The download is larger than announced.')));
        // A change of a percent is enough for the banner.
        if (received - reported >= asset.size / 100 || received === asset.size) {
          reported = received;
          this.set({ state: 'downloading', received, total: asset.size, ...update });
        }
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      progress,
      createWriteStream(archive),
    );
    if (received !== asset.size || hash.digest('hex') !== asset.sha256)
      throw new Error(t('The download does not match the signed checksum.'));
    const unpacked = join(folder, 'unpacked');
    await this.options.unzip(archive, unpacked);
    const app = join(unpacked, 'Reviewer.app');
    const version = await this.options.bundleVersion(app);
    if (version !== update.version)
      throw new Error(
        t('The archive contains version {0} instead of {1}.', version, update.version),
      );
    await rm(archive, { force: true });
    return app;
  }

  /** Hands the downloaded app to the install script and quits; the script opens the new one. */
  async install() {
    if (!this.ready || this.current.state !== 'ready') throw new Error(t('No update is ready.'));
    const { update, app } = this.ready;
    const bundle = this.options.bundlePath!;
    const data = update.kind === 'patch' ? undefined : await this.options.dataDir();
    const stamp = this.stamp().replace(/[:.]/g, '-');
    const script = join(this.options.workDir, 'install.sh');
    await writeFile(script, INSTALL_SCRIPT, { mode: 0o700 });
    this.set({ state: 'installing', ...update });
    this.options.spawnDetached('/bin/sh', [
      script,
      String(process.pid),
      bundle,
      app,
      join(this.options.workDir, 'previous', 'Reviewer.app'),
      data ?? '',
      data ? join(data, 'backups', `before-${update.version}-${stamp}`) : '',
    ]);
    this.options.quit();
  }

  private stamp() {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
