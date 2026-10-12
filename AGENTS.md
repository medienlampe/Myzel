# AGENTS.md

Working notes for coding agents (Claude Code, Cursor, Copilot, …) on **Myzel**.
Read this before touching code. It encodes the invariants that are not obvious from the file tree.
`CLAUDE.md` is a symlink to this file — edit `AGENTS.md`, never the link.

Longer-form documentation lives in [`docs/`](docs/outline.md): architecture, security model,
dependency maintenance.

---

## 1. What this project is

Myzel is an **LLM-managed knowledge base** stored as plain markdown, conforming to the
[Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

This repository **started as a fork of [thecodacus/understory](https://github.com/thecodacus/understory)**
by [@thecodacus](https://github.com/thecodacus), was renamed to Myzel, and develops independently
from it. History and
design decisions predating the fork live upstream — worth a look before concluding something here is
unexplained — but do not assume the two are in sync, and do not port changes across without being
asked. This repository publishes its own image, `ghcr.io/medienlampe/myzel`.

A "bundle" is a directory of `.md` files with YAML frontmatter. Three entry points drive the same
internal agent against that bundle:

| Entry point | Where | Purpose |
|---|---|---|
| MCP server (stdio + streamable HTTP) | `packages/server/src/mcp/` | `memory_query` / `memory_add` / `memory_update` / `memory_status` / `memory_maintain` |
| Web UI | `packages/web/` | Browse bundle, force-directed graph, chat with the agent, replay query traces |
| CLI | `packages/core/src/agent/cli.ts` | `pnpm agent:query` / `pnpm agent:mutate` smoke entries |

**The one design rule that governs everything:**

> Conformance is enforced in **code**, not in prompts. The LLM decides *what* to change;
> `packages/core/src/okf/` guarantees the result is a conformant bundle.

Anything that must always hold (frontmatter validity, `index.md` regeneration, `log.md` append,
path sandboxing, mutation serialization) belongs in the deterministic layer — never in a system
prompt. If you are tempted to fix a correctness bug by editing `system-prompt.ts`, you are
probably fixing it in the wrong place.

---

## 2. Repo layout

```
packages/core/          # zero-server, zero-express. Reusable library.
  src/okf/              # DETERMINISTIC layer — no LLM anywhere in this directory
    bundle.ts           #   sandboxed filesystem access to one bundle
    knowledge-base.ts   #   THE write path: mutation queue + index + log + optional git commit
    frontmatter.ts      #   `---` fence + `yaml` parse/serialize (permissive per spec §9, YAML only)
    git.ts              #   hardened GIT_AUTOCOMMIT (the bundle's own .git is untrusted)
    indexer.ts          #   index.md regeneration (spec §6)
    logger.ts           #   log.md append, newest-first (spec §7)
    validate.ts         #   conformance report (spec §9)
    lint.ts / graph.ts  #   orphans, broken links, link graph
    atomic.ts           #   writeFileAtomic — temp file + rename, used by every writer
    search.ts           #   naive keyword scan (fine into low thousands of concepts)
  src/agent/            # LLM layer (Vercel AI SDK v7)
    agent.ts            #   runQuery / runMutation / streamChat (tool loop, timed, step-capped, cancellable)
    model.ts            #   model chain (primary, override, fallback) shared by agent runs and hot memory
    tools.ts            #   read tools + write tools handed to the model
    system-prompt.ts    #   OKF spec + operating rules + per-mode section
    query-cache.ts      #   layer 1: exact cache, fingerprint-invalidated
    hot-memory.ts       #   layer 2: recent writes + recent Q&A, one tool-free call
    dream.ts            #   autonomous consolidation pass (signals → agent instruction)
    trace.ts            #   traversal recording, persisted to <bundle>/.traces/
    untrusted.ts        #   sanitizers for bundle content headed into a prompt
  src/providers/        # OpenAI-/Anthropic-compatible model config, fallback wrapper, publicErrorMessage
  src/util/             # parseDuration, truncate, redactUrl

packages/server/        # Express 5 + MCP SDK
  src/index.ts          # app wiring: headers, /healthz, CORS, guards, auth (+ failed-auth throttle),
                        #   rate limits, static web build, error handler, graceful shutdown
  src/limits.ts         # input ceilings for everything that reaches a model
  src/startup.ts        # model-config check shared by the HTTP and stdio entry points
  src/net-guard.ts      # Origin/Host validation + the CORS delegate
  src/rate-limit.ts     # per-client brake on the token-spending routes
  src/mcp/server.ts     # the five MCP tools + seed memory refresh
  src/mcp/seed.ts       # session-start memory overview injected into the CLIENT model
  src/api/browse.ts     # deterministic REST browse API (never costs tokens)
  src/api/chat.ts       # streaming chat for the web UI (aborts the run when the client disconnects)

packages/web/           # Vite 8 + React 19 + Tailwind 4
  src/App.tsx           #   data loading + the three panels' content
  src/layout.ts         #   pure layout model: panel order, visibility, widths (persisted in localStorage)
  src/components/Workspace.tsx  # drag & drop + resizable columns (react-resizable-panels v4)
sample-bundle/          # a small conformant bundle used for dev + tests
docs/                   # outline.md → architecture, security, maintenance
```

---

## 3. Setup and commands

Requires **Node ≥ 22.12** and **pnpm 10.34.6** (pinned via `packageManager`; use `corepack enable`).

The [Makefile](Makefile) wraps everything below (`make help` lists it); `make check` runs exactly
what CI runs, and `make dev` / `make start` / `make query` load `.env` and default to the gitignored
`demo-bundle/`. The underlying commands:

```bash
pnpm install
pnpm lint                  # eslint 10 (flat config, type-unaware — tsc covers types)
pnpm format                # prettier --write .   (format:check is what CI runs)
pnpm build                 # tsc for core+server, tsc -b && vite build for web (topological order)
pnpm test                  # vitest + typecheck in every package
```

CI runs `pnpm install --frozen-lockfile`, then lint, format:check, build and test on Node 24. Run
`pnpm lint && pnpm format:check && pnpm test` before pushing and you will not be surprised.

Run the server from source:

```bash
BUNDLE_ROOT=./sample-bundle \
LLM_API_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=sk-... \
LLM_API_FORMAT=openai LLM_MODEL=deepseek-chat \
node packages/server/dist/index.js       # → http://localhost:3800
```

Dev mode (two terminals — server on :3800, Vite HMR on :5180 proxying `/api` and `/mcp`):

```bash
BUNDLE_ROOT=./sample-bundle pnpm --filter @myzel/server dev
pnpm --filter @myzel/web dev
```

Agent smoke entries (need a working `BUNDLE_ROOT` + LLM env):

```bash
BUNDLE_ROOT=./sample-bundle pnpm agent:query  "What do we know about billing?"
BUNDLE_ROOT=./sample-bundle pnpm agent:mutate "Record that we deploy on Fridays"
pnpm --filter @myzel/server exec tsx scripts/mcp-smoke.mts   # needs SMOKE_BUNDLE
```

**Never commit to `sample-bundle/` as a side effect.** Agent runs against it mutate real files
(`index.md`, `log.md`, concepts, and `.traces/`). The `make` targets default to `demo-bundle/`
(gitignored, copied from the sample; `make reset-demo` starts it over); without make, point
`BUNDLE_ROOT` there yourself, and `git checkout -- sample-bundle` if you dirtied it.
`make up` (docker compose) does mount `sample-bundle/` — mind that when testing writes. The server boots without a reachable model (only the config is validated), so
dummy `LLM_*` values are enough to exercise the UI.

---

## 4. Invariants — do not break these

1. **All bundle writes go through `KnowledgeBase`**, never `Bundle` directly and never `node:fs`.
   `KnowledgeBase` is the only place that serializes mutations (`enqueue`), regenerates the
   `index.md` ancestor chain, appends to `log.md`, and optionally git-commits. A write that
   bypasses it produces a non-conformant bundle.
2. **All path handling goes through `Bundle.resolve()` / `Bundle.toBundlePath()`.** Public methods
   take and return *bundle-relative* paths starting with `/`. Nothing may read or write outside
   `bundle.root`. If you add a method taking a caller-supplied path, sandbox it there — see §8.
3. **`index.md` and `log.md` are reserved** (`RESERVED_FILENAMES`). They are generated, never
   authored, and are excluded from concept listings, the graph, and search.
4. **`type` is the only required frontmatter field** (spec §5). Reading is permissive — unknown
   keys and types must round-trip untouched (spec §9). Writing enforces non-empty `type`.
5. **Frontmatter is YAML only, parsed with the YAML 1.2 core schema** (`frontmatter.ts`, on the
   `yaml` package). Fences naming another language (`---js`) are refused — general-purpose
   frontmatter libraries `eval` those. Values keep their written type (an unquoted date stays a
   string); output is written YAML-1.1-safe. Never parse frontmatter anywhere else.
6. **Broken links are warnings, never errors.** The spec requires consumers to tolerate them.
   `validate()` must stay conformant in their presence; `lint()` is where they are surfaced.
7. **The deterministic layer (`src/okf/`) must not import from `src/agent/` or `src/providers/`.**
   The dependency arrow points one way: `okf ← agent ← server`.
8. **Bundle content is untrusted input to every prompt.** Sanitize it at the interpolation site
   (`sanitizeInline` / `sanitizePath`, or `deriveConceptDescription` in `seed.ts`), never by
   trusting the writer.
9. **Traces live in `<bundle>/.traces/`** — a dot-directory. Every bundle walker skips
   dot-entries **and symlinks** (`isHiddenOrLink`), so traces never affect conformance, the graph,
   or search, and links never pull host files in. Keep it that way in any new walker.
10. **stdout is the MCP protocol stream** in `mcp/stdio.ts`. All logging there goes to `stderr`.
    A stray `console.log` in any code path reachable from stdio corrupts the transport.
11. **The mutation queue is per-process.** Two processes (e.g. an stdio MCP client and the HTTP
    server) pointed at the same bundle are *not* serialized against each other.
12. **The bundle's `.git` is untrusted.** Git runs only through `createBundleGit`/`autocommit`
    (`okf/git.ts`): fixed `-c` overrides, a refusal when repo config sets command-running keys,
    `.traces/` excluded. Never call `simpleGit()` on the bundle directly.
13. **Every model-bound input is capped** (`server/src/limits.ts`). A new tool parameter or route
    that reaches a model gets a `max` from there.
14. **The web UI must work under the server's CSP** (`script-src 'self'`, no inline scripts, no
    `eval`). Inline *styles* are allowed only because Shiki emits them.

---

## 5. Conventions

- TypeScript 6, ESM only (`"type": "module"`), `NodeNext` resolution — **relative imports need the
  `.js` extension** in core/server (`./bundle.js`, not `./bundle`). `strict: true` everywhere.
  TS 6 defaults `types` to `[]`, so Node types come from `"types": ["node"]` in
  `tsconfig.base.json`, and web uses `"types": ["vite/client"]`.
- **TypeScript stays on `~6.0`**: typescript-eslint supports `<6.1`. Don't bump to 7 until it does.
- Zod 4 idioms: `z.looseObject(...)` instead of `.passthrough()`, `z.record(key, value)` with both
  arguments.
- Exported functions returning AI SDK tool sets or stream results need an explicit return type
  (`ToolSet`, `ReturnType<typeof streamText<ToolSet>>`) — TS 6 refuses non-portable inferred types.
- Cross-package imports use the workspace entry point: `import { KnowledgeBase } from "@myzel/core"`.
  New public symbols must be re-exported through the `index.ts` barrel of their directory.
- Formatting is Prettier's job (`.prettierrc.json`, 100 columns) — don't hand-wrap against it, and
  don't reformat unrelated lines. Lint is `eslint.config.js`, deliberately type-unaware, with the
  React Compiler rules from `eslint-plugin-react-hooks` v7 on the web package (no setState
  directly in effects, no ref reads during render, no reassigning variables after render).
- Comments explain **why**, not what — see the existing files. Match that density: a short block
  comment above a module or a non-obvious decision, no line-by-line narration.
- Errors from the bundle layer are `BundleError` with a typed `code`; API layers map the code to
  a status (`NOT_FOUND` → 404, otherwise 400). Don't throw bare `Error` from `src/okf/`.
  When rethrowing, attach `{ cause }` (the `preserve-caught-error` lint rule enforces it).
- Env vars are read where they are used, with a documented default, and every new one is added to
  `.env.example` with a comment.
- Duration env vars use `parseDuration` (`"30s" | "15m" | "6h" | "1d"`), which returns `null` on
  invalid input — callers decide the fallback.
- Web: Tailwind 4 is configured in CSS (`src/index.css`, `@import "tailwindcss"`) via the
  `@tailwindcss/vite` plugin — there is no `tailwind.config.js` or PostCSS config. Use v4 class
  names (`rounded-sm`, `outline-hidden`, …).

---

## 6. Testing

- `packages/core/test/` — vitest, no mocking of the filesystem: tests build real temp bundles.
  The OKF suite is organized by spec section (§5 frontmatter, §6 index, §7 log, §9 conformance)
  plus sandbox, search, graph/lint, and mutation-concurrency cases.
- LLM calls are **injected, never mocked globally**: `runDream`, `runQueryCached`, and `hotLookup`
  each take an injectable runner/generate parameter for exactly this reason. Follow that pattern
  for any new LLM-touching function — do not add a test that hits a real provider. Fake models in
  tests use `specificationVersion: "v4"`; older specs get adapted by `wrapLanguageModel`.
- `packages/server/test/` runs `tsc -p tsconfig.test.json` first (`typecheck:test`), then vitest.
  HTTP-level tests start a real Express app on an ephemeral port (`http.test.ts`,
  `rate-limit.test.ts`) — validation paths only, never a model call.
- `packages/core/test/git.test.ts` needs a `git` binary and plants real attacks (fsmonitor,
  filters, hooks) in a temp repo; keep that style for anything touching git.
- `packages/web/test/` covers the pure layout model (`src/layout.ts`); `pnpm test` there also
  typechecks.
- Adding behaviour to `src/okf/` without a test is the wrong move — that layer is the correctness
  guarantee and is cheap to test (no network, no model).

---

## 7. Common tasks — where to start

| Task | Start here |
|---|---|
| Add an MCP tool | `packages/server/src/mcp/server.ts` (registration) → `packages/core/src/agent/agent.ts` if it needs an agent run |
| Add a tool the *internal* model can call | `packages/core/src/agent/tools.ts` (`buildReadTools` / `buildWriteTools`) + a `trace?.record(...)` call + a case in `buildNotation` |
| Change agent behaviour/rules | `packages/core/src/agent/system-prompt.ts` — but first check §1: is this really a prompt problem? |
| Change what a new session sees about the memory | `packages/server/src/mcp/seed.ts` |
| Add a REST endpoint for the UI | `packages/server/src/api/browse.ts` (deterministic; must not call the LLM) |
| Add a provider / change model resolution | `packages/core/src/providers/index.ts` |
| Change conformance rules | `packages/core/src/okf/validate.ts` + a test per spec section |
| Add a panel to the web UI | add its id to `PANEL_IDS` in `packages/web/src/layout.ts` (+ default size), then a `PanelSpec` in `App.tsx` |
| Change the graph view | `packages/web/src/components/GraphView.tsx` (d3-force, ~600 lines — the largest file in the repo) |

---

## 8. Gotchas and known sharp edges

- **`Bundle.resolve()` normalizes before deciding** whether an absolute-looking input is an OS path
  inside the bundle or a canonical bundle-relative path. Don't "simplify" that back into a prefix
  test on the raw string — `/<root>/../../etc/passwd` carries the root as a literal prefix while
  pointing outside it. Anything that reads or writes file *contents* additionally goes through
  `assertRealPathInside()`, which follows symlinks — so do deletes (parent directory) and index
  regeneration (`resolveContained`), while walkers skip symlinks entirely. A new code path that
  touches the filesystem needs the same; see [docs/security.md](docs/security.md#bundle-files).
- **Prompt injection is in scope, and there is a helper for it.** Bundle content flows into (a) the
  internal agent's system prompt via `treeSummary`, (b) the MCP `instructions` field, and (c) the
  `memory_query` tool description via `seed.ts` — i.e. straight into the *client's* context. Every
  title, description, type, path and log summary on those paths goes through `sanitizeInline` /
  `sanitizePath` from `agent/untrusted.ts` first. **If you interpolate bundle content into any new
  prompt, sanitize it there too**, and keep `UNTRUSTED_CONTENT_NOTICE` next to it. Concept
  *bodies* read via `read_concept` stay free-form by design — that is the product.
- **`AUTH_TOKEN` is still unset by default**, but the server binds `127.0.0.1` and `net-guard.ts`
  enforces same-origin (plus `ALLOWED_ORIGINS`) on `/mcp` and `/api`, and **always** checks the
  `Host` header against DNS rebinding: loopback names pass, IP literals pass on a public bind
  (`hostPolicy: "public"`), every other hostname needs `ALLOWED_HOSTS`. Keep the invariant when
  touching `index.ts`: **the guard mounts before `bearerAuth`**, and CORS must never reflect an
  origin the guard would reject. `HOST=0.0.0.0` is the explicit opt-in for network exposure and
  warns when no token is set. The Docker image sets it, so for containers the *published* address
  decides exposure — the compose files default to `127.0.0.1` via `MYZEL_BIND`.
- **Errors shown to clients go through `publicErrorMessage`** (provider errors → HTTP status only);
  log the full error on the server. URLs in logs go through `redactUrl`.
- **simple-git 4 strips ambient `GIT_*` env vars** unless listed in `allowEnvironment`
  (`okf/git.ts` allows only the commit-identity ones), and refuses `-c` keys it deems unsafe
  unless unlocked. Expect both when changing git calls.
- **Shutdown drains writes.** SIGTERM/SIGINT stop the HTTP server and await
  `KnowledgeBase.idle()` (8s cap); the image runs under `tini` so the signal arrives.
- **Docker build:** production dependencies come from a clean `pnpm install --prod --offline`, not
  `pnpm prune --prod` — prune leaves the workspace packages unlinked and the container won't start.
  After touching the Dockerfile, build and *run* the image (`/healthz` must go healthy).
- **Agent runs are cancellable.** `AgentOptions.signal` is combined with the `LLM_TIMEOUT` ceiling;
  `/api/chat` aborts on client disconnect. Pass a signal from any new long-running entry point.
- **Module-level caches**: `query-cache.ts` and `hot-memory.ts` hold process-global state so it
  survives the per-request `McpServer` instances of the stateless HTTP transport. Both are
  **partitioned by bundle root**. Within one bundle the state is shared by all callers;
  `HOT_MEMORY_RECALL_QA=false` keeps one caller's Q&A out of another's prompt on a shared
  instance. Use `clearQueryCache()` / `clearHotMemory()` in tests.
- **The query cache is invalidated by a bundle fingerprint** (path + mtime + size of every concept),
  not by write hooks. Out-of-band edits are picked up; sub-millisecond same-size edits are not.
- **The dreamer's first run is one interval after boot**, never at startup, and `DREAM_INTERVAL`
  is clamped to a 5-minute minimum. It is opt-in; unset means zero background token spend.
- **`log.md` is parsed and re-rendered on every append**, not patched with string replacement, and
  anything not matching the heading/bullet grammar is dropped. That is deliberate: the file is
  generated (spec §7), and an LLM-written summary must not be able to steer where the next bullet
  lands. Concept, index and log writes all go through `writeFileAtomic` (temp file + rename).
- **Web `MarkdownRenderer` uses `dangerouslySetInnerHTML`** for Shiki output. That is safe only
  because Shiki escapes its input; don't route any other HTML through that path. Its
  `rehype-sanitize` schema needs **flat** protocol lists — a nested array silently strips links.
- **`useChat` keeps the first transport it gets.** Per-request values (the model override) go
  through `sendMessage(..., { body })`, not through a transport rebuilt on render.
- **The workspace `Group` remounts when the column order changes** (`key` = visible order), and
  widths are reapplied from the persisted layout. During a panel drag, a transparent shield covers
  every other panel so inputs or the graph canvas cannot swallow the drop.

---

## 9. Environment variables

`BUNDLE_ROOT` is the only required one. See `.env.example` for the full annotated list; the ones
worth knowing:

| Var | Effect |
|---|---|
| `BUNDLE_ROOT` | Directory the agent manages. Required. |
| `LLM_API_BASE_URL` / `LLM_API_KEY` / `LLM_API_FORMAT` / `LLM_MODEL` | Primary model. `LLM_MODEL` may be empty for OpenAI-compatible endpoints — it is auto-discovered from `/v1/models` (60s cache). |
| `LLM_FALLBACK_*` | Optional second model, used on retryable failures. `LLM_FALLBACK_ALLOW_FOR=query` restricts it to read-only ops. |
| `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, … | **Deprecated** legacy path in `providers/index.ts`. Still supported; don't extend it. |
| `AUTH_TOKEN` | Bearer token for `/mcp` + `/api`. Unset = open. |
| `RATE_LIMIT` / `RATE_LIMIT_WINDOW` | Per-client brake on `/mcp` + `/api/chat` (default 60/1m, `0` disables). |
| `RATE_LIMIT_BROWSE` | Separate brake on the `/api` browse routes (default 600 per window, `0` disables). |
| `TRUST_PROXY` | Express `trust proxy` (hop count or addresses) so rate limits see real clients behind a proxy. |
| `ALLOWED_MODELS` | Models a client may request. Unset = client overrides refused; `*` allows any. |
| `LLM_TIMEOUT` / `LLM_MAX_STEPS` / `LLM_DISCOVERY_TIMEOUT` / `HOT_MEMORY_TIMEOUT` | Run ceiling (5m), tool-loop budget (12), and the two shorter timeouts. |
| `HOT_MEMORY_RECALL_QA` | `false` drops recent Q&A pairs from the hot working set. |
| `HOST` | Bind address. Default `127.0.0.1`; `0.0.0.0` to expose on the network (the Docker image sets it). |
| `ALLOWED_ORIGINS` / `ALLOWED_HOSTS` | Additions to the same-origin/loopback defaults of the network guard. `*` opts out. |
| `PORT` | Default 3800. |
| `MYZEL_BIND` | Compose files only: host interface the port is published on (default `127.0.0.1`). |
| `GIT_AUTOCOMMIT` | Commit the bundle after every mutation (best-effort; failures are logged, not thrown). |
| `QUERY_CACHE` / `QUERY_CACHE_TTL` | Exact-answer cache (default on, 24h). |
| `HOT_MEMORY` / `HOT_MEMORY_TTL` | Working-set layer (default on, 1h). |
| `DREAM_INTERVAL` / `DREAM_INSIGHTS` | Autonomous consolidation. Opt-in. |

---

## 10. Git and PR conventions

- Branch off `main`; `main` is the PR target.
- Match the commit style of recent history (`git log --oneline`). Upstream-era commits use
  conventional subjects (`feat: …`, `fix: …`); commits in this fork use short sentence-case
  summaries ending in a period (`Fixes further security issues.`).
- CI (`.github/workflows/docker.yml`) runs lint, format:check, build and test on every PR, then
  builds and publishes the container on `main`/tags. Green build + green tests are the bar.
- Don't commit `.env`, `demo-bundle/`, or a dirtied `sample-bundle/`.
