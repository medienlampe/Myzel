import { parseDoc, hasNonEmptyType } from "./frontmatter.js";
import type { Bundle } from "./bundle.js";
import { familyIssues } from "./families.js";
import { conceptLinkTargets } from "./graph.js";
import type { ConformanceIssue, ConformanceReport } from "./types.js";

/**
 * Conformance check per spec §11. Errors make the bundle non-conformant;
 * warnings (broken links, missing recommended fields, malformed §5/§10
 * families) never do — the spec requires consumers to tolerate them.
 */
export async function validateBundle(bundle: Bundle): Promise<ConformanceReport> {
  const issues: ConformanceIssue[] = [];
  const paths = await bundle.listConceptPaths();
  const known = new Set(paths);
  let directoryCount = 0;

  const countDirs = async (dir: string): Promise<void> => {
    directoryCount++;
    for (const sub of await bundle.listSubdirectories(dir)) await countDirs(sub);
  };
  await countDirs("/");

  for (const skipped of await bundle.listSkippedEntries()) {
    issues.push({
      path: skipped,
      severity: "warning",
      message: "Not read: symlinks and hidden files are skipped, so this is not part of the memory",
    });
  }

  for (const conceptPath of paths) {
    let raw: string;
    try {
      raw = await bundle.readFileRaw(conceptPath);
    } catch {
      continue;
    }
    let frontmatter: Record<string, unknown>;
    let body: string;
    try {
      ({ frontmatter, body } = parseDoc(raw));
    } catch {
      issues.push({
        path: conceptPath,
        severity: "error",
        message: "Frontmatter is not parseable YAML (spec §11.1)",
      });
      continue;
    }
    if (!hasNonEmptyType(frontmatter)) {
      issues.push({
        path: conceptPath,
        severity: "error",
        message: 'Missing non-empty "type" frontmatter field (spec §11.2)',
      });
    }
    if (!frontmatter.title) {
      issues.push({
        path: conceptPath,
        severity: "warning",
        message: 'Missing recommended "title" field',
      });
    }
    if (!frontmatter.description) {
      issues.push({
        path: conceptPath,
        severity: "warning",
        message: 'Missing recommended "description" field',
      });
    }
    issues.push(...familyIssues(conceptPath, frontmatter));
    // Broken links → warnings only (spec: MUST tolerate).
    for (const target of conceptLinkTargets(body, conceptPath)) {
      if (!known.has(target)) {
        issues.push({
          path: conceptPath,
          severity: "warning",
          message: `Broken link: ${target}`,
        });
      }
    }
  }

  return {
    conformant: !issues.some((i) => i.severity === "error"),
    conceptCount: paths.length,
    directoryCount,
    issues,
  };
}
