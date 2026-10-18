import { useEffect, useId, useState, useSyncExternalStore } from "react";

type Mermaid = typeof import("mermaid").default;

// Mermaid is large, so it loads with the first diagram and not with the app.
let mermaidPromise: Promise<Mermaid> | null = null;
// mermaid.initialize is global: renders run one after another so a theme
// switch cannot land between another diagram's initialize and render.
let queue: Promise<unknown> = Promise.resolve();

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => mermaid);
  return mermaidPromise;
}

/**
 * Diagram source → SVG text, or null when it does not parse. The source is
 * bundle content or model output, so it is untrusted: "strict" turns off HTML
 * in labels and click handlers, and plain SVG labels (no foreignObject) keep
 * the image self-contained. The result is only ever shown through an <img>.
 */
function renderSvg(id: string, code: string, dark: boolean): Promise<string | null> {
  const run = queue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      theme: dark ? "dark" : "default",
    });
    if (!(await mermaid.parse(code, { suppressErrors: true }))) return null;
    return (await mermaid.render(id, code)).svg;
  });
  queue = run.catch(() => undefined);
  return run;
}

const DARK = "(prefers-color-scheme: dark)";

function subscribeScheme(onChange: () => void) {
  const query = window.matchMedia(DARK);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const isDark = () => window.matchMedia(DARK).matches;

/** The SVG's own size, so the <img> keeps the diagram's proportions. */
function viewBoxSize(svg: string): { width: number; height: number } | null {
  const box = /viewBox="[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/.exec(svg);
  return box ? { width: Math.ceil(Number(box[1])), height: Math.ceil(Number(box[2])) } : null;
}

/**
 * Renders a ```mermaid block as a diagram. The SVG goes into an <img> as a data
 * URL, never into the page: an image runs no script and loads nothing, so a
 * sanitizer gap in Mermaid cannot reach the DOM. The source stays visible as
 * code until it parses, which covers a diagram still streaming into the chat
 * and one written with a syntax error.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const dark = useSyncExternalStore(subscribeScheme, isDark);
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    renderSvg(id, code, dark).then(
      (rendered) => !stale && setSvg(rendered),
      () => !stale && setSvg(null)
    );
    return () => {
      stale = true;
    };
  }, [code, id, dark]);

  if (svg === null) {
    return (
      <pre className="my-3 overflow-x-auto rounded-xl border border-line bg-backdrop/60 p-3 text-sm">
        <code>{code}</code>
      </pre>
    );
  }
  const size = viewBoxSize(svg);
  return (
    <div className="my-3 overflow-x-auto rounded-xl border border-line bg-backdrop/60 p-3">
      <img
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
        alt="Mermaid diagram"
        width={size?.width}
        height={size?.height}
        className="mx-auto h-auto max-w-full"
      />
    </div>
  );
}
