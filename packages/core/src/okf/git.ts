import { simpleGit, type SimpleGit } from "simple-git";

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

/** Repository-local config keys that make git run a program, or pull in more config. */
const UNSAFE_KEY =
  /^(core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand)|filter\..+\.(clean|smudge|process)|diff\..+\.(command|textconv)|merge\..+\.driver|gpg\.(.+\.)?program|credential\..*|alias\..+|include(if\..+)?\.path|sequence\.editor|uploadpack\..+|receive\..+|.+\.(command|cmd))$/;

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

/** Config keys in the repository's own `.git/config` that would run code. */
export async function unsafeRepoConfigKeys(git: SimpleGit): Promise<string[]> {
  // Fails closed: if the config cannot be read, the error stops the commit.
  const names = await git.raw(["config", "--local", "--name-only", "--list"]);
  return names
    .split("\n")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name && UNSAFE_KEY.test(name));
}

/**
 * Stage everything except traces and commit. Traces hold users' prompts and
 * answers — telemetry, not knowledge — so they stay out of history.
 */
export async function autocommit(git: SimpleGit, message: string): Promise<void> {
  const unsafe = await unsafeRepoConfigKeys(git);
  if (unsafe.length > 0) {
    throw new Error(
      `refusing to commit: the bundle's .git/config sets keys that run programs ` +
        `(${unsafe.join(", ")}). Remove them to re-enable GIT_AUTOCOMMIT.`
    );
  }
  await git.add(["--all", "--", ".", ":(exclude).traces"]);
  await git.commit(message, undefined, { "--no-verify": null });
}
