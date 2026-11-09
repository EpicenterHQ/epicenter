# 0631. A browser observes the remote before making a commit

- **Status:** Proposed
- **Date:** 2026-10-19
- **Amends:** [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) at every browser commit having one parent, allowing a root commit after a successful fetch establishes an empty remote; [ADR-0628](0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) at the persisted browser refs and shallow-boundary metadata, storing only an observed remote base and an optional exact pending commit.
- **Unbuilt:** first attachment in an app, hosted-service and abrupt-crash evidence for uncertain pushes.

## Context

Before a first fetch, a null remote tip could mean that the remote has never
been read. After an empty fetch, it could mean that the remote has no `main`.
Treating both as empty creates an unrelated local root before discovering an
existing server history. ADR-0623 already requires fetching before the first
commit, but the proposed state did not preserve that knowledge.

The hosted store can create a repository without a `main` commit. Someone
must be able to create the ordinary Git root. That bootstrap cannot have
a parent; later browser commits can have one server parent as designed.

## Decision

**The browser stores an observed `remoteBase` and an optional
`pendingCommit`.** `remoteBase` is undefined until a successful fetch, null
after observing an empty remote, and otherwise the last server commit
incorporated locally. A failed or stale fetch publication leaves it undefined.
A network error never establishes emptiness. `pendingCommit` is null while
idle; otherwise it is the exact commit awaiting an established outcome. The
current committed snapshot is `pendingCommit ?? remoteBase ?? null`.

While `remoteBase` is undefined, commit preparation leaves saved edits intact
and returns no pending commit. Offline reads and saves continue. After an empty
observation, the first candidate may be a root commit. Its conditional push
must still expect the server's `main` to be absent. All later candidates have
one parent.

Commit preparation returns the exact `{ base, head }` pair captured when
reusing or publishing a pending commit, or null when there is no pending
commit. The network attempt uses that pair; acknowledgement checks it and
preserves newer edits as ADR-0628 requires. The Git transfer derives its
shallow boundary from `remoteBase`, which is already the retained history
boundary. No second stored boundary or idle duplicate of the base is needed.

## Consequences

The three values of `remoteBase` remove ambiguity between an unfetched remote,
an empty one, and a commit. The optional pending commit preserves the identity
of an uncertain push; saved edits remain a separate overlay so another save
can proceed while that push is unresolved. The publication revision still
guards races across tabs. These are browser engine details, not `Folder` API
fields. Competing initial pushes and lost bootstrap replies still need the
ordinary uncertainty and ancestry checks.
