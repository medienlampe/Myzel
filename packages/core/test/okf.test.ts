import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Bundle,
  BundleError,
  KnowledgeBase,
  parseDoc,
  replaceSection,
  validateBundle,
  regenerateIndex,
  readLog,
  searchBundle,
  lintBundle,
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
  it("writes and reads a concept preserving fields, stamping timestamp", async () => {
    const written = await kb.writeConcept(
      "/tables/customers.md",
      { type: "BigQuery Table", title: "Customers", description: "Core customer table", tags: ["crm"], custom_key: 42 },
      "# Schema\n\nid, name, email",
      "Added customers table concept."
    );
    expect(written.frontmatter.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

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
    await expect(
      kb.writeConcept("/index.md", { type: "T" }, "body", "log")
    ).rejects.toMatchObject({ code: "RESERVED_NAME" });
    await expect(
      kb.writeConcept("/sub/log.md", { type: "T" }, "body", "log")
    ).rejects.toMatchObject({ code: "RESERVED_NAME" });
  });

  it("is permissive reading unknown keys and types", () => {
    const { frontmatter } = parseDoc(`---\ntype: Alien Format\nweird: [1, 2]\n---\nbody`);
    expect(frontmatter.type).toBe("Alien Format");
    expect(frontmatter.weird).toEqual([1, 2]);
  });
});

describe("sandbox", () => {
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

describe("index regeneration (spec §6)", () => {
  it("generates bullet lists with titles and descriptions, root gets okf_version", async () => {
    await kb.writeConcept(
      "/tables/customers.md",
      { type: "Table", title: "Customers", description: "Customer records" },
      "body",
      "add"
    );
    const rootIndex = await fs.readFile(path.join(root, "index.md"), "utf-8");
    expect(rootIndex).toContain('okf_version: "0.1"');
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

describe("log (spec §7)", () => {
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
});

describe("patch", () => {
  it("merges frontmatter and replaces a named section only", async () => {
    await kb.writeConcept(
      "/doc.md",
      { type: "T", title: "Doc", tags: ["a"] },
      "intro text\n\n# Schema\n\nold schema\n\n# Examples\n\nkeep me",
      "add"
    );
    const patched = await kb.patchConcept(
      "/doc.md",
      { frontmatter: { tags: ["a", "b"] }, replaceSection: { heading: "Schema", content: "new schema" } },
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

describe("search", () => {
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

describe("conformance (spec §9)", () => {
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
    await kb.writeConcept("/lonely.md", { type: "T", title: "Lonely" }, "Nothing here links out.", "add");

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
});

describe("graph export", () => {
  it("returns nodes with metadata/degree and deduped edges", async () => {
    await kb.writeConcept("/a.md", { type: "T", title: "A", description: "alpha" }, "See [B](/b.md) and again [B](/b.md).", "add");
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
});
