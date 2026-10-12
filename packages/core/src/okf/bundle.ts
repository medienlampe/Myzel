import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { parseDoc, serializeDoc, hasNonEmptyType } from "./frontmatter.js";
import { RESERVED_FILENAMES } from "./types.js";
import type { Concept, ConceptFrontmatter, TreeNode } from "./types.js";

export class BundleError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "OUTSIDE_BUNDLE"
      | "RESERVED_NAME"
      | "NOT_FOUND"
      | "INVALID_FRONTMATTER"
      | "NOT_MARKDOWN"
      | "HIDDEN_PATH",
    options?: { cause?: unknown }
  ) {
    super(message, options);
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
  private async assertRealPathInside(abs: string, bundlePath: string): Promise<string> {
    const realRoot = await this.realRoot();
    let real: string;
    // Not on disk yet (a new concept, a new directory): resolve the nearest
    // existing ancestor instead, so a symlinked parent can't smuggle the write
    // — or the mkdir before it — out of the bundle.
    let existing = abs;
    let rest = "";
    for (;;) {
      try {
        real = path.join(await fs.realpath(existing), rest);
        break;
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) return abs; // Nothing resolvable — the textual check passed.
        rest = path.join(path.basename(existing), rest);
        existing = parent;
      }
    }
    if (!Bundle.contains(realRoot, real)) {
      throw new BundleError(
        `Path escapes bundle root through a symlink: ${bundlePath}`,
        "OUTSIDE_BUNDLE"
      );
    }
    // The same rule as for typed paths: a link like notes/x.md -> ../.git/config
    // must not reach a hidden file either.
    if (
      path
        .relative(realRoot, real)
        .split(path.sep)
        .some((s) => s.startsWith("."))
    ) {
      throw new BundleError(`Path resolves into a hidden location: ${bundlePath}`, "HIDDEN_PATH");
    }
    return real;
  }

  /**
   * resolve() plus the symlink-following containment check, for callers outside
   * this class that write into the bundle (index regeneration).
   */
  async resolveContained(bundlePath: string): Promise<string> {
    const abs = this.resolve(bundlePath);
    await this.assertRealPathInside(abs, bundlePath);
    return abs;
  }

  /** Normalize any input to a canonical bundle-relative path starting with "/". */
  toBundlePath(inputPath: string): string {
    const abs = this.resolve(inputPath);
    const rel = path.relative(this.root, abs);
    return "/" + rel.split(path.sep).join("/");
  }

  /**
   * Dot-entries (.git, .traces, temp files) are not part of the knowledge base:
   * the walkers never list them, and reading or writing them through the
   * concept API would expose repository credentials or other callers' traces.
   */
  private assertVisiblePath(bundlePath: string): void {
    if (bundlePath.split("/").some((segment) => segment.startsWith("."))) {
      throw new BundleError(
        `Hidden paths are not part of the bundle: ${bundlePath}`,
        "HIDDEN_PATH"
      );
    }
  }

  private assertMarkdown(bundlePath: string): void {
    this.assertVisiblePath(bundlePath);
    if (!bundlePath.endsWith(".md")) {
      throw new BundleError(`Concept paths must end in .md: ${bundlePath}`, "NOT_MARKDOWN");
    }
  }

  private assertConceptPath(bundlePath: string): void {
    this.assertMarkdown(bundlePath);
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
    this.assertMarkdown(canonical);
    const abs = this.resolve(canonical);
    const real = await this.assertRealPathInside(abs, canonical);
    if (!real.endsWith(".md")) {
      throw new BundleError(`Concept paths must end in .md: ${canonical}`, "NOT_MARKDOWN");
    }
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf-8");
    } catch {
      throw new BundleError(`Concept not found: ${canonical}`, "NOT_FOUND");
    }
    let parsed;
    try {
      parsed = parseDoc(raw);
    } catch (err) {
      throw new BundleError(
        `Unreadable frontmatter in ${canonical}: ${(err as Error).message}`,
        "INVALID_FRONTMATTER",
        { cause: err }
      );
    }
    return {
      path: canonical,
      frontmatter: parsed.frontmatter as ConceptFrontmatter,
      body: parsed.body,
      raw,
    };
  }

  async readFileRaw(bundlePath: string): Promise<string> {
    this.assertVisiblePath(this.toBundlePath(bundlePath));
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
    await this.assertRealPathInside(abs, canonical);
    await fs.mkdir(path.dirname(abs), { recursive: true });
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
    // unlink() removes a symlinked *file* itself (harmless), but follows a
    // symlinked parent directory — which would delete a file outside the bundle.
    await this.assertRealPathInside(path.dirname(abs), canonical);
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
      .filter((e) => e.isDirectory() && !isHiddenOrLink(e))
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
      if (isHiddenOrLink(entry)) continue;
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
      if (isHiddenOrLink(entry)) continue;
      const child = path.join(absDir, entry.name);
      if (entry.isDirectory()) await this.walk(child, visit);
      else visit(child, entry.name);
    }
  }
}

/**
 * Entries every bundle walker skips: dot-entries (traces, .git) and symlinks.
 * A symlink can point anywhere on the host; following it would put host files
 * into the tree, search, graph and index. Content reads refuse escapes anyway
 * (assertRealPathInside) — skipping links keeps the listings consistent with that.
 */
export function isHiddenOrLink(entry: Dirent): boolean {
  return entry.name.startsWith(".") || entry.isSymbolicLink();
}

/** Replace the content under a top-level heading; append the section if absent. */
export function replaceSection(body: string, heading: string, content: string): string {
  const normalized = heading.replace(/^#+\s*/, "");
  const lines = body.split("\n");
  // A "# comment" inside a fenced code block is code, not a heading.
  const inFence: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    inFence.push(fence !== null || marker !== undefined);
    if (!marker) continue;
    if (fence === null) fence = marker;
    // Only a fence of the same character and at least the opener's length
    // closes it: a ``` line inside a ```` block is content.
    else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
  }
  const isHeadingAt = (i: number) => !inFence[i] && /^#\s+/.test(lines[i]);
  const start = lines.findIndex(
    (line, i) => isHeadingAt(i) && line.replace(/^#\s+/, "").trim() === normalized
  );
  if (start === -1) {
    const suffix = body.trim().length > 0 ? "\n\n" : "";
    return `${body.trimEnd()}${suffix}# ${normalized}\n\n${content.trim()}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeadingAt(i)) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start + 1).join("\n");
  const after = lines.slice(end).join("\n");
  return `${before}\n\n${content.trim()}\n${after ? "\n" + after : ""}`;
}
