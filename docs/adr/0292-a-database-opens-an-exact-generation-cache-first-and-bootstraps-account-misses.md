# 0292. A database opens an exact generation cache-first and bootstraps account misses

- **Status:** Accepted
- **Date:** 2026-08-29
- **Amended by:** [ADR-0417](0417-a-data-address-holds-one-document.md) removes current-data generation identity while retaining cache-first opening, complete bootstrap, and historical-data refusal.
- **Amended by:** [ADR-0407](0407-app-owns-the-declaration-and-data-engine.md) at the client opener: current App acquisition replaces exact numbered-cache opening. Existing historical bytes and the server refusal of fresh current Personal initialization over admitted history remain. The implementation account below records the earlier protocol, not a current client API.
- **Amends:** [ADR-0285](0285-a-generation-is-a-url-parameter-and-a-device-stores-no-selection.md) at the opener's cache and bootstrap behavior; the URL remains the generation selector.
- **Supersedes:** [ADR-0278](0278-a-replica-syncs-the-application-document-and-fetches-row-documents-on-demand.md) entirely.
- **Relates:** [ADR-0261](0261-a-local-account-replica-is-addressed-by-its-application-server-url-and-verified-principal.md), [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md), [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md)
- **Unbuilt:** none of the opener. `openDatabase`, the generation address, the
  cache-hit-is-state rule, the bootstrap `GET` and the retirement of the
  document identity stamp are all built. One addition the record did not name:
  the bootstrap response carries the log position in an
  `epicenter-log-position` header, without which a device would seed a cursor
  of zero and be handed the same state again over the socket.

## Context

A generation is an exact database address, not a value the opener should
discover or silently replace with the latest one. The page already carries the
number in its URL, and a device holding a retained copy should not wait for a
server to use it. A device that does not hold an account generation needs one
complete initial state before the database is usable; opening an empty account
database would show a false state.

## Decision

**`openDatabase` requires an exact generation and opens it cache-first.**

```ts
type Account = { baseURL: string; principalId: PrincipalId }
type OpenDatabaseOptions = { generation: number; account?: Account }

openDatabase(definition, options): Promise<Result<Database, OpenDatabaseError>>
```

One opener, not two. The returned store's `sync` is `undefined` without an
account and a `SyncCapability` with one, which is the discriminant the store
types already carry.

The generation is validated inline, at the boundary, like any other bad input:
`Number.isSafeInteger(n) && n >= 1`, refused as `Unaddressable`. A route that
parses `NaN` out of a URL segment gets that answer, not `GenerationNotFound`.

The address is derived synchronously and keeps the storage format epoch, which
is what lets the record shape change by stranding rather than migrating:

```txt
epicenter/v4/<appId>/<dataId>/<n>
```

The epoch has moved three times since this was written, which is the mechanism
working rather than drifting: ADR-0295 changed the record's shape to reach
`v2`, ADR-0301 changed what a NULL position means to reach `v3`, and ADR-0324
took the server and the principal out of the name to reach `v4`. What this
record decided, that the generation is the last segment and an address rather
than an instruction to allocate, is unchanged by all three. The current value
lives in `packages/app/src/data/store/browser.ts`; this record owns the scheme, not
the number and not the segments above it.

Enumeration parses the number rather than sorting it, because `9` sorts above
`10`. The percent-encoding this paragraph used to describe went with the
segments: nothing in the name contains a `://` any more.

The sequence:

1. Open the exact address and read what is there.
2. **A cache hit is the presence of the database's Yjs state, not the presence
   of the name.** `openDB` on a missing name *creates* it, so a name-existence
   test would fabricate the empty database it was asked about, and a later open
   would read that shell as a hit. The test is whether the record holds state.
3. On a hit: hydrate, return, and attach the socket in the background when an
   account was supplied.
4. On a miss with no account: `GenerationNotFound`. Opening never invents a
   local generation.
5. On a miss with an account: request the generation's state from the authority,
   write it in one transaction, hydrate, and only then return.
6. After either path, attach the WebSocket. A cached database stays usable when
   that connection fails.

```txt
GET /api/data/v1/<dataId>/generations/<n>

200 application/octet-stream   the generation's stored bytes, served verbatim
404                            never created
401 / 403                      not yours, or no longer signed in
5xx                            unavailable; retry, not "not found"
```

The payload is one Yjs document's state (ADR-0295). There is no envelope, no
addressed sections, and nothing to reassemble. Because it is stored whole, it is
served verbatim rather than re-encoded.

**The ordinary first run never touches this endpoint.** A device that created a
generation by importing a folder already holds its bytes and wrote them locally
(ADR-0293). The bootstrap GET exists for a *second* device opening a generation
someone else created.

`openDatabase` resolves once the local state is durable enough to hydrate. It
does not wait for a WebSocket round trip. Generation discovery stays a separate
operation; a route may resolve or redirect to a number, but the opener opens the
number it is given.

## Consequences

- The cached path is fully offline. Local IndexedDB, hydration, and background
  synchronization are independent of network availability.
- A fresh account generation cannot render empty while its state is missing. It
  bootstraps completely or fails as unavailable.
- A failed bootstrap leaves no half-written database, because the state is
  decoded fully before a single write and applied in one transaction.
- The exact-generation address is the identity, so the document identity stamp,
  supersession, `discard`, and the two-moment "open, then bound" boot gate all
  stop existing. A cache hit is bound because a generation only exists if it was
  created complete.
- A generation number in a URL is an address, not an instruction to allocate.

## Considered alternatives

- **Check the authority before every open.** Refused. It makes a retained copy
  depend on the network and adds a round trip to the common path.
- **Open an empty local database on a cache miss.** Refused. An arbitrary URL
  would become a real empty generation.
- **Two openers, local and account.** Refused. The stores differ by one key,
  which is already the discriminant, and the second half of each opener is the
  same address, claim, and hydrate.
- **Fetch an index first and rows on demand.** Superseded with ADR-0278. There
  are no row documents to fetch.
