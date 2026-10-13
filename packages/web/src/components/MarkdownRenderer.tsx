import React, { createContext, useContext, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Async Shiki highlighter using the JavaScript regex engine (no WASM).
// Per Shiki best practices: use createHighlighterCore + JavaScript engine
// for web apps to avoid WASM loading issues and reduce bundle size.
// Fine-grained imports keep bundle size minimal.
const highlighterPromise = createHighlighterCore({
  themes: [import("@shikijs/themes/solarized-dark"), import("@shikijs/themes/solarized-light")],
  langs: [
    import("@shikijs/langs/javascript"),
    import("@shikijs/langs/typescript"),
    import("@shikijs/langs/tsx"),
    import("@shikijs/langs/jsx"),
    import("@shikijs/langs/python"),
    import("@shikijs/langs/bash"),
    import("@shikijs/langs/shell"),
    import("@shikijs/langs/json"),
    import("@shikijs/langs/yaml"),
    import("@shikijs/langs/html"),
    import("@shikijs/langs/css"),
    import("@shikijs/langs/sql"),
    import("@shikijs/langs/rust"),
    import("@shikijs/langs/go"),
    import("@shikijs/langs/java"),
    import("@shikijs/langs/csharp"),
    import("@shikijs/langs/php"),
    import("@shikijs/langs/ruby"),
    import("@shikijs/langs/markdown"),
    import("@shikijs/langs/xml"),
    import("@shikijs/langs/dockerfile"),
    import("@shikijs/langs/graphql"),
  ],
  engine: createJavaScriptRegexEngine(),
});

/** Sanitize schema: allow everything in defaultSchema plus tables. */
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...new Set([...(defaultSchema.tagNames || []), "table", "thead", "tbody", "tr", "th", "td"]),
  ],
  attributes: {
    ...(defaultSchema.attributes || {}),
    table: [...(defaultSchema.attributes?.table || []), "className"],
    thead: [...(defaultSchema.attributes?.thead || []), "className"],
    tbody: [...(defaultSchema.attributes?.tbody || []), "className"],
    tr: [...(defaultSchema.attributes?.tr || []), "className"],
    th: [...(defaultSchema.attributes?.th || []), "className"],
    td: [...(defaultSchema.attributes?.td || []), "className"],
  },
  // A flat list: hast-util-sanitize compares entries as strings, so a nested
  // array silently matches nothing and strips every external link.
  protocols: {
    ...(defaultSchema.protocols || {}),
    href: ["http", "https", "mailto"],
  },
};

export interface MarkdownRendererProps {
  children: string;
  className?: string;
  /** Resolve an href to a navigation target. Return null for external links. */
  onNavigate?: (href: string) => string | null;
  /** Called when an in-app link is clicked with the resolved path. */
  onNavigateClick?: (path: string) => void;
}

/**
 * Shared markdown renderer with:
 * - GFM (tables, strikethrough, task lists) via remark-gfm
 * - XSS sanitization via rehype-sanitize
 * - Syntax highlighting via Shiki (used directly in code component, NOT rehypeShiki)
 * - Custom table styling
 *
 * Uses createHighlighterCore with the JavaScript regex engine (no WASM)
 * per Shiki best practices for web applications.
 */
type Highlighter = Awaited<typeof highlighterPromise>;

/**
 * What the custom renderers need from the current render. Passed by context
 * so the renderers themselves can be stable module-level components: a new
 * component function on every render would make React remount every link and
 * code block of the document each time the parent re-renders.
 */
const RenderContext = createContext<{
  highlighter: Highlighter | null;
  onNavigate?: (href: string) => string | null;
  onNavigateClick?: (path: string) => void;
}>({ highlighter: null });

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function highlightCode(highlighter: Highlighter, code: string, language: string): string {
  try {
    if (highlighter.getLoadedLanguages().includes(language)) {
      // Both themes as CSS variables; index.css picks the one for the color scheme.
      return highlighter.codeToHtml(code, {
        lang: language,
        themes: { dark: "solarized-dark", light: "solarized-light" },
        defaultColor: false,
      });
    }
  } catch {
    // Fall back to unhighlighted code
  }
  return `<pre class="shiki code-block" tabindex="0"><code>${escapeHtml(code)}</code></pre>`;
}

const LINK_CLASS = "text-blue underline-offset-2 hover:underline";

function Link({ href, children }: React.ComponentProps<"a">) {
  const { onNavigate, onNavigateClick } = useContext(RenderContext);
  const resolved = href && onNavigate ? onNavigate(href) : null;
  if (resolved !== null) {
    return (
      <a
        href={resolved}
        onClick={(e) => {
          e.preventDefault();
          onNavigateClick?.(resolved);
        }}
        className={LINK_CLASS}
      >
        {children}
      </a>
    );
  }
  // An in-page anchor stays in the page; anything else leaves the app.
  if (href?.startsWith("#")) {
    return (
      <a href={href} className={LINK_CLASS}>
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
      {children}
    </a>
  );
}

function Code({
  className,
  children,
  node: _node,
  ...props
}: React.ComponentProps<"code"> & { node?: unknown }) {
  const { highlighter } = useContext(RenderContext);
  const language = /language-(\w+)/.exec(className || "")?.[1];
  if (language && highlighter) {
    // Block code — Shiki escapes its input, so its HTML is safe to inject.
    const html = highlightCode(highlighter, String(children), language);
    return <div dangerouslySetInnerHTML={{ __html: html }} />;
  }
  // Inline code — no highlighting
  return (
    <code
      className="rounded-md bg-raised px-1 py-0.5 font-mono text-[0.9em] text-orange"
      {...props}
    >
      {children}
    </code>
  );
}

const COMPONENTS: Parameters<typeof ReactMarkdown>[0]["components"] = {
  a: Link,
  code: Code,
  table: ({ node: _node, ...props }) => (
    <div className="my-4 overflow-x-auto rounded-xl border border-line">
      <table className="min-w-full border-collapse" {...props} />
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="bg-raised" {...props} />,
  th: ({ node: _node, ...props }) => (
    <th
      className="border-b border-line px-3 py-2 text-left font-semibold text-strong [&:not(:first-child)]:border-l"
      {...props}
    />
  ),
  td: ({ node: _node, ...props }) => (
    <td
      className="border-t border-line px-3 py-2 text-sm text-fg [&:not(:first-child)]:border-l"
      {...props}
    />
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-xl border border-line bg-backdrop/60 p-3 text-sm">
      {children}
    </pre>
  ),
};

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS: Parameters<typeof ReactMarkdown>[0]["rehypePlugins"] = [
  [rehypeSanitize, sanitizeSchema],
];

export function MarkdownRenderer({
  children,
  className,
  onNavigate,
  onNavigateClick,
}: MarkdownRendererProps) {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);

  useEffect(() => {
    let current = true;
    highlighterPromise.then((h) => current && setHighlighter(h));
    return () => {
      current = false;
    };
  }, []);

  return (
    <RenderContext.Provider value={{ highlighter, onNavigate, onNavigateClick }}>
      <div className={className}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={COMPONENTS}
        >
          {children}
        </ReactMarkdown>
      </div>
    </RenderContext.Provider>
  );
}
