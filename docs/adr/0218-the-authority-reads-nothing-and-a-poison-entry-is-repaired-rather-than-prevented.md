# 0218. The authority reads nothing, and a poison entry is repaired rather than prevented

- **Status:** Superseded
- **Superseded by:** [ADR-0277](0277-the-authority-reads-the-bytes-and-sync-becomes-the-yjs-protocol.md). The measurements here stand and so does the conclusion they support: a validation FILTER over bytes is not worth 283 MB. What was never weighed is what blindness costs outside this file, and it is the log position, the cursor, the outbox, gap detection, the resync path and the snapshot-offer dance.
- **Restored by:** [ADR-0298](0298-the-authority-is-byte-blind-and-a-cursor-is-a-log-position.md), which re-weighs what blindness costs against one document per database and finds the bill already paid.
- **Date:** 2026-08-07
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0217](0217-the-authority-appends-opaque-bytes-and-the-client-owns-every-merge.md)
  at one mechanism. Withdrawn: the `diffUpdateV2` filter and the sentence that
  the authority "makes exactly one Yjs call". Everything else in 0217 stands,
  including the refusal to compact, the client-owned merge, the ack, the
  chunking, and the absence of state vectors from the transport.
- Evidence: `packages/app/evidence/data/bench/validate.ts`,
  `packages/app/evidence/data/validation.test.ts`,
  `packages/app/src/data/sync/transport.test.ts`.

## Context

ADR-0217 already establishes that the check could never be a proof: whether
bytes throw on a device depends on the structs that device already holds, and
the authority holds none. It kept the strongest documentless filter anyway, on
the grounds that it cost one call and no document and turned accidental
truncation into a retryable refusal.

Two things were missing from that reasoning. The filter's cost had never been
measured, and the question "what happens if a bad entry does get stored" had
never been answered, so a mechanism was being paid for without knowing either
its price or the price of not having it.

## Decision

**The authority makes no Yjs call at all and never reads the bytes it stores.
A poison entry is recovered from, not prevented.**

`packages/app/src/data/sync/authority.ts` has zero Yjs imports, and that is the
invariant to protect rather than an accident of the current implementation.

### What the filter actually cost

One OS process per cell, the answer discarded exactly as the authority discarded
it (`evidence/bench/validate.ts`):

| on a 27.7 MB update | time | rss |
| --- | --- | --- |
| `encodeStateVectorFromUpdateV2` | 18 ms | 77 MB |
| `diffUpdateV2` (the one that shipped) | 45 ms | **283 MB** |
| sha-256 over the bytes | 10 ms | 0.4 MB |
| `applyUpdateV2` into a throwaway `Doc` | 35 ms | 108 MB |

**The filter cost more than building the document it was chosen to avoid
building**, because it decodes the whole stream and re-encodes a full copy
before discarding it. A call that reads as free at the call site was the ceiling
on what one submission costs the object.

### The two costs that were never on the ledger

- **It was the only thing coupling the authority to Yjs's version.** With it
  gone, a Yjs format change cannot make the server refuse a valid client's
  writes. That failure would have been an outage caused by the safety mechanism.
- **It foreclosed end-to-end encryption**, which is possible exactly as long as
  the authority never reads the bytes. Keeping that door open costs nothing
  today and cannot be reopened cheaply once anything server-side depends on
  parsing an update.

### Recovery, which is what made prevention unnecessary

The log is append-only and every entry is individually addressable, so a poison
entry is repaired by overwriting that one row's bytes with the 13-byte empty
update. It is a valid no-op, the sequence stays contiguous, and every replica
walks straight past it.

That repair only works if somebody knows which entry to fix, and they did not:
a replica that could not apply an entry **returned `Ok`, set no error, and left
its cursor still**, so a bricked device was indistinguishable from an idle one.
It now reports `SyncClientError.Unapplyable` naming the position, and the cursor
still does not move, because advancing past a bad entry would trade a visible
stall for permanent invisible loss. Both halves are pinned.

## Consequences

- **Do not add a server-side validity check back.** It cannot be a proof, it is
  the most expensive thing in an append, and it closes the encryption door. If
  the goal is catching corruption in transit or in the chunking code, a
  client-computed checksum stored beside the bytes does it for 0.4 MB, catches
  more, and requires the authority to understand nothing.
- **`evidence/validation.test.ts` is kept although nothing it measures ships.**
  It is the record of why there is no filter, and deleting the measurement would
  leave only an assertion that "surely the server should check this" could
  overturn in an afternoon.
- **The refusal frame stays.** The chunk collector still rejects a submission
  that contradicts its own chunk count or exceeds the buffer limit, and a
  storage failure is still answered out loud, because `workerd` swallows a throw
  in `webSocketMessage` without closing the socket.
- **A numbered claim in a comment now needs a committed bench.** The cost
  figures above were cited to `evidence/bench/validate.ts` before that file
  existed, which a review caught. Cite a script that runs, or do not cite one.
- **What still bounds the damage is partition ownership**, unchanged from
  ADR-0217: only the principal who owns a partition can author bytes that brick
  it.
