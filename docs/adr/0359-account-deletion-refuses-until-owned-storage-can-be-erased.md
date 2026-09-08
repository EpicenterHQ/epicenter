# 0359. Account deletion refuses until owned storage can be erased

- **Status:** Proposed
- **Date:** 2026-09-08
- **Unbuilt:** Durable deletion progress, complete historical inventory, mutation fencing, socket retirement, and external-service recovery.

## Context

The hosted deletion route ran blobs, billing, observations, and auth-user steps
in order, then reported `204`. It omitted store authorities and generation
ledgers. Auth deletion also left verification records, already-authorized
requests, live sockets, and presigned uploads outside its deletion boundary.
Ordering tests established none of their erasure guarantees.

The store transport admits arbitrary data IDs and socket generation numbers.
Cloudflare object IDs cannot recover the names needed to attribute all existing
objects to accounts. Adding future allocation registration would leave historical
storage outside the promise. The [storage map](../../apps/api/worker/account/README.md)
records the allocation paths, evidence, and exact missing decision.

## Decision

Refuse hosted account deletion before destructive work until it can establish
complete owned-storage discovery, retirement of writes, and durable recovery.
The endpoint preserves its fresh-session and principal-binding checks, then
returns `503 ACCOUNT_DELETION_UNAVAILABLE`. It accepts no deletion job. The UI
disables the action and makes no claim that an account has been erased.

One hosted lifecycle owner must eventually hold both the storage inventory and
deletion progress independently of the Better Auth user. Better Auth keeps
authentication; storage and billing keep their own mechanics. The lifecycle
owner must register allocation before storage is addressed, prevent late writes
at their commit boundaries, and retry after the user's credentials are gone.

Keep hosted account lifecycle in `apps/api/worker/account`. Self-host entry points
do not mount it, receive its bindings, or supply a no-op implementation. Shared
storage code owns resource retirement and erasure only where a real consumer
needs those operations. It carries no hosted-mode or deletion-enabled flag.
The single `instance` principal is shared data, so its bearer grants no account
deletion or whole-instance reset surface. Operator erasure is a separate concern
and is not a feature being implemented by this decision.

Hosted erasure excludes client-device copies. A future completion response must
name any retained tombstone and external-provider retention instead of claiming
deletion everywhere.

## Consequences

People temporarily cannot delete an account through this endpoint. This removes
a path that destroyed authentication without completing its stated task.
Historical ownership needs an explicit evidence-backed disposition before the
workflow can promise completion. No namespace purge or production change is
authorized by this record.

## Considered alternatives

- Add `deleteStore()` to the sequence: cannot enumerate historical storage or
  prevent a delayed seed or live socket from recreating data.
- Sweep admitted generations of known applications: misses failed imports,
  arbitrary data IDs, socket-only generations, and retired address layouts.
- Register future allocations and report success for existing accounts: claims
  completeness without accounting for historical storage.
- Keep auth until the final step and ask people to retry: crashes and eventual
  session revocation can strand progress; already-authorized work remains live.
