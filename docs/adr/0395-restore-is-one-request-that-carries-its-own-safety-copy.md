# 0395. Restore is one request that carries its own safety copy

- **Status:** Proposed
- **Date:** 2026-09-12
- **Relates:** [ADR-0379](0379-reconstruction-is-an-explicit-destructive-library-operation.md) (`Proposed`, edited in place: no receipt survives a lost response, because a retry is refused by the position check and the person is looking at the restored library), [ADR-0394](0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md) (what a kept copy is), [ADR-0393](0393-a-blob-is-addressed-by-its-row-and-the-account-holds-every-one.md) (why restore moves no bytes)
- **Unbuilt:** All of it. `openCurrentAuthority` in `packages/data/src/sync/authority.ts` exposes `prepareActivation().activate()` with `_restore_receipts` and reads `_restore_attempts` for a fence and a pinned digest; this record removes all three and adds the safety copy. No route reaches it in production; only the Honeycrisp fixture worker's `activateForTest` does.

## Context

The restore the unmounted coordinator in `packages/data/src/recovery.ts` was
built toward is five requests that could each be lost: publish a safety backup,
upload prepared bytes, pin their digest to an attempt row, activate,
acknowledge. `sync/attempts.ts` holds the attempt with a partial unique index
over `status = 'pending'`, set-once fields, a `failed` fence, and `pending()`,
`acknowledge`, and `fail` so a page that reopened could learn what a previous
page left unfinished. Every piece bridges a gap between two of the five.

The activation transaction already compares the current generation and head to
an expected position, replaces the log, advances the generation, and retires
the hub after commit (`packages/data/evidence/current-generation/authority.test.ts`).
Nothing in it requires the four requests around it, and its receipt exists only
to make a retry polite.

## Decision

**A restore is one request, and the authority keeps the safety copy in the
transaction that replaces the library.**

```txt
POST /api/libraries/:appId/:library/data/:dataId/restore
multipart:
  safety     the current library rendered as ADR-0394 entries
  state      the reconstructed Yjs state, a fresh lineage
  expected   { generation, head }   the position `safety` was rendered from
```

In one transaction the authority refuses `conflict` when the current
generation or head differ from `expected`; inserts `safety` as a kept copy with
`automatic = 0`; replaces the log with `state`; advances the generation. After
the commit it retires the hub, as `activate()` does today, so a rollback leaves
the admitted sockets usable. The transaction has no state before it runs and
none after it fails. No object moves: every row in the restored copy has its
bytes because the copy held the row, and every row it drops is held by the
safety copy.

**`expected` is a data-safety check, not a courtesy.** The safety copy is
rendered by the client from its replica. If another device pushed an edit the
client has not received, `expected` is behind the authority, the restore is
refused, and the person sees "the library changed while you were restoring;
try again". Trying again renders a new safety copy that has that edit. Nothing
a person has is ever replaced before a copy of it is kept.

**There is no receipt and no operation id.** `restore(id)` downloads the copy,
reads it into a fresh document through the table codecs, renders the current
download as `safety`, and sends the request. A retry after a lost response is
refused `conflict`, because the generation advanced, and the person is looking
at the restored library, because retirement reloaded it. A page that dies
before the response is either looking at the restored library on reopen or at
the unchanged one, and in both cases it has nothing to reconcile.

Each multipart part is read through the same 16 MiB streaming refusal that
`StoreAuthority.fetch` applies to a baseline body.

**Retirement is unchanged.** Sockets receive `retired`, replicas discard their
cache under the library claim, `createDeparture` closes the App and reloads. On
the initiating device the `retired` frame may arrive before the HTTP response,
so the Backups screen shows "Restoring…" and treats departure as success; it
renders an error only when the response is a refusal and no retirement fired.

## Consequences

`_restore_attempts`, `_restore_receipts`, the partial unique index,
`pinPreparation`, the `failed` fence, the digest comparison, `pending()`,
`acknowledge`, `fail`, the client journal, and every test that drives them are
deleted.

A restore costs one render of the current library plus one request, the same
as `backup()`. Its body is text and state under the existing cap.

Two people restoring at once are serialized by the Durable Object; the second
sees `conflict`. Two tabs on one device cannot both hold the App, because the
library claim is exclusive, and the recovery object without an App goes
through the same authority.

Restoring the same copy twice, deliberately, is two restores and two safety
copies. There is no "abandon" and nothing to abandon.

The safety copy is rendered by client code and is exactly as faithful as every
other copy.

## Considered alternatives

- Five requests with a durable attempt row, pinned digest, fence, and client
  journal. Every part bridges a gap a single request removes.
- Two requests, safety copy then activation. Half the machinery, and an extra
  kept copy on every crash between them.
- A client-minted operation id with a receipt table, so a retry could learn
  it already happened. Redundant with `expected`: after a commit the position
  has moved, the retry is refused, and the reload already showed the result.
- Restore without `expected`, last writer wins. Loses edits the safety copy
  never saw.
- The authority copies its own `_snapshot` and `_log` rows as the safety copy.
  Atomic and independent of client code, but a second shape beside the folder.
- Skip the safety copy because a daily copy exists. A daily copy is up to a
  day old; the safety copy is what makes a restore reversible to the second.
