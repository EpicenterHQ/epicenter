# 0236. Remote Super Chat attach is deferred until the complete product exists

- **Status:** Accepted
- **Date:** 2026-08-10
- **Supersedes:** ADR-0115

## Context

ADR-0115 defined an endpoint-addressed relay before Epicenter has a complete
remote Super Chat experience. Keeping its transport, pairing grants, host
directory, cloud Durable Object, client adapter, and smoke harness would make a
large unfinished product surface look supported. It also consumes a separate
Cloudflare Durable Object class just as the hosted storage authority is being
reset to a single, intentional class.

## Decision

Defer remote Super Chat attach completely. Delete its AttachRelay implementation
and every route, binding, migration, grant, directory, client adapter, and
development harness that exists only for it. The deletion is recorded in commit
[`19b9ee6a73`](../../commit/19b9ee6a735f6b843fd09bcf5fbee2767a905792)
(`delete(server): defer remote Super Chat attach`); restore from that commit only
when a new ADR names the complete user-facing experience it serves.

The hosted API Worker starts fresh with `StoreAuthority` as its only Durable
Object class. Recreating the remote Super Chat experience later is a new product
decision, not an inactive compatibility path in the storage authority.

## Consequences

- There is no `/attach`, `/attach/grants`, or `/attach/hosts` route in either
  deployment, and no remote phone-to-desktop Super Chat transport.
- The API configuration can be deployed only after the planned deletion and
  recreation of the existing Cloudflare Worker and its Durable Object state.
- Git preserves the exact deleted implementation for deliberate recovery, but
  no dormant code, migration, or binding remains in the running product.
- A future remote experience must earn a new ADR and implementation rather than
  implicitly reviving the previous relay.

## Considered alternatives

- **Keep AttachRelay dormant.** Rejected. An unmounted route still carries
  migration, binding, test, and maintenance obligations while providing no user
  value.
- **Preserve only the Durable Object for a future feature.** Rejected. The store
  authority and remote Super Chat have unrelated ownership and lifecycle needs.
