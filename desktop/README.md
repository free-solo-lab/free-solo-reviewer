# Reviewer in the browser and on macOS

Both ways of running Reviewer share one React interface (`web/`), one server (`server/`) and one model (`shared/`). Electron in `desktop/` only provides the window, the application menu, the native folder picker, and starting or connecting to the server. In the browser the native adapter is replaced by the regular API.

## Running

- **Browser:** `npm run build`, then `npm start`, and open `http://127.0.0.1:4318`.
- **Desktop from source:** `npm run desktop`.
- **Standalone app:** `npm run desktop:package` builds `release/Reviewer-darwin-arm64/Reviewer.app` on Apple Silicon or `release/Reviewer-darwin-x64/Reviewer.app` on Intel. Move it to Applications and start it from the Dock or Spotlight.

Build on a Mac of the same architecture. The first build downloads Electron, the official Node.js 24 LTS (verified against its SHA-256 checksum) and the production dependencies; they ship inside the app, so it needs no system Node.js, npm or sources. Git and the GitHub CLI must be installed separately, and GitHub and Codex sign-ins come from the user's existing setup. The native Codex CLI is already part of the server dependencies. The build is meant for local use: Developer ID signing, notarization and a `.dmg` are not set up yet.

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
