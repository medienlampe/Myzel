import { describe, expect, it } from "vitest";
import { APICallError, RetryError } from "ai";
import { redactUrl } from "../src/util/url.js";
import { publicErrorMessage } from "../src/providers/errors.js";

describe("redactUrl", () => {
  it("keeps an ordinary base URL readable", () => {
    expect(redactUrl("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/v1");
  });

  it("hides credentials in user info and the query string", () => {
    const shown = redactUrl("https://user:sk-secret@gw.example/v1?key=sk-secret&x=1");
    expect(shown).not.toContain("sk-secret");
    expect(shown).not.toContain("user");
    expect(shown).toBe("https://***@gw.example/v1?***");
  });

  it("never echoes an unparseable value", () => {
    expect(redactUrl("not a url sk-secret")).toBe("(unparseable URL)");
  });
});

describe("publicErrorMessage", () => {
  const apiError = (statusCode?: number) =>
    new APICallError({
      message: "Incorrect API key provided: sk-proj-abcd…wxyz (request id req_123)",
      url: "https://gw.example/v1/chat?key=sk-secret",
      requestBodyValues: {},
      statusCode,
      responseBody: '{"error":"sk-secret"}',
    });

  it("reduces provider errors to their status", () => {
    const shown = publicErrorMessage(apiError(401));
    expect(shown).toBe("the model provider returned HTTP 401");
    expect(shown).not.toContain("sk-");
  });

  it("unwraps retry errors to the last provider error", () => {
    const retry = new RetryError({
      message: "Failed after 3 attempts: sk-secret",
      reason: "maxRetriesExceeded",
      errors: [apiError(500), apiError(503)],
    });
    expect(publicErrorMessage(retry)).toBe("the model provider returned HTTP 503");
  });

  it("names timeouts and keeps understory's own messages", () => {
    expect(publicErrorMessage(new DOMException("t", "TimeoutError"))).toMatch(/timed out/);
    expect(publicErrorMessage(new Error("Concept not found: /x.md"))).toBe(
      "Concept not found: /x.md"
    );
  });
});
