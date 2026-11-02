import type { MethodLink } from '../shared/code-navigation';
import React, { useMemo } from 'react';
import { highlightLines, languageForPath, languageLabels, type CodeLine } from './syntax';
import { t } from '../shared/i18n';

export function CodeTokens({
  tokens,
  links = [],
  onDefinition,
}: {
  tokens: CodeLine;
  links?: MethodLink[];
  onDefinition?: (link: MethodLink) => void;
}) {
  let offset = 0;
  return (
    <>
      {tokens.map((token, i) => {
        const start = offset;
        offset += token.text.length;
        const references = /comment|string|regexp|quote/.test(token.className ?? '')
          ? []
          : links.filter((l) => l.start < offset && l.end > start);
        const pieces: React.ReactNode[] = [];
        let cursor = 0;
        for (const link of references) {
          const from = Math.max(0, link.start - start),
            to = Math.min(token.text.length, link.end - start);
          pieces.push(token.text.slice(cursor, from));
          pieces.push(
            <span
              key={link.start}
              className="method-reference"
              role="link"
              tabIndex={0}
              aria-label={t('Go to definition of {0}', link.name)}
              title={t('⌘-click / Ctrl-click: open {0}. Enter: go to it.', link.name)}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  onDefinition?.(link);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  onDefinition?.(link);
                }
              }}
            >
              {token.text.slice(from, to)}
            </span>,
          );
          cursor = to;
        }
        pieces.push(token.text.slice(cursor));
        return (
          <span className={token.className} key={i}>
            {pieces}
          </span>
        );
      })}
    </>
  );
}
export function CodeLanguage({ path }: { path: string }) {
  return <span className="code-language">{languageLabels[languageForPath(path)]}</span>;
}
export function CodeBlock({ text, language }: { text: string; language: string }) {
  const lines = useMemo(() => highlightLines(text, language), [text, language]);
  return (
    <pre className="sql-code syntax-dark" data-language={language}>
      <code>
        {lines.map((line, i) => (
          <React.Fragment key={i}>
            <CodeTokens tokens={line} />
            {i < lines.length - 1 ? '\n' : ''}
          </React.Fragment>
        ))}
      </code>
    </pre>
  );
}
