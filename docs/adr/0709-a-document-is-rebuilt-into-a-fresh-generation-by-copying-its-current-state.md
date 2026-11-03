# 0709. A document is rebuilt into a fresh generation by copying its current state

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Relates:** [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) (documents and their export format), [ADR-0708](0708-a-namespace-holds-documents-beside-repositories-under-one-resource-grant.md) (a document's name and grants), [ADR-0286](0286-every-generation-is-minted-from-an-artifact-and-compaction-is-an-export-then-an-import.md) and [ADR-0293](0293-a-generation-is-created-by-importing-a-folder-and-the-ledger-row-is-its-existence.md) (the removed store's generations), [ADR-0220](0220-the-authority-keeps-a-snapshot-and-a-tail-and-a-deletion-becomes-real.md) (tombstone growth).
- **Unbuilt:** all of it: the rebuild, the generation number on the server, the refusal of a stale copy, and the "Discard local copy" and "Export it as notes" actions.

## Context

The Yjs store removed in `9f75a9bd51` (ADR-0534) compacted a database by
export then import (ADR-0286). An artifact of `kv.json` and
`<table>/<rowId>.md` notes was minted into a new generation, a device chose
which generation it held (ADR-0292), and importing a folder was the only way
a generation came into being (ADR-0293).

A Yjs document keeps deleted content as tombstones, which grow on every
device and on the server (ADR-0220). [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) brings documents back for
long-lived data, where the owner accepts that growth and wants a rare
way to shed it. A document keeps its name and grants ([ADR-0708](0708-a-namespace-holds-documents-beside-repositories-under-one-resource-grant.md)). Custom
bodies may convert to Markdown imperfectly ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)). No workspace package
imports `@y/y` today; the root `package.json` pins it at `14.0.0-rc.26`
through `overrides`.

## Decision

**A rebuild copies a document's current state into a fresh Yjs document.**
For each root, the rebuild reads the current content and writes it into the
same root of a new `Doc`: attributes, children, text with its formatting,
and embedded values. In the installed `@y/y` 14.0.0-rc.26 that is
`toDeltaDeep()` on each root `Node` and `applyDelta()` on the new one.
Deleted content, delete history, and undo history are not copied.
`cloneDoc()` is not a rebuild: it applies `encodeStateAsUpdate(ydoc)`, which
carries the full history.

**A rebuild never passes through Markdown.** Export and import ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md))
serve backup and moving between stores, and may lose a custom body's
structure.

**The document keeps its id, and the server stores a generation beside it.**

```txt
document <namespace>/<name>    generation: 1, 2, 3 …    a rebuild replaces the stored state and adds 1
```

The name, the address, and every grant ([ADR-0708](0708-a-namespace-holds-documents-beside-repositories-under-one-resource-grant.md)) stay the same. Anyone with
write access to the document may start a rebuild, by hand; nothing schedules
one.

**A copy from an older generation is refused.** A device presents its
generation when it connects. On a mismatch the server sends nothing and
accepts nothing, and the app shows "This document was rebuilt on <date>.
Your copy is from before." with two actions:

```txt
Discard local copy     deletes this device's copy and loads the current generation
Export it as notes     writes this device's copy as notes in ADR-0705's export format, to import by hand
```

No edit crosses generations automatically.

## Consequences

- A rebuild costs work proportional to current content, not history. The
  rebuilt document's size is its content.
- The server holds one integer per document and checks it once per
  connection.
- Edits a device made offline against the old generation are not merged.
  They survive only through "Export it as notes".
- Snapshots, version history, and undo stacks end at a rebuild.
- References to Yjs internals do not survive a rebuild. A `RelativePosition`
  or an item id names structure the rebuild does not copy, so an app either
  does not store such anchors in document data or re-anchors them during the
  rebuild.

## Considered alternatives

- **The same document with no generation, after people purge every
  device.** A forgotten device sends its old items, which the rebuilt
  document does not contain. Map keys keep one side, but text and arrays
  hold both copies, so every body appears twice and the old history returns.
- **Compaction through Markdown.** Lossy wherever a custom body converts
  imperfectly.
- **A new document id per rebuild.** The name, address, grants, and every
  link change, and each device must learn the new id.
- **The removed store's generations,** where a device chooses which
  generation it holds. That needed a ledger of generations; a single current
  generation with refusal needs one integer.
