# Documentation outline

Start with the [README](../README.md) for installing and connecting Myzel. The rules every code
change must keep are in [AGENTS.md](../AGENTS.md) (also read by coding agents; `CLAUDE.md` links to
it).

## Using Myzel

1. **[Running Myzel](running.md)** — everything past the quick start.
   1. Other ways to connect: any MCP client, stdio, the shell, Portainer
   2. Network exposure, auth and cost brakes
   3. What the memory can talk your assistant into
   4. Profiles: several memories on one server
   5. Serving under a sub-path
   6. Troubleshooting
2. **[Configuration](configuration.md)** — every setting.
   1. With Docker Compose
   2. Model providers: local llama.cpp, fallback model, deprecated variables
   3. All variables
3. **[How it works](how-it-works.md)** — what happens to a fact on its way to disk.
   1. The memory on disk (bundles, concepts, OKF)
   2. Why the files stay valid
   3. Memory layers, seed memory
   4. Graph health and maintenance, dreaming, query-path replay

## Working on Myzel

4. **[Architecture](architecture.md)** — how a request becomes a bundle change.
   1. Packages and the one-way dependency rule (`okf ← agent ← server`)
   2. The deterministic OKF layer: sandbox, write path, frontmatter, git, index, log
   3. The agent layer: tool loop, memory layers, dreaming, traces, model chain
   4. The server: memory hosts (single bundle or profiles), middleware order, MCP, browse and
      chat APIs, admin, shutdown
   5. The web UI, including the drag & drop workspace and how to add a panel
5. **[Security](security.md)** — how the memory is defended.
   1. Threat model
   2. Defenses: network, profiles, bundle files, prompt injection, model output, cost, secrets,
      supply chain
   3. Deploying safely
   4. Known limitations
6. **[Maintenance](maintenance.md)** — keeping dependencies current.
   1. Pinned versions and why
   2. Upgrade checklist, including running the Docker image
   3. Known upgrade traps
