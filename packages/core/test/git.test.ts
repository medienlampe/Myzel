import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { createBundleGit, unsafeRepoConfigKeys } from "../src/okf/git.js";

let root: string;
let marker: string;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();

/** An executable script that leaves a marker file if git ever runs it. */
async function plantScript(name: string): Promise<string> {
  const script = path.join(root, ".git", name);
  await fs.writeFile(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });
  return script;
}

const commitCount = () => {
  try {
    return Number(git("rev-list", "--count", "HEAD"));
  } catch {
    return 0; // no commits yet
  }
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-git-"));
  marker = path.join(root, "..", `${path.basename(root)}-pwned`);
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(marker, { force: true });
});

describe("git autocommit", () => {
  it("commits a mutation, leaving traces out of history", async () => {
    await fs.mkdir(path.join(root, ".traces"));
    await fs.writeFile(path.join(root, ".traces", "t.json"), "{}");
    const kb = new KnowledgeBase(root, { gitAutocommit: true });
    await kb.writeConcept("/a.md", { type: "T" }, "body", "Added [a](/a.md).");
    expect(commitCount()).toBe(1);
    const files = git("ls-files");
    expect(files).toContain("a.md");
    expect(files).not.toContain(".traces");
  });

  it("refuses to commit into a repository whose config runs programs (fsmonitor)", async () => {
    git("config", "core.fsmonitor", await plantScript("monitor.sh"));
    const kb = new KnowledgeBase(root, { gitAutocommit: true });
    await kb.writeConcept("/a.md", { type: "T" }, "body", "Added a.");
    await expect(fs.access(marker)).rejects.toThrow();
    expect(commitCount()).toBe(0);
    // The knowledge write itself still succeeded; only the commit was skipped.
    expect((await kb.readConcept("/a.md")).body).toContain("body");
  });

  it("refuses clean filters wired up through .gitattributes", async () => {
    git("config", "filter.evil.clean", await plantScript("clean.sh"));
    await fs.writeFile(path.join(root, ".gitattributes"), "*.md filter=evil\n");
    const kb = new KnowledgeBase(root, { gitAutocommit: true });
    await kb.writeConcept("/a.md", { type: "T" }, "body", "Added a.");
    await expect(fs.access(marker)).rejects.toThrow();
    expect(commitCount()).toBe(0);
  });

  it("never runs repository hooks", async () => {
    await fs.mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\ntouch "${marker}"\n`,
      {
        mode: 0o755,
      }
    );
    const kb = new KnowledgeBase(root, { gitAutocommit: true });
    await kb.writeConcept("/a.md", { type: "T" }, "body", "Added a.");
    await expect(fs.access(marker)).rejects.toThrow();
    expect(commitCount()).toBe(1);
  });

  it("flags every command-running key family and ignores harmless ones", async () => {
    for (const [key, value] of [
      ["core.sshCommand", "x"],
      ["diff.evil.textconv", "x"],
      ["gpg.program", "x"],
      ["gpg.ssh.program", "x"],
      ["include.path", "/tmp/x"],
      ["alias.st", "!x"],
      ["core.editor", "x"],
      ["user.signingkey", "harmless"],
    ]) {
      git("config", key, value);
    }
    expect((await unsafeRepoConfigKeys(createBundleGit(root))).sort()).toEqual([
      "alias.st",
      "core.editor",
      "core.sshcommand",
      "diff.evil.textconv",
      "gpg.program",
      "gpg.ssh.program",
      "include.path",
    ]);
  });
});
