import { promises as fs } from "node:fs";
import path from "node:path";

let counter = 0;

/**
 * Write a file atomically: same-directory temp file, then rename.
 *
 * Every bundle file is rewritten in full on each mutation — index.md and log.md
 * most often. A plain writeFile truncates first, so a crash (or a second
 * process on the same bundle, which the per-process mutation queue does not
 * serialize) can leave a half-written index or a truncated update log. rename()
 * within one directory is atomic on POSIX, so a reader sees either the old file
 * or the new one.
 *
 * The temp name starts with a dot, which every bundle walker skips, so a
 * concurrent read never sees it as a concept.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${counter++}.tmp`);
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
