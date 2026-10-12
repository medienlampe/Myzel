# Maintenance

How dependencies are kept current, which versions are pinned on purpose, and the traps to check
for when upgrading. Day-to-day commands are in [AGENTS.md](../AGENTS.md) §3.

## Versions and why they are pinned

| What | Pinned to | Why |
|---|---|---|
| Node | `engines: >=22.12`; Docker and CI use 24 (LTS) | AI SDK 7, Vite 8 and Vitest 5 need 22.12. |
| `@types/node` | `^22` | It follows the *oldest* supported runtime, so code cannot use APIs that Node 22 lacks. |
| TypeScript | `~6.0` | `typescript-eslint` supports `<6.1`. Move to 7 once it supports it. |
| pnpm | `packageManager` field (exact version) | `corepack enable` gets everyone the same version. |
| GitHub Actions | full commit SHA, with the release in a comment | A tag can be moved to different code. |
| Base image | `node:24-alpine@sha256:…` | The tag stays for readability; the digest decides what is used. |

Dependabot (`.github/dependabot.yml`) updates npm packages, actions and the base image weekly,
with a 7-day cooldown so brand-new releases can settle first. If your environment enforces a
minimum release age, pick an older release rather than adding exemptions to
`pnpm-workspace.yaml`.

## Upgrade checklist

Run this before merging any dependency change:

```bash
pnpm install --frozen-lockfile   # what CI does: the lockfile must match package.json
pnpm audit --prod --audit-level high
pnpm lint && pnpm format:check
pnpm -r build && pnpm test
```

If the Dockerfile, pnpm or the production dependencies changed, also **build and run** the image.
A green build alone is not enough; it has happened that the image built but could not start.

```bash
docker build -t understory:check .
docker run -d --name understory-check -p 127.0.0.1:3899:3800 \
  -e LLM_API_BASE_URL=http://127.0.0.1:9/v1 -e LLM_API_KEY=dummy -e LLM_MODEL=dummy \
  understory:check
docker inspect -f '{{.State.Health.Status}}' understory-check   # wait for "healthy"
docker stop understory-check   # should exit 0 within a second (graceful shutdown)
docker rm understory-check && docker rmi understory:check
```

Dummy model settings are enough here: the server only validates its configuration at startup.

## Known traps

These cost time once. Check them again when the package in question moves.

- **pnpm in Docker.** `pnpm prune --prod` asks for confirmation without a TTY, and with the
  prompt disabled it leaves the workspace packages unlinked. The Dockerfile therefore does a clean
  `pnpm install --prod --frozen-lockfile --offline` instead.
- **simple-git 4:**
  - it drops ambient `GIT_*` environment variables unless they are listed in `allowEnvironment`;
  - it refuses some `-c` keys (`core.hooksPath`, `core.fsmonitor`) unless they are unlocked.

  `okf/git.ts` handles both; keep it that way.
- **TypeScript 6:**
  - `types` defaults to `[]`, so Node types come from `tsconfig.base.json` and the web package
    lists `vite/client`;
  - exported functions returning AI SDK tool sets or stream results need explicit return types.
- **AI SDK:**
  - models follow a specification version (currently `v4`), and test fakes must declare the
    current one, or `wrapLanguageModel` adapts their calls;
  - `useChat` keeps the first transport it receives, so per-request values go through
    `sendMessage(…, { body })`.
- **Tailwind 4:**
  - there is no config file; everything is in `src/index.css`;
  - a small base layer keeps the v3 border colour and the button cursor, so remove it only on
    purpose.
- **React Compiler lint rules** (`eslint-plugin-react-hooks` 7) reject `setState` directly in
  effects, ref reads during render, and reassignment after render. Fix the pattern rather than
  disabling the rule.
- **Zod 4:** use `z.looseObject(…)` instead of `.passthrough()`, and pass both a key and a value
  schema to `z.record()`.
