# How it works

What happens to a fact between your assistant saying "remember this" and a markdown file on disk.
For the code-level view, see [Architecture](architecture.md).

- [The memory on disk](#the-memory-on-disk)
- [Why the files stay valid](#why-the-files-stay-valid)
- [Memory layers](#memory-layers)
- [Seed memory](#seed-memory)
- [Graph health and maintenance](#graph-health-and-maintenance)
- [Dreaming](#dreaming)
- [Query-path replay](#query-path-replay)

## The memory on disk

A memory is a directory (a **bundle**) of markdown files. Each file is one **concept**: a thing
worth remembering, with a few structured fields at the top and free prose below.

```
my-memory/
├── index.md            ← generated table of contents
├── log.md              ← generated history of every change
├── apis/
│   └── billing-api.md
├── tables/
│   └── customers.md
└── playbooks/
    └── oncall-billing.md
```

One concept from the [sample bundle](../sample-bundle) (trimmed):

```markdown
---
type: BigQuery Table
title: Customers
description: 'Core customer dimension table, one row per registered customer.'
tags: [crm, pii]
generated: { by: 'human:maintainers', at: '2026-07-09T15:10:01Z' }
verified: { by: 'human:data-eng', at: '2026-07-10T09:00:00Z' }
---
The canonical customer record. Downstream marts join on `customer_id`.
Billing events reference this table from the [Billing API](/apis/billing-api.md).

# Schema
* `customer_id` (STRING, required) — stable UUID
* `email` (STRING) — PII, masked in non-prod
```

The link to `/apis/billing-api.md` is the important part. Concepts point at each other, so the
memory is a **graph** rather than a pile of loose notes, and Myzel maintains those links for you.
`index.md` and `log.md` are written by Myzel and rewritten on every change, so leave those two
alone. Everything else you can edit by hand: Myzel keeps your formatting and will not overwrite an
edit you make while it is working.

The format follows the
[Open Knowledge Format (OKF) v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md),
a small open standard for markdown knowledge bases, so other tools can read your memory too.
Beyond the required `type`, Myzel uses its optional families:

- **`generated`** records who wrote the current content and when. Myzel sets it on every write:
  `myzel/<model>` for its agent, `process:myzel` for its own code. It replaces v0.1's
  `timestamp`, which is dropped when a concept is rewritten.
- **`sources`** lists what a concept derives from; a footnote such as `[^billing-runbook]` in the
  body attributes one claim to one source. The agent writes provenance this way instead of v0.1's
  `# Citations` list, and moves an old list over when it edits such a concept.
- **`status`** (`draft`, `stable`, `deprecated`) and **`stale_after`**: the agent deprecates
  instead of deleting.
- **`verified`** says who confirmed a concept (a `human:` actor makes it _human-reviewed_). Only
  people and processes add it; the agent cannot, and a rewrite keeps it.

The web UI shows all of these on the concept card, and the conformance report warns (but never
fails) when one is malformed. v0.1 bundles keep working: they are read as they are.

## Why the files stay valid

The rule behind the whole design: **correctness is enforced in code, not by asking the model
nicely.**

A model told "always keep the index up to date" will eventually forget. So a separate plain-code
layer (no AI involved) does the parts that must always hold: it checks that each file has the
required fields, regenerates `index.md`, appends the change to `log.md` and refuses any write that
would land outside your bundle folder.

The model decides _what_ to change. The code guarantees the result is still a valid bundle.

## Memory layers

Not every question deserves a full search. `memory_query` tries three layers in order and stops at
the first one that can answer:

| Layer | When it answers | Cost |
|---|---|---|
| **1. Exact cache** | The same question was asked before and nothing in the memory has changed since. | Free, no model call |
| **2. Hot memory** | The answer is in the few concepts written and questions asked recently, checked with one call. | One small call |
| **3. Deep memory** | Anything else: search the memory, read the relevant files, answer. | A full agent run |

Answers from the first two layers are labelled `(cached answer)` or `(hot memory)`, so you can tell
what a question actually cost. Both are on by default; tune them with `QUERY_CACHE*` and
`HOT_MEMORY*`.

**How the cache knows the memory changed:** it compares a fingerprint of the bundle (path,
modification time and size of every concept file) instead of hooking into the write path. Any write
invalidates every cached answer, which also catches edits made by hand or by another client. Two
different edits within the same millisecond that leave the file size identical are the one case it
can miss.

## Seed memory

An assistant that only sees five bare tool names never gets the instinct to check its memory. So at
**session start** Myzel hands it a compact overview of what the memory contains (folders, concepts
with their types and descriptions, recent activity) through both channels that reach the model:

1. the MCP `instructions` field sent while connecting (clients like Claude put it in the system
   prompt);
2. the description of the `memory_query` tool itself, the universal fallback, since every
   tool-calling client loads tool descriptions.

The overview is regenerated for every new session. In a long-lived stdio session it also refreshes
after `memory_add` and `memory_update`, so the session sees its own writes. Edits from elsewhere
show up at the next session.

## Graph health and maintenance

Graphs rot in two ways: a concept becomes **orphaned** (nothing links to it, so nothing leads the
agent there) or a link goes **broken** (it points at a file that no longer exists). Three mechanisms
counter that:

- **Linking at write time.** A new fact either enriches the concept it belongs to or, when it really
  is a distinct thing, gets its own file _and_ links from related concepts. A fact that contradicts
  an existing one should replace it rather than sit next to it; the agent is instructed to do so,
  but which facts conflict is its judgement call.
- **`memory_maintain`.** A plain-code check finds orphans and broken links (also listed by
  `memory_status` under `graph`), hands them to the agent to repair and reports the counts before
  and after. It does nothing when
  nothing is wrong.
- **Pruning.** When the agent moves or merges concepts, a folder can end up holding only its
  generated `index.md`. Such folders are removed after every change.

## Dreaming

Dreaming does on a schedule what `memory_maintain` does on request: consolidation while nobody is
looking, the way a brain works during sleep. It is **off by default**; turn it on with
`DREAM_INTERVAL=6h`.

- Plain-code signals decide whether there is anything to do: orphans, broken links, probable
  duplicates, concepts grown too large, recent activity worth summarising. **No signals, no run, no
  tokens spent.**
- The first pass runs one interval after startup. Intervals shorter than five minutes are raised to
  five.
- `DREAM_INSIGHTS=false` limits it to repair work, without drawing new conclusions from activity.

## Query-path replay

Every agent run (query, write or chat) records the path it took under `<bundle>/.traces/`: what it
searched, read and wrote. The graph view lists recent runs; selecting one replays the path as
numbered hops across the graph. Visited concepts get a ring, search hits a dotted outline and
everything else fades. It answers _"why did it tell me that?"_

Each run also shows the tokens it used (e.g. `6.2k→320 tok`), so you can see which questions are
expensive.

> [!NOTE]
> The design follows Karpathy's
> [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern (`index.md`
> plus `log.md`, enrich before create, linting for orphans). Two parts of that pattern are deferred
> until scale demands them: a fixed schema of page types and search combining full-text indexing
> with embeddings. The straightforward scan in `search.ts` holds up into the low thousands of
> concepts.
