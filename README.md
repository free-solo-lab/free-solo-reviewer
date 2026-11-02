# Reviewer

[![CI](https://github.com/free-solo-lab/free-solo-reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/free-solo-lab/free-solo-reviewer/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
![Platform: macOS · browser](https://img.shields.io/badge/platform-macOS%20%C2%B7%20browser-lightgrey)
![Node.js 24](https://img.shields.io/badge/node-24%20LTS-339933)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange)

**A local workbench for reviewing pull requests in Java/Kotlin Spring services.**

Reviewer pins the exact code of a pull request, indexes it, asks [Codex](https://github.com/openai/codex) for a structured analysis and ties every claim to the source lines it is based on. You get call sequences across services, transaction boundaries, SQL, database schema changes, API contracts and tests in one place — and you stay in charge of the decision and of what gets published.

> [!WARNING]
> **Alpha version.** Reviewer is in early development: features, data format and settings may change between versions, and some parts are rough. Keep a backup of the data folder if your reviews matter, and please report problems in **Settings → Issues** or on [GitHub](https://github.com/free-solo-lab/free-solo-reviewer/issues).

It runs on your machine as a browser app or a macOS desktop app. The interface is available in English and Russian; Codex writes its descriptions in the language you choose. [Краткая инструкция на русском](README.ru.md).

## Highlights

- **Overview** — a short description of the PR, the affected scenarios and remarks with a risk level. Every statement links to a file, a version and a line range.
- **Sequence diagrams** — calls between services and classes, database access, `@Transactional` scopes and programmatic jOOQ transactions.
- **SQL** — queries rebuilt from jOOQ, ORM and JDBC code, with bind parameters and explicit unknowns.
- **Database** — the schema before and after the PR, built from SQL migrations (Flyway and similar), next to the migration code.
- **Contracts and tests** — changes to OpenAPI, Thrift, Protobuf, GraphQL and ANTLR files; tests with their steps as a description, code and a diagram.
- **Code and review** — project tree, diff, line comments, go-to-definition and “viewed” marks.
- **Follow-up reviews** — after the PR changes, only the delta is analyzed, together with the status of earlier remarks and new replies.
- **Review requests** — every open PR that waits for your review or your team's, across all your GitHub accounts.
- **Before a PR** — review the changes in a working folder against any branch, then let Codex fix the comments step by step.
- **Publishing** — Comment, Request changes or Approve on GitHub, only when you press the button.

See [docs/FEATURES.md](docs/FEATURES.md) for a detailed tour and the HTTP API.

## Your code and your data

- **Code is sent to OpenAI.** For the analysis, changed files and related sources of the selected repositories are read by the model through the [Codex SDK](https://github.com/openai/codex). Do not use Reviewer for code that must not reach an external provider.
- **Everything else stays local** — a SQLite database and code snapshots in the data folder (see [Configuration](#configuration)). The server listens on `127.0.0.1` only and rejects requests from other origins.
- **Nothing is published without you.** A review reaches GitHub only after a preview and an explicit **Send review**.
- **Analysis is read-only.** Codex works in a sandbox on pinned `base`/`head` snapshots with file search and reading only; network access and MCP servers are off, and repository instructions are not loaded. Code is never built or run during the analysis.
- **Secrets are filtered, not guaranteed.** Snapshots skip `.env*`, keys, keystores and secret folders. This is not a substitute for scanning a repository for committed secrets.
- **Fixes are opt-in.** In the **Before PR** mode Codex reads the working folder to draft a plan, and edits files and runs checks only after you press **Start fixing**.

## Install on macOS

Open **Terminal** (Spotlight → “Terminal”), paste one line and press Return:

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/free-solo-lab/free-solo-reviewer/master/scripts/install-macos.sh)"
```

The [installer](scripts/install-macos.sh) works on a clean Mac (Apple Silicon or Intel, macOS 13+). It installs whatever is missing — Homebrew, Git, Node.js 24 and the GitHub CLI — builds **Reviewer.app** from source, puts it into Applications and opens it. Homebrew asks for your Mac password once. The first build takes about five minutes. Run the same line again to update.

From a clone, `./scripts/install-macos.sh` does the same with your checkout.

## Connect GitHub and Codex

Both sign-ins are done in the app. On a fresh install a banner at the top shows the buttons; later they are in the user menu at the bottom left.

**GitHub** — press **Sign in to GitHub**. The one-time code is copied, github.com opens; paste the code and confirm. Repeat with **Add account…** for every other GitHub account, for example a personal and a work one. Each repository can be tied to its own account in **New review**; the account chosen in the menu serves the rest. Reviewer stores no tokens: accounts live in the GitHub CLI (`gh`) and its keychain entry.

**Codex** — press **Connect Codex**, then either:

- **Sign in with ChatGPT** — for a ChatGPT plan that includes Codex. The code is copied and auth.openai.com opens; paste it and confirm.
- **an OpenAI API key** — paste a key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys); usage is billed to that API account.

The sign-in is stored by Codex itself in `~/.codex/auth.json`, the same file `codex login` writes. Reviewer ships its own Codex CLI, so nothing else needs to be installed.

That is all: press **New review**, choose a local clone of a GitHub repository and pick a pull request.

## Other ways to run

### Try it without accounts

The demo creates temporary Git repositories and simulates GitHub and Codex; nothing leaves your machine.

```sh
npm ci
npm run demo
```

Open **http://127.0.0.1:4318**.

### In a browser, from source

Needs Node.js 24 LTS (or 22.13+), Git and the [GitHub CLI](https://cli.github.com/). The folder picker uses the system dialog on macOS and Windows and `zenity` on Linux; a path can always be typed instead.

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4318** and connect GitHub and Codex as above. Terminal sign-ins work as well: `gh auth login` and `npx codex login --device-auth`, or `OPENAI_API_KEY` in the server's environment. Fine-grained GitHub tokens need `Contents: read` and `Pull requests: write`.

### Desktop app from source

- **Run in a window:** `npm run desktop`.
- **Build `Reviewer.app`:** `npm run desktop:package`. The app lands in `release/Reviewer-darwin-arm64/` (Apple Silicon) or `release/Reviewer-darwin-x64/` (Intel) and bundles its own Node.js.

The browser and the desktop app share one server and one review history. Closing the window keeps analyses running; **Open in browser** in the app menu opens the same server. See [desktop/README.md](desktop/README.md) for how the server is shared and where data lives.

## Using Reviewer

1. **Create a review.** Press **New review**, choose a local Git repository (its `origin` must be on github.com) and press **Connect**.
2. **Pick a PR** for each repository you review. Other services can join as context at their current local HEAD.
3. **Press Analyze.** Progress streams into the analysis chat at the bottom; you can stop, add context or continue later.
4. **Explore** the **Overview**, **Contracts**, **Database**, **Tests** and **Code and review** sections. Scenarios and tests switch between **Description**, **Code** and **Diagram**; the database between **Code** and **Model**.
5. **Comment** in **Code and review** by selecting lines in the diff, or add a remark from the analysis to the draft.
6. **Publish** with **Leave a review** → choose Comment, Request changes or Approve → **Review and send** → **Send review**.

When the PR changes, press **Update the PR**: Reviewer analyzes only what changed since your review and shows the status of earlier remarks.

### Reviewing before a PR

1. In **New review**, choose **Before PR · local changes** and a Git folder. No GitHub remote is needed; the repository needs an initial commit.
2. Choose the base: `HEAD` for uncommitted changes only, or `main` / `origin/main` for the branch together with working files. By default Reviewer uses `origin/main` or `origin/master` and refreshes that remote-tracking ref without touching your branch.
3. Leave comments in **Code and review**; they are saved automatically.
4. Open **Fixes with Codex** and press **Draft plan**, refining the task in the same chat if needed.
5. Press **Start fixing**, or run the steps one by one. When Codex needs a decision it pauses and asks; pending questions survive restarts and show up even when the chat is closed.
6. Press **Refresh code in the review** to check the result.

**Codex** in the top bar opens the review on the **Codex steps** tab at any time: run a step with ▶, select several to run together, skip one or follow up on a finished one. The chat itself stays in the bottom panel; when Codex is waiting for an answer, the review shows it with a link to the chat.

### Several GitHub accounts

The current GitHub user is chosen in the menu at the bottom left. It defaults to the active `gh` account, and switching it does not change `gh` itself. A repository can be tied to its own account in **New review** or in the publish dialog. **Add account…** works like `gh auth login --web`: Reviewer copies a one-time code and opens github.com; the same flow refreshes an expired sign-in. If the browser is already signed in to another GitHub account, use a private window for the confirmation.

## Settings

Open the user menu at the bottom left → **Settings**.

- **General** — the interface language, which is also the language Codex writes descriptions and answers in; the GitHub and Codex connections; the data folder.
- **Analysis and prompts** — a scheme of the analysis: its stages in the order they run, what each sends to Codex and which prompts its request is built from. Turn off change descriptions, scenario completion, SQL or test descriptions right on the scheme to save time and tokens; a skipped stage can still be run for one review from its page. Click a prompt to read or edit it in a panel on the right; required `{{variables}}` are filled in by the app.
- **Analysis statistics** — run history with stages, Codex requests, duration and input, cached and output tokens.
- **Issues** — report a bug, request a feature, suggest an improvement or ask a question. It becomes a public issue in [free-solo-lab/free-solo-reviewer](https://github.com/free-solo-lab/free-solo-reviewer/issues) under your GitHub account; replies show up here, with a badge in the user menu until you read them. `REVIEW_FEEDBACK_REPO` points a fork to its own repository.

## Configuration

Environment variables of the server:

| Variable             | Default                        | Purpose                                                        |
| -------------------- | ------------------------------ | -------------------------------------------------------------- |
| `REVIEW_PORT`        | `4318`                         | Port of the local server                                       |
| `REVIEW_STATE_DIR`   | the OS application data folder | Registry of the running server; holds `data/` by default       |
| `REVIEW_DATA_DIR`    | `<REVIEW_STATE_DIR>/data`      | Database and code snapshots (an existing `./.review` is used)  |
| `REVIEW_LANGUAGE`    | the system locale, else `en`   | Language until one is chosen in the settings (`en` or `ru`)    |
| `REVIEW_CODEX_MODEL` | the SDK default model          | Codex model for the analysis                                   |
| `REVIEW_CODEX_BIN`   | the CLI bundled with the SDK   | Explicit path to the Codex CLI                                 |
| `OPENAI_API_KEY`     | —                              | Alternative to **Connect Codex**; takes precedence over it     |
| `CODEX_HOME`         | `~/.codex`                     | Where `auth.json` is read from; no other configuration is used |

In development, Vite proxies `/api` to port 4318; change the proxy in `vite.config.ts` for another port.

## Troubleshooting

- **“GitHub is not connected” at the bottom left** — press **Sign in to GitHub** in the banner or **Add account…** in the user menu.
- **“GitHub CLI is not installed”** — run `brew install gh`, or the installer again.
- **“Codex is not connected”** — press **Connect Codex** in the banner or in the user menu.
- **The app does not open: “Reviewer is damaged” or “cannot be verified”** — happens only with a copy of `Reviewer.app` downloaded from elsewhere, which is not notarized. Build it with the installer instead.
- **Port 4318 is busy** — the demo and the regular server use the same port; run one at a time or set `REVIEW_PORT`.
- **`ExperimentalWarning: SQLite`** in the console is expected: `node:sqlite` is still marked experimental.

## Limitations

- Call sequences and transactions are rebuilt statically from the code; actual execution paths are not confirmed without traces.
- A snapshot holds up to 6000 text files or 64 MB per side, and files up to 1 MB. Model context is capped at 550,000 characters with changes first; truncation is reported in the result.
- SQL is the model's reconstruction with explicit unknowns, not a query captured from a real ORM.
- Several PRs in one review are published separately, without a shared transaction.
- The production audit reports 3 low-severity entries in `swagger-ui-react → swagger-client → deepmerge`, all from [one advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4). No patched `deepmerge` release is available yet. Swagger UI receives only local contracts, and outgoing requests are blocked by the CSP.

## Development

```
server/   Fastify API, analysis, Git, GitHub, Tree-sitter indexer
shared/   data model (Zod schemas), logic shared by server and UI, i18n catalogs
web/      React interface
desktop/  Electron shell and macOS packaging
build/    Vite build plugins
tests/    Vitest suites with real temporary Git repositories; GitHub and the model are faked
docs/     detailed documentation
```

```sh
npm run dev          # UI with hot reload on http://127.0.0.1:5173, API on port 4318
npm run typecheck
npm test
npm run format:check
npm run build
```

`npm run test:codex` runs the real Codex SDK on a small synthetic project; it uses model quota but publishes nothing.

CI checks production dependencies with `npm audit --omit=dev --audit-level=moderate`.
Scoped `overrides` select patched `glob` 14 for `@fastify/static` and `minimatch` 11
for `@swagger-api/apidom-reference` until those packages update their dependency ranges.
These keep the current Fastify and Swagger UI versions; `npm audit fix --force`
would instead downgrade them across major versions. Recheck and remove the overrides
when the parent packages accept the patched versions. Development-only dependencies
are outside this audit gate.

To plug in another model, implement `AnalysisProvider` from `server/provider.ts`. Interface texts are written in English in the code and translated in `shared/locales/`; [CONTRIBUTING.md](CONTRIBUTING.md) explains how to add a message or a language. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE).
