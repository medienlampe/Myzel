/** Shorten to at most `n` characters, marking the cut with an ellipsis. */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
