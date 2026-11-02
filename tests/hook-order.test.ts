import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );

// A hook after `||`, `&&`, `??` or `?` runs on some renders only; React then fails on the next
// render that calls it, as opening Settings from a review did.
it('calls React hooks unconditionally', () => {
  const conditional = /(\|\||&&|\?\?|[^?]\?)\s*!*\s*use[A-Z]\w*\(/;
  const found = files('web').flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line, i) => (conditional.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
  );
  expect(found).toEqual([]);
});
