import { MarkdownRenderer } from "./MarkdownRenderer";
import type { LogEntry } from "../api";

const ACTION_STYLES: Record<LogEntry["action"], string> = {
  Creation: "bg-green/15 text-green",
  Update: "bg-blue/15 text-blue",
  Deletion: "bg-red/15 text-red",
};

export function LogView({
  entries,
  onNavigate,
}: {
  entries: LogEntry[];
  onNavigate: (path: string) => void;
}) {
  if (entries.length === 0) {
    return <p className="p-6 text-sm text-muted">No log entries yet.</p>;
  }
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-2xl font-bold text-strong">Update Log</h1>
      <div className="space-y-2">
        {entries.map((e, i) => {
          const showDate = e.date !== entries[i - 1]?.date;
          return (
            <div key={i}>
              {showDate && (
                <div className="mt-4 mb-1 text-sm font-semibold text-muted">{e.date}</div>
              )}
              <div className="card flex items-start gap-2 px-3 py-2">
                <span className={`chip mt-0.5 shrink-0 ${ACTION_STYLES[e.action]}`}>
                  {e.action}
                </span>
                <div className="markdown text-sm [&_p]:my-0">
                  <MarkdownRenderer
                    onNavigate={(href) =>
                      href.startsWith("/") && href.endsWith(".md") ? href : null
                    }
                    onNavigateClick={onNavigate}
                  >
                    {e.summary}
                  </MarkdownRenderer>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
