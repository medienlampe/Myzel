import { MarkdownRenderer } from "./MarkdownRenderer";
import type { Concept } from "../api";
import { isStale, lastChange, SHOWN_KEYS, sources, status, trustTier, type Source } from "../okf";

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // a literal "%" in a hand-written link
  }
}

/** Resolve a spec-§6.1 relative href (e.g. "billing-api.md", "tables/") against the doc's directory. */
function resolveHref(rawHref: string, docPath: string): string | null {
  if (/^[a-z]+:/i.test(rawHref) || rawHref.startsWith("#")) return null; // external / anchor
  const href = rawHref.replace(/[?#].*$/, ""); // the view has no anchors to jump to
  if (!href) return null;
  // Bundle-absolute links resolve from the root, relative ones from the doc's directory.
  const dir = href.startsWith("/") ? "" : docPath.slice(0, docPath.lastIndexOf("/"));
  const joined = `${dir}/${href.replace(/^\.\//, "")}`;
  // Normalize ".." segments
  const parts: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "" && seg !== ".") parts.push(seg);
  }
  // Index links are percent-encoded (spaces, "#", parentheses in file names).
  const normalized = "/" + parts.map(decodeSegment).join("/");
  if (normalized.endsWith(".md")) return normalized;
  return `${normalized}/index.md`; // directory link → its index
}

/** Frontmatter is user data: a value can be a list or mapping where a string is expected. */
function display(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Renders a concept: frontmatter card + markdown body with in-app link navigation. */
export function ConceptView({
  concept,
  onNavigate,
}: {
  concept: Concept;
  onNavigate: (path: string) => void;
}) {
  const fm = concept.frontmatter;
  const isReserved = /(^|\/)(index|log)\.md$/.test(concept.path);
  const extraKeys = Object.entries(fm).filter(([k]) => !SHOWN_KEYS.has(k));
  const lifecycle = status(fm);
  const tier = trustTier(fm);
  const change = lastChange(fm);
  const provenance = sources(fm);
  const navigate = (href: string) => resolveHref(href, concept.path);

  return (
    <div className="mx-auto max-w-3xl p-6">
      {isReserved ? (
        <p className="mb-4 font-mono text-xs text-muted">
          {concept.path}{" "}
          <span className="italic">
            (generated {concept.path.endsWith("index.md") ? "directory index" : "log"} — maintained
            automatically)
          </span>
        </p>
      ) : (
        <div className="card mb-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip bg-violet/15 text-violet">{display(fm.type)}</span>
            {Array.isArray(fm.tags) &&
              fm.tags.map((t, i) => (
                <span key={i} className="chip bg-cyan/15 font-normal text-cyan">
                  #{display(t)}
                </span>
              ))}
            {lifecycle !== "stable" && (
              <span
                className={`chip ${lifecycle === "deprecated" ? "bg-red/15 text-red" : "bg-yellow/15 text-yellow"}`}
              >
                {lifecycle}
              </span>
            )}
            {isStale(fm) && (
              <span
                title={`Stale since ${String(fm.stale_after)}`}
                className="chip bg-orange/15 text-orange"
              >
                stale
              </span>
            )}
            {tier !== "unverified" && (
              <span
                title="Trust tier, from who verified it (OKF §5.3)"
                className={`chip ${tier === "human-reviewed" ? "bg-green/15 text-green" : "bg-cyan/15 text-cyan"}`}
              >
                {tier}
              </span>
            )}
            {change && (
              <span className="ml-auto text-xs text-muted">
                {change.by && <span className="font-mono">{change.by}</span>}
                {change.by && change.at && " · "}
                {change.at && <time dateTime={change.at}>{formatDate(change.at)}</time>}
              </span>
            )}
          </div>
          <h1 className="mt-2 text-2xl font-bold text-strong">
            {display(fm.title ?? concept.path)}
          </h1>
          {typeof fm.description === "string" && (
            <p className="mt-1 text-sm text-muted">{fm.description}</p>
          )}
          {typeof fm.resource === "string" && (
            <p className="mt-1 truncate font-mono text-xs text-muted">{fm.resource}</p>
          )}
          {extraKeys.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              {extraKeys.map(([k, v]) => (
                <span key={k}>
                  <span className="text-fg">{k}:</span> {JSON.stringify(v)}
                </span>
              ))}
            </div>
          )}
          {provenance.length > 0 && (
            <div className="mt-3 border-t border-line pt-2">
              <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Sources</h2>
              <ul className="mt-1 space-y-0.5 text-sm">
                {provenance.map((source, i) => (
                  <li key={source.id ?? i} className="flex flex-wrap items-baseline gap-x-2">
                    <SourceLink source={source} navigate={navigate} onNavigate={onNavigate} />
                    {source.author && <span className="text-xs text-muted">{source.author}</span>}
                    {source.id && (
                      <span className="font-mono text-[11px] text-faint">[^{source.id}]</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-2 font-mono text-xs text-faint">{concept.path}</p>
        </div>
      )}

      <MarkdownRenderer className="markdown" onNavigate={navigate} onNavigateClick={onNavigate}>
        {concept.body}
      </MarkdownRenderer>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * A source's resource (OKF §5.1, §6.2): a URL opens in a new tab, a bundle
 * path in the app; a scope descriptor ("all queries in project X") is text.
 */
function SourceLink({
  source,
  navigate,
  onNavigate,
}: {
  source: Source;
  navigate: (href: string) => string | null;
  onNavigate: (path: string) => void;
}) {
  const label = source.title ?? source.resource;
  if (/^https?:\/\//i.test(source.resource)) {
    return (
      <a
        href={source.resource}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue underline-offset-2 hover:underline"
      >
        {label}
      </a>
    );
  }
  const inBundle = /^[./]|\.md$/.test(source.resource) ? navigate(source.resource) : null;
  if (inBundle) {
    return (
      <a
        href={inBundle}
        onClick={(e) => {
          e.preventDefault();
          onNavigate(inBundle);
        }}
        className="text-blue underline-offset-2 hover:underline"
      >
        {label}
      </a>
    );
  }
  return <span className="text-fg">{label}</span>;
}
