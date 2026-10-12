import { describe, expect, it } from "vitest";
import { parseDuration } from "../src/util/duration.js";

describe("parseDuration", () => {
  it.each([
    ["30s", 30_000],
    ["15m", 900_000],
    ["1.5h", 5_400_000],
    ["250ms", 250],
  ])("%s → %i ms", (raw, ms) => {
    expect(parseDuration(raw)).toBe(ms);
  });

  it("caps at the longest delay a timer can hold, instead of firing at once", () => {
    expect(parseDuration("30d")).toBe(2_147_483_647);
  });

  it.each([undefined, "", "abc", "5 parsecs", "0s", "0"])("rejects %j", (raw) => {
    expect(parseDuration(raw)).toBeNull();
  });
});
