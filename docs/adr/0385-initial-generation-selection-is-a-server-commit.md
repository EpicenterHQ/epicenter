# 0385. Initial generation selection is a server commit

- **Status:** Proposed
- **Date:** 2026-09-09
- **Unbuilt:** Coordinated integration with the concurrent current-generation design, the proposed ingress bound, and complete runtime/client verification.

## Context

This proposal is paused at the overlap with the current-generation execution
plan. Its history model has not been selected over that competing design.

Two devices can both list an empty library, import separate seeds, and cache
different generation numbers. A browser lock cannot coordinate independent
devices. Explicit imports must still be able to create distinct history.

## Decision

Use a separate initial-generation operation. The library/data ledger atomically
records one immutable initial selection: its existing selection, the newest
admitted historical generation, or a newly reserved monotonic number. Failed
import reservations remain gaps.

The authority initializes that number's snapshot only if absent. Retries confirm
the existing snapshot without overwriting it. The coordinator admits the number
only after durable snapshot storage succeeds. Bootstrap and socket admission
both check the ledger before forwarding to the authority.

An uncached client lists admitted history first. An empty list invokes the
initial operation; a failed list remains an error. The client fetches the
selected generation's canonical snapshot before writing its cache. Its submitted
seed is not evidence of which bytes won. Existing caches still open offline.

## Consequences

Reservation, snapshot storage, and admission can be retried across failures
without leases or a designated initializer. Explicit imports continue to create
new history and do not replace the initial selection.

Initial seeds and imports share a 32 MiB ingress bound, checked while reading the
body. This bounds whole-snapshot buffering on the Worker runtime. An oversized
or empty payload publishes no generation; a reserved number may remain a gap.

## Considered alternatives

- Client-side locks: coordinate tabs in one browser but cannot prevent the
  reproduced cross-device fork.
- Reuse import POST for first opening: every request allocates a different number.
- Cache the caller's seed under the returned number: losing callers retain bytes
  the server never selected.
- Permit sockets before admission: exposes an authority whose seed has not been
  durably published and allows writes to interfere with initialization.
