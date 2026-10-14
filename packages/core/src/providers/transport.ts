import { Agent, fetch as undiciFetch } from "undici";

/**
 * Node's built-in fetch gives up when no response header arrives within 300s,
 * and again when the body goes quiet for 300s. An agent step is one
 * non-streaming request, so a local model that needs longer for a single
 * completion (a long prefill is enough) failed with "fetch failed" and was
 * retried until the run gave up. Model requests therefore use a dispatcher
 * without those two limits: LLM_TIMEOUT and the caller's abort bound them
 * instead. Connecting keeps undici's short timeout, so an unreachable endpoint
 * still fails fast. Ported from upstream understory (thecodacus/understory#48).
 */
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

type UndiciFetchArgs = Parameters<typeof undiciFetch>;

export const llmFetch = ((input: UndiciFetchArgs[0], init?: UndiciFetchArgs[1]) =>
  undiciFetch(input, { ...init, dispatcher })) as unknown as typeof fetch;
