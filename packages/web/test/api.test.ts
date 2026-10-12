import { describe, expect, it } from "vitest";
import { api, ApiError, apiUrl, authHeaders, getAuthToken, setAuthToken } from "../src/api";
import { installFakeApi, json } from "./support/fake-api";

describe("auth token storage", () => {
  it("keeps the token for the tab only", () => {
    setAuthToken("tok");
    expect(sessionStorage.getItem("myzel-token")).toBe("tok");
    expect(localStorage.getItem("myzel-token")).toBeNull();
    expect(authHeaders()).toEqual({ Authorization: "Bearer tok" });
    setAuthToken("");
    expect(getAuthToken()).toBe("");
    expect(authHeaders()).toEqual({});
  });

  it.each([
    ["localStorage", "myzel-token"],
    ["localStorage", "understory-token"],
    ["sessionStorage", "understory-token"],
  ] as const)("moves a token kept by older versions in %s under %s", (store, key) => {
    window[store].setItem(key, "old-token");
    expect(getAuthToken()).toBe("old-token");
    expect(window[store].getItem(key)).toBeNull();
    expect(sessionStorage.getItem("myzel-token")).toBe("old-token");
  });

  it("falls back to memory when storage is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      setAuthToken("in-memory");
      expect(getAuthToken()).toBe("in-memory");
    } finally {
      Object.defineProperty(window, "sessionStorage", original);
      setAuthToken("");
    }
  });
});

describe("API calls", () => {
  it("resolves API paths against the page, so a proxy prefix is kept", () => {
    expect(apiUrl("/api/tree")).toBe(new URL("api/tree", document.baseURI).toString());
  });

  it("sends the token and parses JSON", async () => {
    const fake = installFakeApi({ "/api/types": ["API"] });
    setAuthToken("tok");
    expect(await api.config().catch((e) => e)).toBeInstanceOf(ApiError);
    expect(
      await fetch(apiUrl("/api/types"), { headers: authHeaders() }).then((r) => r.json())
    ).toEqual(["API"]);
    expect(fake.calls.at(-1)?.init?.headers).toEqual({ Authorization: "Bearer tok" });
    setAuthToken("");
  });

  it("reports the auth mode a 401 asks for", async () => {
    installFakeApi({ "/api/tree": json({ error: "unauthorized", mode: "profiles" }, 401) });
    const err = (await api.tree().catch((e) => e)) as ApiError;
    expect(err.status).toBe(401);
    expect(err.authMode).toBe("profiles");
  });

  it("copes with error bodies that are not JSON", async () => {
    installFakeApi({ "/api/tree": new Response("gateway timeout", { status: 504 }) });
    const err = (await api.tree().catch((e) => e)) as ApiError;
    expect(err.status).toBe(504);
    expect(err.authMode).toBeUndefined();
  });

  it("encodes query parameters", async () => {
    const fake = installFakeApi({ "/api/concept": {}, "/api/search": [], "/api/trace": {} });
    await api.concept("/a b.md");
    await api.search("x&y");
    await api.trace("id/1");
    expect(fake.calls.map((c) => c.path)).toEqual([
      "/api/concept?path=%2Fa%20b.md",
      "/api/search?q=x%26y",
      "/api/trace?id=id%2F1",
    ]);
  });
});
