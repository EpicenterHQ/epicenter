# 0631. A browser observes the remote before making a commit

- **Status:** Proposed
- **Date:** 2026-10-19
- **Amends:** [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) at every browser commit having one parent, allowing a root commit after a successful fetch establishes an empty remote; [ADR-0628](0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) at the persisted browser state, adding whether the remote has been observed.
- **Unbuilt:** first-fetch adoption and bootstrap over real Git transport.

## Context

Before a first fetch, null B/C can mean that the remote has never been read.
After an empty fetch, the same pair can mean that the remote has no `main`.
Treating both as empty creates an unrelated local root before discovering an
existing server history. ADR-0623 already requires fetching before the first
commit, but the proposed state did not preserve that knowledge.

The hosted store can create a repository without a `main` commit. Someone
must be able to create the ordinary Git root. That bootstrap cannot have
a parent; later browser commits can have one server parent as designed.

## Decision

**The browser persists `remoteKnown`, initially false.** A successful first
fetch publishes that flag with its adopted refs, objects, boundary metadata,
and reconciled E under the same revision check. A failed or stale publication
leaves it false. Observing an empty remote also requires a successful
publication. A network error never establishes emptiness.

While the flag is false, commit preparation leaves E intact and returns no
pending commit. Offline reads and saves continue. After an empty observation,
the first candidate may be a root commit. Its conditional push must still
expect the server's `main` to be absent. All later candidates have one parent.

Commit preparation returns the exact `{ base, head }` pair captured when
reusing or publishing a pending commit, or null when there is no pending
commit. A confirmed head alone is not a pending request. The network attempt
uses that pair; acknowledgement preserves newer E as ADR-0628 requires.

## Consequences

One persisted bit removes ambiguity between offline-first opening and an
empty remote. It adds no network owner or edit history. Competing initial
pushes and lost bootstrap replies still need the ordinary uncertainty and
ancestry checks; local fixtures do not establish that transport behavior.
