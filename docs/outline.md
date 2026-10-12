# Documentation outline

Documentation for people working on Myzel. Start elsewhere if you are looking for:

- **installing, connecting and configuring it** — the [README](../README.md);
- **the rules every code change must keep** — [AGENTS.md](../AGENTS.md) (also read by coding
  agents; `CLAUDE.md` links to it).

## Pages

1. **[Architecture](architecture.md)** — how a request becomes a bundle change.
   1. Packages and the one-way dependency rule (`okf ← agent ← server`)
   2. The deterministic OKF layer: sandbox, write path, frontmatter, git, index, log
   3. The agent layer: tool loop, memory layers, dreaming, traces, model chain
   4. The server: middleware order, MCP, browse and chat APIs, shutdown
   5. The web UI, including the drag & drop workspace and how to add a panel
2. **[Security](security.md)** — how the memory is defended.
   1. Threat model
   2. Defenses: network, bundle files, prompt injection, model output, cost, secrets, supply chain
   3. Deploying safely
   4. Known limitations
3. **[Maintenance](maintenance.md)** — keeping dependencies current.
   1. Pinned versions and why
   2. Upgrade checklist, including running the Docker image
   3. Known upgrade traps
