# 0222. A host owns how to make a socket, and the library owns everything done with one

- **Status:** Accepted
- **Date:** 2026-08-08
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Relates:** [ADR-0220](0220-the-authority-keeps-a-snapshot-and-a-tail-and-a-deletion-becomes-real.md)
  (the transport this drives),
  [ADR-0218](0218-the-authority-reads-nothing-and-a-poison-entry-is-repaired-rather-than-prevented.md)
  (why a stuck replica is repaired rather than prevented),
  [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)
  (the obligation `onLocalWork` announces).
- **Amended by:** [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md).
  Each dial also declares the locally persisted document ID. A pristine client
  performs a bootstrap-only dial, persists the announced ID, then redials
  before it may send or receive live workspace traffic.
- Evidence: `packages/app/src/data/sync/connection.test.ts`,
  `packages/app/evidence/data/workerd/results.md`.

## Context

`createSyncClient` owns no socket, and that is deliberate and worth keeping:
every timing rule in it is testable without a network, which is not a
hypothetical benefit on this branch, where a cursor rule once "worked" in a
simulation that delivered nothing. Socket construction genuinely differs per
host too: a browser origin builds a URL and carries a cookie, a desktop window
carries a bearer, a lab page carries neither.

What was not legitimate is that the rules for DRIVING a socket lived in each
host's own copy of a connect loop. Two of them are correctness:

- **Reconnecting on `needsResync`.** The client refuses an entry that skips a
  position, because applying past a gap makes the loss permanent and silent. It
  then sets a flag and waits for someone to notice, and a randomised schedule
  showed nobody does: a device wedged at position 108 kept receiving 118, 119 and
  121 and rejecting all of them, with no error surfaced and the socket healthy.
- **Nudging after a local write.** The idle timer that coalesces a burst into one
  entry only starts when something says work was authored, so a caller that
  forgot left that work in the outbox until an unrelated write happened to start
  it. Same silent wedge, and one nobody would have found either, because the
  device looks connected and reports no error.

There is also a stall nobody has explained. A sustained run against Cloudflare
stopped waiting for an acknowledgement at messages 85, 105, 461 and 529, with no
exception logged. Four hypotheses were tested; three were real bugs and none was
this, and a dedicated diagnostic drove 6,000 sends across three shapes with no
stall and flat latency, which rules out gradual degradation.

## Decision

**The host supplies a `dial`, and the library owns everything else.** A dial is
handed the position to ask from and three callbacks, and returns a teardown. That
is the whole of what a host writes.

The library owns: the cursor and document ID in every dial, read fresh from what this replica
durably holds; attach on open, feed on message, detach on close; reconnect on
close with backoff; reconnect on `needsResync`, evaluated after every single
delivery rather than on a timer; and a watchdog.

**The watchdog treats a submission that goes unacknowledged past a generous
window as a dead socket and reconnects.** It is the answer to the stall, and it
is deliberately not a diagnosis: the failure becomes self-healing whatever turns
out to cause it, and the cost of being wrong is a reconnect that re-sends bytes
the authority may already hold, which is free because an update is idempotent.

It compares the submission NUMBER across ticks, not the `inFlight` flag. Only one
submission is out at a time and the next starts on the previous acknowledgement,
so under sustained local work the flag is continuously true on a completely
healthy client, and a watchdog reading it would reconnect a working device every
interval. `SyncClientStatus` carries `inFlightSubmission` for exactly this.

**The backoff resets when a socket has stayed up, not when one opens.** A server
that accepts the upgrade and immediately closes, which is what a rejected
credential and an overloaded authority both look like, would otherwise reset the
backoff on every attempt and turn it into a hot loop.

**The store announces its own local work.** `store.onLocalWork` fires once per
commit that added to the outbox, after that commit is durable, and never for
bytes that arrived from a peer. The driver subscribes, so no application calls
`nudge`.

`createSyncClient` is unchanged underneath and stays exported. This is additive:
the driver is a caller of it like any host was.

## Consequences

A host's connect loop is now a URL and four event listeners. The lab's is the
proof rather than the claim.

Correctness rules that used to be per-application are per-library, so an
application cannot omit one, and cannot omit one silently, which is the failure
mode all three of these share.

Reconnecting is now the answer to four different situations, which is a
simplification and also a bet: if a fifth situation wants a different repair, it
will have to argue for one, because there is only one path here on purpose.

The watchdog does not explain the production stall, and the stall is still
unexplained. This ADR claims only that a device no longer stays stuck in it.
