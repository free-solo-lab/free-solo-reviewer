# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/); the README explains [what each part of the version means](README.md#versions).

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

[0.1.3]: https://github.com/free-solo-lab/free-solo-reviewer/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/free-solo-lab/free-solo-reviewer/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/free-solo-lab/free-solo-reviewer/compare/v0.1.0-alpha.1...v0.1.1
[0.1.0-alpha.1]: https://github.com/free-solo-lab/free-solo-reviewer/releases/tag/v0.1.0-alpha.1
