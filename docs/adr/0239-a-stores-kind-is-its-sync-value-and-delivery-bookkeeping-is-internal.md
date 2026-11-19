# 0239. A store's kind is its sync value, and delivery bookkeeping is internal

- **Status:** Accepted
- **Date:** 2026-08-12
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** ADR-0233
  at the store surface: the replica verbs (`applyRemote`, the client log,
  `onLocalWork`, `hasUnresolvedDependencies`) leave the public type.
- **Amended at the vocabulary only.** `WorkspaceStoreBase` is `DataDocument`,
  `LocalStore`/`AccountStore` are `LocalDocument`/`AccountDocument`, and
  `DataOf<TDef, TStore>` is retired for `LocalData<TDef>` /
  `AccountData<TDef>` / `BrowserData<TDef>`. The decision is untouched: a
  document's kind is still its `sync` value, `undefined` or a
  `SyncCapability`, and the delivery verbs are still behind `syncEngineOf`.
  What changed is that the `store` KEY those names hung off was deleted, so
  they named an object that no longer exists. ADR-0279 left this rename open
  and said what would force it; this was it.
- **Relates:** [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md)
  (persistence as a capability; this record gives sync the same shape).

- **Amended by:** [ADR-0301](0301-owed-updates-collapse-into-one-resendable-row-and-the-fold-stops-asking-whether-a-store-syncs.md) at the fold's use of the store's kind. A store's kind is no longer a constructor argument the fold reads; the row's `authoritySeq` decides.

## Context

`ReplicaStore` was `Store` plus a bag of replica verbs: `applyRemote`, a
`sync` client log (coalesce, acknowledge, cursor, advance, the identity
stamp), `onLocalWork`, and `hasUnresolvedDependencies`. An audit of every
consumer found that no application uses any of them except
`sync.documentIdentity()`, read by three boot gates; everything else is
driven exclusively by the transport (`createSyncClient`,
`createSyncConnection`), the rebuild verb, and tests. Public verbs that can
corrupt a replica if driven casually (an ack drops obligations; a cursor
advance skips entries forever) were being carried on every app-facing store
for the benefit of one internal caller.

Separately, the two store kinds were told apart by an OMITTED property: a
device store simply lacked the replica keys, and code probed `'sync' in
store`. An omitted optional is a weak discriminant: it cannot be narrowed by
value, it reads as "maybe forgot" rather than "deliberately none", and a
spread that accidentally carries the key changes the answer.

## Decision

**The public surface is `WorkspaceStoreBase` plus one discriminating value,
both of a store's cross-cutting concerns are capabilities of the same shape,
and the two kinds carry the domain names the durable partitions already have:
device and account.**

```ts
type WorkspaceStoreBase = {
  readonly persistence: PersistenceCapability; // ADR-0238: get/subscribe/flush
  // pressure, stateVector, encodeStateSince, onCommitted, dispose
};

type DeviceStore = WorkspaceStoreBase & { readonly sync: undefined };
type AccountStore = WorkspaceStoreBase & { readonly sync: SyncCapability };

type SyncCapability = {
  get(): SyncFacts; // { document: string | undefined }
  subscribe(listener: () => void): () => void;
};
```

`sync` is present on BOTH runtime objects, an own property, never omitted or
optional; the value is the discriminant. Every store has local persistence;
only an account store has a concrete synchronization capability, and
`store.sync === undefined` narrows the union without probing for keys.
`SyncFacts` carries the one fact applications demonstrated a need for: which
authority document this replica's state belongs to, which is the boot gate's
whole question. The boot gates subscribe to the capability instead of
listening to `onCommitted` and re-reading. The snapshot is derived from
current consumers, not an invented state machine; it grows only when a real
consumer demonstrates the next fact.

### Delivery bookkeeping is internal

The client log, `applyRemote`, `onLocalWork` and `hasUnresolvedDependencies`
move to a `SyncEngine` reachable only through `syncEngineOf(store)`,
exported from the store module for the transport, the rebuild verb, and
tests, and absent from the package barrel. The engine registry is keyed by
the `sync` capability object rather than by the store, because openers wrap
stores in frozen spreads (`discard()`), and the capability is the one
reference every wrapper preserves.

### One vocabulary, no aliases

The generic kind names (`Store`, `ReplicaStore`) are deleted, not aliased:
the two durable partitions already had the right names in their directory
paths and openers (`epicenter/<ns>/device`, `epicenter/<ns>/account/<id>`,
`openDevice`, `openAccount`, ADR-0233), so the types, constructors, and
runtime wrappers consolidate onto them:

```text
Store               -> DeviceStore        createStore        -> createDeviceStore
ReplicaStore        -> AccountStore       createReplicaStore -> createAccountStore
StoreBase           -> WorkspaceStoreBase (…OverPort constructors follow)
BrowserStore        -> deleted (it aliased DeviceStore and added nothing)
BrowserReplicaStore -> BrowserAccountStore (AccountStore + discard)
BunStore            -> BunAccountStore     (AccountStore + discard)
```

The device document is local-only; the account document is the
authority-backed replica. The server-side test replicas are account stores
too: what makes a store an account store is having an authority, not running
in a browser.

## Consequences

- The package barrel stops exporting `ClientLog` and gains
  `WorkspaceStoreBase`, `SyncCapability`, `SyncFacts`; `StorePersistence` is
  renamed `PersistenceCapability` to match.
- The three app boot gates read `store.sync.get().document` and subscribe to
  `store.sync`; the test-only server replica reports the same way.
- The transport, rebuild, benches and tests import `syncEngineOf`; a future
  external consumer of a delivery verb must demonstrate its need and go
  through the same door, which is the audit this record freezes.
- A generic over either kind constrains on `WorkspaceStoreBase`; `DataOf`
  does.

## Considered alternatives

- **Keep the replica verbs public (status quo).** Rejected by the audit: one
  consumer class (the transport, in-package) and a standing invitation for an
  application to drive verbs that corrupt.
- **An omitted optional `sync?`.** Rejected: the discriminant should be a
  value deliberately present on both kinds, not an absence indistinguishable
  from an oversight.
- **Expose sync status on the connection only.** The connection already
  reports transport health, but it does not exist before sync attaches, and
  the boot gate's question (is this replica stamped) is a fact of the STORE's
  durable record, not of any socket.
