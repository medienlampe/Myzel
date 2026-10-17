# Premises

What Myzel is for, what it promises and what it won't do. Every feature, default and doc page
should fit these. When something doesn't, either the code changes or this page does — on purpose,
never by drift.

## Who it is for

You alone, or a small team that trusts each other. You run Myzel yourself, on your machine or a
server of yours, and connect your own AI tools to it.

## The premises

1. **One memory for all your AI tools.** What you explain to one assistant, the others know.

2. **Plain files you own.** A memory is a folder of markdown in the open
   [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) format.
   It stays valid and useful with Myzel gone. You may edit it in any editor, keep it in git or
   `grep` it; Myzel adapts to hand edits instead of fighting them. The exception is `index.md`
   and `log.md`: they are Myzel's, regenerated on every change, so hand text in them is lost.

3. **Code guards the shape, the model owns the meaning.** Plain code makes sure every write leaves
   a valid bundle: frontmatter, `index.md`, `log.md`, the path sandbox, one write at a time. The
   model decides what to keep, merge, link or drop — including what a new fact contradicts.
   Anything that must always hold belongs in code, never in a prompt. Judgement calls belong to
   the model and are never promised as guarantees.

4. **Safe by default.** Out of the box Myzel listens on localhost only and refuses foreign
   origins. Bundle content, including its `.git`, is untrusted input. Every input that reaches a
   model is capped. Exposing Myzel to a network is an explicit opt-in.

5. **One memory, one circle of trust.** Everyone who shares a memory can read and change all of
   it, and may see what the others asked. Need a wall between people or projects? Give each a
   [profile](running.md#profiles-several-memories-on-one-server). The key is the only thing that
   selects a profile.

6. **Any model, careful with spend.** Any OpenAI- or Anthropic-compatible model with solid tool
   calling works; it need not be expensive. Browsing the memory costs no tokens. Anything that
   spends tokens in the background, like dreaming, is opt-in.

7. **An independent fork.** Myzel began as a fork of
   [understory](https://github.com/thecodacus/understory) and goes its own way. Upstream is a
   source of ideas: good ones are ported by judgement, without promising to stay in sync.

8. **Few dependencies, kept current.** A new runtime dependency needs a reason; for small things
   write the code or use the standard library. Updates land soon after release. A version is held
   back only with a written blocker in [Maintenance](maintenance.md).

## Non-goals

**Never:**

- A hosted service for strangers. Profiles are created with a CLI on your own server, and the
  settings page is for you — not a multi-tenant SaaS.

**Not now** (revisit when a real need shows up):

- A web CMS. The web UI is a window into the memory — browse, graph, chat, replay. Authoring
  happens through your AI tools and your editor.
- Large corpora and vector search. Search is a plain keyword scan, fine into the low thousands of
  concepts.
