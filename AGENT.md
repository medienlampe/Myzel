# AGENT.md

Working notes for coding agents (Claude Code, Cursor, Copilot, …) on **understory**.
Read this before touching code. It encodes the invariants that are not obvious from the file tree.

---

## 1. What this project is

understory is an **LLM-managed knowledge base** stored as plain markdown, conforming to the
[Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

This repository **started as a fork of [thecodacus/understory](https://github.com/thecodacus/understory)**
and develops independently from it. History and design decisions predating the fork live upstream —
worth a look before concluding something here is unexplained — but do not assume the two are in sync,
and do not port changes across without being asked. This repository publishes its own image,
`ghcr.io/medienlampe/understory`.

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
    frontmatter.ts      #   gray-matter parse/serialize (permissive per spec §9)
    indexer.ts          #   index.md regeneration (spec §6)
    logger.ts           #   log.md append, newest-first (spec §7)
    validate.ts         #   conformance report (spec §9)
    lint.ts / graph.ts  #   orphans, broken links, link graph
    atomic.ts           #   writeFileAtomic — temp file + rename, used by every writer
    search.ts           #   naive keyword scan (fine into low thousands of concepts)
  src/agent/            # LLM layer
    agent.ts            #   runQuery / runMutation / streamChat (AI SDK tool loop, timed + step-capped)
    tools.ts            #   read tools + write tools handed to the model
    system-prompt.ts    #   OKF spec + operating rules + per-mode section
    query-cache.ts      #   layer 1: exact cache, fingerprint-invalidated
    hot-memory.ts       #   layer 2: recent writes + recent Q&A, one tool-free call
    dream.ts            #   autonomous consolidation pass (signals → agent instruction)
    trace.ts            #   traversal recording, persisted to <bundle>/.traces/
    untrusted.ts        #   sanitizers for bundle content headed into a prompt
  src/providers/        # generic OpenAI-/Anthropic-compatible model config + fallback wrapper

packages/server/        # Express 5 + MCP SDK
  src/index.ts          # app wiring, CORS, guards, auth, rate limit, static web build, dreamer
  src/net-guard.ts      # Origin/Host validation + the CORS delegate
  src/rate-limit.ts     # per-client brake on the token-spending routes
  src/mcp/server.ts     # the five MCP tools + seed memory refresh
  src/mcp/seed.ts       # session-start memory overview injected into the CLIENT model
  src/api/browse.ts     # deterministic REST browse API (never costs tokens)
  src/api/chat.ts       # streaming chat for the web UI

packages/web/           # Vite + React 18 + Tailwind
sample-bundle/          # a small conformant bundle used for dev + tests
```

---

## 3. Setup and commands

Requires **Node ≥ 20** and **pnpm 10.15.0** (pinned via `packageManager`; use `corepack enable`).

```bash
pnpm install
pnpm lint                  # eslint (flat config, type-unaware — tsc covers types)
pnpm format                # prettier --write .   (format:check is what CI runs)
pnpm build                 # tsc for core+server, tsc -b && vite build for web (topological order)
pnpm test                  # vitest + typecheck in core and server; typecheck in web
```

CI runs `pnpm install --frozen-lockfile`, then lint, format:check, build and test. Run
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
BUNDLE_ROOT=./sample-bundle pnpm --filter @understory/server dev
pnpm --filter @understory/web dev
```

Agent smoke entries (need a working `BUNDLE_ROOT` + LLM env):

```bash
BUNDLE_ROOT=./sample-bundle pnpm agent:query  "What do we know about billing?"
BUNDLE_ROOT=./sample-bundle pnpm agent:mutate "Record that we deploy on Fridays"
pnpm --filter @understory/server exec tsx scripts/mcp-smoke.mts   # needs SMOKE_BUNDLE
```

**Never commit to `sample-bundle/` as a side effect.** Agent runs against it mutate real files
(`index.md`, `log.md`, concepts, and `.traces/`). Point `BUNDLE_ROOT` at a throwaway directory
(`demo-bundle/` is gitignored) when exercising mutations, and `git checkout -- sample-bundle`
if you dirtied it.

---

## 4. Invariants — do not break these

1. **All bundle writes go through `KnowledgeBase`**, never `Bundle` directly and never `node:fs`.
   `KnowledgeBase` is the only place that serializes mutations (`enqueue`), regenerates the
   `index.md` ancestor chain, appends to `log.md`, and optionally git-commits. A write that
   bypasses it produces a non-conformant bundle.
2. **All path handling goes through `Bundle.resolve()` / `Bundle.toBundlePath()`.** Public methods
   take and return *bundle-relative* paths starting with `/`. Nothing may read or write outside
   `bundle.root`. If you add a method taking a caller-supplied path, sandbox it there — see the
   security note in §8.
3. **`index.md` and `log.md` are reserved** (`RESERVED_FILENAMES`). They are generated, never
   authored, and are excluded from concept listings, the graph, and search.
4. **`type` is the only required frontmatter field** (spec §5). Reading is permissive — unknown
   keys and types must round-trip untouched (spec §9). Writing enforces non-empty `type`.
5. **Broken links are warnings, never errors.** The spec requires consumers to tolerate them.
   `validate()` must stay conformant in their presence; `lint()` is where they are surfaced.
6. **The deterministic layer (`src/okf/`) must not import from `src/agent/` or `src/providers/`.**
   The dependency arrow points one way: `okf ← agent ← server`.
7. **Bundle content is untrusted input to every prompt.** Sanitize it at the interpolation site
   (`sanitizeInline` / `sanitizePath`), never by trusting the writer.
8. **Traces live in `<bundle>/.traces/`** — a dot-directory. Every bundle walker skips
   dot-entries, so traces never affect conformance, the graph, or search. Keep it that way.
9. **stdout is the MCP protocol stream** in `mcp/stdio.ts`. All logging there goes to `stderr`.
   A stray `console.log` in any code path reachable from stdio corrupts the transport.
10. **The mutation queue is per-process.** Two processes (e.g. an stdio MCP client and the HTTP
   server) pointed at the same bundle are *not* serialized against each other.

---

## 5. Conventions

- TypeScript, ESM only (`"type": "module"`), `NodeNext` resolution — **relative imports need the
  `.js` extension** (`./bundle.js`, not `./bundle`). `strict: true` everywhere.
- Cross-package imports use the workspace entry point: `import { KnowledgeBase } from "@understory/core"`.
  New public symbols must be re-exported through the `index.ts` barrel of their directory.
- Formatting is Prettier's job (`.prettierrc.json`, 100 columns) — don't hand-wrap against it, and
  don't reformat unrelated lines. Lint is `eslint.config.js`, deliberately type-unaware.
- Comments explain **why**, not what — see the existing files. Match that density: a short block
  comment above a module or a non-obvious decision, no line-by-line narration.
- Errors from the bundle layer are `BundleError` with a typed `code`; API layers map the code to
  a status (`NOT_FOUND` → 404, otherwise 400). Don't throw bare `Error` from `src/okf/`.
- Env vars are read where they are used, with a documented default, and every new one is added to
  `.env.example` with a comment.
- Duration env vars use `parseDuration` (`"30s" | "15m" | "6h" | "1d"`), which returns `null` on
  invalid input — callers decide the fallback.

---

## 6. Testing

- `packages/core/test/` — vitest, no mocking of the filesystem: tests build real temp bundles.
  The OKF suite is organized by spec section (§5 frontmatter, §6 index, §7 log, §9 conformance)
  plus sandbox, search, graph/lint, and mutation-concurrency cases.
- LLM calls are **injected, never mocked globally**: `runDream`, `runQueryCached`, and `hotLookup`
  each take an injectable runner/generate parameter for exactly this reason. Follow that pattern
  for any new LLM-touching function — do not add a test that hits a real provider.
- `packages/server/test/` runs `tsc -p tsconfig.test.json` first (`typecheck:test`), then vitest.
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
| Change the graph view | `packages/web/src/components/GraphView.tsx` (d3-force, ~540 lines — the largest file in the repo) |

---

## 8. Gotchas and known sharp edges

- **`Bundle.resolve()` normalizes before deciding** whether an absolute-looking input is an OS path
  inside the bundle or a canonical bundle-relative path. Don't "simplify" that back into a prefix
  test on the raw string — `/<root>/../../etc/passwd` carries the root as a literal prefix while
  pointing outside it. Anything that reads or writes file *contents* additionally goes through
  `assertRealPathInside()`, which follows symlinks; a symlink planted in the bundle would otherwise
  turn write access into arbitrary host-file reads. Both are covered by tests in the `sandbox` suite.
- **Prompt injection is in scope, and there is a helper for it.** Bundle content flows into (a) the
  internal agent's system prompt via `treeSummary`, (b) the MCP `instructions` field, and (c) the
  `memory_query` tool description via `seed.ts` — i.e. straight into the *client's* context. Every
  title, description, type, path and log summary on those paths goes through `sanitizeInline` /
  `sanitizePath` from `agent/untrusted.ts` first, which collapses it to one line and strips control
  and bidi characters so it cannot forge an instruction line. **If you interpolate bundle content
  into any new prompt, sanitize it there too**, and keep `UNTRUSTED_CONTENT_NOTICE` next to it.
  Concept *bodies* read via `read_concept` stay free-form by design — that is the product.
- **`AUTH_TOKEN` is still unset by default**, but the server now binds `127.0.0.1` and `net-guard.ts`
  enforces same-origin (plus `ALLOWED_ORIGINS`) on `/mcp` and `/api`, with a `Host` check against DNS
  rebinding on loopback binds. Keep the invariant when touching `index.ts`: **the guard mounts before
  `bearerAuth`**, and CORS must never reflect an origin the guard would reject. `HOST=0.0.0.0` is the
  explicit opt-in for network exposure and warns when no token is set.
- **Module-level caches**: `query-cache.ts` and `hot-memory.ts` hold process-global state so it
  survives the per-request `McpServer` instances of the stateless HTTP transport. Both are
  **partitioned by bundle root** — the query-cache key includes it, and hot memory keeps one
  `HotState` per root — because two KnowledgeBases in one process would otherwise collide on
  identical concept paths (and two empty bundles share a fingerprint). Within one bundle the state is
  still shared by all callers; `HOT_MEMORY_RECALL_QA=false` keeps one caller's Q&A out of another's
  prompt on a shared instance. Use `clearQueryCache()` / `clearHotMemory()` in tests.
- **The query cache is invalidated by a bundle fingerprint** (path + mtime + size of every concept),
  not by write hooks. Out-of-band edits are picked up; sub-millisecond same-size edits are not.
- **The dreamer's first run is one interval after boot**, never at startup, and `DREAM_INTERVAL`
  is clamped to a 5-minute minimum. It is opt-in; unset means zero background token spend.
- **`log.md` is parsed and re-rendered on every append**, not patched with string replacement, and
  anything not matching the heading/bullet grammar is dropped. That is deliberate: the file is
  generated (spec §7), and an LLM-written summary must not be able to steer where the next bullet
  lands. Concept, index and log writes all go through `writeFileAtomic` (temp file + rename).
- **Web `MarkdownRenderer` uses `dangerouslySetInnerHTML`** for Shiki output. That is safe only
  because Shiki escapes its input; don't route any other HTML through that path.

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
| `ALLOWED_MODELS` | Models a client may request. Unset = client overrides refused; `*` allows any. |
| `LLM_TIMEOUT` / `LLM_MAX_STEPS` / `LLM_DISCOVERY_TIMEOUT` / `HOT_MEMORY_TIMEOUT` | Run ceiling (5m), tool-loop budget (12), and the two shorter timeouts. |
| `HOT_MEMORY_RECALL_QA` | `false` drops recent Q&A pairs from the hot working set. |
| `HOST` | Bind address. Default `127.0.0.1`; `0.0.0.0` to expose on the network (the Docker image sets it). |
| `ALLOWED_ORIGINS` / `ALLOWED_HOSTS` | Additions to the same-origin/loopback defaults of the network guard. `*` opts out. |
| `PORT` | Default 3800. |
| `GIT_AUTOCOMMIT` | Commit the bundle after every mutation (best-effort; failures are logged, not thrown). |
| `QUERY_CACHE` / `QUERY_CACHE_TTL` | Exact-answer cache (default on, 24h). |
| `HOT_MEMORY` / `HOT_MEMORY_TTL` | Working-set layer (default on, 1h). |
| `DREAM_INTERVAL` / `DREAM_INSIGHTS` | Autonomous consolidation. Opt-in. |

---

## 10. Git and PR conventions

- Branch off `main`; `main` is the PR target.
- Commit subjects are conventional and lowercase: `feat: …`, `fix: …`, `chore: …`, with the
  PR number appended by the merge (`feat: dreaming — scheduled autonomous memory consolidation (#9)`).
- CI (`.github/workflows/docker.yml`) runs `pnpm install`, `pnpm -r build`, `pnpm test` on every
  PR, then builds and publishes the container on `main`/tags. Green build + green tests are the bar.
- Don't commit `.env`, `demo-bundle/`, or a dirtied `sample-bundle/`.
