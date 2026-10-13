import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  setAuthToken,
  type AppConfig,
  type Concept,
  type ConformanceReport,
  type LogEntry,
  type SessionInfo,
  type SearchHit,
  type TreeNode,
} from "./api";
import { reloadPage } from "./reload";
import { Tree } from "./components/Tree";
import { ConceptView } from "./components/ConceptView";
import { LogView } from "./components/LogView";
import { ChatPanel, createChat } from "./components/ChatPanel";
import { GraphView } from "./components/GraphView";
import { SettingsView } from "./components/SettingsView";
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
  | { kind: "concept"; path: string }
  | { kind: "log" }
  | { kind: "graph" }
  | { kind: "settings" }
  | { kind: "empty" };

export default function App() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [report, setReport] = useState<ConformanceReport | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [view, setView] = useState<View>({ kind: "empty" });
  // Tagged with the path it was requested for (the server returns the canonical
  // one), so the previous concept is not shown while the next one loads.
  const [loaded, setLoaded] = useState<{ path: string; concept: Concept } | null>(null);
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
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<SessionInfo["mode"] | null>(null);
  const [profile, setProfile] = useState<SessionInfo | null>(null);

  const refresh = useCallback(() => {
    api
      .tree()
      .then((t) => {
        setTree(t);
        setNeedsToken(false);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          setAuthMode(e.authMode ?? null);
          setNeedsToken(true);
        } else setError(String(e));
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

  // The chat shows the model; a saved setting may have changed it.
  const loadConfig = useCallback(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    loadConfig();
    api
      .profile()
      .then(setProfile)
      .catch(() => {});
  }, [refresh, loadConfig]);

  useEffect(() => {
    if (view.kind !== "concept") return;
    // A slower answer for a concept clicked earlier must not replace this one.
    let current = true;
    api
      .concept(view.path)
      .then((c) => current && setLoaded({ path: view.path, concept: c }))
      .catch((e) => current && setError(String(e)));
    return () => {
      current = false;
    };
  }, [view]);

  // Re-load the open concept (and graph) after chat mutations.
  const [graphRefreshKey, setGraphRefreshKey] = useState(0);
  const onMutation = useCallback(() => {
    refresh();
    setGraphRefreshKey((k) => k + 1);
    setView((v) => ({ ...v }));
  }, [refresh]);

  // Created once, after onMutation (stable: its only dependency never changes).
  const [chat] = useState(() => createChat(onMutation));
  const [chatModel, setChatModel] = useState("");

  // Results for a cleared query are simply not shown, rather than reset from
  // inside the effect (which would cost an extra render per keystroke).
  const shownHits = query.trim() ? hits : null;
  useEffect(() => {
    if (!query.trim()) return;
    let current = true;
    const t = setTimeout(
      () =>
        api
          .search(query)
          .then((h) => current && setHits(h))
          .catch(() => {}),
      200
    );
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [query]);

  const showView = useCallback((next: View) => {
    setView(next);
    setError(null);
  }, []);

  const openConcept = useCallback((path: string) => {
    if (path === "/log.md") {
      setView({ kind: "log" });
    } else {
      setView({ kind: "concept", path });
    }
    setError(null);
    setQuery("");
  }, []);

  // Everything on screen belongs to the memory the current key opens, so a key
  // change always starts from a clean page rather than patching state.
  const submitKey = async (key: string) => {
    setAuthToken(key);
    try {
      await api.profile();
      reloadPage();
    } catch (e) {
      setAuthToken("");
      setTokenError(
        e instanceof ApiError && e.status === 401
          ? "That key was not accepted."
          : `Could not reach the server: ${String(e)}`
      );
    }
  };

  const switchProfile = () => {
    setAuthToken("");
    reloadPage();
  };

  if (needsToken) {
    return (
      <div className="flex h-screen items-center justify-center">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTokenError(null);
            void submitKey(tokenInput.trim());
          }}
          className="card w-80 bg-surface p-5 shadow-lg shadow-backdrop"
        >
          <h1 className="text-sm font-bold tracking-wide text-strong">Myzel 🍄</h1>
          <p className="mt-2 text-sm text-muted">
            {authMode === "profiles" ? (
              <>
                This server hosts several memories. Enter your profile&apos;s API key — it decides
                which memory opens.
              </>
            ) : (
              <>
                This server requires an access token (its{" "}
                <code className="font-mono text-orange">AUTH_TOKEN</code>).
              </>
            )}
          </p>
          {tokenError && (
            <p role="alert" className="mt-2 text-sm text-red">
              {tokenError}
            </p>
          )}
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={authMode === "profiles" ? "Profile API key" : "Access token"}
            aria-label={authMode === "profiles" ? "Profile API key" : "Access token"}
            autoFocus
            className="input mt-3 w-full py-2"
          />
          <button type="submit" className="btn-primary mt-3 w-full py-2">
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
          : view.kind === "settings"
            ? "Settings"
            : "View";

  const explorer = (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          aria-label="Search concepts"
          className="input w-full px-2.5 py-1"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {shownHits ? (
          <div className="space-y-1">
            {shownHits.length === 0 && <p className="px-2 text-xs text-muted">No matches.</p>}
            {shownHits.map((h) => (
              <button
                key={h.path}
                onClick={() => openConcept(h.path)}
                className="row block w-full py-1.5"
              >
                <div className="text-sm text-strong">{h.title ?? h.path}</div>
                {h.snippet && <div className="truncate text-xs text-muted">{h.snippet}</div>}
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
          <p className="px-2 text-xs text-muted">Loading…</p>
        )}
      </div>

      <div className="flex gap-1 border-t border-line p-1.5 text-xs">
        <button
          onClick={() => showView({ kind: "log" })}
          aria-pressed={view.kind === "log"}
          className={`flex-1 rounded-lg px-3 py-1.5 transition-colors ${view.kind === "log" ? "bg-blue/15 text-blue" : "text-muted hover:bg-raised hover:text-strong"}`}
        >
          Log
        </button>
        <button
          onClick={() => showView({ kind: "graph" })}
          aria-pressed={view.kind === "graph"}
          className={`flex-1 rounded-lg px-3 py-1.5 transition-colors ${view.kind === "graph" ? "bg-blue/15 text-blue" : "text-muted hover:bg-raised hover:text-strong"}`}
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
      {error && <p className="p-6 text-sm text-red">{error}</p>}
      {!error && view.kind === "empty" && (
        <div className="flex h-full items-center justify-center p-6 text-center text-faint">
          <p>Select a concept, or ask the agent.</p>
        </div>
      )}
      {!error &&
        view.kind === "concept" &&
        (loaded?.path === view.path ? (
          <ConceptView concept={loaded.concept} onNavigate={openConcept} />
        ) : (
          <p className="p-6 text-sm text-faint">Loading…</p>
        ))}
      {!error && view.kind === "log" && <LogView entries={log} onNavigate={openConcept} />}
      {!error && view.kind === "graph" && (
        <GraphView refreshKey={graphRefreshKey} onNavigate={openConcept} />
      )}
      {!error && view.kind === "settings" && <SettingsView onSaved={loadConfig} />}
    </div>
  );

  const panels: Record<PanelId, PanelSpec> = {
    explorer: { title: "Explorer", minWidth: 200, content: explorer },
    content: { title: viewTitle, minWidth: 320, content },
    chat: {
      title: "Agent chat",
      minWidth: 280,
      content: (
        <ChatPanel
          chat={chat}
          config={config}
          model={chatModel}
          onModelChange={setChatModel}
          onOpenConcept={openConcept}
        />
      ),
    },
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center gap-2 px-3 pt-2 pb-1">
        <h1 className="text-sm font-bold tracking-wide text-strong">Myzel 🍄</h1>
        {profile?.profile && (
          <span className="flex items-center gap-1 text-xs">
            <span className="text-muted">profile</span>
            <span className="font-medium text-strong">{profile.profile}</span>
            <button
              onClick={switchProfile}
              title="Forget this key and open a different profile"
              className="btn-ghost px-1.5 py-0.5"
            >
              switch
            </button>
          </span>
        )}
        {report && (
          <span
            title={`${report.conceptCount} concepts, ${report.issues.length} issues`}
            className={`chip ${report.conformant ? "bg-green/15 text-green" : "bg-red/15 text-red"}`}
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
                className={`rounded-lg px-2 py-1 transition-colors ${open ? "bg-blue/15 text-blue" : "text-muted hover:bg-raised hover:text-strong"}`}
              >
                {PANEL_LABELS[id]}
              </button>
            );
          })}
          <button
            onClick={() => {
              // Settings open in the View panel; bring it back if it is closed.
              if (layout.hidden.includes("content")) updateLayout(togglePanel(layout, "content"));
              showView({ kind: "settings" });
            }}
            aria-pressed={view.kind === "settings"}
            className={`ml-1 rounded-lg px-2 py-1 transition-colors ${view.kind === "settings" ? "bg-blue/15 text-blue" : "text-muted hover:bg-raised hover:text-strong"}`}
          >
            Settings
          </button>
          <button
            onClick={() => updateLayout(DEFAULT_LAYOUT)}
            title="Restore the default panel arrangement"
            className="btn-secondary ml-1 px-2 py-1 text-xs font-normal"
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
