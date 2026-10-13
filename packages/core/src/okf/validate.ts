import { parseDoc, hasNonEmptyType } from "./frontmatter.js";
import type { Bundle } from "./bundle.js";
import { familyIssues } from "./families.js";
import { BUNDLE_LINK_RE } from "./graph.js";
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
    // Broken bundle-relative links → warnings only (spec: MUST tolerate).
    for (const match of body.matchAll(BUNDLE_LINK_RE)) {
      if (!known.has(match[1])) {
        issues.push({
          path: conceptPath,
          severity: "warning",
          message: `Broken bundle-relative link: ${match[1]}`,
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
