import { promises as fs } from "node:fs";
import { KnowledgeBase } from "@myzel/core";
import { ProfileError, type ProfileRegistry } from "./profiles.js";

/**
 * The profiles CLI's commands, apart from process wiring (profiles-cli.ts) so
 * they can be tested. Returns the exit code. (Ported from upstream understory.)
 */

export const USAGE = `Usage: <profiles-cli> <command>

  list                     Show profiles
  create <name>            Create a profile and print its API key (shown once)
  rotate <name>            Replace a profile's API key; the old key stops working
  remove <name> [--purge]  Revoke a profile's key. The memory stays on disk
                           unless --purge is given.

Reads PROFILES_ROOT from the environment. Run as "make profiles ARGS=…" from a
source checkout, or "node server/dist/profiles-cli.js …" in the container.`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliOptions {
  gitAutocommit: boolean;
}

function printKey(io: CliIo, profile: string, key: string): void {
  io.out(`profile: ${profile}`);
  io.out(`api key: ${key}`);
  io.out("");
  io.out("Store this key now — it is not saved and cannot be shown again.");
  io.out(`Use it as:  Authorization: Bearer ${key}`);
}

async function list(registry: ProfileRegistry, io: CliIo): Promise<void> {
  const profiles = await registry.list();
  if (profiles.length === 0) {
    io.out(`No profiles in ${registry.root}. Create one with the "create <name>" command.`);
  }
  for (const p of profiles) {
    const concepts = await new KnowledgeBase(registry.bundlePath(p.name)).bundle
      .listConceptPaths()
      .then(
        (paths) => paths.length,
        () => 0
      );
    io.out(
      `${p.name.padEnd(24)} ${String(concepts).padStart(5)} concepts   created ${p.createdAt.slice(0, 10)}`
    );
  }
  // Directories without a key: revoked profiles kept on disk, or bundles to adopt.
  const registered = new Set(profiles.map((p) => p.name));
  const entries = await fs.readdir(registry.root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && !registered.has(entry.name)) {
      io.out(`${entry.name.padEnd(24)} (no key — "create ${entry.name}" adopts this directory)`);
    }
  }
}

export async function runProfilesCommand(
  argv: string[],
  registry: ProfileRegistry,
  io: CliIo,
  options: CliOptions
): Promise<number> {
  const [command, ...rest] = argv;
  const purge = rest.includes("--purge");
  const [name] = rest.filter((a) => !a.startsWith("--"));
  const needName = () => {
    if (!name) throw new ProfileError(`${command} needs a profile name`, "INVALID_NAME");
    return name;
  };

  try {
    switch (command) {
      case "list":
        await list(registry, io);
        return 0;
      case "create": {
        const created = await registry.create(needName());
        if (options.gitAutocommit) {
          try {
            await new KnowledgeBase(registry.bundlePath(created.name), {
              gitAutocommit: true,
            }).ensureGitReady();
          } catch (err) {
            // Same rule as the admin API: a profile whose history cannot be
            // recorded is not handed out. Its directory stays on disk.
            await registry.remove(created.name);
            io.err(`error: git autocommit cannot work for this profile: ${(err as Error).message}`);
            return 1;
          }
        }
        printKey(io, created.name, created.key);
        return 0;
      }
      case "rotate": {
        const rotated = await registry.rotate(needName());
        printKey(io, rotated.name, rotated.key);
        return 0;
      }
      case "remove": {
        await registry.remove(needName(), { purge });
        io.out(
          purge
            ? `Removed profile "${name}" and deleted its memory.`
            : `Revoked profile "${name}". Its memory is still at ${registry.bundlePath(name)} (use --purge to delete it).`
        );
        return 0;
      }
      case undefined:
      case "help":
      case "--help":
        io.out(USAGE);
        return command ? 0 : 1;
      default:
        io.err(`Unknown command "${command}"\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof ProfileError) {
      io.err(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
