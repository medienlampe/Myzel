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

  it("commits only what the mutation touched, never the user's own work", async () => {
    const kb = new KnowledgeBase(root, { gitAutocommit: true });
    await kb.writeConcept("/notes/a.md", { type: "T" }, "body", "Added a.");
    await fs.writeFile(path.join(root, "draft.md"), "---\ntype: T\n---\nhalf-finished\n");
    await fs.writeFile(path.join(root, "staged.md"), "---\ntype: T\n---\nmine\n");
    git("add", "staged.md");
    await kb.writeConcept("/notes/b.md", { type: "T" }, "body", "Added b.");
    await kb.deleteConcept("/notes/a.md", "Removed a.");
    expect(commitCount()).toBe(3);
    const files = git("ls-files").split("\n");
    expect(files).toEqual(
      expect.arrayContaining(["notes/b.md", "notes/index.md", "index.md", "log.md"])
    );
    expect(files).not.toContain("notes/a.md");
    expect(files).not.toContain("draft.md");
    // Still staged for the user's own commit, but not part of any of ours.
    expect(git("diff", "--cached", "--name-only")).toBe("staged.md");
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

  it("refuses filters hidden in .git/config.worktree", async () => {
    git("config", "extensions.worktreeConfig", "true");
    git("config", "--worktree", "filter.evil.clean", await plantScript("clean.sh"));
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
      ["core.worktree", "/home"],
      ["filter.a b.clean", "x"],
      ["user.signingkey", "harmless"],
    ]) {
      git("config", key, value);
    }
    expect((await unsafeRepoConfigKeys(createBundleGit(root))).sort()).toEqual([
      "alias.st",
      "core.editor",
      "core.sshcommand",
      "core.worktree",
      "diff.evil.textconv",
      "filter.a b.clean",
      "gpg.program",
      "gpg.ssh.program",
      "include.path",
    ]);
  });
});

describe("ensureGitReady", () => {
  let plain: string;

  beforeEach(async () => {
    plain = await fs.mkdtemp(path.join(os.tmpdir(), "okf-plain-"));
  });

  afterEach(async () => {
    await fs.rm(plain, { recursive: true, force: true });
  });

  const gitIn = (dir: string, ...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();

  it("initializes a bundle that is not a repository, with a first commit", async () => {
    await new KnowledgeBase(plain, { gitAutocommit: true }).ensureGitReady();
    expect(gitIn(plain, "log", "--format=%s")).toBe("chore: initialize memory history");
  });

  it("gives a bundle nested in another repository its own one", async () => {
    // `root` (from the outer beforeEach) is a repository; nest a bundle inside it.
    const nested = path.join(root, "memory");
    await fs.mkdir(nested);
    await new KnowledgeBase(nested, { gitAutocommit: true }).ensureGitReady();
    expect(gitIn(nested, "rev-parse", "--show-toplevel")).toBe(await fs.realpath(nested));
    expect(commitCount()).toBe(0); // the outer repository got no commit
  });

  it("refuses at startup when the repository config can run programs", async () => {
    git("config", "core.fsmonitor", "/tmp/whatever");
    await expect(new KnowledgeBase(root, { gitAutocommit: true }).ensureGitReady()).rejects.toThrow(
      /core\.fsmonitor/
    );
  });

  it("initializes only once — later startups add no commits", async () => {
    const kb = new KnowledgeBase(plain, { gitAutocommit: true });
    await kb.ensureGitReady();
    await kb.ensureGitReady();
    expect(gitIn(plain, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("treats a git worktree as the bundle's own repository", async () => {
    git("commit", "--allow-empty", "-q", "-m", "base");
    const worktree = path.join(plain, "wt");
    git("worktree", "add", "-q", worktree);
    await new KnowledgeBase(worktree, { gitAutocommit: true }).ensureGitReady();
    expect(gitIn(worktree, "log", "--format=%s")).toBe("base"); // no "initialize" commit
  });

  it("is a no-op without gitAutocommit", async () => {
    await new KnowledgeBase(plain).ensureGitReady();
    await expect(fs.access(path.join(plain, ".git"))).rejects.toThrow();
  });
});
