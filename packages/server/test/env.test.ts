import { describe, expect, it } from "vitest";
import { envCount, isDemoMode, parseAllowedModels, resolveBindHost } from "../src/env.js";

describe("resolveBindHost", () => {
  it("binds loopback unless HOST names an address — blank counts as unset", () => {
    expect(resolveBindHost({})).toBe("127.0.0.1");
    expect(resolveBindHost({ HOST: "" })).toBe("127.0.0.1");
    expect(resolveBindHost({ HOST: "  " })).toBe("127.0.0.1");
    expect(resolveBindHost({ HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });
});

describe("envCount", () => {
  it.each([
    [undefined, 60],
    ["", 60],
    ["  ", 60],
    ["abc", 60],
    ["-1", 60],
    ["1.5", 60],
    ["0", 0],
    ["120", 120],
  ])("%j → %i", (raw, expected) => {
    expect(envCount(raw, 60)).toBe(expected);
  });
});

describe("parseAllowedModels", () => {
  it("splits and trims, keeping case", () => {
    expect(parseAllowedModels(" Model-A, ,model-b ")).toEqual(["Model-A", "model-b"]);
    expect(parseAllowedModels(undefined)).toEqual([]);
  });
});

describe("isDemoMode", () => {
  it("is on only for DEMO_MODE=true", () => {
    expect(isDemoMode({ DEMO_MODE: "true" })).toBe(true);
    expect(isDemoMode({ DEMO_MODE: "1" })).toBe(false);
    expect(isDemoMode({})).toBe(false);
  });
});
