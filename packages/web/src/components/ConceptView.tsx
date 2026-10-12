import { MarkdownRenderer } from "./MarkdownRenderer";
import type { Concept } from "../api";

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // a literal "%" in a hand-written link
  }
}

/** Resolve a spec-§6 relative href (e.g. "billing-api.md", "tables/") against the doc's directory. */
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
  const extraKeys = Object.entries(fm).filter(
    ([k]) => !["type", "title", "description", "resource", "tags", "timestamp"].includes(k)
  );

  return (
    <div className="mx-auto max-w-3xl p-6">
      {isReserved ? (
        <p className="mb-4 font-mono text-xs text-zinc-500">
          {concept.path}{" "}
          <span className="italic">
            (generated {concept.path.endsWith("index.md") ? "directory index" : "log"} — maintained
            automatically)
          </span>
        </p>
      ) : (
        <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-sm bg-purple-900/60 px-2 py-0.5 text-xs font-medium text-purple-300">
              {display(fm.type)}
            </span>
            {Array.isArray(fm.tags) &&
              fm.tags.map((t, i) => (
                <span key={i} className="rounded-sm bg-zinc-800 px-2 py-0.5 text-xs text-cyan-300">
                  #{display(t)}
                </span>
              ))}
            {typeof fm.timestamp === "string" && (
              <span className="ml-auto text-xs text-zinc-500">
                {new Date(fm.timestamp).toLocaleString()}
              </span>
            )}
          </div>
          <h1 className="mt-2 text-2xl font-bold">{display(fm.title ?? concept.path)}</h1>
          {typeof fm.description === "string" && (
            <p className="mt-1 text-sm text-zinc-400">{fm.description}</p>
          )}
          {typeof fm.resource === "string" && (
            <p className="mt-1 truncate font-mono text-xs text-zinc-500">{fm.resource}</p>
          )}
          {extraKeys.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
              {extraKeys.map(([k, v]) => (
                <span key={k}>
                  <span className="text-zinc-400">{k}:</span> {JSON.stringify(v)}
                </span>
              ))}
            </div>
          )}
          <p className="mt-2 font-mono text-xs text-zinc-600">{concept.path}</p>
        </div>
      )}

      <MarkdownRenderer
        className="markdown"
        onNavigate={(href) => resolveHref(href, concept.path)}
        onNavigateClick={onNavigate}
      >
        {concept.body}
      </MarkdownRenderer>
    </div>
  );
}
