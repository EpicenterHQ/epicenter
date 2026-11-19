# 0187. A bound handle reports staleness; tables can name rows, values cannot

- **Status:** Accepted
- **Date:** 2026-07-28
- **Amended by:** [ADR-0206](0206-a-rows-id-comes-from-whoever-knows-it-and-one-relation-holds-every-fact.md) at one clause, the value half of this record's title. Values are deleted there, so "values cannot" has no subject; the table-invalidation law, its two scopes, and the staleness contract are untouched.
- **Amends:** ADR-0186 by settling the `data` half of what it deferred; and [ADR-0185](0185-trusted-app-http-uses-tauris-standard-transport-without-observation.md) by naming the host-owned data invalidation socket as an Epicenter capability carrier rather than an ordinary HTTP observer
- **Relates:** ADR-0160, [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md), [ADR-0175](0175-table-traversal-is-complete-and-classified-with-paging-kept-private.md), [ADR-0176](0176-lenses-declare-no-query-capabilities-indexed-reads-require-separate-owners.md), ADR-0178

## Context

A bound Lens could read and write, but nothing could tell a surface that what it
had read was no longer true. In-process runtimes had a listener registry; the
browser worker sent one message per changed address; the desktop proxy told only
the surface that had just written, so a second window never heard anything at
all. Three mechanisms, three different promises, and one of them was a lie.

The question that decides the shape is what a handle is allowed to claim. It is
tempting to make one uniform subscription that carries no payload: every change
means "re-read everything reachable here", and there is nothing to get wrong.
That is honest, and it permanently throws away information the replica already
produced. A commit names its addresses; a row has a runtime-minted id; a scan of
ten thousand rows to learn that three moved is work nobody asked for.

The opposite temptation is to always name the changed ids. That is dishonest the
moment an observation carrier drops a frame: a row deleted during the gap leaves
nothing behind to name it with, so "here are the ids that changed" cannot be
completed.

Underneath both is an asymmetry that ADR-0178 already recorded in storage. A row
is a member of a runtime-identified collection with a terminal tombstone; a
value is an author-addressed register that can be set and unset forever. They
are not the same thing, and a single subscription shape has to lie about one of
them.

## Decision

**A bound handle reports when data reachable through it may be stale.** A table
handle can sometimes name the rows; a value handle has no smaller identity to
name.

```ts
export type TableInvalidation =
	| { readonly scope: 'rows'; readonly rowIds: readonly string[] }
	| { readonly scope: 'table' };

TableLens.subscribe(
	listener: (invalidation: TableInvalidation) => void,
): () => void;

ValueLens.subscribe(listener: () => void): () => void;
```

### The laws

1. **Invalidation is a superset.** It may over-report and must never
   under-report.
2. **Registration is synchronous, does no I/O, and never fires initially.**
   Subscribe then read is race-free with nothing to discard.
3. **One invalidation per committed replica notification per logical table.** A
   commit touching sixty-four rows of one table calls a listener once with
   sixty-four ids.
4. **Delivery may duplicate.** Consumers converge idempotently.
5. **A table-scope invalidation supersedes in-flight incremental work.**
6. **A carrier gap heals locally.** On reconnect the client emits table scope to
   every subscribed table and a void invalidation to every subscribed value. The
   wire encodes no reconnect, reset, or scope.
7. **The desktop carrier is established before the opener resolves.** That is
   what buys law 2: there is no window in which a subscription could have been
   installed too late, so no initial fire is needed to cover one.

### The transport

The replica stays the truth owner and emits one `readonly Address[]` per commit.
The browser worker and the Bun host each forward that batch **whole**, as one
frame. One client-side dispatcher groups addresses into per-table row ids and
per-value invalidations, owns the handle-local listener maps, and synthesizes
gap recovery. It is the same module in all three engines, so the laws are
written once rather than three times with three chances to drift.

Desktop surfaces get one authenticated, origin-checked, host-owned WebSocket
each, on a bounded route beside the operations route. Backpressure or a failed
send closes the socket into the reconnect path rather than dropping a frame and
continuing on a carrier that silently skips commits.

A surface is a document, not a binding. One app window may bind several Lenses,
and it still registers one surface and holds one socket: the host broadcasts
every committed address to every surface, so a second socket would carry a
second copy of the same stream and heal its own gaps on its own schedule. The
carrier is opened by the first bind, joined by every later one, and closed when
the last binding releases it; `close()` on one binding releases that binding's
listeners and nothing else.

The local echo is deleted. When the broadcast is authoritative, a writer that
also notified itself would double-fire, and local and remote surfaces would see
the same commit at different times through different code.

### Refused

- **A SQLite subscription registry or SQL triggers.** The replica already knows
  what it committed.
- **A host-side per-table interest registry.** The host does not know which
  Lenses a surface bound, and teaching it would mean registration, retention,
  and two parties agreeing forever. The client already knows.
- **A replay journal, ACK, cursor, or epoch protocol.** Durable replay is a
  second consistency mechanism beside the exchange that already converges facts.
- **Snapshots on the wire, a host-side cache, or a query engine.** ADR-0176
  refuses the query capabilities the last of these would need.
- **Observation of an installed app's ordinary HTTP**, which ADR-0185 already
  refused and this record does not reopen.

## Consequences

- An adapter can be incremental. `fromTable` re-reads the named rows and rescans
  only on table scope or when a point read cannot answer, so a three-row commit
  costs three reads rather than a full scan.
- An ordinary caller may still ignore the payload entirely and rescan. The
  precise path is an optimization the primitive makes possible, never a
  correctness obligation it imposes.
- Two app surfaces bound to the same Lens now see each other's writes. This is
  the first cross-surface liveness promise Epicenter makes for `data`.
- `data` is no longer deferred by ADR-0186. How the client is delivered is
  unchanged; what it can now deliver includes a bound Lens.
- A carrier gap within one host generation self-heals instead of forcing a
  reload. The cost is that a reconnect rescans, which is the price of never
  claiming a deletion did not happen. A full host-process restart invalidates
  the browser session and surface registration, so it still requires a surface
  reload; this transport does not introduce a second bootstrap protocol.
- One more socket per desktop surface, on the same origin, session, and Origin
  check as every other host API. Per surface, not per Lens: an app that declares
  four namespaces still costs the host one registration and one socket.
- **Every trusted surface receives every committed address batch, across every
  namespace, and filters client-side.** This is the direct cost of refusing a
  host interest registry, and it is larger than "two surfaces on one Lens see
  each other's writes". A surface that has bound nothing still receives the
  whole machine's write stream, so both the volume and the namespace metadata it
  carries are global to the host rather than scoped to the app's interest: the
  frame rate scales with total write activity, and the set of namespaces in use
  is enumerable from what arrives. Under the ADR-0179/ADR-0183 full-trust model
  this is a cost, not an exposure, and the refusal above stands. It is recorded
  here so it is not rediscovered as a surprise, and so this record is not cited
  as license for a broadcast where trust is not total.
- **A surface that dies without disconnecting is retained until the host process
  exits.** Membership is added by `open` and removed only by an explicit
  `disconnect`, so a reloaded, crashed, or killed WebView leaves its registration
  and every row document it opened behind. Observation socket loss is the only
  related signal the host receives, but it carries neither surface identity nor
  proof that the surface died, so nothing can attribute it. A retained member
  can issue nothing, which is why this is a leak rather than a correctness
  failure.
  Socket close cannot simply become `disconnect`: a transient carrier gap is
  recoverable under law 6, while disconnect disposes the row documents that
  existing handles still name. Reclamation needs a lease or terminal-death
  protocol that distinguishes those lifetimes. An unload-time `disconnect` is
  not that protocol: `pagehide` does not fire on crash or kill, and a request
  issued during unload is not guaranteed to be sent.

## Considered alternatives

- **A void table subscription.** Rejected: it permanently mandates a full scan
  for every change and discards ids the replica already emitted. Simplicity here
  is paid for on every commit, forever.
- **Bare changed ids with no scope.** Rejected: an observation gap cannot
  enumerate what it missed, and a deleted row leaves nothing to name.
- **`{ kind: 'rows' | 'reset' }`.** Rejected: `reset` names a cause rather than a
  claim, and a cause invites siblings (`resumed`, `migrated`, `reloaded`) that
  every consumer must then branch on.
- **`readonly string[] | 'all'`.** Rejected: both arms are iterable, so
  forgetting to narrow compiles cleanly and then treats `'all'` as the three row
  ids `a`, `l`, `l`.
- **A non-empty tuple type for `rowIds`.** Rejected for the public surface: the
  runtime guarantees non-emptiness, and encoding it in the type charges every
  consumer for a constraint only the producer can violate.
- **Values as one-row tables.** Rejected: rows are runtime-identified members
  with terminal tombstones and document and blob ownership; values are
  author-addressed reversible registers. ADR-0178 already documents the sentinel
  and check complexity that unifying their storage costs.
- **Lens-level observation only.** Rejected: it moves the filtering problem to
  every consumer without removing it.
- **A public `Address[]` stream.** Rejected: it hands applications the raw
  internal vocabulary and makes every consumer reimplement grouping.
- **A platform-owned live cache or pushed snapshots.** Rejected: the platform
  would own memory, eviction, and staleness for data it does not know the shape
  of, and a snapshot on the wire duplicates what a read already answers.
- **Separate coarse and precise `subscribe` methods.** Rejected: two methods for
  one question, and every consumer picks wrong once.
- **A fail-closed desktop carrier.** This was the only clean way to delete table
  scope: if a gap is fatal, no invalidation ever has to describe one. Rejected
  because a transient socket gap within one host generation should heal itself
  rather than make a person reload their app.
