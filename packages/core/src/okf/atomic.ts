import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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
 * concurrent read never sees it as a concept. It is random and created with
 * O_EXCL ("wx"): a predictable name could be pre-planted in a synced bundle as a
 * symlink, and writeFile would follow it to any file the server can write.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, content, { encoding: "utf-8", flag: "wx" });
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
