import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { highlightLines, highlightDiff, languageForPath, sqlLanguage } from '../web/syntax';
import { CodeBlock } from '../web/Code';

const textOf = (lines: ReturnType<typeof highlightLines>) =>
  lines.map((line) => line.map((t) => t.text).join('')).join('\n');
describe('syntax rendering', () => {
  it.each([
    ['Order.java', 'public class Order { private String id = "order"; }'],
    ['Order.kt', 'data class Order(val id: String = "order")'],
    ['query.sql', "SELECT id FROM orders WHERE status = 'pending';"],
    ['client.ts', 'export async function charge(id: string): Promise<void> { return; }'],
    ['app.py', 'def create_order():\n    return "order"\n'],
    ['openapi.yaml', 'openapi: 3.0.3\ninfo:\n  title: Orders'],
    ['pom.xml', '<project><version>1.0</version></project>'],
    ['package.json', '{"name":"orders","private":true}'],
    ['Dockerfile', 'FROM node:24\nRUN npm ci'],
  ])('highlights %s without changing source text', (path, source) => {
    const lines = highlightLines(source, languageForPath(path));
    expect(textOf(lines)).toBe(source);
    expect(lines.flat().some((t) => t.className.startsWith('hljs-'))).toBe(true);
  });
  it('carries multi-line comments and strings across line boundaries, including blank lines', () => {
    const source = '/* first\n\nlast */\nString value = "text";\n';
    const lines = highlightLines(source, 'java');
    expect(textOf(lines)).toBe(source);
    expect(lines).toHaveLength(5);
    expect(lines[0][0].className).toContain('hljs-comment');
    expect(lines[2][0].className).toContain('hljs-comment');
    const kotlin = 'val query = """\nSELECT * FROM orders\n"""\n';
    expect(textOf(highlightLines(kotlin, 'kotlin'))).toBe(kotlin);
  });
  it('preserves CRLF and escapes untrusted HTML as React text', () => {
    const source = '<img src=x onerror="alert(1)">\r\n<script>alert(1)</script>\r\n';
    expect(textOf(highlightLines(source, 'xml'))).toBe(source);
    const html = renderToStaticMarkup(
      React.createElement(CodeBlock, { text: source, language: 'xml' }),
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;');
    expect(html).toContain('hljs-');
  });
  it('keeps unknown languages and very large files readable', () => {
    const source = '<unknown>\n\n';
    expect(textOf(highlightLines(source, 'not-a-language'))).toBe(source);
    const large = 'a'.repeat(300_001);
    const lines = highlightLines(large, 'java');
    expect(textOf(lines)).toBe(large);
    expect(lines.flat().every((t) => t.className === '')).toBe(true);
  });
  it('highlights deleted and added code separately and preserves comment anchors', () => {
    const patch =
      '--- a/Order.java\n+++ b/Order.kt\n@@ -10,2 +20,3 @@\n-/* removed comment\n-ends */\n+val id: String = "order"\n+// added comment\n+return id\n';
    const rows = highlightDiff(patch, 'Order.kt', 'Order.java');
    const changed = rows.filter((r) => r.kind === 'addition' || r.kind === 'deletion');
    expect(changed.map((r) => [r.left, r.right])).toEqual([
      [10, null],
      [11, null],
      [null, 20],
      [null, 21],
      [null, 22],
    ]);
    expect(changed[0].tokens[0].className).toContain('hljs-comment');
    expect(
      changed[2].tokens.some((t) => t.text === 'val' && t.className.includes('hljs-keyword')),
    ).toBe(true);
    for (const row of changed)
      expect(row.tokens.map((t) => t.text).join('')).toBe(row.text.slice(1));
    expect(rows.at(-1)?.left).toBeNull();
  });
  it('does not carry grammar state across independent diff hunks', () => {
    const rows = highlightDiff(
      '@@ -1 +1 @@\n+/* truncated\n@@ -100 +100 @@\n+return 42;',
      'Order.java',
    );
    const added = rows.filter((r) => r.kind === 'addition');
    expect(added[1].right).toBe(100);
    expect(
      added[1].tokens.some((t) => t.text === 'return' && t.className.includes('hljs-keyword')),
    ).toBe(true);
  });
  it('uses PostgreSQL grammar for dollar-quoted SQL', () => {
    const source = "DO $$\nBEGIN\n  RAISE NOTICE 'ok';\nEND\n$$;";
    const lines = highlightLines(source, sqlLanguage('PostgreSQL 16'));
    expect(textOf(lines)).toBe(source);
    expect(lines.flat().some((t) => t.className)).toBe(true);
  });
});
