import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { parseDoc, serializeDoc, hasNonEmptyType } from "./frontmatter.js";
import { RESERVED_FILENAMES } from "./types.js";
import type { Concept, ConceptFrontmatter, TreeNode } from "./types.js";

export class BundleError extends Error {
  constructor(
    message: string,
    public readonly code:
      "OUTSIDE_BUNDLE" | "RESERVED_NAME" | "NOT_FOUND" | "INVALID_FRONTMATTER" | "NOT_MARKDOWN"
  ) {
    super(message);
    this.name = "BundleError";
  }
}

/**
 * Filesystem access to one OKF bundle, sandboxed to its root directory.
 * All public methods take/return bundle-relative paths ("/dir/concept.md").
 */
export class Bundle {
  readonly root: string;
  private realRootPromise: Promise<string> | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Is `abs` the given root or below it? Purely textual — see assertRealPathInside. */
  private static contains(root: string, abs: string): boolean {
    return abs === root || abs.startsWith(root + path.sep);
  }

  /** Resolve a bundle-relative path to an absolute one, rejecting escapes. */
  resolve(bundlePath: string): string {
    let abs: string;
    if (path.isAbsolute(bundlePath)) {
      // Two kinds of input look absolute: an OS path from a directory walk
      // ("/<root>/dir/x.md") and a canonical bundle-relative path ("/dir/x.md").
      // Normalize BEFORE deciding which it is — "/<root>/../../etc/passwd"
      // carries the root as a literal prefix but points outside it, so a
      // prefix test on the raw string would wave it through.
      const normalized = path.resolve(bundlePath);
      abs = Bundle.contains(this.root, normalized)
        ? normalized
        : path.resolve(this.root, bundlePath.replace(/^\/+/, ""));
    } else {
      abs = path.resolve(this.root, bundlePath);
    }
    if (!Bundle.contains(this.root, abs)) {
      throw new BundleError(`Path escapes bundle root: ${bundlePath}`, "OUTSIDE_BUNDLE");
    }
    return abs;
  }

  /** The bundle root with symlinks resolved. Cached — the root doesn't move. */
  private realRoot(): Promise<string> {
    this.realRootPromise ??= fs.realpath(this.root).catch(() => this.root);
    return this.realRootPromise;
  }

  /**
   * Containment check that follows symlinks. resolve() reasons about the path
   * textually, so a symlink stored INSIDE the bundle can still point outside
   * it — planting one would turn write access to the bundle into arbitrary
   * host-file reads. Every path whose contents we are about to read or write
   * goes through here as well.
   */
  private async assertRealPathInside(abs: string, bundlePath: string): Promise<void> {
    const realRoot = await this.realRoot();
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      // Not on disk yet (a new concept): check the nearest existing ancestor
      // instead, so a symlinked parent directory can't smuggle the write out.
      try {
        real = path.join(await fs.realpath(path.dirname(abs)), path.basename(abs));
      } catch {
        return; // Nothing resolvable — the textual check already passed.
      }
    }
    if (!Bundle.contains(realRoot, real)) {
      throw new BundleError(
        `Path escapes bundle root through a symlink: ${bundlePath}`,
        "OUTSIDE_BUNDLE"
      );
    }
  }

  /** Normalize any input to a canonical bundle-relative path starting with "/". */
  toBundlePath(inputPath: string): string {
    const abs = this.resolve(inputPath);
    const rel = path.relative(this.root, abs);
    return "/" + rel.split(path.sep).join("/");
  }

  private assertConceptPath(bundlePath: string): void {
    if (!bundlePath.endsWith(".md")) {
      throw new BundleError(`Concept paths must end in .md: ${bundlePath}`, "NOT_MARKDOWN");
    }
    const base = path.posix.basename(bundlePath);
    if (RESERVED_FILENAMES.has(base)) {
      throw new BundleError(
        `"${base}" is a reserved filename (index.md/log.md) and cannot be a concept`,
        "RESERVED_NAME"
      );
    }
  }

  async exists(bundlePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(bundlePath));
      return true;
    } catch {
      return false;
    }
  }

  async readConcept(bundlePath: string): Promise<Concept> {
    const canonical = this.toBundlePath(bundlePath);
    const abs = this.resolve(canonical);
    await this.assertRealPathInside(abs, canonical);
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf-8");
    } catch {
      throw new BundleError(`Concept not found: ${canonical}`, "NOT_FOUND");
    }
    const { frontmatter, body } = parseDoc(raw);
    return { path: canonical, frontmatter: frontmatter as ConceptFrontmatter, body, raw };
  }

  async readFileRaw(bundlePath: string): Promise<string> {
    const abs = this.resolve(bundlePath);
    await this.assertRealPathInside(abs, bundlePath);
    try {
      return await fs.readFile(abs, "utf-8");
    } catch {
      throw new BundleError(`File not found: ${bundlePath}`, "NOT_FOUND");
    }
  }

  async writeConcept(
    bundlePath: string,
    frontmatter: ConceptFrontmatter,
    body: string
  ): Promise<Concept> {
    const canonical = this.toBundlePath(bundlePath);
    this.assertConceptPath(canonical);
    if (!hasNonEmptyType(frontmatter)) {
      throw new BundleError(
        `Frontmatter must include a non-empty "type" field (OKF spec §5)`,
        "INVALID_FRONTMATTER"
      );
    }
    const stamped: ConceptFrontmatter = {
      ...frontmatter,
      timestamp: new Date().toISOString(),
    };
    const abs = this.resolve(canonical);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await this.assertRealPathInside(abs, canonical);
    await writeFileAtomic(abs, serializeDoc(stamped, body));
    return { path: canonical, frontmatter: stamped, body, raw: serializeDoc(stamped, body) };
  }

  /**
   * Targeted update: merge frontmatter keys (null deletes a key) and/or
   * replace the content under one top-level "# Section" heading.
   */
  async patchConcept(
    bundlePath: string,
    changes: {
      frontmatter?: Record<string, unknown>;
      replaceSection?: { heading: string; content: string };
      replaceBody?: string;
    }
  ): Promise<Concept> {
    const existing = await this.readConcept(bundlePath);
    const fm: ConceptFrontmatter = { ...existing.frontmatter };
    if (changes.frontmatter) {
      for (const [k, v] of Object.entries(changes.frontmatter)) {
        if (v === null) delete fm[k];
        else fm[k] = v;
      }
    }
    let body = changes.replaceBody ?? existing.body;
    if (changes.replaceSection) {
      body = replaceSection(body, changes.replaceSection.heading, changes.replaceSection.content);
    }
    return this.writeConcept(existing.path, fm, body);
  }

  async deleteConcept(bundlePath: string): Promise<void> {
    const canonical = this.toBundlePath(bundlePath);
    this.assertConceptPath(canonical);
    const abs = this.resolve(canonical);
    try {
      await fs.unlink(abs);
    } catch {
      throw new BundleError(`Concept not found: ${canonical}`, "NOT_FOUND");
    }
  }

  /** All concept files (recursive), as bundle-relative paths. */
  async listConceptPaths(dir = "/"): Promise<string[]> {
    const out: string[] = [];
    await this.walk(this.resolve(dir), (abs, name) => {
      if (name.endsWith(".md") && !RESERVED_FILENAMES.has(name)) {
        out.push(this.toBundlePath(abs));
      }
    });
    return out.sort();
  }

  /** Immediate subdirectories of a directory. */
  async listSubdirectories(dir = "/"): Promise<string[]> {
    const abs = this.resolve(dir);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => this.toBundlePath(path.join(abs, e.name)))
      .sort();
  }

  async listTree(dir = "/"): Promise<TreeNode> {
    const abs = this.resolve(dir);
    const name = abs === this.root ? "/" : path.basename(abs);
    const node: TreeNode = {
      name,
      path: this.toBundlePath(abs),
      kind: "directory",
      children: [],
    };
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        node.children!.push(await this.listTree(this.toBundlePath(childAbs)));
      } else if (entry.name.endsWith(".md")) {
        if (RESERVED_FILENAMES.has(entry.name)) {
          node.children!.push({
            name: entry.name,
            path: this.toBundlePath(childAbs),
            kind: "reserved",
          });
        } else {
          let fmSummary: { type?: string; title?: string; description?: string } = {};
          try {
            const { frontmatter } = parseDoc(await fs.readFile(childAbs, "utf-8"));
            fmSummary = {
              type: typeof frontmatter.type === "string" ? frontmatter.type : undefined,
              title: typeof frontmatter.title === "string" ? frontmatter.title : undefined,
              description:
                typeof frontmatter.description === "string" ? frontmatter.description : undefined,
            };
          } catch {
            // Permissive: unparseable file still appears in the tree.
          }
          node.children!.push({
            name: entry.name,
            path: this.toBundlePath(childAbs),
            kind: "concept",
            ...fmSummary,
          });
        }
      }
    }
    return node;
  }

  private async walk(
    absDir: string,
    visit: (absPath: string, name: string) => void
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(absDir, entry.name);
      if (entry.isDirectory()) await this.walk(child, visit);
      else visit(child, entry.name);
    }
  }
}

/** Replace the content under a top-level heading; append the section if absent. */
export function replaceSection(body: string, heading: string, content: string): string {
  const normalized = heading.replace(/^#+\s*/, "");
  const lines = body.split("\n");
  const isHeading = (line: string) => /^#\s+/.test(line);
  const start = lines.findIndex(
    (line) => isHeading(line) && line.replace(/^#\s+/, "").trim() === normalized
  );
  if (start === -1) {
    const suffix = body.trim().length > 0 ? "\n\n" : "";
    return `${body.trimEnd()}${suffix}# ${normalized}\n\n${content.trim()}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start + 1).join("\n");
  const after = lines.slice(end).join("\n");
  return `${before}\n\n${content.trim()}\n${after ? "\n" + after : ""}`;
}
