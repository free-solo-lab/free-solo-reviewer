# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: the **Security** tab → **Report a vulnerability** in this repository. Include steps to reproduce, the affected version or commit and the possible impact.

We will acknowledge the report within a few working days and share a plan for the fix. Fixes are released for the latest version on the `main` branch.

## Supported versions

Only the latest commit on `main` receives fixes. Run the installer again, or `git pull` and rebuild, to update.

## Threat model

Reviewer is a local, single-user application. Its security boundaries are:

- **Network access.** The server listens on `127.0.0.1` only, accepts only a localhost `Host` header and its own `Origin`, rejects cross-site requests and state-changing requests without `application/json`, and serves a strict CSP.
- **PR code is never run.** Snapshots are built by reading Git objects; hooks and `core.fsmonitor` are disabled for every `git` call, symbolic links are not followed, and secrets (`.env`, keys, `.ssh`, `auth.json` and similar) are left out of snapshots.
- **Codex analysis** runs in a `read-only` sandbox without network access, with an empty environment and a separate temporary `HOME`; credentials are copied there only for the duration of a request.
- **Codex fixes** can write only to the repository's working folder (`workspace-write`) and only after an explicit action of the user.
- **GitHub.** Nothing is published without pressing **Send review**; requests go through the signed-in `gh`, per repository or per current user.
- **Feedback.** **Settings → Issues** publishes only what the user writes and sends, as a public issue under their own GitHub account. Technical details are opt-in and hold the operating system, Node.js and interface language, never code or repository names.
- **Sign-ins.** Reviewer stores no tokens. GitHub accounts stay in `gh`; **Connect Codex** runs the bundled `codex login`, which writes `~/.codex/auth.json`, and an API key reaches it through stdin, never through command arguments or logs.
- **Desktop.** The Electron window runs with `sandbox` and `contextIsolation` and without Node.js in the renderer; external links open in the system browser.

Out of scope: other processes running as the same OS user, and content the user sends to the model on purpose (the code of the selected repositories is sent to OpenAI — see the README).
