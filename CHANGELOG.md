# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/); the README explains [what each part of the version means](README.md#versions).

## [Unreleased]

## [0.3.0] — 2026-11-05

A minor release: a live log of the app's errors, GitHub-style folding of unchanged code and fixes to transactions and SQL on the interaction diagram. No changes to the data format.

### Added

- A **Logs** tab next to Codex and Terminal shows the app's diagnostic journal live: failed API requests, failed `git`/`gh`/`codex` commands with their exit code and error output, analysis failures, server crashes and warnings, interface errors from the browser and the desktop app's launches. It filters by level, searches, copies the shown entries and counts new errors on the tab. Tokens and passwords are redacted, and the same entries now go to `server.log`.
- Like on GitHub, the code view folds unchanged code more than three lines away from a change behind a `@@ … @@` bar. Its arrows reveal 20 lines towards the change below or above, or the whole gap when it is short; the bar at the start or end of a file offers one direction. Unchanged methods fold away with their headers; changed methods, comments, the selection and the opened line stay visible. Editing and a scenario's method view show every line.

### Changed

- **Report a problem…** moved from **Settings → Issues** to the user menu and opens as a popup with the report form and your issues with their replies; the new-reply badge moved there as well.
- The desktop app checks for updates every 30 minutes instead of every six hours.

### Fixed

- A transaction frame on the interaction diagram stays open until the transactional method returns, including the queries of a DAO `Impl` injected through its interface, instead of breaking into several frames.
- A query step on the diagram always opens the SQL window rather than the method code. Queries of `*DaoImpl` classes and jOOQ calls through `getDslContext()` are recognized, so SQL is generated for them, and the generate button is available in the range comparison view too.

## [0.2.1] — 2026-11-03

Improved macOS application signing, startup diagnostics and shutdown reliability. No changes to the data format.

### Added

- Native desktop failure dialogs with log access and credential-redacted diagnostic copying; a rotating `desktop.log`, renderer/server failure reporting, and app-menu shortcuts for logs, diagnostics and the running application in Finder.
- A real Electron/React startup smoke check with an isolated profile, in addition to the existing packaged backend checks. Background update checks are disabled only in smoke mode.

### Fixed

- The packaged app is now fully ad-hoc signed, including nested binaries and native modules, instead of retaining the invalid Electron resource seal. Signing errors stop the build, and signatures are checked before packaging and after copying from the image. Developer ID signing and notarization remain separate requirements for Apple-trusted distribution.
- DMGs disable Spotlight indexing and include bilingual installation/replacement instructions. The app name remains Reviewer.app so Finder can replace the installed copy normally.
- DMG creation retains three attempts with a five-minute limit each. Build logs report each attempt's duration and configured limit; command errors preserve exit codes, termination signals and timing even when stderr is empty.
- GUI smoke checks require the application shell and reject startup error screens. Desktop shutdown waits for its owned server even if diagnostics fail, escalating a stuck server after ten seconds; failures to open the logs folder show a recoverable native message.

## [0.2.0] — 2026-11-03

A minor release: the app updates itself from now on, and the review shows your decisions on the timeline. No changes to the data format; install this version by hand once, later ones arrive by themselves.

### Added

- The desktop app updates itself: it checks the signed `latest.json` of the latest GitHub release, downloads the new version in the background and installs it with **Restart and update** from a banner or **Settings → About**. The database is copied before a minor release, and a failed swap puts the old app back.
- A tag publishes the GitHub release with both DMGs, update archives and the signed manifest.
- The timeline marks each version you reviewed: a green check for an approval, a purple message for comments only, an orange cross for requested changes, and an orange refresh on the current version when the code changed after your approval. The review list shows **approved** and **review again** states.
- A click on any earlier point of the timeline, or on the bare line, moves the comparison start there.

### Changed

- The Codex console is one log of the analysis and the fixes that opens at the end and follows new entries. Commands are one line saying what they did, such as “Read MethodCallInterceptors.java, lines 40–47”, instead of their output. Fixes open as a dialog from the review instead of a second view of the panel.
- An icon in the Codex tab shows whether Codex works, waits for you, failed or is done, instead of the stage and PR line.

### Fixed

- The packaged runtime installs only server packages even with npm versions that install every entry of a lock; the DMG smoke check no longer fails on React.

## [0.1.3] — 2026-11-03

macOS DMG distribution and smaller desktop packages. No changes to the data format or settings.

### Added

- `npm run desktop:dmg` creates a macOS disk image with Reviewer.app and an Applications shortcut for installation by dragging the app into Applications.
- Manual and tag-triggered GitHub Actions builds for Apple Silicon and Intel, with verified DMG artifacts and SHA-256 checksums.
- `npm run desktop:dmg:smoke` checks installation from an image; `desktop:smoke -- --app <path>` checks an explicit installed copy with isolated data and no model requests.

### Changed

- Desktop packages install only server dependencies from the existing lock file. The already-bundled React interface no longer brings a second copy of its npm dependencies into the app.
- Desktop packages retain only the target macOS architecture of node-pty and the Java/Kotlin WASM grammars. Build output reports runtime, UI, application and DMG sizes.

### Fixed

- Repeated desktop builds replace the previous UI assets instead of accumulating obsolete bundles.

## [0.1.2] — 2026-11-03

A patch release: fixes only, no new features and no changes to the data format. Update without preparation.

### Fixed

- Errors in the corner are no longer hidden behind other notices: the notices stack, and the floating “Descriptions awaiting an update” panel is removed.
- **Send review** is disabled for an empty review with **Comment** or **Request changes**, and the dialog says to add a comment or choose **Approve**, instead of an error from GitHub after sending.
- The arrow in the base branch picker of a local review points from the reviewed branch to the base, as in a GitHub pull request.

## [0.1.1] — 2026-11-02

A patch release: fixes and dependency security updates only, no new features and no changes to the data format. Update without preparation.

### Fixed

- Sending a review no longer adds a comparison point on the same code, so **Code and review** keeps showing the changes instead of “Since the last review · 0 files”. The sent review becomes a point once the PR gets new commits.
- If the author pushed before **Send**, the new commits and replies are pulled in as a new point, and the comments are carried over for a check before sending again, instead of an error asking to refresh by hand.
- Codex steps started for a single comment after files changed in the working folder now offer **Continue with the current files**, as a group of selected comments already did.
- `npm ci` in CI: the lock file again lists the platform builds of `tree-sitter`.
- The installer uses the `master` branch, which is now the default branch.

### Security

- `follow-redirects` 1.16.2; patched `glob` for `@fastify/static` and `minimatch` for `@swagger-api/apidom-reference` through scoped `overrides`.

### Added

- The version is shown in **Settings → General → About** and in the tooltip of the alpha badge, with a link to these notes.

## [0.1.0-alpha.1] — 2026-11-02

The first public alpha. Features, the data format and settings may still change.

### Changed since the first internal build

- Reviews open several times faster. The server reads source indexes only when a request needs them, instead of all revisions' indexes on every request; the browser downloads only the indexes of the current analysis and the compared review, in a format about half the size, and prepares code navigation in the background.

### Added

- One-line installer for macOS (`scripts/install-macos.sh`): installs Homebrew, Git, Node.js 24 and the GitHub CLI when missing, builds `Reviewer.app` and puts it into Applications.
- **Connect Codex** in the app: a ChatGPT sign-in with a one-time code or an OpenAI API key, without a terminal.
- A banner on a fresh install that leads to the GitHub and Codex sign-ins.
- **Codex** in the top bar opens the review on a new **Codex steps** tab, where steps are run, skipped or followed up at any time; the chat stays in the bottom panel and the review shows when Codex is waiting for an answer.
- Every comment in the review shows the date and time of its latest action; the history lists the latest first.
- Settings are pages of their own: **General** (language, GitHub and Codex connections, data folder) and **Analysis and prompts**, a scheme of the analysis stages in order with the prompts each one sends; stages are switched on the scheme and prompts open in a panel on the right.
- **Settings → Issues**: feedback of a chosen kind (bug, feature request, improvement, question) becomes an issue of the project from your GitHub account; replies are checked in the background, marked as new and answered in the app.
- Replies and reactions for every reviewer comment on the **Comments** page: line comments, conversation comments and review summaries.
- Secret scanning and `shellcheck` in CI; issue and pull request templates.

[Unreleased]: https://github.com/free-solo-lab/free-solo-reviewer/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/free-solo-lab/free-solo-reviewer/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/free-solo-lab/free-solo-reviewer/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/free-solo-lab/free-solo-reviewer/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/free-solo-lab/free-solo-reviewer/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/free-solo-lab/free-solo-reviewer/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/free-solo-lab/free-solo-reviewer/compare/v0.1.0-alpha.1...v0.1.1
[0.1.0-alpha.1]: https://github.com/free-solo-lab/free-solo-reviewer/releases/tag/v0.1.0-alpha.1
