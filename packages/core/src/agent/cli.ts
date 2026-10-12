#!/usr/bin/env tsx
/**
 * Agent smoke CLI.
 *   make query Q="What do we know about billing?"      (from the repository root)
 *   make mutate I="Add a concept about the users table"
 * or directly, with an absolute bundle path (the script runs in packages/core):
 *   BUNDLE_ROOT=/abs/path/to/bundle pnpm agent:query "…"
 */
import { KnowledgeBase } from "../okf/index.js";
import { runQuery, runMutation } from "./agent.js";

const [mode, ...rest] = process.argv.slice(2);
const input = rest.join(" ").trim();
const bundleRoot = process.env.BUNDLE_ROOT;

if (!bundleRoot || !input || !["query", "mutate"].includes(mode)) {
  console.error('Usage: BUNDLE_ROOT=<dir> tsx cli.ts query|mutate "<text>"');
  process.exit(1);
}

const kb = new KnowledgeBase(bundleRoot, {
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});

if (mode === "query") {
  const { answer, steps } = await runQuery(kb, input);
  console.log(answer);
  console.error(`\n[${steps} steps]`);
} else {
  const outcome = await runMutation(kb, input);
  if (outcome.ok) {
    console.log(outcome.result.summary);
    console.error(
      `\n[${outcome.result.steps} steps] files changed: ${outcome.result.filesChanged.join(", ") || "none"}`
    );
  } else {
    console.error(`Mutation failed: ${outcome.error}`);
    process.exit(1);
  }
}
