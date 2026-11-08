# 0852. Epicenter is one contract and four open slots

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at Epicenter Cloud, which fills slots rather than being a separate product. [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at `epicenter new`, which becomes `epicenter add` from a built-in template.
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md), [ADR-0851](0851-each-app-has-one-git-remote-its-meeting-point-and-backup.md), [ADR-0853](0853-collections-give-an-app-its-reading-actions-and-screens-are-clients.md).
- **Unbuilt:** the registry, the built-in template as a source, and Epicenter Cloud.

## Context

Epicenter has to serve two kinds of people with one design: a non-technical
person who wants everything handled, and a developer who wants to choose each
piece. Each piece already has an open standard beneath it, and each can have a
default Epicenter provides.

## Decision

**What stays fixed is the app contract: a folder whose `epicenter.ts` defines
actions (ADR-0841), committed by one rule (ADR-0850). Everything else is a slot
with an open standard and an Epicenter default.**

| Slot | Open standard | Epicenter's default | Swapped for |
| --- | --- | --- | --- |
| Code: where an app comes from | a Git URL | the Epicenter registry | any repository |
| Remote: history, meeting point, backup | Git | Epicenter Cloud on Cloudflare Artifacts | GitHub, any Git host |
| Your Epicenter: runs named actions, holds sign-ins | `epicenter serve` (HTTP, MCP) and SSH | an Epicenter Cloud container | the person's own Mac, Linux, or Windows machine |
| Screens: where a person looks and taps | HTTP and MCP clients | the Epicenter app (desktop, phone, web) | Claude, a script, any client |

Batteries included means every default: a person installs the Epicenter app,
signs in, and never sees Git. A developer swaps any slot without changing an
app.

**Code arrives one way: `epicenter add <source>`** copies an app's files from a
Git URL into a new repository and keeps the source as its `upstream` branch
(ADR-0841). `epicenter new <name>` is `add` from a built-in template, which
includes `epicenter.ts`, `package.json`, and a `.gitignore` with
`node_modules/` and `.cache/`.

## Consequences

- Epicenter Cloud is the defaults for the remote and your Epicenter, running the
  same code a person's own machine runs.
- A person can leave any default by cloning the remote and changing `origin`,
  or by running `epicenter setup` on their own machine.

## Considered alternatives

- **Epicenter Cloud as its own product with its own sync.** A second
  implementation of every slot.
- **A separate `new` with its own scaffolding.** A second way code arrives.
