import { describe, expect, it } from "vitest";
import { isStale, lastChange, sources, status, trustTier } from "../src/okf";

describe("OKF v0.2 families for display", () => {
  it("derives the trust tier from verified, a bare mapping included (§5.2, §5.3)", () => {
    expect(trustTier({})).toBe("unverified");
    expect(trustTier({ verified: { by: "human:ana", at: "x" } })).toBe("human-reviewed");
    expect(trustTier({ verified: [{ by: "process:nightly" }] })).toBe("machine-confirmed");
    expect(trustTier({ verified: [{ by: "process:nightly" }, { by: "human:ana" }] })).toBe(
      "human-reviewed"
    );
    expect(trustTier({ verified: ["nonsense", { at: "x" }] })).toBe("unverified");
  });

  it("reads status and staleness", () => {
    expect(status({})).toBe("stable");
    expect(status({ status: "deprecated" })).toBe("deprecated");
    const now = Date.parse("2026-10-13T00:00:00Z");
    expect(isStale({ stale_after: "2026-10-01T00:00:00Z" }, now)).toBe(true);
    expect(isStale({ stale_after: "2026-12-01T00:00:00Z" }, now)).toBe(false);
    expect(isStale({ stale_after: "whenever" }, now)).toBe(false);
    expect(isStale({}, now)).toBe(false);
  });

  it("prefers generated over the legacy timestamp", () => {
    expect(lastChange({ generated: { by: "myzel/x", at: "2026-01-01T00:00:00Z" } })).toEqual({
      by: "myzel/x",
      at: "2026-01-01T00:00:00Z",
    });
    expect(lastChange({ timestamp: "2026-01-01T00:00:00Z" })).toEqual({
      at: "2026-01-01T00:00:00Z",
    });
    expect(lastChange({ generated: {}, timestamp: "t" })).toEqual({ at: "t" });
    expect(lastChange({ generated: "odd" })).toBeNull();
  });

  it("keeps only sources that name a resource", () => {
    expect(
      sources({
        sources: [{ id: "a", resource: "https://x", title: "X" }, { title: "no resource" }, "odd"],
      })
    ).toEqual([{ id: "a", resource: "https://x", title: "X", author: undefined }]);
    expect(sources({ sources: "nope" })).toEqual([]);
  });
});
