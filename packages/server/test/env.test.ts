import { describe, expect, it } from "vitest";
import { envCount, parseAllowedModels } from "../src/env.js";

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
