# 0336. An authority mints every generation, so every store has an account

- **Status:** Accepted
- **Date:** 2026-09-02
- **Supersedes:** [ADR-0233](0233-a-browser-application-keeps-a-device-document-and-one-account-replica-per-account.md) (the device document, the retained replica, and the sign-out rule) and [ADR-0279](0279-an-application-has-two-databases-and-copying-a-row-is-the-verb.md) (two databases and the copy between them, which has nothing left to copy between)
- **Amends:** [ADR-0324](0324-a-database-address-is-its-data-id-and-generation-and-the-definition-declares-its-authority.md) by withdrawing the `authority` field and the two-data-ids section; [ADR-0293](0293-a-generation-is-created-by-importing-a-folder-and-the-ledger-row-is-its-existence.md) at "the device assigns it without"; [ADR-0262](0262-the-desktop-host-owns-one-active-connection-and-no-connection-registry.md) at "local data survives sign-out"

- **Amended by:** [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at account-required storage: local sessions mint local generations; account generations remain authority-owned.

## Context

Two store kinds existed. A device store recorded `NO_AUTHORITY`
(`packages/data/src/store/log.ts`) on its own appends, so it owed nobody and
`fold` compacted everything it held. An account store recorded NULL, which means
owed, and `fold` skips owed rows. The constant survives, as the fold's baseline
for bytes that arrived from elsewhere. One difference in one column, and above
it:
two constructors, a `replication: 'none' | 'remote'` discriminant branching four
times through the engine, two address grammars (`local/gen/` beside
`account/<base URL>/<principal id>/gen/`), an `openDatabase` overload on an
optional `account`, and six type names for what is nearly one thing.

Honeycrisp shipped both, as `/device` and `/account`: two notebooks a person
navigated between, with two openers, two gates, and two failure surfaces.

The device store existed so that a database could have no server, ever. The
reason anyone wanted that was a person using an application before signing in.

## Decision

**An authority mints every generation, so every store has an account.**

A person signs in before anything else; that is the first run. There is one
store kind and one address (`packages/data/src/store/browser.ts`).

```txt
openDatabase(definition, { appId, generation, account })   account is required
createGeneration(definition, { appId, account })           account is required
```

The address that shipped is ADR-0324's `epicenter/v4/<app-id>/<data-id>/<n>`,
not the `epicenter/v3/<data-id>/account/<base URL>/<principal id>/gen/<n>` this
record was drafted against, and `newestGeneration({ appId, dataId })` takes no
account at all. What that changes here is spelling: the account is required to
OPEN a store either way, and ADR-0325's binding is what carries the two facts
the address stopped holding.

**Three type names, and each says one thing.** `DataDocument` carries `sync`,
because every store has it. `Data<T>` is a store with no address, which is what
`createAccountStore` and `openMemory` return. `ReplicaData<T>` is a store that
knows its server, which is what `openDatabase` returns. `LocalDocument`,
`AccountDocument`,
`AddressedDocument`, `LocalData`, `AccountData`, and `BrowserData` are gone.

**A definition declares no authority.** Whether a database has one is a fact
about the person's sign-in state, not a claim a schema makes. ADR-0324 introduced
`authority: 'none' | 'epicenter'` and then defined `'none'` twice, as "no
server, ever" and as "no server yet"; both readings are withdrawn with the
field.

**Permanently device-local state is app-owned SQLite** (ADR-0321). It is not
Epicenter Data with the sync turned off.

**Sign-out closes the replica and deletes nothing.** The generation stays at its
address and reopens on the next sign-in as the same principal. ADR-0262 said
sign-out preserves device and account data; the device half has nothing left to
preserve and the account half is unchanged.

## Consequences

- A person meets a sign-in before they meet the product, once per machine.
  Everything after it is unchanged: writes land locally and immediately, and a
  month offline works.
- A person offline for a month sees every write land at once and loses nothing.
  An append made offline is owed, so `fold` skips it and `mergeOwed` collapses
  the chain at `SNAPSHOT_FOLD_THRESHOLD` instead, bounding it by the threshold
  rather than by how long the device stayed offline. What waited for the
  connection is garbage collection, not durability.
- **ADR-0240, ADR-0243, and ADR-0246 become true again.** ADR-0324's "two
  notebooks are two data ids" had made all three false; Honeycrisp declares one
  definition whose data id is
  its app id, which is what those records say.
- A row removal still costs every device a tombstone in memory on every load,
  forever, until an explicit Rebuild (ADR-0276). Nothing here changes that, which
  is why removal stays a dialog a person confirms.
- Vocab, Whispering, and Skills lose the document they fell back to when signed
  out, so a signed-out person in any of them meets the sign-in gate rather than
  an empty notebook. Skills has no auth client at all, so it opens nothing and
  says so where it used to open a device document.

## Considered alternatives

- **Keep the device store.** Its cost at the surface was two database types
  differing by one member, `syncStatus()`, and one component tree rendering
  both. It lost because the split put "no account" in the kind of database
  rather than in the moment, so a person who signed in could not bring their
  notes with them: the notes were in a different kind of thing.
- **Let a database start unbound and bind on first sign-in.** Rejected. It keeps
  a second minter, needs a reserved address so a device-minted `1` and an
  authority-minted `1` never share one, and its second device has no automatic
  answer: two unbound histories reaching one account is the merge ADR-0325
  refuses.
- **Require the account because an offline replica's log grows forever.** False:
  `mergeOwed` bounds the owed chain at `SNAPSHOT_FOLD_THRESHOLD`. Only the
  product reason survives.
