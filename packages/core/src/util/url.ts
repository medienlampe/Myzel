/**
 * A URL safe to print: user info and query string removed. Some
 * OpenAI-compatible gateways take the key as `?key=` or `https://user:key@…`,
 * and log lines and error messages end up in `docker logs`, MCP clients and
 * bug reports.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    url.search = url.search ? "?***" : "";
    url.hash = "";
    return url.toString();
  } catch {
    return "(unparseable URL)";
  }
}
