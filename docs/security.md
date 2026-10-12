# Security

How Myzel defends the memory, how to deploy it without undoing that, and what is known to be
left open. The rules that code changes must keep are in [AGENTS.md](../AGENTS.md) §4 and §8;
this page explains the reasoning behind them.

## Threat model

The memory is personal data, and anyone who can reach `/mcp` or `/api` can read *and rewrite* it.
Untrusted input arrives in five ways:

| Source | Example |
|---|---|
| **Network clients** | A web page the user visits tries to call the local server (drive-by, DNS rebinding); anyone on the LAN connects directly. |
| **Bundle files** | A git-synced or bind-mounted bundle contains files, symlinks or a `.git` directory nobody reviewed. |
| **Text the agent ingests** | Prompt injection in saved content steers the internal agent's tools, including writes and deletes. |
| **Model output** | Agent answers are rendered as markdown in the web UI. |
| **Dependencies and build** | A compromised package, action or base image. |

## Defenses

### Network

- **Loopback by default.** The server binds `127.0.0.1`. The compose files publish the port on
  `127.0.0.1` (`MYZEL_BIND`). Network exposure is always an explicit step, and the server
  warns when it is exposed without `AUTH_TOKEN`.
- **Origin check** on `/mcp` and `/api`: browsers may call only from the same origin or from an
  origin listed in `ALLOWED_ORIGINS`. CORS mirrors the same allowlist and never reflects the
  request's origin.
- **Host check against DNS rebinding**, on every bind. Loopback names always pass, IP addresses
  pass on a public bind (an address cannot be rebound), and any other hostname must be listed in
  `ALLOWED_HOSTS`.
- **Bearer auth** (`AUTH_TOKEN`). Tokens are compared as SHA-256 digests with `timingSafeEqual`.
  Failed attempts are throttled *before* the comparison: 20 per 15 minutes per client.
- **Order matters** in `server/src/index.ts`: the network guard runs before auth, so a hostile
  origin is refused whether or not a token is set.
- **Response hardening:**
  - a CSP that allows scripts only from the same origin and no framing (`frame-ancestors 'none'`);
  - `nosniff` and `Referrer-Policy: no-referrer`;
  - no `x-powered-by` header;
  - a final error handler that never returns stack traces.

### Bundle files

- **Path sandbox.** All paths go through `Bundle.resolve()`, which normalizes the path *before*
  checking that it is inside the bundle. Content reads, writes, deletes and index regeneration
  additionally follow symlinks (`assertRealPathInside`, `resolveContained`).
- **Walkers skip symlinks and dot-entries**, so host files never enter the tree, search, graph or
  index, and `.traces/` and `.git` stay invisible.
- **Frontmatter is YAML only.** Fences naming another language (`---js`) are refused, because
  general-purpose frontmatter parsers evaluate them as code. Parsing uses the YAML 1.2 core
  schema, and aliases are capped by the `yaml` library.
- **The bundle's `.git` is untrusted** (`okf/git.ts`). Git can run programs during a plain `add`
  or `commit`, so every git call:
  - disables hooks, fsmonitor and commit signing;
  - is refused when the repository's own config sets any key that runs a command (filters, diff
    drivers, aliases, `include.path`, …). This check fails closed;
  - stages everything except `.traces/`, which holds users' prompts.

### Prompt injection

- Titles, descriptions, types, paths and log lines are collapsed to one line and stripped of
  control and bidi characters before they reach any prompt (`agent/untrusted.ts`), so stored text
  cannot forge an instruction line. This covers the agent's system prompt, the session seed sent
  to MCP clients, hot memory, and the maintenance and dreaming instructions.
- Every one of those prompts states that the listings are stored content, not instructions
  (`UNTRUSTED_CONTENT_NOTICE`).
- `log.md` is re-rendered from a strict grammar on every append, so a summary cannot decide where
  the next entry lands.
- **Limit:** concept *bodies* are free-form by design, and the agent reads them. A model can still
  be persuaded by text it reads on purpose. Review what lands in a memory that ingests untrusted
  sources.

### Model output in the web UI

- Markdown is sanitized with `rehype-sanitize` (links: `http`, `https`, `mailto` only).
- `dangerouslySetInnerHTML` is used only for Shiki's highlighted code, which escapes its input.
- External links get `noopener noreferrer`.
- The access token is kept in `sessionStorage`, so it lives only as long as the tab.

### Cost and availability

- **Rate limits:**
  - `/mcp` and `/api/chat`, which can start agent runs: `RATE_LIMIT`, default 60/min;
  - the read-only `/api` routes, which read the whole bundle: `RATE_LIMIT_BROWSE`, default 600/min.

  IPv6 clients are grouped by /64. Behind a reverse proxy, set `TRUST_PROXY`.
- **Input caps** (`server/src/limits.ts`):

  | Input | Limit |
  |---|---|
  | `memory_query` question | 4,000 characters |
  | `memory_add` content | 100,000 characters |
  | `memory_update` instruction | 20,000 characters |
  | newest chat turn | 20,000 characters |
  | JSON body | 1 MB |

- Clients cannot choose a model unless it is listed in `ALLOWED_MODELS`.
- Agent runs have a step cap (`LLM_MAX_STEPS`) and a time limit (`LLM_TIMEOUT`), and stop when
  the chat client disconnects.
- Link extraction runs in linear time, even on hostile input.

### Secrets

- Provider errors reach clients only as an HTTP status (`publicErrorMessage`); the full error is
  logged on the server.
- URLs in logs and error messages are redacted (`redactUrl`), since some gateways take the key in
  the URL.
- `.dockerignore` keeps `.env` out of the image.

### Supply chain and image

- **Pinning:** GitHub Actions are pinned to commit SHAs and the base image to a digest. Dependabot
  keeps them, and npm packages, current with a 7-day cooldown.
- **Least privilege in CI:** the workflow starts from `permissions: {}` and each job asks only for
  what it needs.
- **Checks:** CI fails on high or critical advisories in production dependencies.
- **Published images** carry an SBOM and a signed build-provenance attestation.
- **The container:**
  - runs as the unprivileged `node` user;
  - uses `tini` as PID 1;
  - shuts down gracefully, waiting for pending writes;
  - has a `/healthz` health check.

## Deploying safely

1. **Keep the default bind** unless other machines need access. To expose it, set
   `MYZEL_BIND=0.0.0.0` (compose) or `HOST=0.0.0.0` (native), **and** set `AUTH_TOKEN` to a
   long random value (`openssl rand -hex 24`).
2. **Reaching it by name** (`nas.local`, a proxy domain)? Add that name to `ALLOWED_HOSTS`. Access
   by IP address needs nothing.
3. **Behind a reverse proxy**, set `TRUST_PROXY` (e.g. `1` for one hop), so rate limits apply per
   client.
4. **Shared instance:** set `HOT_MEMORY_RECALL_QA=false` so one caller's recent questions and
   answers stay out of another caller's prompt.
5. **`GIT_AUTOCOMMIT` with a bind-mounted bundle** works across file owners. A repository whose
   config can run programs is refused, so remove such keys to enable commits.

## Known limitations

- **No OS-package scan of the image.** CI audits npm dependencies only. A scanner needs a
  third-party action, which is a supply-chain decision of its own.
- **Whole-bundle reads.** Search, graph and validate read every concept on each request. The
  session seed is cached and the browse API is rate-limited, but a shared, fingerprint-invalidated
  snapshot would remove the rest of that cost.
- **`HOT_MEMORY_RECALL_QA` defaults to on**, which suits a single user. Turning it off by default
  would be a product decision.
- **The mutation queue is per process.** An stdio client and the HTTP server pointed at the same
  bundle are not serialized against each other.
