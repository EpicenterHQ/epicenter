# Shared documents with Yjs on `fetch` and `websocket`

**Date**: 2026-11-17
**Status**: Draft
**Owner**: Braden

## One Sentence

An app could offer live shared editing by relaying Yjs updates over the
`websocket` and `publish` of ADR-0945, storing them as an append-only log under
`local/`, and exporting Markdown to `data/` as the copy that lasts.

Nothing here is decided. It is a sketch and the research behind it, kept so
the first app that wants shared editing does not start from zero. That app
settles the open questions below, and what it settles becomes a decision
record.

## How to read this spec

```txt
Read first:
  Current state
  Sketch
  Open questions

Read when building:
  What Yjs allows without loading a document
  What Yjs 14 changes
```

## Current state

- A record is a Markdown file under `data/`. Two devices editing one note go
  through the data handle's `set` or `edit`, and the second write replaces
  the first or is refused.
- An app offers only actions. ADR-0945 (Proposed, unbuilt) adds `fetch`,
  `websocket` and `publish`.
- ADR-0943 allows a CRDT to own live edits with one exporter writing a saved
  copy into the home, and refuses a CRDT built into the platform.

## Sketch

```txt
Laptop types
   |
   v
websocket.message --> append the update bytes to local/docs/<id>/log.bin
                  --> publish(<id>, update)  to every socket, sender included
                                |
                                v
                       Phone applies the update

A routine, every few minutes:
export action --> load base + log into a Y.Doc --> write data/notes/<id>.md
compact action -> load with gc --> write base.bin, start log.bin again
```

```txt
apps/notes/
  code/epicenter.ts        fetch, websocket, and the read, edit, export and compact actions
  data/notes/<id>.md       the export: committed, what survives a lost disk
  local/docs/<id>/
    base.bin               the last compaction: one Yjs update
    log.bin                each update since, length-prefixed, in arrival order
```

The working assumptions behind the sketch:

- **One kind of document.** It never closes and is not rebuilt from Markdown
  when its editors leave.
- **The relay never loads a document.** It appends and publishes bytes. Only
  `export`, `compact`, and an agent's `read` and `edit` load one.
- **Agents and the command line edit through actions.** `edit` takes the one
  passage to replace and its replacement, as `edited` in
  `packages/app/src/text-edit.ts` does, makes that change as a Yjs update,
  appends it, and publishes it. Only `export` writes the Markdown file.
- **The Markdown is what lasts.** A lost `local/` costs the edits since the
  last export. Recovery rebuilds the document from Markdown, and a browser
  still holding the old document must discard it.

## Open questions

Each is for the first app to answer against real use.

1. **Which app, and which editor.** `@y/codemirror` on Markdown source is in
   beta. No Tiptap binding for Yjs 14 was found.
2. **How a document maps to Markdown.** Which parts are front matter, which
   are the body, and what `read` returns as JSON.
3. **When `export` and `compact` run.** A routine on a schedule, or after a
   document goes quiet.
4. **Whether Yjs history is kept.** Compaction drops deleted text. Yjs 14's
   attribution and suggestion features need an uncompacted copy. Otherwise
   history is the Git history of the Markdown.
5. **How recovery tells browsers to discard.** One option is a generation id
   in the socket's URL that the relay refuses when it is not current.
6. **Yjs 13.6 or 14.** See below.
7. **Where the relay code lives.** In the app, or a module apps import.
   ADR-0942 publishes two packages at one version, so a third package is not
   free.
8. **Whether per-message app loading is fast enough.** Unmeasured (ADR-0945).
9. **Hosting.** A person whose home is off cannot edit. A hosted relay at
   another address would serve the same client. That is a product decision
   outside this spec; `@y/hub` is the reference for it.

## What Yjs allows without loading a document

Checked against Yjs 13.6.31 source in this repository's `node_modules` and
through DeepWiki on 2026-11-17.

| Need | How, from bytes alone |
| --- | --- |
| Store an update | append it; updates apply in any order and duplicates are harmless |
| Merge a log | `mergeUpdates(updates)` |
| What the log holds | `encodeStateVectorFromUpdate(merged)` |
| Answer a joining client | send the merged log as sync step 2 |
| Relay presence | forward awareness messages unparsed |

What needs a `Y.Doc`:

- **Dropping deleted text.** Merging never does. Load into
  `new Y.Doc({ gc: true })` and write `encodeStateAsUpdate`. A client holding
  the old history can still sync against that output.
- **Reading the text**, for `export` and for an agent's `read`.

Limits:

- A lost update leaves that client's later edits pending on other clients
  until it arrives. The relay sending its own state vector on join lets the
  client resend what is missing. This is inferred from the source, not tested.
- The sync protocol in `y-protocols` uses the V1 update format. One log holds
  one format.
- The stock WebSocket server keeps a `Y.Doc` in memory per room, so the
  relay answers sync step 1 itself.

## What Yjs 14 changes

Read from `@y/y@14.0.0-rc.30` (released 2026-11-14) and its companion
packages on 2026-11-17.

- **It is published as `@y/y`**, with `@y/protocols`, `@y/websocket`,
  `@y/codemirror` and `@y/prosemirror`. The `yjs` package stops at an
  abandoned 14 beta.
- **The update bytes and the sync messages are the same as 13.6.** A relay
  that handles only bytes works with either.
- **`@y/websocket` confirms a local edit only when the server sends it
  back.** The relay must publish to the sender too.
- **`diffUpdate` is deprecated and `parseUpdateMeta` is gone.** The official
  server, `@y/hub`, sends the whole document on join.
- **Merging keeps the first input where two overlap.** Put the compacted
  `base.bin` before the log, or deleted text comes back.
- **`createContentIdsFromUpdate` and `intersectUpdateWithContentIds`** let a
  relay drop content it already holds before appending.
- **A 13.6 client cannot share a document with a 14 client.** 14 writes every
  nested type as one `YNode` type.
- **It is a release candidate.** No frozen format or release date is stated,
  and yjs#815 (merging throws on some malformed updates), #824 and #825 (gap
  handling) are open. The relay should refuse an update Yjs cannot decode.
- **`@y/hub`** keeps no document in memory, stores bytes, and compacts by
  loading. It needs Redis and S3 or Postgres, and is licensed AGPL or
  commercially.

Not determined: whether the format will be frozen, whether 13.6 and 14 are
tested against each other upstream, and how `@y/websocket` behaves on
reconnect when the server answers with a diff.

## What proves the change is done

A first app whose note stays the same on two devices typing at once, shows an
agent's `edit` on both within a second, and whose `data/notes/<id>.md` matches
the document after `export`. Then the settled choices move to a decision
record and this file is deleted.
