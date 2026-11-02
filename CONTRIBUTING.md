# Contributing

Thanks for your interest in Reviewer! Issues and pull requests are welcome.

## Setup

```sh
nvm use          # Node.js from .nvmrc
npm ci
npm run dev      # UI on http://127.0.0.1:5173, API on port 4318
```

`npm run demo` starts the app with synthetic repositories, without GitHub or Codex.

## Before opening a pull request

```sh
npm run typecheck
npm test
npm run format:check
npm run build
```

CI runs the same checks, plus `shellcheck` for `scripts/` and a [gitleaks](https://github.com/gitleaks/gitleaks) scan of every commit for tokens and keys.

Keep test data synthetic: no real repository, organization or account names, no code from private projects. Commit with your GitHub `noreply` address (**Settings → Emails → Keep my email addresses private**) if you do not want your email in the public history.

## Conventions

- **Layout.** `server/` is Node.js only, `web/` is browser only, and `shared/` holds pure functions and types without environment dependencies. Logic needed on both sides belongs in `shared/`.
- **Reuse.** Look for an existing helper before adding one: `shared/errors.ts` (error messages), `shared/patch.ts` (unified diff parsing), `shared/i18n.ts` (texts), `server/process.ts` (`command`, `git`, `AppError`).
- **API errors** are thrown as `AppError(message, status)`.
- **External processes** run only through `command` / `git` with an argument array, never through a shell. Validate user values that reach Git arguments and separate them with `--` or `--end-of-options`.
- **Paths** from requests are resolved through `safePath`.
- **Tests.** Cover new behavior with a test in `tests/`, using temporary Git repositories and fake `GitHubGateway` / `AnalysisProvider` implementations, without network access.
- **Formatting** is Prettier (`npm run format`).
- **Comments** explain why, not what.

## Texts and languages

Every text a user sees is written in English in the code and wrapped in `t()` from `shared/i18n.ts`:

```ts
t('Analysis finished: {0}.', state); // placeholders are {0}, {1}…
tc('migration', 'Added'); // a context when one English text needs different translations
plural(count, 'changed file', 'changed files');
```

Translations live in `shared/locales/`, one catalog per language, keyed by the English text; plural entries hold the language's own forms under `"one|other"`. To add a message, add its translation to every catalog. To add a language, add it to `LANGUAGES` in `shared/i18n.ts` and create its catalog.

Prompts for the model are always in English and receive the chosen language as `{{language}}`. Text saved in one language is read back after the language changes, so code that recognizes a saved message uses `startsLike()` or `inAllLanguages()` rather than comparing with the current translation. A test fails if non-English text appears in the source outside the catalogs.

Tests run in Russian (see `vitest.config.ts`), which also checks the Russian catalog; `tests/i18n.test.ts` covers English.

## Reporting vulnerabilities

Please do not report them in public issues — see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
