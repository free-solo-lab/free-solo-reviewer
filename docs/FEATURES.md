# Features and internals

A detailed tour of the interface and of how Reviewer works. For installation and a quick start, see the [README](../README.md).

## Overview

**What changes** renders descriptions as Markdown: paragraphs, headings, lists, tables and highlighted code blocks. The model follows a fixed structure — summary, notable changes and what needs checking; for scenarios — goal, flow, behavior change, errors and limitations. Older plain-prose descriptions are split into headings and lists on display without changing the saved analysis.

The secondary menu switches between the overall **What changes** page and individual scenarios. A scenario opens as its **Description**, **Code** — the changed methods it touches, each with its diff, comments and navigation — or **Diagram**.

## Sequence diagrams

Scenarios are listed in the secondary menu with search and a service filter. The diagram fills the rest of the window and scrolls inside itself. **Internal calls** in the diagram toolbar collapses or expands the internal calls of all services; choosing a scenario starts at the top of its diagram.

Participant names stay pinned while scrolling vertically, so services and their nested classes remain visible; horizontal scrolling moves the headers and lifelines together. The same applies to test diagrams. Clicking a class card opens the whole file in **Code and review**; service cards change the level of detail.

One repository is one service; a session holds one PR per repository and up to eight repositories. Returns are kept apart from calls and never form false cycles; real cycles are grouped with strongly connected components.

The database is a separate logical participant of its service. When a SQL step points to a chain through several local services, the interface restores the intermediate calls only when there is a single confirmed path through call sites of the same code version; ambiguous calls are never guessed. For saved analyses, database access is restored from the method index without asking Codex, and such links are marked as assumptions. Migrations are not added to runtime scenarios.

Internal classes of a service have their own dashed lifelines under the service header; arrows connect classes, and SQL goes from the repository to the database. Self-calls within one class are hidden.

The scenario catalog is checked against the affected entry points: handlers, controllers and background jobs. If some entry points have no scenario, the analysis is marked partial. **Complete scenarios** asks only for the missing chains and keeps existing scenarios, remarks and comments.

Before returning a result, Codex is required to verify every call chain against the sources and the index: the entry, local delegation, client wrappers, database queries, branches and returns. Missing context stays an explicit unknown. This is a consistency check of a static analysis, not runtime verification.

## Code and review

The secondary menu shows every repository of the review as its own root: services, protocols and context repositories without a PR. All text files of the snapshot and files removed by the PR are available, with a folder tree, search, statuses and change counters. **Changed files only** hides unchanged files; viewed files can be hidden and files filtered by extension.

The viewer shows the full source with added (`+`, green) and removed (`−`, red) lines. Removed lines keep their original numbers, and a comment on them is anchored to the `base` side, including renamed files. Dragging across line numbers selects a range for a comment (the view scrolls at the window edge); Shift-click works too. Comments appear under their range in every code view, including tests and jumps from diagrams.

⌘-click (Ctrl-click elsewhere) on a called method opens its definition in the same pinned version of the repository. Overloads and unresolved receivers show a choice. **Back** and **Forward** restore the line, scroll position and unsaved comment; ⌘[ / ⌘] and Alt+← / Alt+→ work too. Navigation uses the syntax index, not full JVM type resolution.

**Viewed** marks are stored in SQLite and tied to the PR, the path and the content hash: a new SHA with the same content keeps the mark, a changed file becomes unviewed again. Methods can be marked separately.

Drafts are saved to SQLite automatically after a short pause; a browser backup restores changes if the page reloads before the server answers. Restoring is limited to the same session, snapshot and head SHA.

## Publishing a review

Each PR gets its own decision: Comment, Request changes or Approve. The preview shows the selected comments, the commit and the GitHub account the review is sent as; only the send button publishes. Inline comments go to added or removed lines of the right PR, other remarks join the overall text, and the review always carries an explicit `commit_id`.

The GitHub CLI needs read access to the repository and permission to publish pull request reviews (`Contents: read`, `Pull requests: write` for fine-grained tokens). GitHub does not allow approving or requesting changes on your own PR, and approving requires explicit access to the repository.

If GitHub does not confirm the outcome of a submission, publishing again is blocked until it is verified: **Verify with GitHub** looks for the submission among your reviews instead of blindly posting again. When GitHub definitely rejects a review (HTTP 4xx), the reason is shown and the draft becomes editable again.

## PR updates and follow-up reviews

A changed PR blocks publishing. **Update the PR** first compares the PR metadata: without new commits or replies the current analysis stays and the model is not called. Otherwise a follow-up analysis covers the diff from the previously reviewed head to the new one, the earlier remarks and the new GitHub replies. Replies without code changes refresh the discussion and keep the finished review.

Snapshots, analyses and drafts of earlier reviews are kept in the version history. The overview gains a **Changes since the review** block with changed files, replies and the status of earlier remarks. Fix statuses are the model's assessment with references to the current code; an item without an answer keeps the **Check** status. The original description is kept word for word, and unchanged conclusions carry over only after their sources are compared. Comment texts move into the new draft; when the head changes, their anchors are reset for a manual recheck.

## Transactions

Transactional scopes of annotated methods are drawn as frames on the diagram. The label shows the propagation, the tooltip the rollback rules, limitations and a link to the code. REQUIRED means joining an outer transaction or starting a new one; SUPPORTS and MANDATORY are shown as conditional, NOT_SUPPORTED and NEVER as scopes without a transaction. Possible self-invocation is marked as an unconfirmed boundary. Frames are rebuilt from the index without an LLM and do not mean an observed BEGIN or COMMIT; class-level annotations are not yet taken into account.

A frame covers the `@Transactional` method and confirmed calls of its methods and repositories; only the involved classes and the database take part, not the whole service.

Programmatic jOOQ transactions (`DSLContext.transaction`, `transactionResult`, `transactionAsync`, `transactionResultAsync`, `transactionPublisher`) are recognized in Java and Kotlin by the AST and the declared `DSLContext` type. The frame covers the inline callback, including database access through helper methods of the same bean. Nested scopes are shown separately with a note on the TransactionProvider and savepoints. For async and reactive code, the end of the callback is not treated as a commit. Method references, custom wrappers and arbitrary `DSLContext` aliases are not rebuilt yet.

## SQL

Clicking an arrow to the database opens a panel with SQL from the saved analysis. The model rebuilds parameterized queries from jOOQ, ORM and JDBC code, configuration and helper methods; the server checks the structure and the source references. Variants of a dynamic query are shown separately, each with its bind parameters and unknown parts. Opening the panel never runs the model, the PR code or SQL.

Model SQL **is not a confirmed runtime trace**: generated fields, settings, ORM mapping and parameters can change the final query. When context is missing, the model returns the reason instead of an invented query. **Complete SQL with Codex** asks only for methods without saved queries and never overwrites the others.

Actual SQL can be imported as JSON from a jOOQ `ExecuteListener` or Hibernate `StatementInspector` trace (the SQL panel shows the format). The SHA and method coordinates are checked; Reviewer cannot vouch for the origin of an uploaded log and never runs SQL.

## Database

The **Database** section opens in **Code**: the SQL of every migration the PR adds, changes or removes, whole, with its diff and comments. **Model** shows tables, columns with types and nullable/PK/FK flags, indexes and foreign keys from the SQL migrations of the pinned snapshots. Comparing the merge base with the head highlights added, removed and changed tables, columns, indexes and relations. Unrelated tables are laid out in rows of up to four columns, linked tables stay together, and the model opens fitted to the window; zoom with the controls in its corner or with Ctrl/Cmd and the mouse wheel. Clicking a table opens the DDL of its migration.

The secondary menu lists the service's migrations with search, Flyway versions and PR change marks; choosing one narrows both views to it. INSERT, UPDATE, DELETE and TRUNCATE are marked as data changes.

Extraction supports CREATE TABLE/INDEX, keys, constraints, the main ALTER COLUMN/ADD/DROP forms and DROP TABLE/INDEX. Dynamic and unsupported DDL is reported as an incomplete schema. The schema is rebuilt from migrations in file-name order, not read from a running database; migrations are never executed.

## Tests

Tests are grouped by scenario; ambiguous checks are grouped by test class. Each test opens as its **Description** (summary and steps with the data they prepare or check), **Code** (the whole test method with diff and comments) or **Diagram** (setup, mocks, explicit calls and assertions). The internal graph of production methods is not expanded.

Completeness is checked against the annotated test methods of the snapshot; a parameterized method counts as one test. Missing tests are requested in batches of ten, each batch saved as it arrives. Tests are never run: pass/fail and coverage are not claimed.

## Review requests

**Review requests** at the bottom of the sidebar lists open PRs that request a review from the current GitHub user or one of their teams, grouped by repository. Requests without activity for two weeks are folded away and not counted. **Start review** creates a review of the PR in a connected repository, or asks for the folder of a local clone first. Lists are cached per user, so switching users in the bottom-left menu is instant.

## Settings

- **Language** — English or Russian for menus, messages and the prose Codex writes. Prompts are in English and receive the language as `{{language}}`; logs and markers saved in another language are still recognized.
- **Analysis stages** — change descriptions, scenario completion, SQL and test descriptions can be turned off. A skipped stage is remembered on the run, does not make the analysis partial and is never cached as a complete result.
- **Analysis prompts** — edit, save and restore each template; a run that was interrupted continues with the template it started with.
- **Analysis statistics** — stages, requests, duration and tokens of every run; older runs are reconstructed approximately from their logs.

## Architecture

- **React and Vite** — the interface, SVG sequence diagrams, a local Swagger UI and syntax highlighting (Java, Kotlin, SQL, TypeScript, YAML and more).
- **Fastify** — a local JSON API with SSE progress. Loopback only, Host and Origin checks, JSON for every state-changing request, a strict CSP.
- **SQLite** (`node:sqlite`) — repositories, sessions, results, the index per SHA, drafts, settings and submission state. After a restart, an unfinished analysis is marked interrupted and a submission uncertain.
- **Git** — fetching PR objects and reading text files of the merge base and head. Branches and working files are not touched; only objects and `FETCH_HEAD` are updated. Hooks and `core.fsmonitor` are disabled for every Git call.
- **Tree-sitter** — syntax parsing of Java and Kotlin: methods, annotations and call sites. This is not full type resolution.
- **Codex SDK** — structured JSON matching a shared Zod schema (`shared/model.ts`). The server checks that files and line ranges exist and drops unconfirmed references.
- **GitHub** — `gh api` with the user's credentials, per repository or per current user.
- **i18n** — English source texts with catalogs in `shared/locales/`; the server and the interface share one language setting.

The index cache is keyed by SHA, side and analyzer version. Verified model results are cached by the set of SHAs, PR metadata, analyzer version, provider and model; an analysis of the same version is never repeated. After a Codex error, a new attempt makes a new request: failed answers never reach the cache.

`AnalysisProvider` in `server/provider.ts` lets you plug in another model while keeping the artifact format and evidence checks.

## Deleting a review

Hover a review in the sidebar and press the trash icon. The local session, analysis history, drafts, code snapshots, Codex fix context and cached results not used by other reviews are deleted. The PR and comments published on GitHub are not changed. Stop a running analysis and verify an unfinished submission first.

## HTTP API

The server listens on `127.0.0.1` only. Every state-changing request requires `Content-Type: application/json`. Request and response types live in `shared/model.ts`.

| Method     | Path                                             | Purpose                                      |
| ---------- | ------------------------------------------------ | -------------------------------------------- |
| `GET`      | `/api/health`                                    | Server liveness                              |
| `GET`      | `/api/status`                                    | GitHub sign-in and model configuration       |
| `GET`      | `/api/runtime`                                   | Identity of the running server               |
| `GET`      | `/api/repositories`                              | Connected repositories                       |
| `POST`     | `/api/repositories`                              | Connect a local repository by path           |
| `POST`     | `/api/repositories/pick-directory`               | System folder picker                         |
| `GET`      | `/api/repositories/:id/pulls`                    | Open PRs of a repository                     |
| `PUT`      | `/api/repositories/:id/github-user`              | GitHub account of a repository               |
| `GET`      | `/api/github/accounts`                           | `gh` accounts and the current user           |
| `PUT`      | `/api/github/current`                            | Switch the current GitHub user               |
| `GET`      | `/api/github/review-requests`                    | Open PRs waiting for a review (`login`)      |
| `GET,POST` | `/api/github/login`                              | Add a `gh` account with a one-time code      |
| `POST`     | `/api/github/login/cancel`                       | Cancel the sign-in                           |
| `GET`      | `/api/sessions`                                  | List of reviews                              |
| `POST`     | `/api/sessions`                                  | Create a review with Git snapshots           |
| `GET`      | `/api/sessions/:id`                              | Snapshots, analysis and version history      |
| `DELETE`   | `/api/sessions/:id`                              | Delete a review and its local data           |
| `POST`     | `/api/sessions/:id/refresh`                      | Check the PR for new commits and replies     |
| `POST`     | `/api/sessions/:id/analyze`                      | Start or continue the analysis               |
| `POST`     | `/api/sessions/:id/scenario-analysis`            | Complete missing scenarios                   |
| `POST`     | `/api/sessions/:id/sql-analysis`                 | Complete SQL                                 |
| `POST`     | `/api/sessions/:id/test-analysis`                | Complete the test analysis                   |
| `POST`     | `/api/sessions/:id/analysis-message`             | Add a note to the running analysis           |
| `POST`     | `/api/sessions/:id/cancel`                       | Cancel the analysis                          |
| `GET`      | `/api/sessions/:id/events`                       | SSE progress with `Last-Event-ID` support    |
| `GET`      | `/api/sessions/:id/source`                       | A snapshot file (`repoId`, `side`, `path`)   |
| `GET`      | `/api/sessions/:id/navigation-index`             | Methods and call sites for navigation        |
| `GET`      | `/api/sessions/:id/code-comparison`              | A file compared with an earlier review       |
| `GET`      | `/api/sessions/:id/database-schema`              | Database schema from migrations              |
| `GET`      | `/api/sessions/:id/sql-preview`                  | SQL of a method from the saved analysis      |
| `POST`     | `/api/sessions/:id/sql-capture`                  | Import actual SQL from a trace               |
| `GET,PUT`  | `/api/sessions/:id/viewed-files`                 | “Viewed” marks of files                      |
| `GET,PUT`  | `/api/sessions/:id/viewed-methods`               | “Viewed” marks of methods                    |
| `GET`      | `/api/sessions/:id/discussion`                   | PR discussions from GitHub                   |
| `POST`     | `/api/sessions/:id/discussion/replies`           | Reply in a discussion thread                 |
| `PUT`      | `/api/sessions/:id/discussion/reactions`         | React to a comment                           |
| `GET`      | `/api/sessions/:id/drafts`                       | Drafts per PR                                |
| `PUT`      | `/api/sessions/:id/drafts/:snapshotId`           | Save a draft                                 |
| `POST`     | `/api/sessions/:id/drafts/:snapshotId/submit`    | Publish a review on GitHub                   |
| `POST`     | `/api/sessions/:id/drafts/:snapshotId/reconcile` | Verify a submission with GitHub              |
| `GET,POST` | `/api/sessions/:id/fix-chat`                     | Fix chat with Codex: plan, apply or one step |
| `POST`     | `/api/sessions/:id/fix-chat/respond`             | Answer a Codex question or approval request  |
| `POST`     | `/api/sessions/:id/fix-chat/cancel`              | Stop the fixes                               |
| `GET,PUT`  | `/api/sessions/:id/working-file`                 | Read or save a file of the working folder    |
| `POST`     | `/api/sessions/:id/checkout`                     | Switch the working folder to the PR branch   |
| `GET,PUT`  | `/api/settings/language`                         | Interface and response language              |
| `GET,PUT`  | `/api/settings/steps`                            | Optional analysis stages turned off          |
| `GET`      | `/api/settings/prompts`                          | Prompt templates                             |
| `PUT`      | `/api/settings/prompts/:id`                      | Save or restore a prompt template            |
| `GET`      | `/api/settings/statistics`                       | Analysis runs                                |
| `GET`      | `/api/settings/statistics/:id`                   | Stages and requests of one run               |
