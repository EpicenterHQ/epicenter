# 0072. Local Books ships as a standalone CLI; the ADR-0047 daemon surface is deferred behind a verb-core seam

- **Status:** Superseded
- **Date:** 2026-06-26
- **Superseded by:** [ADR-0902](0902-this-repositorys-outside-apps-stay-in-apps.md): Local Books is deleted, and this record is its history.
- **Refined by:** [ADR-0086](0086-no-live-consumer-for-network-reachable-capability-reach-opensidian-is-superseded-not-migrated.md) (answers this ADR's own reopening trigger: the delivery vehicle it names, a shared agent-chat client, is now the super app, which reaches Local Books locally, not by reopening a network daemon; the trigger stays closed)
- **Narrows (for Local Books only):** [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) (the client loop + dispatched-action daemon). ADR-0047 stands for the platform; this records that Local Books does not realize it yet.
- **Relates:** [ADR-0061](0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md) (the three capabilities and the one approved write, unchanged here, only re-housed), [ADR-0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md) (actions cross process boundaries, the seam this leaves open).

## Context

ADR-0061 settled three Local Books capabilities: read the mirror with SQL, run a live QuickBooks report, and recategorize one expense (the single approved write). The code expressed them as Epicenter workspace actions (`defineQuery` / `defineMutation` / `defineActions`) served by a data daemon (`mount.ts`, `books.ts`), so a client agent loop could open the synced room, see the tools advertised over presence, and dispatch them, the design ADR-0047 lays out: the loop runs on your phone, the daemon on your box, your books leave only as a tool result.

That daemon was never wired. Nothing imported `localBooksMount`, there was no `epicenter.config.ts`, and the CLI binary (`bin.ts`) deliberately did not import the action layer. So the headline experience, "ask my books a question," had no runnable entrypoint at all: the CLI did `auth` / `sync` / `status` and nothing else. Onboarding readers (simulated and real) consistently hit this wall, and worse, the AGENTS.md prose described a daemon that did not run, which actively misled.

Meanwhile the standalone path already worked: `sync` produces one SQLite file per company, and any local coding agent (Claude Code, Codex) pointed at it answers financial questions by writing SQL. The sync-engine spec (`specs/20260621T100000`) had in fact chosen exactly this ("the chat agent is off the shelf"). The two sources had drifted: the spec said off-the-shelf, the code reached halfway toward the daemon, and neither shipped a usable AI surface.

A clean-break pass (compatibility pressure released: the mirror is box-local and re-pullable, and the daemon code had no callers) settled which one Local Books is, for now.

## Decision

**Local Books ships as a standalone CLI. The three capabilities become first-class CLI verbs over `books.db`; the ADR-0047 daemon surface is deferred, not deleted in spirit, behind a verb-core seam.**

- **Three verbs.** `local-books query "<sql>"` (read-only SQL over the local mirror), `local-books report <Name>` (live QuickBooks report), `local-books recategorize <Purchase|Bill> <id> --to <accountId>` (the one approved write). The verb *is* ADR-0061's "one approved verb": running a `mutation` is the human's approval, replacing the loop's synchronous approval pause.

- **A verb-core seam.** Each capability is a plain function over explicit dependencies (`dbPath`, an `OpenQbClient`) returning a `wellcrafted` `Result`, in `src/books/`. The CLI command is a thin adapter that parses argv and calls the core. This is the whole reason the deferral is cheap: re-attaching the daemon later is a second thin adapter (`defineQuery({ input, handler: core })`) over the same cores, not a rewrite.

- **The daemon plumbing is deleted.** `mount.ts`, `books.ts`, and the `defineActions` capability-lattice wrapper go; the `@epicenter/workspace` and `@epicenter/chat` dependencies go with them, so `bun build --compile` stays lean. The capability-lattice gating (which tools exist) becomes ordinary command preconditions: `query` always works; `report` and `recategorize` need stored credentials; `recategorize` is withheld when `LOCAL_BOOKS_READ_ONLY` is set.

- **The off-the-shelf agent is the documented AI path.** "Your books as a local SQLite database any agent can grill" is the product sentence. `query` is the front door for a human; pointing Claude Code / Codex at the file (reachable from another device over a private mesh like Tailscale) is the agent path. Nothing touches Epicenter cloud, which is the strongest possible privacy posture for financial data.

## Consequences

- **The AI surface is finally runnable**, with no inference runtime, no room, no sign-in. The cost is that "chat from your phone in a real app" is not a Local Books feature today; off-the-shelf reach is terminal-shaped (SSH/mesh + a coding agent), a developer experience, not a consumer one.
- **No financial data egresses to Epicenter.** The daemon design routed tool *results* (your rows) through the metered inference stream; the standalone path keeps everything on the box and lets you choose the model.
- **ADR-0047 is untouched as a platform decision.** When Local Books rejoins it, the daemon adapter wraps the existing `src/books/` cores; ADR-0061's capabilities need not be redesigned.
- **The misleading "data daemon" prose is gone** from AGENTS.md and the README, replaced by the grill story that is actually true.

## Considered alternatives

- **Build `local-books ask` (a bespoke in-app agent loop + inference backend).** Rejected now: it re-adds the loop, approval seam, and inference dependency the sync-engine spec deliberately collapsed, to do worse what an off-the-shelf coding agent already does well against a plain SQLite file.
- **Finish the ADR-0047 daemon (wire `epicenter.config.ts` + a chat client).** Deferred, not rejected: it is the right shape for a consumer "chat with your books from anywhere" product, but that is premature platform spend while Whispering is the wedge. See the trigger below.
- **Keep `mount.ts` as a labeled "experimental, not wired" seam.** Rejected: a non-functional daemon (no config, no client) is still dead code that promises a feature it cannot deliver, the exact thing that misled onboarding readers. Git preserves it; the verb-core seam preserves the cheap path back.

## Trigger to revisit

Reopen the ADR-0047 daemon for Local Books when there is a concrete need for **multi-device chat with the books from a non-terminal client** (a phone or web app) where the raw mirror must stay on the box, AND the shared Epicenter agent-chat client (`@epicenter/app-shell/agent-chat`) is the ready delivery vehicle. At that point re-add a thin `mount.ts` that wraps the `src/books/` cores with `defineActions`; do not resurrect a bespoke per-app loop.
