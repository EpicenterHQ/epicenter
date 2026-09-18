# 0223. A page holds the store, and only three small relations have to survive

- **Status:** Superseded
- **Date:** 2026-08-08
- **Superseded by:** [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md), which deletes the in-memory SQLite file this record's store committed into and makes IndexedDB own the durable facts directly, so the mirroring worker, the OPFS file it held, and the three relations that had to survive it all go with it. A page still holds the store, restated by [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) and implemented in `packages/data/src/store/browser.ts`; the durability alarm became the visible persistence debt of ADR-0238 and then one health bit ([ADR-0298](0298-the-authority-is-byte-blind-and-a-cursor-is-a-log-position.md)).
- **Relates:** [ADR-0215](0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md)
  (the synchronous surface this preserves),
  [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  (the file a store needs),
  [ADR-0177](0177-a-browser-replica-is-owned-by-a-storage-partition-and-origin-pair.md)
  (a WebView is a storage partition and origin pair).
- Evidence: `packages/data/evidence/browser/sync-access-handle.ts` and
  `packages/data/evidence/browser/durable-store/main.ts`. The Honeycrisp
  browser scripts that drove the same claim through the application are
  deleted: an account is required (ADR-0336), so a fresh browser context meets
  the sign-in gate and never reaches a note.

## Context

The store is synchronous end to end, and its durability comes from a
`SqliteDatabase` whose `run` and `transaction` return rather than resolve. On
Bun that is `bun:sqlite` and it holds trivially. In a browser it does not:
sqlite-wasm's only durable backing is the origin private file system, reached
through `FileSystemFileHandle.createSyncAccessHandle`, and that is available
only in dedicated workers. Measured in a real Chromium on a secure origin, with
the worker arm as a control that must succeed:

```txt
context           available  detail
main thread       false      createSyncAccessHandle is not a function
dedicated worker  true       9 bytes written
```

**A false conclusion was drawn from that and is recorded here so it is not drawn
again:** that a page therefore cannot host the store, and that Honeycrisp was
blocked until some host owned its file. It does not follow, and the throwaway
lab refuted it by running the whole time. The store needs a synchronous HANDLE,
not synchronous DURABILITY. It touches SQLite in three places, the schema and
the replay at construction and then `transaction` and `all`, and every read a
person makes (`get`, `list`, `ids`, `document`) comes from the `Y.Doc` already
in memory. SQLite is a write-behind log and a query cache, not the read path.

This is the same error shape the store's own comment once carried: `observeDeep`
cannot name the row (true) therefore nothing can (false), which ADR-0221 undid.

## Decision

**The store runs in the page, over an in-memory SQLite. A dedicated worker holds
the same database on OPFS and is fed the same statements.** On open the page
takes the file back whole and deserializes it, so it holds exactly what the last
session committed with nothing to reconcile, and `createStore` hydrates from it
exactly as it does on Bun.

**Every statement is mirrored, not a curated subset.** Forwarding only the three
underscore-prefixed relations the store owns would mean the worker knows what a
projection is, and two schemas that can disagree. Forwarding everything makes
the worker's file byte-identical, so opening is a restore rather than a replay
and the projection comes back for free. Batched per transaction, so one store
commit is one message, and a rolled-back transaction sends nothing.

**The worker is not a replica and not a proxy.** It applies statements it does
not interpret and holds bytes it never reads; nothing in it imports Yjs, a lens
or the store. That is the whole difference from the superseded stack, where the
worker owned the replica and the page was its asynchronous client, which is why
every read in an application on that stack is awaited.

**A durability failure becomes an alarm, not a returned error.** On Bun the
durable write IS the write, so `persist` poisons the store the moment storage
refuses. IndexedDB is asynchronous, so the refusal arrives after the write
returned `Ok` and there is nothing left to fail. `durability()` reports it in the same shape as
`hasUnresolvedDependencies`, and `whenDurable()` is there for anyone who wants
to wait.

## Consequences

Honeycrisp moves without a host owning anything, which is what the alternative
would have required.

Nothing is lost when the alarm fires: the `Y.Doc` still holds the work and the
outbox still owes it to the authority, so it reaches every other device
normally. What is lost is the guarantee that a RELOAD of this device sees it.
That is a genuinely weaker promise than Bun's and it is the price of the
arrangement; an application that ignores the alarm will eventually mislead
somebody.

The page pays a WASM compile and one IndexedDB read at open, which is why
opening is the one asynchronous thing left in an application on this store, and
why the ready-application render gate is the shape a page on it wants.

The store gains `onCommitted` beside `onLocalWork`. They are not
interchangeable: the transport must not be nudged by bytes that arrived from a
peer, and durability must not ignore them.

`packages/data/evidence/browser/durable-store/main.ts` runs the whole thing
across a real reload with three controls. The Honeycrisp script that did the
same through the real application is deleted, because an account is required
now (ADR-0336) and a fresh browser context stops at the sign-in gate.
