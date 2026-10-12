import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProfileRegistry } from "../src/profiles.js";
import { runProfilesCommand } from "../src/profiles-commands.js";

let root: string;
let registry: ProfileRegistry;
let out: string[];
let err: string[];
const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
const run = (argv: string[], gitAutocommit = false) =>
  runProfilesCommand(argv, registry, io, { gitAutocommit });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "myzel-cli-"));
  registry = new ProfileRegistry(root);
  out = [];
  err = [];
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("profiles CLI commands", () => {
  it("creates, lists, rotates and removes profiles", async () => {
    expect(await run(["list"])).toBe(0);
    expect(out.join("\n")).toContain("No profiles");

    expect(await run(["create", "work"])).toBe(0);
    const key = out.find((l) => l.startsWith("api key: "))!.slice(9);
    expect((await registry.resolve(key))?.name).toBe("work");

    await fs.mkdir(path.join(root, "loose"));
    out = [];
    expect(await run(["list"])).toBe(0);
    expect(out.join("\n")).toMatch(/work\s+0 concepts/);
    expect(out.join("\n")).toContain('"create loose" adopts this directory');

    expect(await run(["rotate", "work"])).toBe(0);
    expect(await registry.resolve(key)).toBeNull();

    expect(await run(["remove", "work"])).toBe(0);
    expect(out.at(-1)).toContain("Its memory is still at");
    await expect(fs.stat(path.join(root, "work"))).resolves.toBeTruthy();
    await run(["create", "work"]);
    expect(await run(["remove", "work", "--purge"])).toBe(0);
    await expect(fs.stat(path.join(root, "work"))).rejects.toThrow();
  });

  it("refuses a profile whose history cannot be recorded, like the admin API", async () => {
    // A directory to adopt that is a repository with a config that runs programs.
    const dir = path.join(root, "work");
    await fs.mkdir(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "core.fsmonitor", "x"], { cwd: dir });
    expect(await run(["create", "work"], true)).toBe(1);
    expect(err.join("\n")).toContain("git autocommit cannot work");
    expect(await registry.list()).toEqual([]);
  });

  it("reports usage errors with a non-zero exit", async () => {
    expect(await run(["create"])).toBe(1);
    expect(err.at(-1)).toContain("create needs a profile name");
    expect(await run(["rotate", "ghost"])).toBe(1);
    expect(await run(["frobnicate"])).toBe(1);
    expect(err.at(-1)).toContain('Unknown command "frobnicate"');
    expect(await run([])).toBe(1);
    expect(await run(["--help"])).toBe(0);
    expect(out.at(-1)).toContain("Usage:");
  });
});
