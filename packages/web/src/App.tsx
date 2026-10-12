import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  setAuthToken,
  type AppConfig,
  type Concept,
  type ConformanceReport,
  type LogEntry,
  type SearchHit,
  type TreeNode,
} from "./api";
import { Tree } from "./components/Tree";
import { ConceptView } from "./components/ConceptView";
import { LogView } from "./components/LogView";
import { ChatPanel } from "./components/ChatPanel";
import { GraphView } from "./components/GraphView";
import { Workspace, type PanelSpec } from "./components/Workspace";
import {
  DEFAULT_LAYOUT,
  PANEL_IDS,
  loadLayout,
  saveLayout,
  togglePanel,
  type LayoutState,
  type PanelId,
} from "./layout";

type View =
  { kind: "concept"; path: string } | { kind: "log" } | { kind: "graph" } | { kind: "empty" };

export default function App() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [report, setReport] = useState<ConformanceReport | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [view, setView] = useState<View>({ kind: "empty" });
  const [concept, setConcept] = useState<Concept | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [layout, setLayout] = useState<LayoutState>(loadLayout);
  const updateLayout = useCallback((next: LayoutState) => {
    setLayout(next);
    saveLayout(next);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");

  const refresh = useCallback(() => {
    api
      .tree()
      .then((t) => {
        setTree(t);
        setNeedsToken(false);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setNeedsToken(true);
        else setError(String(e));
      });
    api
      .validate()
      .then(setReport)
      .catch(() => {});
    api
      .log()
      .then(setLog)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    api
      .config()
      .then(setConfig)
      .catch(() => {});
  }, [refresh]);

  useEffect(() => {
    if (view.kind === "concept") {
      api
        .concept(view.path)
        .then(setConcept)
        .catch((e) => setError(String(e)));
    }
  }, [view]);

  // Re-load the open concept (and graph) after chat mutations.
  const [graphRefreshKey, setGraphRefreshKey] = useState(0);
  const onMutation = useCallback(() => {
    refresh();
    setGraphRefreshKey((k) => k + 1);
    setView((v) => ({ ...v }));
  }, [refresh]);

  // Results for a cleared query are simply not shown, rather than reset from
  // inside the effect (which would cost an extra render per keystroke).
  const shownHits = query.trim() ? hits : null;
  useEffect(() => {
    if (!query.trim()) return;
    const t = setTimeout(
      () =>
        api
          .search(query)
          .then(setHits)
          .catch(() => {}),
      200
    );
    return () => clearTimeout(t);
  }, [query]);

  const openConcept = useCallback((path: string) => {
    if (path === "/log.md") {
      setView({ kind: "log" });
    } else {
      setView({ kind: "concept", path });
    }
    setError(null);
    setQuery("");
  }, []);

  if (needsToken) {
    return (
      <div className="flex h-screen items-center justify-center">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setAuthToken(tokenInput.trim());
            setTokenInput("");
            refresh();
            api
              .config()
              .then(setConfig)
              .catch(() => {});
          }}
          className="w-80 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5"
        >
          <h1 className="text-sm font-bold tracking-wide text-cyan-300">understory 🌱</h1>
          <p className="mt-2 text-sm text-zinc-400">
            This server requires an access token (its{" "}
            <code className="text-zinc-300">AUTH_TOKEN</code>).
          </p>
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Access token"
            autoFocus
            className="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-hidden focus:border-cyan-600"
          />
          <button
            type="submit"
            className="mt-3 w-full rounded-lg bg-cyan-700 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-600"
          >
            Unlock
          </button>
        </form>
      </div>
    );
  }

  const viewTitle =
    view.kind === "log"
      ? "Log"
      : view.kind === "graph"
        ? "Graph"
        : view.kind === "concept"
          ? "Concept"
          : "View";

  const explorer = (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-800 p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          aria-label="Search concepts"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm outline-hidden focus:border-cyan-600"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {shownHits ? (
          <div className="space-y-1">
            {shownHits.length === 0 && <p className="px-2 text-xs text-zinc-500">No matches.</p>}
            {shownHits.map((h) => (
              <button
                key={h.path}
                onClick={() => openConcept(h.path)}
                className="block w-full rounded-sm px-2 py-1.5 text-left hover:bg-zinc-800"
              >
                <div className="text-sm text-zinc-200">{h.title ?? h.path}</div>
                {h.snippet && <div className="truncate text-xs text-zinc-500">{h.snippet}</div>}
              </button>
            ))}
          </div>
        ) : tree ? (
          <Tree
            node={tree}
            selected={view.kind === "concept" ? view.path : null}
            onSelect={openConcept}
          />
        ) : (
          <p className="px-2 text-xs text-zinc-500">Loading…</p>
        )}
      </div>

      <div className="flex border-t border-zinc-800 text-xs">
        <button
          onClick={() => setView({ kind: "log" })}
          className={`flex-1 px-3 py-2 hover:bg-zinc-800 ${view.kind === "log" ? "text-cyan-300" : "text-zinc-400"}`}
        >
          Log
        </button>
        <button
          onClick={() => setView({ kind: "graph" })}
          className={`flex-1 border-l border-zinc-800 px-3 py-2 hover:bg-zinc-800 ${view.kind === "graph" ? "text-cyan-300" : "text-zinc-400"}`}
        >
          Graph
        </button>
      </div>
    </div>
  );

  const content = (
    <div
      className={`h-full min-w-0 ${view.kind === "graph" ? "overflow-hidden" : "overflow-y-auto"}`}
    >
      {error && <p className="p-6 text-sm text-red-400">{error}</p>}
      {!error && view.kind === "empty" && (
        <div className="flex h-full items-center justify-center p-6 text-center text-zinc-600">
          <p>Select a concept, or ask the agent.</p>
        </div>
      )}
      {!error && view.kind === "concept" && concept && (
        <ConceptView concept={concept} onNavigate={openConcept} />
      )}
      {!error && view.kind === "log" && <LogView entries={log} onNavigate={openConcept} />}
      {!error && view.kind === "graph" && (
        <GraphView refreshKey={graphRefreshKey} onNavigate={openConcept} />
      )}
    </div>
  );

  const panels: Record<PanelId, PanelSpec> = {
    explorer: { title: "Explorer", minWidth: 200, content: explorer },
    content: { title: viewTitle, minWidth: 320, content },
    chat: {
      title: "Agent chat",
      minWidth: 280,
      content: <ChatPanel config={config} onMutation={onMutation} onOpenConcept={openConcept} />,
    },
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <h1 className="text-sm font-bold tracking-wide text-cyan-300">understory 🌱</h1>
        {report && (
          <span
            title={`${report.conceptCount} concepts, ${report.issues.length} issues`}
            className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${
              report.conformant
                ? "bg-emerald-900/60 text-emerald-300"
                : "bg-red-900/60 text-red-300"
            }`}
          >
            {report.conformant ? "conformant" : "non-conformant"}
          </span>
        )}
        <nav aria-label="Panels" className="ml-auto flex items-center gap-1 text-xs">
          {PANEL_IDS.map((id) => {
            const open = !layout.hidden.includes(id);
            return (
              <button
                key={id}
                aria-pressed={open}
                onClick={() => updateLayout(togglePanel(layout, id))}
                className={`rounded-sm px-2 py-1 hover:bg-zinc-800 ${open ? "text-cyan-300" : "text-zinc-500"}`}
              >
                {PANEL_LABELS[id]}
              </button>
            );
          })}
          <button
            onClick={() => updateLayout(DEFAULT_LAYOUT)}
            title="Restore the default panel arrangement"
            className="ml-1 rounded-sm border border-zinc-800 px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            Reset layout
          </button>
        </nav>
      </header>

      <Workspace layout={layout} onLayoutChange={updateLayout} panels={panels} />
    </div>
  );
}

const PANEL_LABELS: Record<PanelId, string> = {
  explorer: "Explorer",
  content: "View",
  chat: "Chat",
};
