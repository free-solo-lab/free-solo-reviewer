# Reviewer in the browser and on macOS

Both ways of running Reviewer share one React interface (`web/`), one server (`server/`) and one model (`shared/`). Electron in `desktop/` only provides the window, the application menu, the native folder picker, and starting or connecting to the server. In the browser the native adapter is replaced by the regular API.

## Running

- **Browser:** `npm run build`, then `npm start`, and open `http://127.0.0.1:4318`.
- **Desktop from source:** `npm run desktop`.
- **Standalone app:** `npm run desktop:package` builds `release/Reviewer-darwin-arm64/Reviewer.app` on Apple Silicon or `release/Reviewer-darwin-x64/Reviewer.app` on Intel. Move it to Applications and start it from the Dock or Spotlight.
- **DMG:** `npm run desktop:dmg` builds the same app and packages it as `release/Reviewer-<version>-darwin-<arch>.dmg`. Open the image, drag Reviewer.app to Applications, eject the image and launch the installed app. Quit Reviewer before replacing it with a newer build.

Build on a Mac of the same architecture. The first build downloads Electron, the official Node.js 24 LTS (verified against its SHA-256 checksum) and the server's production dependencies; they ship inside the app, so it needs no system Node.js, npm or sources. Git and the GitHub CLI must be installed separately, and GitHub and Codex sign-ins come from the user's existing setup. The native Codex CLI is already part of the server dependencies.

The DMG uses the built-in `hdiutil` utility, HFS+ and UDZO compression. It contains Reviewer.app and an Applications symlink. Temporary staging preserves the app's permissions and symlinks; failed image creation keeps the previous DMG intact. No Apple credentials are needed. Developer ID signing and notarization are not configured, so a downloaded build may require **System Settings → Privacy & Security → Open Anyway** on first launch; see [Apple's instructions](https://support.apple.com/en-gb/102445). The source installer remains available when an exception cannot be granted.

## Build verification and CI

```sh
npm run desktop:dmg
npm run desktop:dmg:smoke
# Explicit paths are supported too:
npm run desktop:dmg:smoke -- --image /path/to/Reviewer.dmg
npm run desktop:smoke -- --app /path/to/Reviewer.app
```

The image smoke check verifies its checksum, mounts it read-only, checks the Applications link, executable permissions and framework symlinks, copies Reviewer.app into a temporary installation folder and ejects the image. It then checks the copied app's contents and backend with an isolated database: bundled Node.js, SQLite, Java and Kotlin indexing, a native terminal over WebSocket, Codex CLI startup and reuse of the running service. It rejects duplicate UI dependencies, foreign terminal binaries and unused WASM grammars. It makes no model or GitHub requests and leaves the user's Applications and data folders untouched. `desktop:smoke` without arguments still checks the app in its usual release folder.

The **macOS DMG** GitHub Actions workflow runs manually or on `v*` tags, building natively on `macos-15` (arm64) and `macos-15-intel` (x64). Each job runs the image smoke check and uploads its DMG and SHA-256 file as a separate artifact, retained for 30 days. It does not create or publish GitHub Releases. After downloading and unzipping an artifact, use `shasum -a 256 -c <filename>.dmg.sha256` in its folder to verify the download.

Before distributing a build, also check the GUI: install through Finder, eject the DMG, launch from Applications, choose a repository, close and reopen the window, and quit the app. A replacement app should reopen the same review history.

## Package contents and size

The server build's esbuild import graph determines its runtime dependencies. `desktop/runtime-package.ts` also includes packages loaded through `createRequire` or `require.resolve`: node-pty, the Java/Kotlin grammars and Codex CLI. The build creates a runtime manifest and a copy of the project lock with those installation roots, retaining locked versions, integrity hashes and overrides. `npm ci` installs only that runtime; React, Swagger UI, fonts and other interface dependencies are already bundled by Vite.

After installation, the build keeps only `node-pty/prebuilds/darwin-<arch>` and the Java/Kotlin grammar WASMs. It preserves package licenses and fixes the terminal helper's execute bit. The cache fingerprint includes the runtime manifest, lock, architecture and packaging revision. Increase that revision when expanding retained assets so an older, pruned cache is reinstalled. The UI directory is replaced on every build to remove obsolete hashed assets.

Build output reports logical sizes for the runtime, UI, app and DMG; framework symlinks are not counted twice. Measured on Apple Silicon with Electron 45.0.0 and Node.js 24.22.2:

| Component | Previous v0.1.2 build | v0.1.3    |
| --------- | --------------------- | --------- |
| Runtime   | 723.4 MiB             | 474.1 MiB |
| UI        | 6.2 MiB               | 3.3 MiB   |
| App       | 981.1 MiB             | 729.0 MiB |
| DMG       | 389.4 MiB             | 315.4 MiB |

The DMG is about 19% smaller. Most of the remaining size is the required Codex CLI, Electron and standalone Node.js. Sizes can change with dependency versions and architecture; compare measurements using the same build environment.

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

Update the sources or the app after analyses have finished. The file lock protects startup, but it does not replace a backup of the data folder before deleting or moving it.
