import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Startup files for zsh in the built-in terminal. Each one runs the user's own file of the same
 * name with the user's ZDOTDIR, so their setup works as in any terminal; then completion is
 * turned on if their setup did not do it, so Tab completes git branches, commands and options.
 * Nothing in the user's home changes, and other terminals are not affected.
 */
const userFile = (name: string) => `if [[ -f "$REVIEWER_USER_ZDOTDIR/${name}" ]]; then
  REVIEWER_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$REVIEWER_USER_ZDOTDIR"
  source "$REVIEWER_USER_ZDOTDIR/${name}"
  REVIEWER_USER_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$REVIEWER_ZDOTDIR"
fi
`;
const files: Record<string, string> = {
  '.zshenv': userFile('.zshenv'),
  '.zprofile': userFile('.zprofile'),
  '.zshrc': `${userFile('.zshrc')}if (( ! $+functions[compdef] )); then
  autoload -Uz compinit && compinit -i -d "$ZDOTDIR/.zcompdump"
fi
`,
  // The last startup file of a login shell: from here on zsh uses the user's own folder again.
  '.zlogin': `${userFile('.zlogin')}ZDOTDIR="$REVIEWER_USER_ZDOTDIR"
unset REVIEWER_ZDOTDIR REVIEWER_USER_ZDOTDIR
`,
};

/** The environment that makes a zsh start with completion; other shells start unchanged. */
export function shellIntegration(
  shell: string,
  dir: string,
  env: Record<string, string>,
): Record<string, string> {
  if (basename(shell) !== 'zsh') return {};
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(dir, name), content, { mode: 0o600 });
  return { ZDOTDIR: dir, REVIEWER_USER_ZDOTDIR: env.ZDOTDIR || env.HOME || '' };
}
