# 0707. An app that needs co-editing is a document app

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Relates:** [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) (folder and document stores), [ADR-0690](0690-merges-happen-only-where-history-records-the-common-ancestor.md) (merges where history records the common ancestor).
- **Amended by:** [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) at the document store: the folder is the only kind of store.
- **Unbuilt:** the document store [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) names; no app co-edits today.

## Context

A folder note changes by whole-file writes that Git merges at sync: front matter
key by key, the body by diff3 with conflict blocks (`settle`,
`packages/definition/src/merge/settle.ts`). Two people typing in one note at
once is not something that merge serves.

ADR-0690, still Proposed, named a body session as the only collaboration
layer a folder permitted: a live session over one note's body that persisted
back to the file. Every design for it had to answer what happens when
an agent or a sync writes the same file during the session, how often the
session writes a commit, and which version it merges against. Jupyter's
collaboration (disk wins and resets the room) and Overleaf's Git bridge (live
history exported as linear commits) settle that by making one side
authoritative; no precedent keeps both live editing and ordinary file writes on
the same data.

## Decision

**An app whose people edit the same item at the same time keeps its data
in a document ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)).** Live presence and concurrent edits come
from the document's Yjs sync.

**A folder note has no live session.** Nothing seeds a live room from a note,
streams edits into it, or writes it back on a checkpoint. A folder app's
concurrent edits meet only at sync, under `settle`.

A folder keeps agents, `grep`, and Git history; a document keeps live
co-editing, offline copies, and synchronous reads. No data has both.

The current folder apps (Honeycrisp, Notes, Opensidian, The Ark, and the rest
listed in [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)) are not designed for co-editing and stay folders.

## Consequences

- The session machinery ADR-0690 left open is not built: no seeding a Yjs room
  from a blob, no checkpoint commits, no reconciliation when a file changes
  during a session.
- A person who wants their agent to rewrite a note and a partner to edit it live
  picks one; the agent reaches a document through `epicenter get` and
  `epicenter set` ([ADR-0716](0716-agents-edit-a-document-through-one-shot-cli-commands.md)).
- Moving an app's data from a folder to a document, if co-editing becomes
  necessary, is the export-then-import migration of [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md).

## Considered alternatives

- **A live session over one note's body, checkpointed as commits.** The hardest
  piece in the design, with no precedent for keeping both sides writable; no
  current app needs it.
- **A Yjs copy of every folder note.** The two-way bridge [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) refuses.
- **Server-ordered edit steps instead of a CRDT for co-editing.** A transport
  choice inside a document store, not a reason to put live sessions on folders.
