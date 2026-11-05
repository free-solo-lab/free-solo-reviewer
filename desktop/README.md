# Reviewer in the browser and on macOS

Both ways of running Reviewer share one React interface (`web/`), one server (`server/`) and one model (`shared/`). Electron in `desktop/` only provides the window, the application menu, the native folder picker, and starting or connecting to the server. In the browser the native adapter is replaced by the regular API.

## Running

- **Browser:** `npm run build`, then `npm start`, and open `http://127.0.0.1:4318`.
- **Desktop from source:** `npm run desktop`.
- **Standalone app:** `npm run desktop:package` builds `release/Reviewer-darwin-arm64/Reviewer.app` on Apple Silicon or `release/Reviewer-darwin-x64/Reviewer.app` on Intel. Move it to Applications and start it from the Dock or Spotlight.
- **DMG:** `npm run desktop:dmg` builds the same app and packages it as `release/Reviewer-<version>-darwin-<arch>.dmg`. Open the image, drag Reviewer.app to Applications, eject the image and launch the installed app. Quit Reviewer before replacing it with a newer build.

Build on a Mac of the same architecture. The first build downloads Electron, the official Node.js 24 LTS (verified against its SHA-256 checksum) and the server's production dependencies; they ship inside the app, so it needs no system Node.js, npm or sources. Git and the GitHub CLI must be installed separately, and GitHub and Codex sign-ins come from the user's existing setup. The native Codex CLI is already part of the server dependencies.

The DMG uses the built-in `hdiutil` utility, HFS+ and UDZO compression. It contains Reviewer.app, an Applications symlink and bilingual installation instructions. It disables Spotlight indexing of the mounted image. Temporary staging preserves the app's permissions and symlinks; failed image creation keeps the previous DMG intact. The build keeps the three-attempt retry policy, with a five-minute limit per attempt and cleanup of partial images; each attempt logs its duration and limit.

The complete application bundle, including nested executables and native modules, is ad-hoc signed after packaging. Signing failures stop the build. `codesign --verify --deep --strict` runs before image creation, on the mounted app and again on the installed copy. No Apple credentials are needed. This fixes the invalid Electron resource seal of older builds, but does not provide Developer ID trust or notarization: a downloaded build may still require **System Settings → Privacy & Security → Open Anyway** on first launch. See [Apple's instructions](https://support.apple.com/en-gb/102445). A macOS block before Electron starts cannot be replaced with an app-owned error dialog.

Updating uses Finder's normal **Replace** prompt: quit Reviewer, copy `Reviewer.app` into the same Applications folder, confirm replacement and eject the image. Names and the bundle ID stay constant. Spotlight can also find mounted images, source builds and copies in other folders; eject old images and use **Reviewer → Show app in Finder** to locate the running copy. Reviewer does not delete old applications or rebuild the system index automatically.

## Build verification and CI

```sh
npm run desktop:dmg
npm run desktop:dmg:smoke
# Explicit paths are supported too:
npm run desktop:dmg:smoke -- --image /path/to/Reviewer.dmg
npm run desktop:smoke -- --app /path/to/Reviewer.app
npm run desktop:gui:smoke -- --app /path/to/Reviewer.app
```

The image smoke check verifies its checksum, mounts it read-only, checks signatures, the Applications link, executable permissions and framework symlinks, copies Reviewer.app into a temporary installation folder and ejects the image. It then checks the copied app's contents and backend with an isolated database: bundled Node.js, SQLite, Java and Kotlin indexing, a native terminal over WebSocket, Codex CLI startup and reuse of the running service. Finally it launches the real Electron executable with a disposable profile, waits for a window and the application shell, rejects startup error screens, and quits. This test uses the `--reviewer-smoke` flag; desktop failures in that mode produce a nonzero exit instead of an interactive dialog, and automatic update checks are disabled. It rejects duplicate UI dependencies, foreign terminal binaries and unused WASM grammars. These checks make no model or GitHub requests and leave the user's Applications and data folders untouched.

The **macOS DMG** GitHub Actions workflow runs manually or on `v*` tags, building natively on `macos-15` (arm64) and `macos-15-intel` (x64). Each job runs the image smoke check and uploads its DMG, update archive and SHA-256 files as a separate artifact, retained for 30 days. On a tag, a final job publishes a GitHub release with both architectures and the signed `latest.json` (see [Updates](#updates)). After downloading and unzipping an artifact, use `shasum -a 256 -c <filename>.dmg.sha256` in its folder to verify the download.

Before distributing a build, also check the GUI: install through Finder, eject the DMG, launch from Applications, choose a repository, close and reopen the window, and quit the app. A replacement app should reopen the same review history.

## Desktop diagnostics

`desktop.log` is initialized before server startup in the Reviewer state folder. It records launch metadata, the window-ready event and sanitized failure details. At 5 MiB it rotates to `desktop.log.1`, retaining one previous copy. An unavailable log folder does not suppress the native error dialog. `server.log` remains the backend journal: failed requests and commands, analysis failures, crashes and interface errors are written there too, and the **Logs** tab of the bottom panel shows them live together with `desktop.log`.

Server startup failures, window load failures, renderer crashes and unhandled main-process errors use one native dialog with **Show logs**, **Copy diagnostics** and **Close**. An unexpected exit of an owned server also opens it; normal shutdown and separately started servers do not. The app menu exposes logs, diagnostic copying and **Show app in Finder**. Copied reports contain version, macOS version, architecture, application path, stage and error metadata. They exclude environment dumps, full logs, repository contents and credentials, and are never uploaded automatically. Every existing error report should be reviewed before sharing it externally.

## Package contents and size

The server build's esbuild import graph determines its runtime dependencies. `desktop/runtime-package.ts` also includes packages loaded through `createRequire` or `require.resolve`: node-pty, the Java/Kotlin grammars and Codex CLI. The build creates a runtime manifest with those installation roots and a lock that keeps only the packages reachable from them, resolved the way Node resolves them, with their locked versions, integrity hashes and overrides. `npm ci` installs every entry of a lock, so leaving the rest out is what keeps React, Swagger UI, fonts and other interface dependencies, already bundled by Vite, out of the app.

After installation, the build keeps only `node-pty/prebuilds/darwin-<arch>` and the Java/Kotlin grammar WASMs. It preserves package licenses and fixes the terminal helper's execute bit. The cache fingerprint includes the runtime manifest, lock, architecture and packaging revision. Increase that revision when expanding retained assets so an older, pruned cache is reinstalled. The UI directory is replaced on every build to remove obsolete hashed assets.

Build output reports logical sizes for the runtime, UI, app and DMG; framework symlinks are not counted twice. Measured on Apple Silicon with Electron 45.0.0 and Node.js 24.22.2:

| Component | Previous v0.1.2 build | v0.1.3    |
| --------- | --------------------- | --------- |
| Runtime   | 723.4 MiB             | 474.1 MiB |
| UI        | 6.2 MiB               | 3.3 MiB   |
| App       | 981.1 MiB             | 729.0 MiB |
| DMG       | 389.4 MiB             | 315.4 MiB |

The DMG is about 19% smaller. Most of the remaining size is the required Codex CLI, Electron and standalone Node.js. Sizes can change with dependency versions and architecture; compare measurements using the same build environment.

## Updates

The app updates itself from GitHub releases:

1. Fifteen seconds after start and then every 30 minutes it downloads `latest.json` from the latest release and checks its Ed25519 signature against the key in `desktop/update-public-key.ts`. Unsigned or altered manifests are rejected.
2. When the version is newer, it downloads `Reviewer-<version>-darwin-<arch>.zip` into `~/Library/Application Support/Reviewer/updates`, checks its size and SHA-256 from the signed manifest, unpacks it and checks the version inside.
3. A banner and **Settings → About** offer **Restart and update**. The app quits (stopping a server it started), and `install.sh` waits for it, copies the database to `<data>/backups/before-<version>-<time>` for a minor or major release, swaps Reviewer.app, keeps the old copy in `updates/previous` and opens the new version, which removes the old copy on start. If the new app cannot be moved into place, the old one is put back and opened. The script's output is `updates/install.log`.

An app that cannot replace itself (not in a writable folder, started from the disk image, or moved by macOS to a translocated copy from Downloads) offers the release page instead. Errors while checking show only in Settings; a failed download shows a banner with **Retry**.

The release workflow signs `latest.json` with the `REVIEWER_UPDATE_KEY` repository secret, the PKCS#8 PEM private key; without it the release is not published. `node --import tsx desktop/update-key.ts <file.pem>` creates a new pair, writes the private key to the file and prints the public key. A new key makes installed apps reject updates until they are reinstalled once, so keep the key.

To try the whole path before a release, build an app with a higher version, sign a `latest.json` for its archive with the private key and serve both locally, then start an older installed copy with its own data and the local manifest:

```sh
REVIEWER_UPDATE_URL=http://127.0.0.1:4399/latest.json REVIEW_STATE_DIR=/tmp/r/state \
  REVIEW_DATA_DIR=/tmp/r/data REVIEW_PORT=4325 /path/to/Reviewer.app/Contents/MacOS/Reviewer
```

## One server, one data folder

The browser and the app both start the server through `server/service.ts`. Before opening the database, the server takes a file lock, so two processes never recover or analyze with the same SQLite database at once. The desktop app checks `/api/runtime` and connects only to a compatible Reviewer that uses the same data folder; an unrelated service on the port is neither loaded into the window nor stopped.

The data folder is chosen in this order:

1. An explicit `REVIEW_DATA_DIR`.
2. An existing `.review/review.sqlite` in the working folder of the launch, for older installations.
3. The last saved path in `~/Library/Application Support/Reviewer/service.json`.
4. `~/Library/Application Support/Reviewer/data` for a new installation.

An existing database and its snapshots are not moved, because they contain absolute paths. After the first run of `npm start`, the desktop app remembers the same folder and works with it without a terminal. The registry never stores credentials. `REVIEW_STATE_DIR` overrides the registry and log folder, `REVIEW_PORT` the port, `REVIEW_WEB_DIR` the path to the built interface; both ways of running honor them.

Closing the desktop window keeps the app and running analyses alive; opening it again from the Dock shows the same window. **Reviewer → Open in browser** opens the same server. Quitting the app (`⌘Q`) stops only a server the app started itself, and an unfinished analysis keeps its checkpoint. A server started separately is left running. The log of a server started by the app is `~/Library/Application Support/Reviewer/server.log`.

The app's menus follow the language chosen in **Settings**; restart the app after changing it.

Quit and fatal diagnostic failures share one shutdown path. Reviewer cancels a pending startup and waits for an owned server to exit after SIGTERM; after ten seconds it sends SIGKILL and waits up to two more seconds. Repeated Quit requests wait for the same cleanup. A separately started server is left running. If opening the logs folder fails, a native message shows its path and the reason, then returns to the diagnostic dialog or the app.

Update the sources or the app after analyses have finished. The file lock protects startup, but it does not replace a backup of the data folder before deleting or moving it.
