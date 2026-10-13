import { promises as fs } from "node:fs";
import { writeFileAtomic } from "./atomic.js";
import type { Bundle } from "./bundle.js";
import type { LogAction, LogEntry } from "./types.js";

const LOG_HEADER = "# Directory Update Log";
const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})/;
const BULLET = /^\*\s+\*\*(Creation|Update|Deletion)\*\*:\s*(.*)$/;

interface LogSection {
  date: string;
  entries: { action: LogAction; summary: string }[];
}

/**
 * Append an entry to the root log.md per spec §9: newest-first, grouped under
 * `## YYYY-MM-DD` headings.
 *
 * The log is parsed into sections and re-rendered rather than patched with
 * string replacement. Summaries are written by the LLM from user-supplied
 * knowledge, so one containing something that looks like a date heading used to
 * be able to steer where the next bullet landed. Re-rendering also normalizes
 * spacing instead of accumulating it. log.md is a generated file (spec §9), so
 * regenerating it is allowed; anything not matching the grammar below is not
 * part of the log and is dropped.
 */
export async function appendLog(bundle: Bundle, action: LogAction, summary: string): Promise<void> {
  const logPath = await bundle.resolveContained("/log.md");
  const today = new Date().toISOString().slice(0, 10);

  const sections = parseSections(await readRaw(logPath));
  const entry = { action, summary: flatten(summary) };

  const todaySection = sections.find((s) => s.date === today);
  if (todaySection) {
    todaySection.entries.unshift(entry); // newest bullet first within the day
  } else {
    sections.unshift({ date: today, entries: [entry] }); // newest day first
  }

  await writeFileAtomic(logPath, render(sections));
}

/** Parse the root log.md into structured entries (best-effort, permissive). */
export async function readLog(bundle: Bundle): Promise<LogEntry[]> {
  const sections = parseSections(await readRaw(await bundle.resolveContained("/log.md")));
  return sections.flatMap((section) =>
    section.entries.map((entry) => ({
      date: section.date,
      action: entry.action,
      summary: entry.summary,
    }))
  );
}

async function readRaw(logPath: string): Promise<string> {
  try {
    return await fs.readFile(logPath, "utf-8");
  } catch {
    return ""; // No log yet.
  }
}

function parseSections(raw: string): LogSection[] {
  const sections: LogSection[] = [];
  let current: LogSection | null = null;
  for (const line of raw.split("\n")) {
    const heading = line.match(DATE_HEADING);
    if (heading) {
      current = { date: heading[1], entries: [] };
      sections.push(current);
      continue;
    }
    const bullet = line.match(BULLET);
    if (bullet && current) {
      current.entries.push({ action: bullet[1] as LogAction, summary: bullet[2].trim() });
    }
  }
  return sections;
}

function render(sections: LogSection[]): string {
  const lines: string[] = [LOG_HEADER, ""];
  for (const section of sections) {
    lines.push(`## ${section.date}`, "");
    for (const entry of section.entries) {
      lines.push(`* **${entry.action}**: ${entry.summary}`, "");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * One line, always: a summary spanning several lines could otherwise forge a
 * date heading or an extra bullet on the next append.
 */
function flatten(summary: string): string {
  return summary.replace(/\s+/g, " ").trim();
}
