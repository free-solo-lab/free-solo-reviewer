# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

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
