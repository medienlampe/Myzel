import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { OKF_VERSION } from "./families.js";
import { parseDoc } from "./frontmatter.js";
import { RESERVED_FILENAMES } from "./types.js";
import { isHiddenOrLink, type Bundle } from "./bundle.js";

/**
 * Regenerate a directory's index.md per spec §8:
 * bullet list of `[Title](relative-url) - description`, subdirectories included.
 * The root index.md carries the only frontmatter allowed in an index: okf_version.
 */
export async function regenerateIndex(bundle: Bundle, dir = "/"): Promise<string> {
  const absDir = await bundle.resolveContained(dir);
  const isRoot = absDir === bundle.root;
  const entries = await fs.readdir(absDir, { withFileTypes: true });

  const conceptLines: string[] = [];
  const dirLines: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isHiddenOrLink(entry)) continue;
    if (entry.isDirectory()) {
      const summary = await summarizeDirectory(path.join(absDir, entry.name));
      dirLines.push(
        `* [${linkText(entry.name)}](${linkTarget(entry.name)}/) - ${oneLine(summary)}`
      );
      continue;
    }
    if (!entry.name.endsWith(".md") || RESERVED_FILENAMES.has(entry.name)) continue;
    let title = entry.name.replace(/\.md$/, "");
    let description = "";
    try {
      const { frontmatter } = parseDoc(await fs.readFile(path.join(absDir, entry.name), "utf-8"));
      if (typeof frontmatter.title === "string" && frontmatter.title) title = frontmatter.title;
      if (typeof frontmatter.description === "string") description = frontmatter.description;
    } catch {
      // Permissive: index unparseable files by filename.
    }
    const desc = oneLine(description);
    conceptLines.push(
      `* [${linkText(title)}](${linkTarget(entry.name)})${desc ? ` - ${desc}` : ""}`
    );
  }

  const dirName = isRoot ? "Knowledge Base" : path.basename(absDir);
  const sections: string[] = [];
  // The bundle declares the spec version it targets (spec §12).
  if (isRoot) sections.push(`---\nokf_version: "${OKF_VERSION}"\n---\n`);
  sections.push(`# ${capitalize(dirName)}\n`);
  if (conceptLines.length > 0) sections.push(conceptLines.join("\n") + "\n");
  if (dirLines.length > 0) {
    const heading = isRoot ? "Memory Segments" : "Subdirectories";
    sections.push(`## ${heading}\n\n${dirLines.join("\n")}\n`);
  }

  const content = sections.join("\n");
  await writeFileAtomic(path.join(absDir, "index.md"), content);
  return content;
}

/** Regenerate index.md for a directory and every ancestor up to the root. */
export async function regenerateIndexChain(bundle: Bundle, dir: string): Promise<void> {
  let current = bundle.resolve(dir);
  // The directory may have been pruned away — start from the nearest ancestor
  // that still exists (the root always does), or it would be recreated.
  while (current !== bundle.root) {
    try {
      await fs.access(current);
      break;
    } catch {
      current = path.dirname(current);
    }
  }
  while (true) {
    await regenerateIndex(bundle, bundle.toBundlePath(current));
    if (current === bundle.root) break;
    current = path.dirname(current);
  }
}

/**
 * index.md is a bullet list (spec §8): one entry per line. Frontmatter values
 * can span lines (`description: |`) or contain "]", either of which would
 * break the list or the link, so both are normalized here.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function linkText(text: string): string {
  return oneLine(text).replace(/[\\[\]]/g, "\\$&");
}

/** A file name as a link target: spaces, "#", "?" and parentheses would break the link. */
function linkTarget(name: string): string {
  return encodeURIComponent(name).replace(
    /[()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Remove directories left holding nothing but their generated index.md (or
 * nothing at all).
 * Agents that move or merge concepts leave such husks behind, and delete_concept
 * cannot remove them (index.md is reserved), so the cleanup is deterministic:
 * bottom-up over the bundle, so a parent emptied by pruning its children goes
 * too. Never touches the root, hidden directories or symlinks, and removes only
 * index.md itself — a directory holding anything else (even a dot-file) stays.
 * Returns the removed bundle paths. (Ported from upstream understory.)
 */
export async function pruneEmptyDirs(bundle: Bundle): Promise<string[]> {
  const removed: string[] = [];

  // Best-effort per directory: one unreadable or busy folder (lost+found on a
  // volume root, a mount point) must not stop the rest of the sweep.
  const visit = async (absDir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !isHiddenOrLink(entry)) await visit(path.join(absDir, entry.name));
    }
    if (absDir === bundle.root) return;
    try {
      // Re-read: children may have been pruned during the recursion above.
      const remaining = await fs.readdir(absDir, { withFileTypes: true });
      if (remaining.length > 1) return;
      if (remaining.length === 1) {
        const [only] = remaining;
        if (only.name !== "index.md" || only.isDirectory()) return;
        await fs.rm(path.join(absDir, "index.md"));
      }
      await fs.rmdir(absDir);
      removed.push(bundle.toBundlePath(absDir));
    } catch {
      // Raced with a writer, or not removable here — leave it for next time.
    }
  };

  await visit(bundle.root);
  return removed;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * One-line deterministic summary of a directory's contents for index listings:
 * concept count, distinct types and the first few titles — always derivable,
 * always current, no LLM.
 */
async function summarizeDirectory(absDir: string): Promise<string> {
  const titles: string[] = [];
  const types = new Set<string>();
  let count = 0;

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (isHiddenOrLink(entry)) continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.name.endsWith(".md") && !RESERVED_FILENAMES.has(entry.name)) {
        count++;
        try {
          const { frontmatter } = parseDoc(await fs.readFile(child, "utf-8"));
          if (typeof frontmatter.type === "string" && frontmatter.type) types.add(frontmatter.type);
          if (titles.length < 3) {
            titles.push(
              typeof frontmatter.title === "string" && frontmatter.title
                ? frontmatter.title
                : entry.name.replace(/\.md$/, "")
            );
          }
        } catch {
          if (titles.length < 3) titles.push(entry.name.replace(/\.md$/, ""));
        }
      }
    }
  };
  await walk(absDir);

  if (count === 0) return "empty";
  const typeList = [...types].sort().join(", ");
  const titleList = titles.join(", ") + (count > titles.length ? ", …" : "");
  return `${count} concept${count === 1 ? "" : "s"}${typeList ? ` (${typeList})` : ""}: ${titleList}`;
}
