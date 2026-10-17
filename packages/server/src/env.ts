/**
 * Reading numeric settings: blank or malformed values mean "not set" and fall
 * back to the default. Number("") is 0, which would silently disable a brake
 * (RATE_LIMIT) or bind a random port (PORT) — 0 must be written out on purpose.
 */
export function envCount(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * The bind address. Blank counts as unset like every other setting here: an
 * empty HOST would make Node listen on every interface, the opposite of what
 * clearing the variable means.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOST?.trim() || "127.0.0.1";
}

/**
 * Which models a client may request. Unset means none: the server's configured
 * model is used and a client-supplied override is refused, so a request cannot
 * redirect spend onto a different (pricier) model. "*" restores free choice.
 * Model ids are case-sensitive, so unlike host lists nothing is lowercased.
 */
export function parseAllowedModels(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * DEMO_MODE: serve one bundle read-only, to try Myzel out quickly. Writes are
 * refused by KnowledgeBase itself; the entry points also drop what only
 * exists to write (MCP write tools, dreaming, /admin, git autocommit).
 */
export function isDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEMO_MODE === "true";
}
