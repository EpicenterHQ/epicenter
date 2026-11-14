# 0897. Notes keeps each note as a Yjs document behind its Markdown contract

- **Status:** Proposed
- **Date:** 2026-11-13
- **Amends:** [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) at "the folder is the only kind of store", for an app whose authority is hosted: what an authority stores behind its contract is that app's choice (ADR-0896).
- **Relates:** [ADR-0534](0534-data-folders-are-the-only-data-model.md) (Yjs as the platform's store, removed), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (a losing edit is kept), [ADR-0896](0896-each-apps-data-has-one-authority-and-every-other-copy-is-a-client-or-a-read-only-mirror.md) (one authority per app, mirrors, the routes).
- **Unbuilt:** all of it. This record stays Proposed until two phones, each offline with every note, edit the same note and then reconnect, and the owner's home mirror shows the merged Markdown.

## Context

Notes is for the owner and for customers. On a phone offline, the owner
wants every note, and edits the same note on two devices before either
has synced. Under ADR-0895's rule, the later body would replace the other
whole. Notes are small, and most are short.

Yjs was the platform's store and was removed twice (ADR-0534, ADR-0771),
because every app, file, and agent had to go through a CRDT. ADR-0896 makes
storage behind the contract an app's own choice. The owner's page "Server
ordered metadata, Yjs at the edges" (`~/Code/vault/pages/2026-07-11-server-ordered-metadata-yjs-at-the-edges.md`) puts Yjs where independent edits must
survive.

The `@epicenter/workspace@0.3.0` tag holds the earlier sync work:
`packages/sync`, the Yjs sync wire format with an auth subprotocol, and
`packages/server/src/room`, a room core with a Cloudflare Durable Object
adapter, an update log, and compaction when a room empties.

## Decision

**Notes' authority is hosted at `notes.epicenter.so`. Inside it, each note
is a Yjs document, held by every device that has the note, and merged when
devices meet. Outside it, Notes is its Markdown contract: a mirror, an
agent, and an export see only Markdown.**

```txt
phone: every note, offline        laptop: every note, offline
  a Yjs document per note           a Yjs document per note
            └───── Yjs sync when online ─────┘
                         ▼
notes.epicenter.so: every note's document, and a numbered list of changes
     │ changes and export: Markdown                ▲ actions: notes.edit, notes.set
     ▼                                             │ applied to the document
~/Epicenter/apps/notes/data/   the owner's read-only mirror (ADR-0896)
```

- **One document per note,** with its body as `Y.Text` holding Markdown, and
  its title and tags as fields beside it. One small index document lists the
  notes and their deletions. A phone stores every document locally and loads
  the one it opens.
- **Yjs's sync is the outbox.** A device keeps its documents in the browser's
  storage or a file, exchanges what it has with the authority on reconnecting,
  and sends only what is missing.
- **An edit outlives a deletion.** A note deleted on one device and edited on
  another comes back, as ADR-0622 keeps a losing edit.
- **An action is applied to the document.** `notes.edit` from an agent
  becomes a change to `Y.Text` on the authority, so it merges like any other
  edit.
- **The authority renders a note's Markdown when it changes** and records it
  in the numbered list that answers `changes`. `export` is every note's
  Markdown, with the history of those renders.
- **The authority is a Durable Object per person,** built from the room core
  and wire format at `@epicenter/workspace@0.3.0`.

## Consequences

- Two offline edits to one note both survive, merged by Yjs.
- No other app, no home, and no agent handles Yjs.
- The owner runs hosted infrastructure: accounts, storage, and uptime.
  Notes is the first hosted authority.
- A document's state grows with its edits; compaction keeps it small.
- A person may still move Notes to their home (ADR-0896). The home then
  holds the documents and runs the same room.

## Considered alternatives

- **Plain records with an outbox, the later body winning (ADR-0895).** Loses
  one of two offline edits to a note, which the owner makes.
- **A three-way text merge on the authority.** Needs each device's base
  version, and leaves a clash in one line to a marker or a loss.
- **Automerge or Loro.** Neither offers a reason to leave the Yjs work
  already written.
- **One document for all notes.** A phone would load every note to open one,
  and compaction would cover everything at once.
