# Running Myzel

Everything past the [quick start](../README.md#quick-start): other ways to connect, exposing the
server safely, several memories on one server and what to do when it doesn't start. Every variable
is listed in [Configuration](configuration.md).

- [Other ways to connect](#other-ways-to-connect)
- [Network exposure](#network-exposure)
- [Auth](#auth)
- [Cost](#cost)
- [What the memory can talk your assistant into](#what-the-memory-can-talk-your-assistant-into)
- [Profiles: several memories on one server](#profiles-several-memories-on-one-server)
- [Serving under a sub-path](#serving-under-a-sub-path)
- [Demo mode](#demo-mode)
- [Troubleshooting](#troubleshooting)

## Other ways to connect

**Any MCP client.** Add `http://localhost:3800/mcp` as a _streamable HTTP_ MCP server (the client's
docs say where) and restart the client so it picks up the tools.

**stdio transport.** The client starts Myzel as a local process and talks to it over its input and
output streams. No auth token is needed, since nothing touches the network:

```bash
claude mcp add myzel \
  -e BUNDLE_ROOT=/path/to/your/bundle \
  -e LLM_API_BASE_URL=https://api.deepseek.com/v1 \
  -e LLM_API_KEY=sk-... \
  -e LLM_API_FORMAT=openai \
  -e LLM_MODEL=deepseek-chat \
  -- node /path/to/myzel/packages/server/dist/mcp/stdio.js
```

**From the shell.** The same agent without any client, handy for checking a setup (needs a
[source checkout](../README.md#development)):

```bash
make query  Q="What do we know about billing?"
make mutate I="Record that we deploy on Fridays"   # writes to demo-bundle/
```

**Portainer.** Use [docker-compose.portainer.yml](../docker-compose.portainer.yml) as a repository
stack.

## Network exposure

Your memory is readable _and writable_ by anyone who can reach the port, so the defaults are strict:

- The server listens on **loopback only** (`127.0.0.1`): nothing outside your machine can connect.
- `/mcp` and `/api` reject browser requests from other websites. Without that, any page you visit
  could read and rewrite your memory through your browser.
- The `Host` header is checked too, which stops DNS rebinding (a malicious site pointing its own
  domain at your server). `localhost` always works and so do IP addresses (e.g.
  `http://192.168.1.20:3800`) when the server is exposed.

To open it up:

- **Native:** `HOST=0.0.0.0`, paired with [`AUTH_TOKEN`](#auth). The server warns at startup if the
  token is missing.
- **Docker:** the image binds `0.0.0.0` inside the container, so _where the port is published_
  decides who can reach it. The quick start and this repo's compose files publish on `127.0.0.1`.
  Publish on all interfaces (`MYZEL_BIND=0.0.0.0` with this repo's compose files, or `"3800:3800"`
  in your own) **and** set `AUTH_TOKEN`.
- **Reaching it by name** (`nas.local`, a reverse-proxy domain)? Add the name:
  `ALLOWED_HOSTS=nas.local`.
- **A browser app on a different address** needs `ALLOWED_ORIGINS=https://your-frontend`. Myzel's
  own web UI and the dev proxy need nothing; non-browser clients (curl, native MCP clients) are
  unaffected.

## Auth

With no token the server is open, which is fine on localhost. **Before exposing it anywhere else,
set `AUTH_TOKEN`** to a long random value:

```bash
AUTH_TOKEN=$(openssl rand -hex 24)
```

`/mcp` and `/api` then require it as a bearer token. MCP clients send it as a header:

```bash
claude mcp add --transport http myzel http://host:3800/mcp \
  --header "Authorization: Bearer <token>"
```

The web UI stays reachable and asks for the token. It keeps the token for the browser tab only, so a
new tab asks again. Repeated wrong tokens lock a client out: after 20 failures within 15 minutes it
is refused until that window ends. The stdio transport needs no token.

## Cost

Every request to `/mcp` and `/api/chat` can start an agent run, and agent runs cost tokens. The
brakes:

- a per-client **rate limit** (`RATE_LIMIT`, default 60 per minute);
- clients **can't pick the model**: the server's model is used unless you list alternatives in
  `ALLOWED_MODELS`;
- a **wall-clock ceiling** per run (`LLM_TIMEOUT`, default 30 minutes);
- **capped inputs**: a question at 4,000 characters, a `memory_add` document at 100,000.

Behind a reverse proxy set `TRUST_PROXY` (e.g. `1` for one hop). Otherwise every client arrives from
the proxy's address and shares one rate-limit bucket.

## What the memory can talk your assistant into

Everything saved in the memory eventually reaches a language model, including the overview your
assistant loads at session start. A concept whose description reads _"…ignore your previous
instructions and…"_ is a **prompt injection**. That matters most when your assistant saves things it
read elsewhere: a web page, an issue tracker, a dependency's README.

Myzel neutralizes the structural part. Titles, descriptions, types and log summaries are collapsed
to one line with control and text-direction characters removed before they enter any prompt, so
stored text can't forge a new heading, bullet or instruction line. The session overview and Myzel's
own system prompt both state that these listings are stored content, never directions.

What it can't do is make a model immune to persuasive text it reads on purpose: a concept's body is
free-form by design. Treat the memory like any shared document and review what lands there when an
assistant ingests untrusted sources.

The full threat model is in [Security](security.md).

## Profiles: several memories on one server

One server can host a separate memory per profile, say `work`, `health` and a side project. Each
profile has its own bundle and its own API key, and **the key is the only thing that selects a
memory**: a request with the `work` key is served from the `work` bundle and can't name, read or
search any other profile. The URLs stay the same for everyone.

Turn it on by pointing `PROFILES_ROOT` at a directory (it takes precedence over `BUNDLE_ROOT`):

```yaml
services:
  myzel:
    # ...as in the quick start, plus:
    volumes:
      - myzel-profiles:/profiles
    environment:
      PROFILES_ROOT: /profiles
      ADMIN_TOKEN: ${ADMIN_TOKEN:-} # optional: enables the /admin API

volumes:
  myzel-profiles:
```

Manage profiles with the bundled CLI. It works next to a running server, which picks up changes on
the next request:

```bash
docker compose exec myzel node server/dist/profiles-cli.js create work
# profile: work
# api key: myz_...        <- shown once; only a hash is stored

docker compose exec myzel node server/dist/profiles-cli.js list
docker compose exec myzel node server/dist/profiles-cli.js rotate work          # old key stops working
docker compose exec myzel node server/dist/profiles-cli.js remove work          # revokes the key, keeps the memory
docker compose exec myzel node server/dist/profiles-cli.js remove work --purge  # also deletes the memory
```

From a source checkout: `make profiles ARGS="create work"` (with `PROFILES_ROOT` in `.env`).

Give each assistant its profile's key:

```bash
claude mcp add --transport http work-memory http://host:3800/mcp \
  --header "Authorization: Bearer myz_..."
```

The web UI asks for a key and opens that profile's memory. The top bar names the profile and has a
**switch** button to enter a different key.

Worth knowing:

- Every request needs a profile key; `AUTH_TOKEN` is not used. Wrong keys are throttled like wrong
  `AUTH_TOKEN` guesses.
- With `ADMIN_TOKEN` set, `GET`/`POST /admin/profiles`, `POST /admin/profiles/<name>/rotate` and
  `DELETE /admin/profiles/<name>[?purge=true]` do what the CLI does. The admin token manages
  profiles but can't open any memory, and a profile key can't reach `/admin`.
- Layout: one bundle per profile at `PROFILES_ROOT/<name>/`, plus `PROFILES_ROOT/profiles.json` (the
  registry, readable by its owner only). To turn an existing bundle into a profile, put it at
  `PROFILES_ROOT/<name>/` and run `create <name>`, which adopts the directory.
- Caches, hot memory, traces, git history and dreaming are all per profile. Dreams run one profile
  after another.
- The stdio transport serves one bundle: point its `BUNDLE_ROOT` at a profile's directory.

Profiles were designed upstream, in
[thecodacus/understory#45](https://github.com/thecodacus/understory).

## Serving under a sub-path

The web UI uses relative URLs, so it works behind a reverse proxy that serves it under a path prefix
and strips the prefix before forwarding. No configuration is needed:

```bash
tailscale serve --bg --set-path=/myzel http://localhost:3800
```

```caddy
handle_path /myzel/* {
  reverse_proxy localhost:3800
}
```

Open it with a trailing slash (`https://host/myzel/`). Without it, relative URLs escape the prefix.
If you reach the server by a hostname, add it to `ALLOWED_HOSTS` and set `TRUST_PROXY` (see
[Cost](#cost)).

## Demo mode

`DEMO_MODE=true` serves one bundle read-only: visitors can browse it, search it, look at the graph,
replay traces and ask the agent questions, but nothing can change it. `KnowledgeBase` refuses every
write, so the guarantee does not depend on the model behaving. On top of that, the server drops
everything that exists only to write:

- MCP offers `memory_query` and `memory_status` only, and its instructions say the memory is
  read-only.
- The chat gets the read tools and the query prompt, so it answers but never edits.
- `/admin` (settings, profiles), dreaming and `GIT_AUTOCOMMIT` are off. `PROFILES_ROOT` is refused.
- The web UI shows a **demo · read-only** chip and hides **Settings**.

Two ways to start it with the [sample memory](../sample-bundle):

```bash
make demo        # from source, on a throwaway copy of sample-bundle/ — http://localhost:3800
make demo-up     # docker-compose.demo.yml; `make demo-down` stops it
```

Without a model (the `LLM_*` variables, e.g. in `.env`) the demo still starts: browsing, search,
the graph and trace replay work, the chat shows **no model** and questions fail with the
configuration error. Outside demo mode a missing model stops the server at startup. The container copies the sample into a
tmpfs at start, so each restart begins from the pristine sample. Point `BUNDLE_ROOT` elsewhere to
demo your own bundle.

Read-only does not mean free. Every question runs the agent and spends model tokens, so a public
demo should keep `RATE_LIMIT` on (the demo compose file defaults to 20 per minute) and use a key
with a spending cap. Visitors also share one memory: the trace list shows everyone's questions,
and the demo compose file sets `HOT_MEMORY_RECALL_QA=false` so one visitor's questions do not enter
another's prompt.

## Troubleshooting

Start with `docker compose logs myzel`. Most failures print exactly what is missing.

| What you see | What it means |
|---|---|
| `BUNDLE_ROOT (one memory) or PROFILES_ROOT … is required` | Neither `BUNDLE_ROOT` nor `PROFILES_ROOT` is in the `environment:` block. |
| `LLM configuration error: No LLM configured.` | No model settings arrived. Usually `.env` isn't next to `docker-compose.yml` or is named differently. `docker compose config` prints what Compose actually resolved. |
| `LLM_MODEL is required for this endpoint.` | Your provider doesn't support model discovery. Set `LLM_MODEL` to a concrete model id. |
| `Model discovery failed: HTTP 404 at …` / `No models listed at …` | `LLM_API_BASE_URL` is probably wrong. It must include the API version path, e.g. `https://api.deepseek.com/v1`. |
| `port is already allocated` | Something else uses port 3800. Change the **left** number (`"3900:3800"`) and open `localhost:3900`. |
| The web UI loads but the graph is empty | Expected for a fresh memory. Teach it a fact in the chat first. |
| The web UI asks for a token | `AUTH_TOKEN` is set (see [Auth](#auth)) or the server runs in [profile mode](#profiles-several-memories-on-one-server) and wants a profile key. |
| Your assistant has the tools but never uses them | Restart the client after adding the server so it gets the [seed overview](how-it-works.md#seed-memory). Then ask it once: _"check your memory for X"_. |
| The agent replies but writes nothing | The model probably handles tool calling poorly. Try a stronger one (see [Model providers](configuration.md#model-providers)). |
| Errors mentioning legacy configuration | Only old variables (`DEEPSEEK_API_KEY`, …) are set and Myzel can't tell which provider is meant. Switch to `LLM_API_BASE_URL` / `LLM_API_KEY` / `LLM_API_FORMAT`. |
