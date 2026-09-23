# The store

Orientation, not a design record. The decisions and their reasoning live in
`docs/adr/`; this is the page that makes any single function here readable
without first finding the four ADRs it assumes.

## The model

The live `Y.Doc` accepts edits immediately. Its persistence controller queues
updates, confirms durable bytes, and makes those bytes available to sync.
The authority numbers opaque submissions. Durable rows record both the document
bytes and whether delivery is still owed.

```txt
local edit -> live Y.Doc -> updateV2 -> persistence queue
                                           |
                                    atomic durable batch
                                           |
                                      onSendable
                                           |
                                    byte-blind authority
                                           |
remote apply <- received bytes and position <- numbered entry
```

Browser replicas store their update chain in IndexedDB. The SQLite port follows
the same contract in tests and runtime probes. The authority stores its own log
and client-provided snapshots in SQLite.

A storage failure cannot undo an accepted edit. It retains the failed batch in
memory and reports `blocked`. The sender reads confirmed durable debt, so an edit
whose append failed stays local until persistence recovers. A network connection
cannot rescue those unpersisted bytes. Closing while still blocked can lose them.

`pending` covers the entire outstanding storage operation, which may take longer
than a microtask. `saved` means the local queue is empty, independently of remote
acknowledgement. The app's persistence notice shows `blocked` and offers `flush()`
as a retry.

## The one column you have to understand

Almost every query in this directory turns on `authoritySeq`, and it is
three-valued in a nullable integer. Read this table once and the rest of the
subsystem reads plainly.

| Value | Meaning | Who writes it |
| --- | --- | --- |
| `NULL` | **owed.** This device authored these bytes and the authority has never seen them. | a replica's own appends |
| `0` (`NO_AUTHORITY`) | **held, never owed.** Real bytes with no position, and none is coming. | a local store's own appends; received bytes whose position is unknown; a fold baseline |
| `>= 1` | the position the authority's log gave these bytes | an acknowledgement or received entry |

The authority starts numbering at `1`; `0` cannot identify an authority entry
(`sync/authority.ts`).

The distinction that carries the design is **`NULL` against everything else**,
because that is the one the sender reads. A local store records `NO_AUTHORITY`
rather than `NULL` precisely so that `NULL` means owed on every store kind,
which is what let the fold stop asking what kind of store it is (ADR-0301).

## Three facts are derived, never stored

```txt
   outbox   =  the rows WHERE authoritySeq IS NULL
   cursor   =  MAX(authoritySeq)
   lastId   =  MAX(id)
```

There is no outbox table and no cursor row, and that absence is load-bearing
rather than tidy. A stored cursor can commit in a transaction that its bytes
did not, and a cursor ahead of its bytes skips replay permanently and
invisibly. A derived cursor cannot express that state: it can only lag, and
lagging is free because an update is idempotent (ADR-0298).

The same argument covers the outbox. A separate relation can disagree with the
log; a column cannot disagree with itself.

## The acknowledgement is one write doing three jobs

When the authority accepts a submission and files it at position 502, one
`UPDATE` stamps `502` onto every owed row the submission covered. That single
act:

```txt
   1. empties the outbox      the rows stop matching `IS NULL`
   2. advances the cursor     MAX(authoritySeq) is now 502
   3. permits the fold        stamped rows may be collapsed
```

Those were three separate mechanisms once. They are one because they were
always one fact reported three times: *these bytes reached that log entry.*

Without acknowledgements nothing is lost, but this device re-uploads every edit
forever, re-downloads the whole history on every reconnect, and never shrinks
its log.

A received acknowledgement also suppresses resend in the current session while
its durable write is pending. That in-memory floor disappears on restart. If the
acknowledgement never reached disk, reopening recovers the owed rows and safely
resends them. The durable cursor advances only with the committed record.

## The fold chooses by row, never by store

```txt
   authoritySeq IS NOT NULL  ──▶  replay into a fresh document, re-encode whole
                                  the strongest compaction available, and the
                                  only one that realizes `gc: true`

   authoritySeq IS NULL      ──▶  merge with `mergeUpdatesV2`
                                  preserves a resendable delta; a whole
                                  document is not something the authority
                                  could be offered
```

Owed rows collapse after the outstanding batch finishes, above both the live
acknowledgement floor and `lastCoalescedId`, the highest id the sender has ever
been handed. A row above that watermark has never been named by any
submission, so no acknowledgement in flight can name it. Offline, `coalesce` is
never called, so every append qualifies and a device with no connection stays
bounded by the threshold rather than by how long it stayed offline.

**The merged row takes a new id above every id it replaces, and this is the
safety argument rather than a detail.** An acknowledgement stamps
`id <= throughId`. A merged row inheriting the lowest id it replaced would be
stamped by an acknowledgement for a submission that did not carry all of its
bytes, marking unsent work as sent and losing it in silence. Above the range,
no earlier acknowledgement can name it, so a merge that races a submission
costs a redelivery the authority absorbs. `port-conformance.test.ts` pins this
against both ports; if you are tempted to reuse the low id, that test is why
you should not.

`@epicenter/app/data` exposes `openData(definition, sqlite)` for callers that
own SQLite. Its disposal closes the document and flushes persistence, leaving
the supplied connection open. The Bun-only `/memory` helper owns its fresh
connection, or borrows a reusable `MemoryRecord`. Public `/store` exports types;
resource composition stays inside the implementation.

## What each file owns

| File | Owns |
| --- | --- |
| `store.ts` | the live document, the typed surface, and the client half of sync |
| `persistence.ts` | IDs, the ordered queue, durable mirror, debt merging, and send eligibility |
| `log.ts` | the SQLite `DurablePort`, the fold, and `replay` |
| `browser.ts` | App-owned current-library acquisition and IndexedDB backing |
| `document.ts` | the Yjs grammar: table roots, rows, body nodes |
| `persist.ts` | asking the browser not to evict this origin |
| `flush-on-hide.ts` | getting the queue onto disk before the page goes away |
| `claims.ts` | one writer per address across tabs |
| `port-conformance.test.ts` | holding the two ports to one contract |

Two hand-written implementations of one `DurablePort` exist, and only the
IndexedDB one ships to a person's device. They are kept honest by one suite
driving both through identical `DurableOp[]`; before that suite existed they
stayed green while disagreeing about the fold.

## What happens when things break

```txt
   persistence fails, network fine   the edit is live but cannot be sent yet.
                                     restart can lose it. status: blocked

   persistence fine, network down    the edit is durable and owed. it goes out
                                     on reconnect

   both fail, then the process dies  the edit may be lost. this is the priced
                                     boundary (ADR-0300), not an oversight

   a batch is refused                it returns to the FRONT of the queue.
                                     nothing behind it may commit first, which
                                     is what stops the record growing a hole
                                     that the derived cursor would then lie about
```

That last one is the cheapest guard here and the one worth defending hardest: a
hole in the durable record is silent, permanent, and invisible to both devices.

## Measurements, not intuition

`evidence/browser/port-cost` drives the real IndexedDB port per operation, and
`evidence/browser/write-cost` compares write shapes. Reasoning about this
subsystem from a model rather than from those harnesses produced the wrong
answer three times: whole-document replacement looked free, raising
`SNAPSHOT_FOLD_THRESHOLD` looked like a win, and the state-vector watermark
looked cheaper than the id-outbox. All three were wrong, and measuring said so
in minutes. Run them before changing a threshold or a write shape.
