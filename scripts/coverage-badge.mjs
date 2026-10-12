// Combines the packages' coverage summaries (vitest's json-summary reporter)
// into a shields.io endpoint badge: line coverage across the whole workspace.
// Usage: node scripts/coverage-badge.mjs <output.json>   (after pnpm test:coverage)
import { readFileSync, writeFileSync } from "node:fs";

const PACKAGES = ["core", "server", "web"];

let covered = 0;
let total = 0;
for (const name of PACKAGES) {
  const file = new URL(`../packages/${name}/coverage/coverage-summary.json`, import.meta.url);
  const { lines } = JSON.parse(readFileSync(file, "utf8")).total;
  covered += lines.covered;
  total += lines.total;
}

const percent = total === 0 ? 0 : (covered / total) * 100;
const color =
  percent >= 90 ? "brightgreen" : percent >= 80 ? "green" : percent >= 70 ? "yellow" : "red";
const badge = { schemaVersion: 1, label: "coverage", message: `${percent.toFixed(1)}%`, color };

writeFileSync(process.argv[2] ?? "coverage.json", `${JSON.stringify(badge)}\n`);
console.log(`coverage badge: ${badge.message} (${covered}/${total} lines)`);
