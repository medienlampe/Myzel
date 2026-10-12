#!/usr/bin/env node
/**
 * Manage profiles from the command line — process wiring only; the commands
 * live in profiles-commands.ts. Operates on PROFILES_ROOT directly, so it works
 * next to a running server (which picks changes up on the next request).
 *
 *   docker compose exec myzel node server/dist/profiles-cli.js create work
 *   make profiles ARGS="create work"          (from a source checkout)
 */
import { ProfileRegistry } from "./profiles.js";
import { runProfilesCommand, USAGE } from "./profiles-commands.js";

const io = { out: (line: string) => console.log(line), err: (line: string) => console.error(line) };
const argv = process.argv.slice(2);
const root = process.env.PROFILES_ROOT;
if (!root && argv[0] !== "help" && argv[0] !== "--help") {
  console.error(`PROFILES_ROOT is not set\n\n${USAGE}`);
  process.exit(1);
}
const gitAutocommit = process.env.GIT_AUTOCOMMIT === "true";
const registry = new ProfileRegistry(root ?? ".", { gitAutocommit });
process.exit(await runProfilesCommand(argv, registry, io, { gitAutocommit }));
