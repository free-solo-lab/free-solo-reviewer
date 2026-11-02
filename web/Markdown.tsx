import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './Code';

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (/^(https?:|mailto:|#)/i.test(url) ? url : '')}
        components={{
          h1: ({ children }) => <h3>{children}</h3>,
          h2: ({ children }) => <h3>{children}</h3>,
          h3: ({ children }) => <h4>{children}</h4>,
          a: ({ href, children }) =>
            href ? (
              <a
                href={href}
                target={href.startsWith('#') ? undefined : '_blank'}
                rel="noreferrer noopener"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span>{alt ?? ''}</span>,
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => {
            const code = React.isValidElement<{ className?: string; children?: React.ReactNode }>(
              children,
            )
              ? children.props
              : null;
            const language = /language-([\w-]+)/.exec(code?.className ?? '')?.[1];
            return language ? (
              <CodeBlock
                text={String(code?.children ?? '').replace(/\n$/, '')}
                language={language}
              />
            ) : (
              <pre>{children}</pre>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
