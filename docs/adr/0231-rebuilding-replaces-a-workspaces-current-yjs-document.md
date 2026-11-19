# 0231. Rebuilding replaces a workspace's current Yjs document

- **Status:** Accepted
- **Date:** 2026-08-10
- **Amended by:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) at bootstrap and the announcement. A replica dials its generation's address, so the authority no longer names its document on every connection and the bootstrap connection is deleted; supersession becomes a fact the generation states rather than an equality the replica computes. Rebuild workspace returns as a source of bytes for a new generation.
- **Amended by:** ADR-0277 at the cursor. Admission is still equality on the document identity, which is what generations ride on; a replica no longer holds a log position, because there is no log to be positioned in.
- **Superseded by:** [ADR-0256](0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md) at the product rebuild action and the authority's whole-document replacement path
- **Amends:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md), [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md), [ADR-0219](0219-a-deleted-row-is-removed-and-the-presence-flag-is-retired.md), ADR-0220, ADR-0222, and [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md)

## Context

A workspace is a Yjs document whose shared graph contains the tables, rows,
row documents, and workspace key-value state the application presents. The
authority keeps the current document's snapshot and update log. A cursor says
where a replica is within that log. It does not say which document the cursor
belongs to.

That distinction matters when a user wants a clean rebuild: copy the visible
workspace into a fresh Yjs document, give it a fresh identity, and retire the
old document completely. The old document must not remain a fallback history,
and a device holding it must not merge its state into the replacement.

`gc: true` and ordinary snapshot folding solve different problems. They reduce
discarded Yjs structures or stored history within one document. Neither creates
a new document, changes document identity, or tells another device to discard
its obsolete local replica.

## Decision

Every document has one owner and one current identity.

For a shared workspace, the authority owns an opaque current document ID and
the state for exactly that ID:

```text
workspace
└── current document ID
    ├── snapshot
    └── ordered update log
```

### Rebuild workspace

The product action is **Rebuild workspace**. It requires explicit user
confirmation because devices with unsynchronised workspace state will lose
that state.

The initiating client:

1. verifies that it holds the current document ID and a complete local view;
2. reads the live Yjs shared graph, including all root shared types and their
   nested content;
3. copies that live value into a fresh `Y.Doc`, producing fresh Yjs struct
   identities; and
4. sends those bytes to the authority with the old document ID and its current
   log head as a compare-and-swap lease.

The authority accepts only when both lease values still name its current
document and head. In one authority operation it creates a new opaque document
ID, installs the rebuilt snapshot and a new log, and deletes the old snapshot
and log. There is no retained remote collection of retired documents.

The successful initiator discards its local workspace replica and reloads like
every other superseded replica. Rebuilding therefore has one adoption path,
not a special local success case.

### Bootstrap and admission

A local workspace replica stores its cursor and its document ID together.

A pristine replica without an ID may make one bootstrap connection. The
authority announces the current ID and closes; nothing else travels on that
connection. The replica persists the ID, then reconnects with it. Only a
connection whose declared ID equals the authority's current ID is admitted,
and every byte of state, in both directions, moves on admitted connections.
The replica-exchange invariant therefore has no first-contact exception.

If a replica declares a different ID, it is superseded. It discards the local
workspace state and reloads. It does not upload, merge, retain, or export its
old workspace bytes through sync.

This intentionally removes first-use offline workspace editing. A workspace
must bootstrap before it can accept workspace edits. That is the small rule
that makes the clean break unambiguous.

### Private local documents

This record defines workspace identity and workspace sync only. It does not
define the browser's private-local document or an action that copies private
values into a workspace. If the product offers that action, it must be an
explicit application-level copy into the current workspace document, never a
Yjs merge between documents.

## Consequences

- Rebuild is a user-directed clean break. It preserves the visible workspace
  value, not the old Yjs document or its history.
- An offline device that already bootstrapped keeps its ordinary offline work
  only while its document remains current. A rebuild retires that work.
- A device cannot accidentally turn pre-bootstrap local data into shared
  workspace history.
- Automatic snapshot folding remains available within one current document.
  It is an implementation detail and is never named Rebuild workspace.
- Recovery requires a separately designed backup or export feature. It is not
  supplied by hidden retained authority documents.
- Clients from before the document-ID protocol are reset rather than supported
  by a compatibility path.

## Required checks

Tests must demonstrate that:

- rebuilding copies rows, nested documents, formatting, and live shared state
  into fresh Yjs identities;
- a stale document is never admitted or merged;
- a bootstrap connection carries the announcement and nothing else, and an
  unstamped client neither pushes nor applies foreign bytes;
- a client persists the announced ID before its admitted connection; and
- snapshot folding inside a current document does not weaken rebuild's lease.
