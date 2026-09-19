/**
 * The lab writes markdown — issue bodies, drafted fixes — and a report nobody
 * can skim is a report nobody reads, so it is rendered rather than dumped.
 */
import ReactMarkdown from 'react-markdown';

import { cn } from '@/lib/utils';

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('text-xs leading-relaxed', className)}>
      <ReactMarkdown
        components={{
          h1: ({ children }) => <h3 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h3>,
          h2: ({ children }) => <h3 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h3>,
          h3: ({ children }) => <h4 className="mt-3 mb-1 text-xs font-semibold first:mt-0">{children}</h4>,
          h4: ({ children }) => (
            <h5 className="mt-3 mb-1 font-mono text-xs font-semibold first:mt-0">{children}</h5>
          ),
          p: ({ children }) => <p className="my-1.5">{children}</p>,
          ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-4">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-4">{children}</ol>,
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          em: ({ children }) => <em className="text-muted-foreground italic">{children}</em>,
          a: ({ children, href }) => (
            <a href={href} className="underline underline-offset-2" target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ children, className: cls }) =>
            cls?.startsWith('language-') ? (
              <code className="font-mono">{children}</code>
            ) : (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.95em] break-all">{children}</code>
            ),
          pre: ({ children }) => (
            <pre className="my-1.5 overflow-x-auto rounded-md bg-muted/60 px-3 py-2 text-xs whitespace-pre-wrap">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
          ),
          hr: () => <hr className="my-3 border-border/60" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
