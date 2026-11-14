# 0897. Notes keeps each note as a Yjs document behind its Markdown contract

- **Status:** Proposed
- **Date:** 2026-11-13
- **Amends:** [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) at "The folder is the only kind of store", for a service app: what a service keeps behind its contract is its own choice (ADR-0896).
- **Relates:** [ADR-0534](0534-data-folders-are-the-only-data-model.md) (Yjs as the platform's store, removed), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (a losing edit is kept), [ADR-0896](0896-every-app-has-one-truth-and-every-other-copy-is-a-cache.md) (one truth per app; Notes is a service app with a Markdown cache).
- **Unbuilt:** all of it. This record stays Proposed until two phones, each offline with every note, edit the same note and then reconnect, and the owner's home cache shows the merged Markdown.

## Context

Notes is for the owner and for customers. On a phone offline, the owner
wants every note, and edits the same note on two devices before either has
synced. If the later body replaced the earlier whole, one of those edits
would be lost. Notes are small, and most are short.

Yjs was the platform's store and was removed twice (ADR-0534, ADR-0771),
because every app, file, and agent had to go through a CRDT. Under ADR-0896,
a service keeps what it likes behind its contract. The owner's page "Server
ordered metadata, Yjs at the edges" puts Yjs where independent edits must
survive.

The `@epicenter/workspace@0.3.0` tag holds the earlier sync work:
`packages/sync`, the Yjs sync wire format with an auth subprotocol, and
`packages/server/src/room`, a room core with a Cloudflare Durable Object
adapter, an update log, and compaction when a room empties.

## Decision

**Notes' truth is a service at `notes.epicenter.so`. Inside it, each note is
a Yjs document, held by every device that has the note, and merged when
devices meet. Outside it, Notes is its Markdown contract: the owner's cache,
an agent, and an export see only Markdown.**

```txt
phone: every note, offline        laptop: every note, offline
  a Yjs document per note           a Yjs document per note
            └───── Yjs sync when online ─────┘
                         ▼
notes.epicenter.so: every note's document, and a numbered list of changes
     │ notes.sync and export: Markdown             ▲ notes.edit, notes.set
     ▼                                             │ applied to the document
~/Epicenter/apps/notes/data/   the owner's Markdown cache (ADR-0896)
```

- **One document per note,** with its body as `Y.Text` holding Markdown, and
  its title and tags as fields beside it. One small index document lists the
  notes and their deletions. A phone stores every document and loads the one
  it opens.
- **Yjs's sync is the outbox.** A device keeps its documents in browser
  storage or a file, exchanges what it has with the service on reconnecting,
  and sends only what is missing.
- **An edit outlives a deletion.** A note deleted on one device and edited on
  another comes back, as ADR-0622 keeps a losing edit.
- **An action is applied to the document.** `notes.edit` from an agent
  becomes a change to `Y.Text` on the service, so it merges like any other
  edit.
- **The service renders a note's Markdown when it changes** and numbers the
  change. The home's `notes.sync` asks for the changes after the last number
  it saw. `export` is every note's Markdown.
- **The service is a Durable Object per person,** built from the room core and
  wire format at `@epicenter/workspace@0.3.0`.

## Consequences

- Two offline edits to one note both survive, merged by Yjs.
- No other app, no home, and no agent handles Yjs.
- The owner runs a hosted service: accounts, storage, and uptime.
- A document's state grows with its edits; compaction keeps it small.

## Considered alternatives

- **Plain records, the later body winning.** Loses one of two offline edits
  to a note, which the owner makes.
- **A three-way text merge on the service.** Needs each device's base
  version, and leaves a clash in one line to a marker or a loss.
- **Automerge or Loro.** Neither offers a reason to leave the Yjs work
  already written.
- **One document for all notes.** A phone would load every note to open one,
  and compaction would cover everything at once.
