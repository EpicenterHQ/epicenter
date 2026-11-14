# 0896. Each app's data has one authority, and every other copy is a client or a read-only mirror

- **Status:** Proposed
- **Date:** 2026-11-13
- **Amends:** [ADR-0895](0895-only-the-home-commits-an-apps-data-and-a-connected-program-delivers-to-it-through-the-apps-actions.md) at "only the home commits an app's data": only the app's authority commits it, and the authority may be a hosted home; at "no device keeps a continuously synced copy": a mirror follows a one-way feed of changes and is never written; and at "A full copy on every device, with a feed of changes from the home", which conflated a read-only feed with two-way reconciliation.
- **Relates:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (one person's software; a hosted Epicenter is Later in `docs/vision.md`), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (whoever has the folder edits files), [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) (the contract), [ADR-0897](0897-notes-keeps-each-note-as-a-yjs-document-behind-its-markdown-contract.md) (Notes, the first hosted authority).
- **Unbuilt:** all of it: the `changes`, `files`, and `export` routes, mirrors, `epicenter move`, tokens for programs, and a hosted authority.

## Context

ADR-0895 has one home commit every app's data. Two cases do not fit. A
person without an always-on computer still wants their notes on every
device. And the owner wants some apps, Notes first, hosted at
`notes.epicenter.so` for themself and for customers, with a Markdown copy on
the owner's own home for agents and an archive.

Three independent reviews reached the same account. Comparable systems give
each dataset one authority: Bitwarden and Immich make "hosted or
self-hosted" a server address, Linear and Notion keep a server-ordered
authority with a client cache, and Home Assistant keeps it at home. None
runs a hosted copy and a home copy that both accept writes. Every design
that allowed two writable copies needed cross-site merging, a Markdown to
CRDT import, and a handoff of authority, which is the folder sync product
ADR-0840 set aside.

`serve` already offers actions at `POST /<app>/<action>`
(`packages/cli/src/http.ts:134`) and prints an app's contract as JSON Schema
(`packages/cli/src/listing.ts:108`). It refuses a request whose `Origin` is
not its own host (`http.ts:414-426`).

## Decision

**Each app's data has exactly one authority at a time: a person's home, or
a home Epicenter runs for them. Only the authority commits it. Every other
copy is a client, which asks through actions, or a mirror, which follows a
one-way feed and is never written.**

```txt
          the authority for an app (one, chosen per app)
          your home  or  a home Epicenter runs for you
             ▲ actions, and an outbox while offline   │ changes, one way
   clients: a phone, a laptop, a UI,          mirrors: read-only Markdown in Git,
   an agent elsewhere, a program              for backup, agents' reads, and leaving
```

- **The promise is the contract and its routes,** not a program or a
  storage format. A hosted authority may keep its data in a database, so
  long as what it hands out is Markdown in the contract's shape:

  ```txt
  GET     /<app>                       the contract, as JSON Schema
  POST    /<app>/<collection>.<verb>   list, get, add, set, edit, delete
  POST    /<app>/changes  {cursor?}    paths changed or deleted since the cursor, and the next cursor; or reset
  GET|PUT /<app>/files/<path>          bytes beside a record
  GET     /<app>/export                the data folder, with its history
  ```

  The cursor is opaque: a commit id on a home, a sequence number on a
  hosted authority. A deletion appears in the feed. A cursor the authority
  can no longer answer gets `reset`, and the caller lists and compares.
- **A mirror is a view.** Its files are read-only on disk. `epicenter <app>`
  and a UI served from a mirror send actions to the authority, and the mirror
  pulls right after each one it forwards, so an agent reads its own write.
  If a file changes anyway, the mirror commits it to a side branch before the
  next pull overwrites it, and its status names the file.
- **Whoever wants to edit an app's files directly keeps that app's
  authority on their home.** That is a choice made per app.
- **Moving the authority is `epicenter move <app>`.** The old authority
  freezes writes at a checkpoint; the data and its history move; the new
  authority accepts retries from devices that were offline, recognised by
  each write's id; the old one refuses or redirects later writes and becomes
  a mirror or is deleted. A device offline for weeks never blocks a move.
- **A hosted home runs only Epicenter's own apps.** Running a customer's or
  an agent's code would need a sandbox per person.
- **Mail's authority is Gmail, and its copy lives on the person's own home,**
  because its sign-in does (ADR-0870).
- **A program authenticates with a bearer token:** a device token the home
  mints, or the hosted account's sign-in.

## Consequences

- No copy is ever reconciled with another. A clash happens only at the
  authority, under that app's rule.
- One protocol serves a phone reaching a home, a home mirroring a hosted
  app, and a third party in any language reading the JSON Schema.
- A hosted Epicenter can sell an operated home per app; a self-hoster gets
  the same apps, since billing is hosted-only and the code is AGPL.
- An app hosted for the owner cannot be written while the internet is down,
  even on the owner's home. Its mirror still reads.
- A mirror's history is its own snapshots of what it pulled; the
  authority's history moves only with `epicenter move` or `export`.

## Considered alternatives

- **The hosted copy is the truth and the home's copy is writable,** with file
  edits forwarded. The home becomes a second writer; that is two-way sync.
- **The home is always the truth, with hosting as a relay.** Nothing for
  people without an always-on computer.
- **Per-app hosted services, each its own implementation.** A second
  implementation of the contract to keep in step with `serve`; nothing here
  prevents it, since the routes are the promise.
- **Overwrite a stray edit on a mirror and rely on history.** An
  uncommitted edit is in no history; the side branch keeps it.
- **Drain every outbox before a move.** A phone offline for weeks would block
  it.
