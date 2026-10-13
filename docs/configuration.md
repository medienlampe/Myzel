# Configuration

Every setting is an environment variable. `BUNDLE_ROOT` (one memory) or `PROFILES_ROOT` (one memory
per [profile](running.md#profiles-several-memories-on-one-server)) is the only required one. The
annotated template is [.env.example](../.env.example).

- [With Docker Compose](#with-docker-compose)
- [The settings page](#the-settings-page)
- [Model providers](#model-providers)
- [All variables](#all-variables)

## With Docker Compose

A setting reaches the container only if the compose file passes it through. This repo's compose
files pass the model settings (except `LLM_FALLBACK_RETRY_429`), the legacy provider keys,
`AUTH_TOKEN`, `ADMIN_TOKEN`, `ALLOWED_*`, `TRUST_PROXY`, the rate limits, `LLM_TIMEOUT` /
`LLM_MAX_STEPS`, `HOT_MEMORY_RECALL_QA`, `DREAM_INTERVAL` and `GIT_AUTOCOMMIT`. Add a line under
`environment:` for anything else you set.

Profile settings are left out on purpose: see
[Profiles](running.md#profiles-several-memories-on-one-server) for the volume and variables to add.

## The settings page

With `ADMIN_TOKEN` set, **Settings** in the web UI's top bar changes the model and behaviour
settings without editing files: the primary and fallback model, `ALLOWED_MODELS`, run limits and
timeouts, the query cache and hot memory, dreaming, git autocommit and the rate limits. The page
asks for the admin token and keeps it only until the page is reloaded.

- **Where changes go:** `SETTINGS_FILE`, a JSON file whose values override the environment and
  `.env`. The Docker image uses `/config/settings.json` (the compose files mount a volume there);
  `make` uses `.myzel-settings.json` in the repository root (gitignored). Without `SETTINGS_FILE`
  the page is read-only. The file holds API keys and is written readable by its owner only.
- **When they apply:** most settings on the next request. Those marked **restart** (dreaming, git
  autocommit, rate limits) are saved at once and take effect when Myzel restarts. A stdio MCP
  process reads the file when it starts.
- **What is checked:** a save is all-or-nothing. Every value is validated, and the resulting model
  setup must still resolve, before anything is written. API keys are never sent back to the
  browser; the page only shows whether one is set.
- **What is not there:** network and access settings (`HOST`, `PORT`, `AUTH_TOKEN`,
  `ADMIN_TOKEN`, `ALLOWED_ORIGINS` / `ALLOWED_HOSTS`, `TRUST_PROXY`, `BUNDLE_ROOT`,
  `PROFILES_ROOT`) stay in the environment, so a change in the UI can't lock you out or open the
  server wider. The settings file is ignored for them too.
- **Reset** on a setting drops the saved value, and the environment's applies again.

## Model providers

Any **OpenAI-compatible** or **Anthropic-compatible** API works, which covers nearly every provider
and every local server. Set `LLM_API_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`, and set
`LLM_API_FORMAT` to `openai` (the default) or `anthropic`.

**Not sure what to pick?** DeepSeek is a good default: cheap and strong enough at the tool calling
Myzel needs.

| Provider | Settings |
|---|---|
| **DeepSeek** | `LLM_API_BASE_URL=https://api.deepseek.com/v1` `LLM_API_KEY=sk-...` `LLM_MODEL=deepseek-chat` |
| **OpenAI** | `LLM_API_BASE_URL=https://api.openai.com/v1` `LLM_API_KEY=sk-...` `LLM_MODEL=gpt-4o` |
| **Anthropic** | `LLM_API_BASE_URL=https://api.anthropic.com/v1` `LLM_API_KEY=sk-ant-...` `LLM_API_FORMAT=anthropic` `LLM_MODEL=claude-sonnet-5` |
| **Groq** | `LLM_API_BASE_URL=https://api.groq.com/openai/v1` `LLM_API_KEY=gsk_...` `LLM_MODEL=llama-3.3-70b-versatile` |
| **Local llama.cpp** | `LLM_API_BASE_URL=http://localhost:8080/v1` `LLM_MODEL=` _(discovered automatically)_; in Docker use `http://host.docker.internal:8080/v1` |

> [!IMPORTANT]
> The model must support **tool calling** (also called function calling). Myzel's agent works by
> calling search, read and write tools in a loop, so a model that can't do that fails or produces
> nothing. Most current models are fine; very small local models often are not.

### Local llama.cpp

```bash
# on the machine running the model: --jinja enables OpenAI-style tool calling
llama-server -m model.gguf --jinja --host 0.0.0.0 --port 8080

# on the Myzel side: no model id needed, it is discovered from the endpoint
LLM_API_BASE_URL=http://inference-box:8080/v1 LLM_API_FORMAT=openai LLM_MODEL= \
BUNDLE_ROOT=./sample-bundle node packages/server/dist/index.js
```

This works behind llama-swap too: discovery prefers the model that is currently **loaded**, so a
query doesn't trigger a multi-minute model swap. Pin one explicitly with `LLM_MODEL=`.

### Fallback model

For example a local model with a hosted backup. Set the matching `LLM_FALLBACK_*` variables:

```bash
LLM_API_BASE_URL=http://localhost:8080/v1 LLM_MODEL= \
LLM_FALLBACK_API_BASE_URL=https://api.deepseek.com/v1 \
LLM_FALLBACK_API_KEY=sk-... LLM_FALLBACK_MODEL=deepseek-chat
```

The fallback takes over when the primary model fails with an error worth retrying: a timeout, a
network failure, HTTP 408 or a 5xx. HTTP 429 counts only with `LLM_FALLBACK_RETRY_429=true`.

`LLM_FALLBACK_ALLOW_FOR=query` restricts the fallback to read-only operations, so the backup model
never writes. The compose files set exactly that by default; a native run allows the fallback for
everything unless you set it.

### Deprecated variables

The older `LLM_PROVIDER` and per-provider key variables (`DEEPSEEK_API_KEY`, `LLAMACPP_BASE_URL`, …)
still work and are translated automatically. Prefer the `LLM_API_*` ones: when those are set, the
old ones are ignored.

## All variables

| Variable | Effect |
|---|---|
| `BUNDLE_ROOT` | The folder holding the memory. **Required** unless `PROFILES_ROOT` is set. |
| `PROFILES_ROOT` | Host one memory per API key instead of a single bundle. See [Profiles](running.md#profiles-several-memories-on-one-server). |
| `ADMIN_TOKEN` | Enables `/admin`: the [settings page](#the-settings-page) and, in profile mode, profile management. Unset: no `/admin`. |
| `SETTINGS_FILE` | Where the settings page saves; its values override the environment. Unset: the page is read-only. |
| `LLM_API_BASE_URL` / `LLM_API_KEY` / `LLM_API_FORMAT` / `LLM_MODEL` | The model Myzel uses. `LLM_MODEL` may stay empty for OpenAI-compatible endpoints that list their models; it is then discovered. |
| `LLM_FALLBACK_*` | Optional [backup model](#fallback-model), used when the primary fails with a retryable error. |
| `PORT` | Default `3800`. |
| `HOST` | Network interface to listen on. Default `127.0.0.1` (this machine only); `0.0.0.0` exposes it to the network. |
| `AUTH_TOKEN` | Require this token on `/mcp` and `/api`. Unset means no auth. Ignored in profile mode, where each profile has its own key. |
| `ALLOWED_ORIGINS` / `ALLOWED_HOSTS` | Extra origins and hostnames allowed past the browser guard. Needed when you reach the server by a hostname other than `localhost`. |
| `MYZEL_BIND` | Compose files only: the host interface the port is published on. Default `127.0.0.1`. |
| `RATE_LIMIT` / `RATE_LIMIT_WINDOW` | Requests per client on `/mcp` and `/api/chat`. Default `60` per `1m`; `0` disables. |
| `RATE_LIMIT_BROWSE` | Requests per client on the read-only `/api` routes. Default `600` per window; `0` disables. |
| `TRUST_PROXY` | Set behind a reverse proxy (`1` or the proxy's address) so rate limits apply per client. |
| `ALLOWED_MODELS` | Models a client may request per call. Unset means the server's model always wins; `*` allows any. |
| `LLM_TIMEOUT` / `LLM_MAX_STEPS` | Ceiling for one agent run (default `30m`, since local models can take minutes) and its tool-loop budget (default `12`). |
| `LLM_DISCOVERY_TIMEOUT` / `HOT_MEMORY_TIMEOUT` | Ceilings for model discovery (default `10s`) and the hot-memory call (default `1m`). |
| `GIT_AUTOCOMMIT` | Commit the bundle after every change. Default `false`. A bundle that isn't a git repository yet is initialized at startup; the server refuses to start if committing can't work. |
| `QUERY_CACHE` / `QUERY_CACHE_TTL` | [Exact-answer cache](how-it-works.md#memory-layers). On by default, `24h`. Independent of `HOT_MEMORY`. |
| `HOT_MEMORY` / `HOT_MEMORY_TTL` | [Short-term working set](how-it-works.md#memory-layers). On by default, `1h`. |
| `HOT_MEMORY_RECALL_QA` | Whether recent questions and answers join the working set. Set `false` on a shared instance. |
| `DREAM_INTERVAL` / `DREAM_INSIGHTS` | [Scheduled consolidation](how-it-works.md#dreaming). Off by default. |
