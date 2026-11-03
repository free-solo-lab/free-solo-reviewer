import { describe, expect, it } from 'vitest';
import { commandSummary } from '../shared/command-summary';

describe('command summaries in the Codex console', () => {
  it('names the file and lines Codex read instead of its output', () => {
    expect(
      commandSummary(
        `/bin/zsh -lc "nl -ba repo-1/head/woody-api/src/main/java/dev/vality/woody/api/proxy/MethodCallInterceptors.java | sed -n '40,47p'"\n    40  private static void`,
      ),
    ).toBe('Чтение MethodCallInterceptors.java, строки 40–47');
    expect(commandSummary(`/bin/zsh -lc '/bin/cat manifest.json'`)).toBe('Чтение manifest.json');
    expect(commandSummary(`/bin/zsh -lc "/usr/bin/sed -n '1580,1854p' docs/a.json"`)).toBe(
      'Чтение a.json, строки 1580–1854',
    );
    expect(
      commandSummary(
        `/bin/zsh -lc 'if [ -f previous-review.json ]; then cat previous-review.json; fi'`,
      ),
    ).toBe('Чтение previous-review.json');
  });
  it('describes searches and listings', () => {
    expect(
      commandSummary(`/bin/zsh -lc "rg --files -g 'previous-review.json' -g 'AGENTS.md'"`),
    ).toBe('Поиск файлов: previous-review.json, AGENTS.md');
    expect(commandSummary(`/bin/zsh -lc "/opt/codex-path/rg -n 'postgres' repo-1/head/src"`)).toBe(
      'Поиск «postgres» в src',
    );
    expect(
      commandSummary(`/bin/zsh -lc "/usr/bin/grep -n -E 'V19__|Query.java' changes.json"`),
    ).toBe('Поиск «V19__|Query.java» в changes.json');
    expect(commandSummary(`/bin/zsh -lc '/usr/bin/which rg; /bin/ls repo-1/head'`)).toBe(
      'Список файлов: head',
    );
  });
  it('falls back to a short command line for anything else', () => {
    expect(commandSummary(`/bin/zsh -lc 'npm test -- --run'`)).toBe('npm test -- --run');
    expect(commandSummary(`x`.repeat(200))).toHaveLength(88);
  });
});
