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
