import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Bundle,
  BundleError,
  KnowledgeBase,
  contentVersion,
  parseDoc,
  serializeDoc,
  replaceSection,
  validateBundle,
  readLog,
  searchBundle,
  lintBundle,
  regenerateIndex,
  pruneEmptyDirs,
  familyIssues,
  isOkfDatetime,
  isActor,
} from "../src/okf/index.js";

let root: string;
let kb: KnowledgeBase;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-test-"));
  kb = new KnowledgeBase(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("frontmatter round-trip", () => {
  it("quotes strings the YAML 1.2 core schema would retype", () => {
    const fm = { type: "T", title: "0o17", tags: ["0x1F", "yes"] };
    expect(parseDoc(serializeDoc(fm, "b")).frontmatter).toEqual(fm);
  });

  it("writes and reads a concept preserving fields, stamping generated (v0.2 §5.2)", async () => {
    const written = await kb.writeConcept(
      "/tables/customers.md",
      {
        type: "BigQuery Table",
        title: "Customers",
        description: "Core customer table",
        tags: ["crm"],
        custom_key: 42,
      },
      "# Schema\n\nid, name, email",
      "Added customers table concept."
    );
    expect(written.frontmatter.generated).toEqual({ by: "process:myzel", at: expect.any(String) });
    expect(isOkfDatetime(written.frontmatter.generated?.at)).toBe(true);
    expect(written.frontmatter).not.toHaveProperty("timestamp");

    const read = await kb.readConcept("/tables/customers.md");
    expect(read.frontmatter.type).toBe("BigQuery Table");
    expect(read.frontmatter.custom_key).toBe(42);
    expect(read.body).toContain("# Schema");
  });

  it("rejects concepts without a type", async () => {
    await expect(
      kb.writeConcept("/x.md", { type: "" } as never, "body", "log")
    ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
  });

  it("rejects reserved filenames as concepts", async () => {
    await expect(kb.writeConcept("/index.md", { type: "T" }, "body", "log")).rejects.toMatchObject({
      code: "RESERVED_NAME",
    });
    await expect(
      kb.writeConcept("/sub/log.md", { type: "T" }, "body", "log")
    ).rejects.toMatchObject({ code: "RESERVED_NAME" });
  });

  it("is permissive reading unknown keys and types", () => {
    const { frontmatter } = parseDoc(`---\ntype: Alien Format\nweird: [1, 2]\n---\nbody`);
    expect(frontmatter.type).toBe("Alien Format");
    expect(frontmatter.weird).toEqual([1, 2]);
  });

  it("round-trips values exactly as written — dates and yes/no stay strings", async () => {
    await fs.writeFile(
      path.join(root, "d.md"),
      "---\ntype: T\nreleased: 2026-01-01\nflag: yes\n---\nbody\n"
    );
    await kb.patchConcept("/d.md", { frontmatter: { title: "D" } }, "Titled d.");
    const { frontmatter } = await kb.readConcept("/d.md");
    expect(frontmatter.released).toBe("2026-01-01");
    expect(frontmatter.flag).toBe("yes");
    // …and stay readable by YAML 1.1 tools, which would otherwise coerce them.
    const raw = await fs.readFile(path.join(root, "d.md"), "utf-8");
    expect(raw).toContain("released: '2026-01-01'");
    expect(raw).toContain("flag: 'yes'");
  });

  it("keeps a hand-edited file's comments, quoting, flow lists and order on a patch", async () => {
    const hand =
      '---\n# owned by the payments team\ntype: T\ntags: [red, blue] # keep short\nnote: "quoted"\ntitle: Alpha\n---\nbody\n';
    await fs.writeFile(path.join(root, "h.md"), hand);
    await kb.patchConcept("/h.md", { frontmatter: { title: "Beta" } }, "Renamed h.");
    const raw = await fs.readFile(path.join(root, "h.md"), "utf-8");
    expect(raw).toContain(
      "# owned by the payments team\ntype: T\ntags: [ red, blue ] # keep short"
    );
    expect(raw).toContain('note: "quoted"\ntitle: Beta\n');
    expect(raw).toMatch(/generated:/);

    await kb.patchConcept(
      "/h.md",
      { frontmatter: { tags: ["red", "blue", "green"], note: null } },
      "Tagged."
    );
    const again = await fs.readFile(path.join(root, "h.md"), "utf-8");
    expect(again).toContain("tags: [ red, blue, green ]");
    expect(again).not.toContain("note:");
  });

  it("rejects frontmatter that is not a mapping or never closed", () => {
    expect(() => parseDoc("---\n- a\n- b\n---\nbody")).toThrow(/mapping/);
    expect(() => parseDoc("---\ntype: T\nbody without a closing fence")).toThrow(/never closed/);
  });

  it("round-trips an empty body without adding blank lines", () => {
    const { body } = parseDoc(serializeDoc({ type: "T" }, ""));
    expect(body).toBe("");
    expect(serializeDoc({ type: "T" }, "")).toBe("---\ntype: T\n---\n\n");
  });

  it("keeps a body's leading blank line across rewrites", async () => {
    await kb.writeConcept("/b.md", { type: "T" }, "\nfirst paragraph", "Added b.");
    await kb.patchConcept("/b.md", { frontmatter: { title: "B" } }, "Titled b.");
    expect((await kb.readConcept("/b.md")).body).toBe("\nfirst paragraph\n");
  });

  it("reports unreadable frontmatter as a BundleError, not a crash", async () => {
    await fs.writeFile(path.join(root, "bad.md"), "---\ntype: T\ntype: again\n---\nbody\n");
    await expect(kb.readConcept("/bad.md")).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
  });

  it("never evaluates JavaScript frontmatter", () => {
    const g = globalThis as { __okfEvaluated?: boolean };
    for (const fence of ["---js", "---javascript"]) {
      expect(() =>
        parseDoc(`${fence}\n(globalThis.__okfEvaluated = true, { type: "T" })\n---\nbody`)
      ).toThrow(/only YAML/);
    }
    expect(g.__okfEvaluated).toBeUndefined();
  });
});

describe("sandbox", () => {
  it("refuses reserved names in any case — LOG.md is log.md on macOS and Windows", async () => {
    for (const p of ["/LOG.md", "/sub/Index.md"]) {
      await expect(kb.writeConcept(p, { type: "T" }, "x", "s")).rejects.toMatchObject({
        code: "RESERVED_NAME",
      });
    }
  });

  it("rejects .. escapes", () => {
    const bundle = new Bundle(root);
    expect(() => bundle.resolve("/../../etc/passwd")).toThrow(BundleError);
    expect(() => bundle.resolve("../outside.md")).toThrow(BundleError);
  });

  it("allows normal nested paths", () => {
    const bundle = new Bundle(root);
    expect(bundle.resolve("/a/b/c.md")).toBe(path.join(root, "a/b/c.md"));
  });

  it("accepts OS-absolute paths inside the bundle (directory-walk output)", () => {
    const bundle = new Bundle(root);
    const inside = path.join(root, "a/b/c.md");
    expect(bundle.resolve(inside)).toBe(inside);
    expect(bundle.resolve(root)).toBe(root);
  });

  it("never resolves outside the root, whatever the input looks like", () => {
    const bundle = new Bundle(root);
    // Hostile inputs either throw or fall back to bundle-relative interpretation
    // (which keeps them under the root). Which of the two happens depends on how
    // deep the root sits, so the invariant to assert is containment, not throwing.
    // The ".." strings are built by concatenation, not path.join, so the segments
    // survive into resolve() and exercise the normalize-before-decide path — the
    // shape that used to slip through the raw-prefix test.
    const hostile = [
      `${root}/../../etc/passwd`,
      `${root}/x/../../../etc/shadow`,
      `${root}/../${path.basename(root)}-sibling/secret.md`,
      `${root}-evil/secret.md`,
      "/etc/passwd",
      "//etc/passwd",
      "/../../etc/passwd",
      "../outside.md",
    ];
    for (const input of hostile) {
      let resolved: string | null = null;
      try {
        resolved = bundle.resolve(input);
      } catch (err) {
        expect(err).toBeInstanceOf(BundleError);
        expect((err as BundleError).code).toBe("OUTSIDE_BUNDLE");
      }
      if (resolved !== null) {
        expect(
          resolved === root || resolved.startsWith(root + path.sep),
          `${input} resolved outside the bundle: ${resolved}`
        ).toBe(true);
      }
    }
  });

  it("refuses to read through a symlink that points outside the bundle", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "okf-outside-"));
    try {
      await fs.writeFile(path.join(outside, "secret.md"), "---\ntype: Secret\n---\n\ntop secret\n");
      await fs.symlink(path.join(outside, "secret.md"), path.join(root, "leak.md"));

      await expect(kb.readConcept("/leak.md")).rejects.toMatchObject({
        code: "OUTSIDE_BUNDLE",
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses to write through a symlinked directory that points outside the bundle", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "okf-outside-"));
    try {
      await fs.symlink(outside, path.join(root, "escape"), "dir");

      await expect(
        kb.writeConcept("/escape/planted.md", { type: "T" }, "body", "log")
      ).rejects.toMatchObject({ code: "OUTSIDE_BUNDLE" });
      await expect(fs.access(path.join(outside, "planted.md"))).rejects.toThrow();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps symlinked files and directories out of the tree, search, graph and index", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "okf-outside-"));
    try {
      await fs.writeFile(
        path.join(outside, "host.md"),
        "---\ntype: Secret\ntitle: Host secret\ndescription: leaked\n---\nhostonly\n"
      );
      await fs.symlink(path.join(outside, "host.md"), path.join(root, "link.md"));
      await fs.symlink(outside, path.join(root, "linkdir"), "dir");
      await kb.writeConcept("/real.md", { type: "T" }, "body", "Added real.");

      const tree = JSON.stringify(await kb.listTree());
      expect(tree).not.toContain("link");
      expect(tree).not.toContain("Host secret");
      expect(await kb.bundle.listConceptPaths()).toEqual(["/real.md"]);
      expect(await searchBundle(kb.bundle, "hostonly")).toEqual([]);
      const index = await fs.readFile(path.join(root, "index.md"), "utf-8");
      expect(index).not.toContain("Host secret");
      expect(index).not.toContain("linkdir");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses to regenerate an index inside a symlinked directory", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "okf-outside-"));
    try {
      await fs.symlink(outside, path.join(root, "escape"), "dir");
      await expect(regenerateIndex(kb.bundle, "/escape")).rejects.toMatchObject({
        code: "OUTSIDE_BUNDLE",
      });
      await expect(fs.access(path.join(outside, "index.md"))).rejects.toThrow();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("never writes through a pre-planted temp-file symlink", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "okf-outside-"));
    try {
      const victim = path.join(outside, "victim");
      await fs.writeFile(victim, "original");
      // Old temp names were predictable (.<name>.<pid>.<counter>.tmp).
      for (let i = 0; i < 20; i++) {
        await fs.symlink(victim, path.join(root, `.index.md.${process.pid}.${i}.tmp`));
      }
      await kb.writeConcept("/a.md", { type: "T" }, "x", "Added a.");
      expect(await fs.readFile(victim, "utf-8")).toBe("original");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("creates no directories outside the bundle before refusing a write", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "okf-outside-"));
    try {
      await fs.symlink(outside, path.join(root, "escape"), "dir");
      await expect(
        kb.writeConcept("/escape/new/deep/x.md", { type: "T" }, "body", "log")
      ).rejects.toMatchObject({ code: "OUTSIDE_BUNDLE" });
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses hidden paths and non-markdown files through the concept API", async () => {
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".git", "config"), "url = https://token@host/x");
    await fs.writeFile(path.join(root, "notes.txt"), "plain");
    await expect(kb.readConcept("/.git/config")).rejects.toMatchObject({ code: "HIDDEN_PATH" });
    await expect(kb.readConcept("/notes.txt")).rejects.toMatchObject({ code: "NOT_MARKDOWN" });
    await expect(
      kb.writeConcept("/.hidden/x.md", { type: "T" }, "body", "log")
    ).rejects.toMatchObject({ code: "HIDDEN_PATH" });
  });

  it("refuses a concept symlink that resolves into a hidden location", async () => {
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".git", "config"), "url = https://user:SECRET@host/x");
    await fs.mkdir(path.join(root, "notes"));
    await fs.symlink("../.git/config", path.join(root, "notes", "leak.md"));
    await expect(kb.readConcept("/notes/leak.md")).rejects.toMatchObject({ code: "HIDDEN_PATH" });
  });

  it("does not follow a symlinked log.md out of the bundle", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "okf-outside-"));
    try {
      await fs.writeFile(path.join(outside, "victim.md"), "original");
      await fs.symlink(path.join(outside, "victim.md"), path.join(root, "log.md"));
      await expect(kb.readLog()).rejects.toMatchObject({ code: "OUTSIDE_BUNDLE" });
      expect(await fs.readFile(path.join(outside, "victim.md"), "utf-8")).toBe("original");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses to delete through a symlinked directory that points outside the bundle", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "okf-outside-"));
    try {
      await fs.writeFile(path.join(outside, "victim.md"), "---\ntype: T\n---\nbody\n");
      await fs.symlink(outside, path.join(root, "escape"), "dir");

      await expect(kb.deleteConcept("/escape/victim.md", "log")).rejects.toMatchObject({
        code: "OUTSIDE_BUNDLE",
      });
      await expect(fs.access(path.join(outside, "victim.md"))).resolves.toBeUndefined();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("still works when the bundle root itself is reached through a symlink", async () => {
    // os.tmpdir() is itself symlinked on macOS (/var → /private/var), so the
    // real-path check must compare against the RESOLVED root, not the given one.
    const linkRoot = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "okf-link-")), "bundle");
    await fs.symlink(root, linkRoot, "dir");
    const linked = new KnowledgeBase(linkRoot);

    await linked.writeConcept("/a/b.md", { type: "T", title: "B" }, "body", "log");
    expect((await linked.readConcept("/a/b.md")).frontmatter.title).toBe("B");
  });
});

describe("index regeneration (spec §8)", () => {
  it("indexes a directory whose name ends in .md", async () => {
    await kb.writeConcept("/g.md/x.md", { type: "T" }, "x", "s");
    expect(await fs.readFile(path.join(root, "g.md", "index.md"), "utf-8")).toContain("x.md");
  });

  it("keeps each index entry on one line with a valid link", async () => {
    await kb.writeConcept(
      "/my notes.md",
      { type: "T", title: "A [draft] title", description: "line one\nline two" },
      "body",
      "Added notes."
    );
    const index = await fs.readFile(path.join(root, "index.md"), "utf-8");
    expect(index).toContain("* [A \\[draft\\] title](my%20notes.md) - line one line two\n");
    await kb.writeConcept("/C#(1).md", { type: "T", title: "Ends in \\" }, "b", "Added C#.");
    const again = await fs.readFile(path.join(root, "index.md"), "utf-8");
    expect(again).toContain("* [Ends in \\\\](C%23%281%29.md)\n");
  });

  it("generates bullet lists with titles and descriptions, root gets okf_version", async () => {
    await kb.writeConcept(
      "/tables/customers.md",
      { type: "Table", title: "Customers", description: "Customer records" },
      "body",
      "add"
    );
    const rootIndex = await fs.readFile(path.join(root, "index.md"), "utf-8");
    expect(rootIndex).toContain('okf_version: "0.2"');
    expect(rootIndex).toContain("## Memory Segments");
    // Segment lines summarize contents: count, types, titles — not just "subdirectory".
    expect(rootIndex).toContain("* [tables](tables/) - 1 concept (Table): Customers");

    const dirIndex = await fs.readFile(path.join(root, "tables/index.md"), "utf-8");
    expect(dirIndex).toContain("* [Customers](customers.md) - Customer records");
    // index.md must not have frontmatter outside root
    expect(dirIndex.startsWith("---")).toBe(false);
  });

  it("regenerates the whole ancestor chain after nested writes", async () => {
    await kb.writeConcept("/a/b/deep.md", { type: "T", title: "Deep" }, "x", "add deep");
    for (const p of ["index.md", "a/index.md", "a/b/index.md"]) {
      await expect(fs.access(path.join(root, p))).resolves.toBeUndefined();
    }
  });
});

describe("pruning husk directories", () => {
  it("removes a directory left holding only index.md, and its emptied parents", async () => {
    await kb.writeConcept("/a/b/c.md", { type: "T", title: "C" }, "body", "Added c.");
    await kb.writeConcept("/keep.md", { type: "T", title: "Keep" }, "body", "Added keep.");
    await kb.deleteConcept("/a/b/c.md", "Removed c.");
    await expect(fs.access(path.join(root, "a"))).rejects.toThrow();
    const rootIndex = await fs.readFile(path.join(root, "index.md"), "utf-8");
    expect(rootIndex).not.toContain("(a/)");
    expect(rootIndex).toContain("(keep.md)");
  });

  it("leaves hand-made folders elsewhere in the bundle alone", async () => {
    await fs.mkdir(path.join(root, "drafts"));
    await fs.mkdir(path.join(root, "handdir"));
    await fs.writeFile(path.join(root, "handdir", "index.md"), "# My notes\n");
    await kb.writeConcept("/notes/a.md", { type: "T" }, "body", "Added a.");
    await kb.patchConcept("/notes/a.md", { replaceBody: "new" }, "Changed a.");
    await expect(fs.access(path.join(root, "drafts"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "handdir", "index.md"))).resolves.toBeUndefined();
  });

  it("never fails a mutation over a folder it cannot read or clean up", async () => {
    await fs.mkdir(path.join(root, "locked"));
    await fs.chmod(path.join(root, "locked"), 0o000);
    await fs.mkdir(path.join(root, "odd", "index.md"), { recursive: true });
    await fs.writeFile(path.join(root, "odd", "index.md", "x.txt"), "a directory named index.md");
    try {
      await kb.writeConcept("/ok.md", { type: "T" }, "body", "Added ok.");
      expect(await kb.readLog()).toHaveLength(1); // index, log (and commit) still happened
      await expect(fs.access(path.join(root, "odd", "index.md", "x.txt"))).resolves.toBeUndefined();
    } finally {
      await fs.chmod(path.join(root, "locked"), 0o755);
    }
  });

  it("keeps directories with any other content, hidden directories and the root", async () => {
    await fs.mkdir(path.join(root, "notes"));
    await fs.writeFile(path.join(root, "notes", "index.md"), "# Notes\n");
    await fs.writeFile(path.join(root, "notes", ".keep"), "");
    await fs.mkdir(path.join(root, ".traces"));
    expect(await pruneEmptyDirs(kb.bundle, "/notes")).toEqual([]);
    expect(await pruneEmptyDirs(kb.bundle, "/.traces")).toEqual([]);
    expect(await pruneEmptyDirs(kb.bundle, "/")).toEqual([]);
    await expect(fs.access(path.join(root, "notes", "index.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, ".traces"))).resolves.toBeUndefined();
  });
});

describe("log (spec §9)", () => {
  it("appends newest-first with action bullets under ISO date headings", async () => {
    await kb.writeConcept("/one.md", { type: "T", title: "One" }, "x", "Created one.");
    await kb.writeConcept("/one.md", { type: "T", title: "One" }, "y", "Updated one.");
    await kb.deleteConcept("/one.md", "Removed one.");

    const log = await fs.readFile(path.join(root, "log.md"), "utf-8");
    expect(log).toMatch(/^# Directory Update Log/);
    expect(log).toMatch(/## \d{4}-\d{2}-\d{2}/);

    const entries = await readLog(kb.bundle);
    expect(entries.map((e) => e.action)).toEqual(["Deletion", "Update", "Creation"]);
    expect(entries[0].summary).toBe("Removed one.");
  });

  it("keeps a CRLF log's history on the next append", async () => {
    await kb.writeConcept("/one.md", { type: "T" }, "x", "Created one.");
    const file = path.join(root, "log.md");
    await fs.writeFile(file, (await fs.readFile(file, "utf-8")).replace(/\n/g, "\r\n"));
    await kb.writeConcept("/two.md", { type: "T" }, "x", "Created two.");
    expect((await readLog(kb.bundle)).map((e) => e.summary)).toEqual([
      "Created two.",
      "Created one.",
    ]);
  });
});

describe("writes against hand edits", () => {
  it("refuses a write whose expected version no longer matches the file", async () => {
    const first = await kb.writeConcept("/v.md", { type: "T" }, "one", "Added v.");
    const seen = contentVersion(first.raw);
    await fs.writeFile(path.join(root, "v.md"), "---\ntype: T\n---\nhand\n");
    await expect(
      kb.writeConcept("/v.md", { type: "T" }, "two", "Rewrote v.", undefined, {
        expectedVersion: seen,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await kb.readConcept("/v.md")).body).toBe("hand\n");
    await expect(
      kb.writeConcept("/v.md", { type: "T" }, "x", "Created.", undefined, { expectedVersion: null })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("carries verified forward on a rewrite, but lets a patch remove it", async () => {
    const verified = { by: "human:ana", at: "2026-06-25T09:00:00Z" };
    await kb.writeConcept("/c.md", { type: "T", verified }, "one", "Added c.");
    await kb.writeConcept("/c.md", { type: "T" }, "two", "Rewrote c.");
    expect((await kb.readConcept("/c.md")).frontmatter.verified).toEqual(verified);
    await kb.patchConcept("/c.md", { frontmatter: { verified: null } }, "Unverified c.");
    expect((await kb.readConcept("/c.md")).frontmatter.verified).toBeUndefined();
  });
});

describe("patch", () => {
  it("treats a short fence inside a longer one as content", () => {
    const body = "# A\n\n````md\n```\n# B\n```\n````\n\n# C\n\nc\n";
    expect(replaceSection(body, "A", "new a")).toBe("# A\n\nnew a\n\n# C\n\nc\n");
  });

  it("does not mistake a # comment inside a code block for a heading", () => {
    const body = "# Setup\n\n```bash\n# install deps\nnpm ci\n```\n\n# Usage\n\nrun it\n";
    const out = replaceSection(body, "Setup", "new setup");
    expect(out).toBe("# Setup\n\nnew setup\n\n# Usage\n\nrun it\n");
  });

  it("merges frontmatter and replaces a named section only", async () => {
    await kb.writeConcept(
      "/doc.md",
      { type: "T", title: "Doc", tags: ["a"] },
      "intro text\n\n# Schema\n\nold schema\n\n# Examples\n\nkeep me",
      "add"
    );
    const patched = await kb.patchConcept(
      "/doc.md",
      {
        frontmatter: { tags: ["a", "b"] },
        replaceSection: { heading: "Schema", content: "new schema" },
      },
      "Updated schema section."
    );
    expect(patched.frontmatter.tags).toEqual(["a", "b"]);
    expect(patched.body).toContain("new schema");
    expect(patched.body).not.toContain("old schema");
    expect(patched.body).toContain("keep me");
    expect(patched.body).toContain("intro text");
  });

  it("appends the section when the heading is absent", () => {
    const out = replaceSection("just a body", "Citations", "[1] [X](https://x.com)");
    expect(out).toContain("# Citations");
    expect(out).toContain("[1] [X](https://x.com)");
    expect(out).toContain("just a body");
  });
});

// Ported from upstream understory, thecodacus/understory#35 by @mebagwell.
describe("replaceSection at any heading level", () => {
  it("replaces under a ## heading instead of appending a duplicate section", () => {
    const body = "# Title\n\nIntro.\n\n## Goals\n\nold\n\n## Notes\n\nn1\n";
    expect(replaceSection(body, "## Goals", "new goals")).toBe(
      "# Title\n\nIntro.\n\n## Goals\n\nnew goals\n\n## Notes\n\nn1\n"
    );
  });

  it("replaces nested subsections up to the next same-or-higher heading", () => {
    const body = "## Goals\n\na\n\n### Detail\n\nd\n\n## Notes\n\nn\n";
    expect(replaceSection(body, "Goals", "fresh")).toBe("## Goals\n\nfresh\n\n## Notes\n\nn\n");
  });

  it("matches a heading with a closing hash sequence, but not hashes glued to the title", () => {
    const body = "# Title\n\n## Goals ##\n\nold\n\n## Notes\n\nn\n";
    expect(replaceSection(body, "## Goals", "new")).toBe(
      "# Title\n\n## Goals ##\n\nnew\n\n## Notes\n\nn\n"
    );
    expect(replaceSection("## Goals##\n\nx\n", "Goals", "y")).toContain("# Goals\n\ny");
  });

  it("drops a repeated heading at the top of the new content", () => {
    expect(
      replaceSection("# T\n\n## Gotchas\n\nold\n", "Gotchas", "## Gotchas ##\n\n- fresh")
    ).toBe("# T\n\n## Gotchas\n\n- fresh\n");
  });

  it("refuses an ambiguous heading instead of editing the first match", () => {
    const body = "## A\n\nx\n\n## B\n\nx\n\n## A\n\ny\n";
    expect(() => replaceSection(body, "A", "z")).toThrow(BundleError);
    expect(() => replaceSection(body, "A", "z")).toThrow(/appears 2 times/);
  });

  it("ignores headings inside a fenced code block at any level", () => {
    const fence = "```";
    const body = `# T\n\n## Setup\n\n${fence}bash\n## not a heading\n${fence}\n\n## Run\n\nr\n`;
    expect(replaceSection(body, "Setup", "new")).toBe("# T\n\n## Setup\n\nnew\n\n## Run\n\nr\n");
  });
});

describe("OKF v0.2 frontmatter on write", () => {
  it("records the writer as generated.by and replaces a legacy timestamp", async () => {
    await fs.writeFile(
      path.join(root, "old.md"),
      "---\ntype: T\ntimestamp: '2026-01-01T00:00:00Z'\n---\nBody.\n"
    );
    const patched = await kb.patchConcept(
      "/old.md",
      { replaceBody: "New." },
      "patch",
      "myzel/deepseek-chat"
    );
    expect(patched.frontmatter.generated?.by).toBe("myzel/deepseek-chat");
    const raw = await fs.readFile(path.join(root, "old.md"), "utf-8");
    expect(raw).not.toContain("timestamp");
    expect(raw).toContain("generated:");
  });

  it("keeps the structured v0.2 families", async () => {
    const written = await kb.writeConcept(
      "/rev.md",
      {
        type: "Attested Computation",
        runtime: "bigquery",
        parameters: [{ name: "year", type: "integer", required: true }],
        executor: { resource: "references/run.md", receipt: ["job_id"] },
        sources: [{ id: "policy", resource: "https://wiki.example/policy", title: "Policy" }],
        usage_window: { from: "2026-06-01T00:00:00Z", to: "2026-06-30T00:00:00Z" },
        verified: { by: "human:ana", at: "2026-06-25T09:00:00Z" },
      },
      "# Computation\n\n    SELECT 1",
      "add"
    );
    expect((await kb.readConcept("/rev.md")).frontmatter).toMatchObject({
      sources: written.frontmatter.sources,
      verified: { by: "human:ana", at: "2026-06-25T09:00:00Z" },
      executor: { resource: "references/run.md", receipt: ["job_id"] },
    });
  });

  // Adapted from upstream understory, thecodacus/understory#41 by @Piggidragon.
  it("refuses objects where the spec wants strings, and leaves the file untouched", async () => {
    await kb.writeConcept("/doc.md", { type: "T", description: "orig" }, "body", "add");
    for (const value of [
      { __type: "string", __value: "typed placeholder" },
      {},
      ["ok", { notOk: 1 }],
    ]) {
      await expect(
        kb.patchConcept("/doc.md", { frontmatter: { description: value } }, "patch")
      ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
    }
    await expect(
      kb.writeConcept("/x.md", { type: "T", tags: { a: true } as never }, "body", "add")
    ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
    expect((await kb.readConcept("/doc.md")).frontmatter.description).toBe("orig");
  });

  it("carries a structured producer key forward, but never creates or alters one", async () => {
    await fs.writeFile(
      path.join(root, "billing.md"),
      "---\ntype: API\nowner:\n  team: payments\n---\nBody.\n\n# Notes\n\nold\n"
    );
    const patched = await kb.patchConcept(
      "/billing.md",
      {
        frontmatter: { description: "Charges" },
        replaceSection: { heading: "Notes", content: "new" },
      },
      "patch"
    );
    expect(patched.frontmatter.owner).toEqual({ team: "payments" });
    await expect(
      kb.patchConcept("/billing.md", { frontmatter: { owner: { team: "other" } } }, "patch")
    ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
    await expect(
      kb.writeConcept("/new.md", { type: "T", owner: { team: "x" } }, "body", "add")
    ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
  });

  it("does not let an object already in a spec key ride along", async () => {
    await fs.writeFile(path.join(root, "broken.md"), "---\ntype: T\ndescription: {}\n---\nBody.\n");
    await expect(kb.patchConcept("/broken.md", { replaceBody: "x" }, "patch")).rejects.toThrow(
      /description/
    );
    const repaired = await kb.patchConcept(
      "/broken.md",
      { frontmatter: { description: "Fixed" }, replaceBody: "x" },
      "repair"
    );
    expect(repaired.frontmatter.description).toBe("Fixed");
  });
});

describe("OKF v0.2 families (spec §5, §10)", () => {
  it("accepts well-formed families and a bare verified mapping", () => {
    expect(
      familyIssues("/a.md", {
        type: "Metric",
        status: "stable",
        stale_after: "2026-12-31T00:00:00Z",
        generated: { by: "reference_agent/gemini-2.5-pro", at: "2026-06-20T22:53:05Z" },
        verified: { by: "human:ana", at: "2026-06-25T09:00:00+02:00" },
        sources: [
          {
            id: "s",
            resource: "https://x",
            author: "team:fpa",
            last_modified: "2026-04-02T00:00:00Z",
          },
        ],
        usage_window: { from: "2026-06-01T00:00:00Z", to: "2026-06-30T00:00:00Z" },
      })
    ).toEqual([]);
  });

  it("warns about malformed families", () => {
    const messages = familyIssues("/a.md", {
      type: "Attested Computation",
      status: "done",
      stale_after: "2026-12-31",
      generated: { at: "yesterday" },
      verified: [{ by: "ana", at: "2026-06-25T09:00:00Z" }, "nope"],
      sources: [{ title: "no resource" }, { resource: "x", last_modified: "soon" }],
      usage_window: "June",
    }).map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/"status" should be one of draft, stable, deprecated/),
        expect.stringMatching(/"stale_after" should be an ISO 8601 datetime/),
        expect.stringMatching(/generated.by should be an actor/),
        expect.stringMatching(/generated.at should be an ISO 8601 datetime/),
        expect.stringMatching(/verified\[0\].by should be an actor/),
        expect.stringMatching(/verified\[1\] should be a \{ by, at \} mapping/),
        expect.stringMatching(/sources\[0\] needs a "resource"/),
        expect.stringMatching(/sources\[1\].last_modified/),
        expect.stringMatching(/"usage_window" should be a \{ from, to \} mapping/),
        expect.stringMatching(/needs a "runtime"/),
      ])
    );
    expect(
      familyIssues("/a.md", { type: "T", sources: "x", generated: "me" }).map((i) => i.message)
    ).toEqual([
      expect.stringMatching(/"sources" should be a list/),
      expect.stringMatching(/"generated" should be a \{ by, at \} mapping/),
    ]);
  });

  it("recognizes datetimes with offsets and the three actor forms", () => {
    expect(isOkfDatetime("2026-06-30T14:00:00Z")).toBe(true);
    expect(isOkfDatetime("2026-06-30T14:00:00.123+02:00")).toBe(true);
    expect(isOkfDatetime("2026-06-30T14:00:00")).toBe(false);
    expect(isOkfDatetime("2026-13-45T99:00:00Z")).toBe(false);
    for (const actor of ["myzel/deepseek-chat", "human:ana", "process:nightly"]) {
      expect(isActor(actor)).toBe(true);
    }
    for (const actor of ["ana", "human:", "two words/x", 3]) expect(isActor(actor)).toBe(false);
  });

  it("keeps a bundle conformant while it warns about families", async () => {
    await fs.writeFile(path.join(root, "a.md"), "---\ntype: T\nstatus: done\n---\nBody.\n");
    const report = await validateBundle(kb.bundle);
    expect(report.conformant).toBe(true);
    expect(report.issues.some((i) => i.message.includes('"status"'))).toBe(true);
  });
});

describe("search", () => {
  it("survives frontmatter values that are not strings", async () => {
    await fs.writeFile(
      path.join(root, "odd.md"),
      "---\ntype: T\ntitle: {toString: 1}\ntags: [{a: 1}, crm]\n---\nbody\n"
    );
    const hits = await kb.search("body", { tags: ["crm"] });
    expect(hits.map((h) => h.path)).toEqual(["/odd.md"]);
  });

  it("tolerates a non-string type when filtering by type", async () => {
    await fs.writeFile(path.join(root, "odd.md"), "---\ntype: 123\n---\nbody\n");
    await kb.writeConcept("/ok.md", { type: "Note" }, "body", "Added ok.");
    const hits = await kb.search("", { type: "note" });
    expect(hits.map((h) => h.path)).toEqual(["/ok.md"]);
  });

  beforeEach(async () => {
    await kb.writeConcept(
      "/tables/customers.md",
      { type: "Table", title: "Customers", description: "CRM customer records", tags: ["crm"] },
      "Contains emails and billing country.",
      "add"
    );
    await kb.writeConcept(
      "/apis/billing.md",
      { type: "API Endpoint", title: "Billing API", tags: ["billing"] },
      "Charges customers monthly.",
      "add"
    );
  });

  it("ranks title matches above body matches", async () => {
    const hits = await searchBundle(kb.bundle, "customers");
    expect(hits[0].path).toBe("/tables/customers.md");
    expect(hits.length).toBe(2); // body match on billing too
  });

  it("filters by type and tags", async () => {
    const byType = await searchBundle(kb.bundle, "customers", { type: "API Endpoint" });
    expect(byType.map((h) => h.path)).toEqual(["/apis/billing.md"]);
    const byTag = await searchBundle(kb.bundle, "", { tags: ["crm"] });
    expect(byTag.map((h) => h.path)).toEqual(["/tables/customers.md"]);
  });
});

describe("conformance (spec §11)", () => {
  it("valid bundle passes; missing type is an error; broken link is only a warning", async () => {
    await kb.writeConcept(
      "/good.md",
      { type: "T", title: "Good", description: "fine" },
      "See [missing](/nope.md).",
      "add"
    );
    // Write a malformed concept behind the KB's back.
    await fs.writeFile(path.join(root, "bad.md"), `---\ntitle: No Type\n---\nbody\n`);

    const report = await validateBundle(kb.bundle);
    expect(report.conformant).toBe(false);
    expect(report.issues.some((i) => i.severity === "error" && i.path === "/bad.md")).toBe(true);
    const linkIssue = report.issues.find((i) => i.message.includes("/nope.md"));
    expect(linkIssue?.severity).toBe("warning");

    await fs.rm(path.join(root, "bad.md"));
    const clean = await validateBundle(kb.bundle);
    expect(clean.conformant).toBe(true);
  });
});

describe("lint (graph health)", () => {
  it("flags orphans (no inbound links) and treats index catalogs as non-sources", async () => {
    // hub is linked-to; spoke links out but nothing links back to it; lonely is isolated.
    await kb.writeConcept("/hub.md", { type: "T", title: "Hub" }, "The central concept.", "add");
    await kb.writeConcept("/spoke.md", { type: "T", title: "Spoke" }, "See [Hub](/hub.md).", "add");
    await kb.writeConcept(
      "/lonely.md",
      { type: "T", title: "Lonely" },
      "Nothing here links out.",
      "add"
    );

    const report = await lintBundle(kb.bundle);
    const orphanPaths = report.orphans.map((o) => o.path).sort();
    // hub has an inbound link → not orphan. spoke + lonely have none → orphans.
    // The generated index.md files must NOT count as inbound links.
    expect(orphanPaths).toEqual(["/lonely.md", "/spoke.md"]);
    expect(report.linkCount).toBe(1);
    expect(report.healthy).toBe(false);
  });

  it("flags broken links and reports healthy when fully wired", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "A" }, "Link to [B](/b.md).", "add");
    let report = await lintBundle(kb.bundle);
    expect(report.brokenLinks).toEqual([{ path: "/a.md", target: "/b.md" }]);

    // Add B and a back-link so nothing is orphaned or broken.
    await kb.writeConcept("/b.md", { type: "T", title: "B" }, "Back to [A](/a.md).", "add");
    report = await lintBundle(kb.bundle);
    expect(report.brokenLinks).toEqual([]);
    expect(report.orphans).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it("follows relative links (spec §6.1) the way editors write them", async () => {
    await kb.writeConcept("/apis/billing.md", { type: "T" }, "See [x](invoices.md).", "add");
    await kb.writeConcept(
      "/apis/invoices.md",
      { type: "T" },
      "Back to [b](./billing.md), on to [c](../people/dana%20k.md) and [d](../gone.md).",
      "add"
    );
    await kb.writeConcept("/people/dana k.md", { type: "T" }, "[up](../apis/billing.md)", "add");
    const report = await lintBundle(kb.bundle);
    expect(report.orphans).toEqual([]);
    expect(report.brokenLinks).toEqual([{ path: "/apis/invoices.md", target: "/gone.md" }]);
    const { issues } = await validateBundle(kb.bundle);
    expect(issues.map((i) => i.message)).toContain("Broken link: /gone.md");
  });

  it("ignores URLs and links that climb out of the bundle", async () => {
    await kb.writeConcept(
      "/a.md",
      { type: "T" },
      "[w](https://example.com/x.md) [p](//host/y.md) [o](../../outside.md)",
      "add"
    );
    const report = await lintBundle(kb.bundle);
    expect(report.brokenLinks).toEqual([]);
    expect(report.linkCount).toBe(0);
  });
});

describe("graph export", () => {
  it("returns nodes with metadata/degree and deduped edges", async () => {
    await kb.writeConcept(
      "/a.md",
      { type: "T", title: "A", description: "alpha" },
      "See [B](/b.md) and again [B](/b.md).",
      "add"
    );
    await kb.writeConcept("/b.md", { type: "U", title: "B" }, "Back to [A](/a.md).", "add");
    await kb.writeConcept("/c.md", { type: "T", title: "C" }, "island", "add");

    const graph = await kb.graph();
    expect(graph.nodes.length).toBe(3);
    const a = graph.nodes.find((n) => n.path === "/a.md")!;
    expect(a.title).toBe("A");
    expect(a.description).toBe("alpha");
    expect(a.links).toBe(2); // one out (deduped), one in
    expect(graph.nodes.find((n) => n.path === "/c.md")!.links).toBe(0);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { source: "/a.md", target: "/b.md" },
        { source: "/b.md", target: "/a.md" },
      ])
    );
    expect(graph.edges.length).toBe(2); // duplicate A→B link counted once
  });
});

describe("mutation serialization", () => {
  it("concurrent writes all land and log all entries", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        kb.writeConcept(`/c${i}.md`, { type: "T", title: `C${i}` }, "x", `Added C${i}.`)
      )
    );
    const entries = await readLog(kb.bundle);
    expect(entries.length).toBe(8);
    const tree = await kb.listTree();
    const concepts = tree.children!.filter((c) => c.kind === "concept");
    expect(concepts.length).toBe(8);
  });

  it("idle() waits for queued writes, including ones queued while waiting", async () => {
    const first = kb.writeConcept("/a.md", { type: "T" }, "x", "Added a.");
    const idle = kb.idle();
    const second = kb.writeConcept("/b.md", { type: "T" }, "x", "Added b.");
    await idle;
    expect(await readLog(kb.bundle)).toHaveLength(2);
    await Promise.all([first, second]);
  });
});

describe("read-only memory (DEMO_MODE)", () => {
  it("refuses every write and leaves the bundle untouched", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "A" }, "x", "Added a.");
    const before = await fs.readdir(root, { recursive: true });
    const readOnly = new KnowledgeBase(root, { readOnly: true });
    expect(readOnly.readOnly).toBe(true);
    expect(kb.readOnly).toBe(false);

    const refused = [
      readOnly.writeConcept("/b.md", { type: "T" }, "x", "Added b."),
      readOnly.patchConcept("/a.md", { replaceBody: "more" }, "Patched a."),
      readOnly.deleteConcept("/a.md", "Removed a."),
    ];
    for (const write of refused) {
      await expect(write).rejects.toMatchObject({ name: "BundleError", code: "READ_ONLY" });
    }
    expect(await fs.readdir(root, { recursive: true })).toEqual(before);
    expect((await readOnly.readConcept("/a.md")).body.trim()).toBe("x");
    expect(await readOnly.idle()).toBeUndefined();
  });
});
