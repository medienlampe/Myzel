// Guards the premise "few dependencies, kept current" (docs/premises.md).
//
//   node scripts/check-deps.mjs reasons    every runtime dependency has a row in
//                                          docs/maintenance.md, and every row a dependency
//   node scripts/check-deps.mjs outdated   no dependency is a major version behind unless
//                                          maintenance.md's pin table holds it back
//
// `reasons` runs in CI on every push; `outdated` needs the registry and runs weekly.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PACKAGES = ["core", "server", "web"];
const doc = readFileSync(new URL("../docs/maintenance.md", import.meta.url), "utf8");

/** Backticked names in the first column of the table under `heading`. */
function tableNames(heading) {
  const start = doc.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`docs/maintenance.md has no "## ${heading}" section`);
  const section = doc.slice(start + 1).split(/\n## /)[0];
  const names = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| What") || line.startsWith("|---")) continue;
    const firstCell = line.split("|")[1];
    for (const match of firstCell.matchAll(/`([^`]+)`/g)) names.push(match[1]);
  }
  return names;
}

function manifest(name) {
  return JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url)));
}

function reasons() {
  const listed = new Set(tableNames("Runtime dependencies"));
  const used = new Set();
  const problems = [];
  for (const name of PACKAGES) {
    for (const [dep, range] of Object.entries(manifest(name).dependencies ?? {})) {
      if (range.startsWith("workspace:")) continue;
      used.add(dep);
      if (!listed.has(dep)) problems.push(`${dep} (packages/${name}) has no row saying why`);
    }
  }
  for (const dep of listed) {
    if (!used.has(dep)) problems.push(`${dep} is listed but no package depends on it any more`);
  }
  return problems.map((p) => `${p} — see "Runtime dependencies" in docs/maintenance.md`);
}

function outdated() {
  const held = tableNames("Versions and why they are pinned");
  const isHeld = (dep) =>
    held.some((h) => (h.endsWith("/*") ? dep.startsWith(h.slice(0, -1)) : h === dep));
  const run = spawnSync("pnpm", ["outdated", "-r", "--format", "json"], { encoding: "utf8" });
  // pnpm exits non-zero whenever anything is outdated; only unreadable output is an error.
  let report;
  try {
    report = JSON.parse(run.stdout || "{}");
  } catch {
    throw new Error(`could not read "pnpm outdated" output:\n${run.stdout}\n${run.stderr}`);
  }
  const entries = Array.isArray(report)
    ? report.map((e) => [e.packageName ?? e.name, e])
    : Object.entries(report);
  const major = (v) =>
    Number(
      String(v ?? "")
        .replace(/^[^\d]*/, "")
        .split(".")[0]
    );
  return entries
    .filter(([dep, e]) => major(e.latest) > major(e.current) && !isHeld(dep))
    .map(
      ([dep, e]) =>
        `${dep} ${e.current} → ${e.latest} is a major behind. Upgrade, or add a blocker to the pin table in docs/maintenance.md`
    );
}

const mode = process.argv[2] ?? "reasons";
const problems = mode === "outdated" ? outdated() : reasons();
if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log(`✓ dependencies: ${mode} check passed`);
