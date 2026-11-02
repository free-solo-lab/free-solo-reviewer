import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { Markdown } from '../web/Markdown';
const render = (text: string) =>
  renderToStaticMarkup(React.createElement(Markdown, { children: text }));
describe('review Markdown', () => {
  it('renders paragraphs, headings, emphasis, inline code and nested lists', () => {
    const html = render(
      '## Изменения\n\n**Регистрация** через `registerInvoice`.\n\n- Первый шаг\n  - Вложенный шаг\n- Второй шаг',
    );
    expect(html).toContain('<h3>Изменения</h3>');
    expect(html).toContain('<strong>Регистрация</strong>');
    expect(html).toContain('<code>registerInvoice</code>');
    expect(html.match(/<ul>/g)).toHaveLength(2);
  });
  it('renders GitHub tables and strikethrough', () => {
    const html = render('| До | После |\n| --- | --- |\n| ~~Старое~~ | Новое |');
    expect(html).toContain('<table>');
    expect(html).toContain('<del>Старое</del>');
  });
  it('highlights fenced source without nesting pre elements', () => {
    const html = render('```sql\nSELECT id FROM invoice;\n```');
    expect(html).toContain('hljs-keyword');
    expect(html.match(/<pre/g)).toHaveLength(1);
  });
  it('does not execute model HTML, load images or expose script URLs', () => {
    const html = render(
      '<script>alert(1)</script>\n\n[link](javascript:alert%281%29)\n\n![remote](https://example.com/tracker.png)',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('tracker.png');
  });
  it('preserves the old saved plain-text analysis without rewriting it', () => {
    expect(render('Описание без Markdown.')).toContain('<p>Описание без Markdown.</p>');
  });
});
