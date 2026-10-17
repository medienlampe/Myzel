import { AISDKError, APICallError, RetryError } from "ai";

/**
 * The error text a client may see. A provider's error response can carry
 * request details — gateway debug output, echoed headers, sometimes part of
 * the key — so provider errors are reduced to their HTTP status, and any other
 * AI SDK error (invalid or unparseable responses embed the provider's body) to
 * a fixed sentence; callers log the full error on the server. Errors raised by
 * Myzel itself are already written for the user and pass through.
 */
export function publicErrorMessage(err: unknown): string {
  if (RetryError.isInstance(err)) return publicErrorMessage(err.lastError);
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "the model call timed out or was cancelled";
  }
  if (APICallError.isInstance(err)) {
    return err.statusCode != null
      ? `the model provider returned HTTP ${err.statusCode}`
      : "the model provider could not be reached";
  }
  if (AISDKError.isInstance(err)) return "the model returned a response Myzel could not use";
  return err instanceof Error ? err.message : String(err);
}
