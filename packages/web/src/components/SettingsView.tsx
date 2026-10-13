import { useEffect, useState } from "react";
import {
  adminApi,
  ApiError,
  getAdminToken,
  setAdminToken,
  type SettingsData,
  type SettingView,
} from "../api";

/**
 * The settings page: the model and behaviour settings the server lets the UI
 * change, behind ADMIN_TOKEN. Edits collect into one batch; the server checks
 * the whole batch (and that the model setup still resolves) before saving it.
 * Settings marked "restart" are saved now and take effect at the next start.
 */

type Status =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "locked"; error?: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: SettingsData };

/** A change per key: a string sets it, null goes back to the environment. */
type Changes = Record<string, string | null>;

function describeError(err: unknown): Status {
  if (err instanceof ApiError && err.status === 404) return { kind: "disabled" };
  if (err instanceof ApiError && err.status === 401) {
    return getAdminToken()
      ? { kind: "locked", error: "That token was not accepted." }
      : { kind: "locked" };
  }
  if (err instanceof ApiError && err.status === 429) {
    return { kind: "locked", error: "Too many failed attempts — try again later." };
  }
  return { kind: "error", message: err instanceof Error ? err.message : String(err) };
}

export function SettingsView({ onSaved }: { onSaved: () => void }) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    adminApi
      .settings()
      .then((data) => current && setStatus({ kind: "ready", data }))
      .catch((err) => current && setStatus(describeError(err)));
    return () => {
      current = false;
    };
  }, [attempt]);

  const unlock = (token: string) => {
    setAdminToken(token);
    setAttempt((n) => n + 1);
  };
  const lock = () => {
    setAdminToken("");
    setStatus({ kind: "locked" });
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-2xl font-bold text-strong">Settings</h1>
        {status.kind === "ready" && (
          <button onClick={lock} className="btn-ghost ml-auto border border-line">
            Lock
          </button>
        )}
      </div>
      {status.kind === "loading" && <p className="text-sm text-muted">Loading…</p>}
      {status.kind === "disabled" && (
        <div className="card p-4 text-sm text-fg">
          <p>Changing settings from the UI is turned off on this server.</p>
          <p className="mt-2 text-muted">
            Start Myzel with <Code>ADMIN_TOKEN</Code> to enable it, and with{" "}
            <Code>SETTINGS_FILE</Code> to say where changes are saved.
          </p>
        </div>
      )}
      {status.kind === "error" && (
        <p role="alert" className="text-sm text-red">
          {status.message}
        </p>
      )}
      {status.kind === "locked" && <Unlock error={status.error} onUnlock={unlock} />}
      {status.kind === "ready" && (
        <SettingsForm
          data={status.data}
          onSaved={(data) => {
            setStatus({ kind: "ready", data });
            onSaved();
          }}
          onLocked={() => setStatus(describeError(new ApiError(401, "")))}
        />
      )}
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <code className="rounded-md bg-raised px-1 py-0.5 font-mono text-[0.9em] text-orange">
      {children}
    </code>
  );
}

function Unlock({ error, onUnlock }: { error?: string; onUnlock: (token: string) => void }) {
  const [token, setToken] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim()) onUnlock(token.trim());
      }}
      className="card max-w-md p-5"
    >
      <p className="text-sm text-muted">
        Settings need the server&apos;s admin token (<Code>ADMIN_TOKEN</Code>). It is kept only
        until this page is reloaded.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red">
          {error}
        </p>
      )}
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="Admin token"
        aria-label="Admin token"
        autoFocus
        className="input mt-3 w-full py-2"
      />
      <button type="submit" disabled={!token.trim()} className="btn-primary mt-3 w-full py-2">
        Unlock settings
      </button>
    </form>
  );
}

function SettingsForm({
  data,
  onSaved,
  onLocked,
}: {
  data: SettingsData;
  onSaved: (data: SettingsData) => void;
  onLocked: () => void;
}) {
  const [changes, setChanges] = useState<Changes>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ applied: string[]; restart: string[] } | null>(null);
  const count = Object.keys(changes).length;

  const groups = new Map<string, SettingView[]>();
  for (const s of data.settings) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);

  const change = (setting: SettingView, value: string | null | undefined) => {
    setResult(null);
    setChanges((current) => {
      const next = { ...current };
      // undefined: back to what is saved now (no change at all).
      if (value === undefined || (value !== null && value === setting.value))
        delete next[setting.key];
      else next[setting.key] = value;
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await adminApi.saveSettings(changes);
      setChanges({});
      setResult({ applied: saved.applied, restart: saved.restart });
      onSaved({ writable: saved.writable, settings: saved.settings });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLocked();
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 pb-20">
      {!data.writable && (
        <p role="status" className="card border-yellow/40 bg-yellow/10 p-3 text-sm text-yellow">
          Read-only: this server has no <Code>SETTINGS_FILE</Code>, so changes cannot be saved.
        </p>
      )}
      <p className="text-sm text-muted">
        Saved values override the server&apos;s environment. Network and access settings (address,
        tokens, allowed origins) are not here: they stay in the environment.
      </p>

      {[...groups].map(([group, settings]) => (
        <section key={group} aria-label={group} className="card divide-y divide-line">
          <h2 className="px-4 py-2.5 text-sm font-semibold text-strong">{group}</h2>
          {settings.map((s) => (
            <SettingRow
              key={s.key}
              setting={s}
              change={changes[s.key]}
              disabled={!data.writable || saving}
              onChange={(value) => change(s, value)}
            />
          ))}
        </section>
      ))}

      <div className="sticky bottom-0 -mx-2">
        <div className="card flex flex-wrap items-center gap-2 bg-surface/95 px-4 py-2.5 shadow-lg shadow-backdrop backdrop-blur-sm">
          <div aria-live="polite" className="min-w-0 flex-1 text-sm">
            {error ? (
              <span role="alert" className="text-red">
                {error}
              </span>
            ) : result ? (
              <span className="text-green">
                Saved.
                {result.restart.length > 0 && (
                  <span className="text-yellow">
                    {" "}
                    Restart Myzel for {result.restart.join(", ")} to take effect.
                  </span>
                )}
              </span>
            ) : (
              <span className="text-muted">
                {count === 0 ? "No changes" : `${count} unsaved change${count === 1 ? "" : "s"}`}
              </span>
            )}
          </div>
          <button
            onClick={() => {
              setChanges({});
              setError(null);
            }}
            disabled={count === 0 || saving}
            className="btn-ghost border border-line"
          >
            Discard
          </button>
          <button
            onClick={() => void save()}
            disabled={count === 0 || saving || !data.writable}
            className="btn-primary"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<SettingView["source"], string> = {
  settings: "saved here",
  environment: "environment",
  default: "default",
};

function SettingRow({
  setting: s,
  change,
  disabled,
  onChange,
}: {
  setting: SettingView;
  /** The pending change: a value, null (back to the environment) or undefined (none). */
  change: string | null | undefined;
  disabled: boolean;
  onChange: (value: string | null | undefined) => void;
}) {
  const id = `setting-${s.key}`;
  const reverting = change === null;
  // What the field shows: the pending value, or what is in effect now.
  const shown = typeof change === "string" ? change : reverting ? "" : (s.value ?? "");
  const canBeEmpty = s.kind === "text" || s.kind === "url" || s.kind === "secret";
  // Clearing a field that cannot be empty means "no value of my own".
  const fromInput = (value: string) => (value === "" && !canBeEmpty ? null : value);

  return (
    <div className="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <label htmlFor={id} className="text-sm font-medium text-strong">
            {s.label}
          </label>
          <span
            className={`chip font-normal ${
              s.source === "settings" ? "bg-blue/15 text-blue" : "bg-raised text-muted"
            }`}
          >
            {SOURCE_LABEL[s.source]}
          </span>
          {!s.live && (
            <span title="Takes effect after a restart" className="chip bg-yellow/15 text-yellow">
              restart
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted">{s.description}</p>
        <p className="mt-0.5 font-mono text-[11px] text-faint">{s.key}</p>
      </div>

      <div className="flex min-w-0 items-start gap-1.5">
        <div className="min-w-0 flex-1">
          {s.kind === "boolean" ? (
            <select
              id={id}
              aria-label={`${s.label}, ${s.group}`}
              value={shown}
              disabled={disabled}
              onChange={(e) => onChange(fromInput(e.target.value))}
              className="input w-full"
            >
              <option value="">not set here ({s.fallback ?? "off"} by default)</option>
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
          ) : s.kind === "choice" ? (
            <select
              id={id}
              aria-label={`${s.label}, ${s.group}`}
              value={shown}
              disabled={disabled}
              onChange={(e) => onChange(fromInput(e.target.value))}
              className="input w-full"
            >
              <option value="">not set here ({s.fallback} by default)</option>
              {s.choices?.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={id}
              aria-label={`${s.label}, ${s.group}`}
              type={s.kind === "secret" ? "password" : "text"}
              inputMode={s.kind === "count" ? "numeric" : undefined}
              autoComplete="off"
              spellCheck={false}
              value={shown}
              disabled={disabled}
              onChange={(e) =>
                onChange(
                  s.kind === "secret" && e.target.value === ""
                    ? undefined
                    : fromInput(e.target.value)
                )
              }
              placeholder={
                s.kind === "secret"
                  ? s.isSet
                    ? "•••••••• (set — type to replace)"
                    : "not set"
                  : (s.fallback ?? "")
              }
              className="input w-full font-mono text-[13px]"
            />
          )}
          {reverting && (
            <p className="mt-1 text-xs text-yellow">Goes back to the environment&apos;s value.</p>
          )}
        </div>
        {s.source === "settings" && !reverting && (
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={disabled}
            title="Drop the saved value and use the environment's"
            className="btn-ghost shrink-0"
          >
            Reset
          </button>
        )}
        {change !== undefined && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            disabled={disabled}
            title="Undo this change"
            className="btn-ghost shrink-0"
          >
            Undo
          </button>
        )}
      </div>
    </div>
  );
}
