import { promises as fs } from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

async function realpathOrSelf(p: string): Promise<string> {
  return fs.realpath(p).catch(() => p);
}

/**
 * Git autocommit for a bundle — with the bundle's own repository treated as
 * untrusted. A bundle can arrive from anywhere (a clone, a sync, a bind mount),
 * and git runs programs named in a repository's config during plain `add` and
 * `commit`: fsmonitor, hooks, clean filters (triggered by .gitattributes in the
 * tree), the signing program. Committing into a planted repository would be
 * code execution as the server user.
 *
 * Two layers:
 * 1. Every git call overrides the settings a commit would otherwise execute.
 * 2. A repository whose local config names any command-running key is refused
 *    outright (autocommit is skipped and logged); there are too many such keys
 *    to override one by one, and filter/diff drivers are named per repository.
 */

/** Passed as `-c` on every call. The values turn the features off. */
const OVERRIDES = ["core.hooksPath=/dev/null", "core.fsmonitor=false", "commit.gpgsign=false"];

/**
 * Repository config keys that make git run a program, pull in more config, or
 * point it at files outside the bundle (core.worktree would stage and commit
 * whatever directory it names).
 */
const UNSAFE_KEY =
  /^(core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand|worktree)|extensions\.worktreeconfig|filter\..+\.(clean|smudge|process)|diff\..+\.(command|textconv)|merge\..+\.driver|gpg\.(.+\.)?program|credential\..*|alias\..+|include(if\..+)?\.path|sequence\.editor|uploadpack\..+|receive\..+|.+\.(command|cmd))$/;

export function createBundleGit(root: string): SimpleGit {
  return simpleGit({
    baseDir: root,
    // safe.directory: a bind-mounted bundle is usually owned by the host user,
    // not the server's, and git then refuses the repository outright. That
    // ownership check guards against repositories planted by another user —
    // the threat the overrides and the config scan here already handle — so
    // the bundle is trusted for these calls only, never globally.
    config: [...OVERRIDES, `safe.directory=${root}`],
    // simple-git refuses these keys even when the value disables the feature;
    // ours are constants, never user input.
    unsafe: { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true },
    // simple-git drops every ambient GIT_* variable by default. Commit identity
    // is the one set a deployment legitimately supplies that way (the Docker
    // image does) — none of these make git run anything.
    allowEnvironment: [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
    ],
  });
}

/**
 * Unsafe keys in the repository's own config. That is more than `.git/config`:
 * with extensions.worktreeConfig, git also reads `.git/config.worktree`, which
 * `--local` does not show. `--show-scope` labels every entry, so all
 * repository-controlled scopes are checked, whatever file they came from.
 * Fails closed: if the config cannot be read, the error stops the commit.
 */
export async function unsafeRepoConfigKeys(git: SimpleGit): Promise<string[]> {
  const listing = await git.raw(["config", "--list", "--name-only", "--show-scope"]);
  // "<scope>\t<name>": split on the first tab only — subsection names
  // (filter."a b".clean) may contain spaces.
  return listing
    .split("\n")
    .map((line) => {
      const tab = line.indexOf("\t");
      return [
        line.slice(0, tab),
        line
          .slice(tab + 1)
          .trim()
          .toLowerCase(),
      ];
    })
    .filter(([scope, name]) => (scope === "local" || scope === "worktree") && UNSAFE_KEY.test(name))
    .map(([, name]) => name);
}

/**
 * Startup check for GIT_AUTOCOMMIT, so a broken setup fails loudly at boot
 * instead of silently committing nothing on every mutation:
 * - git must be installed;
 * - the bundle must be its own repository — one that is not (or that only sits
 *   inside some other repository) gets initialized, so commits never land in a
 *   parent project's history;
 * - the repository config must pass the same check as every commit;
 * - commits need an identity: without one from git config or GIT_AUTHOR_*,
 *   a repository-local fallback is set.
 * (Adapted from upstream understory.)
 */
export async function prepareRepo(git: SimpleGit, root: string): Promise<void> {
  const version = await git.version();
  if (!version.installed) {
    throw new Error("git is not installed or not in PATH");
  }
  // "Own repository" means its top level is the bundle itself. Comparing paths
  // (not the .git entry) also covers worktrees and submodules, where .git is a
  // file, and a bundle nested inside some other repository.
  const toplevel = await git.revparse(["--show-toplevel"]).catch(() => "");
  const isOwnRepo =
    toplevel !== "" && (await realpathOrSelf(toplevel.trim())) === (await realpathOrSelf(root));
  if (!isOwnRepo) await git.init();

  const unsafe = await unsafeRepoConfigKeys(git);
  if (unsafe.length > 0) {
    throw new Error(
      `the bundle's git config sets keys that run programs (${unsafe.join(", ")}) — remove them`
    );
  }

  const email = await git.raw(["config", "user.email"]).catch(() => "");
  if (!email.trim() && !(process.env.GIT_AUTHOR_EMAIL && process.env.GIT_COMMITTER_EMAIL)) {
    await git.addConfig("user.name", "myzel");
    await git.addConfig("user.email", "myzel@localhost");
  }
  if (!isOwnRepo) {
    // Proves committing works before the first mutation depends on it.
    await git.commit("chore: initialize memory history", undefined, {
      "--allow-empty": null,
      "--no-verify": null,
    });
  }
}

/**
 * Commit what one mutation changed — the concept, the index.md files it
 * regenerated, log.md — and nothing else. The bundle is also the user's
 * folder: their half-finished hand edits and unrelated files are theirs to
 * commit, not ours to sweep into an agent's commit. Anything they had staged
 * stays staged and out of this commit. Traces never match: they hold users'
 * prompts and answers, telemetry rather than knowledge.
 *
 * `paths` are bundle-relative ("/a/b.md"); missing ones count when git still
 * tracks them (a deletion). Pathspecs are literal, so a file name holding `*`
 * or `:` matches only itself.
 */
export async function autocommit(
  git: SimpleGit,
  root: string,
  message: string,
  paths: string[]
): Promise<void> {
  const unsafe = await unsafeRepoConfigKeys(git);
  if (unsafe.length > 0) {
    throw new Error(
      `refusing to commit: the bundle's .git/config sets keys that run programs ` +
        `(${unsafe.join(", ")}). Remove them to re-enable GIT_AUTOCOMMIT.`
    );
  }
  const specs: string[] = [];
  for (const p of new Set(paths)) {
    const rel = p.replace(/^\/+/, "");
    if (!rel || rel.split("/").some((seg) => seg.startsWith("."))) continue;
    const spec = `:(literal)${rel}`;
    const exists = await fs
      .access(path.join(root, rel))
      .then(() => true)
      .catch(() => false);
    if (exists || (await git.raw(["ls-files", "--", spec])).trim()) specs.push(spec);
  }
  if (specs.length === 0) return;
  await git.raw(["add", "--all", "--", ...specs]);
  const staged = await git.raw(["diff", "--cached", "--name-only", "--", ...specs]);
  if (!staged.trim()) return;
  // Naming the paths makes this an --only commit: other staged changes stay out.
  await git.raw(["commit", "--no-verify", "-m", message, "--", ...specs]);
}
