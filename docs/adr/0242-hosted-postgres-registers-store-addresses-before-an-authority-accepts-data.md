# 0242. Hosted Postgres registers store addresses before an authority accepts data

- **Status:** Proposed
- **Date:** 2026-08-14
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md)
  at authority lifecycle. Its name remains
  `principals/<principalId>/stores/<namespace>` and its opaque data contract is
  unchanged; this record adds the hosted address book and hard-deletion fence
  that the open namespace set requires.
- **Relates:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md)
  (the host still owns no application data), [ADR-0076](0076-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md)
  (Postgres is hosted-only).
<!-- doc-path-check: ignore-next-line -->
- **Implementation:** Hosted store address book (`specs/20260814T170000-hosted-store-address-book.md`, deleted; recover via `git log --all --full-history`).

## Context

ADR-0225 gives every `(principal, application namespace)` its own opaque
`StoreAuthority`. That is the right authority shape for an application, but an
account may open an unbounded set of third-party namespaces. Cloudflare can
address one object by its deterministic name; it cannot answer "which store
authorities belong to this account?".

The old one-authority-per-account design made hard account deletion one
`deleteAll()` call. Replacing it with one authority per namespace without an
address book changes deletion from "erase the hosted copy" to "revoke access
and retain whatever cannot be enumerated." That is not the account-deletion
promise.

## Decision

**Hosted Postgres owns the complete address book of an account's store
authorities, and no authority may accept application bytes before its address
is durably registered.** One row records a principal, a namespace, and only
lifecycle metadata needed to create, fence, enumerate, and remove that address.
It never records a workspace row, document, update, snapshot, schema, or
derived application fact.

The authenticated store boundary creates the address-book row before it reaches
the named Durable Object. The row is idempotent for a repeated open. A failed
registration therefore leaves no accepted authority data; an empty registered
address is harmless and remains discoverable for deletion.

**Hosted account deletion is hard deletion of the hosted replica.** It first
installs a durable deletion fence that denies new store admission for that
principal. It then enumerates every registered namespace and seals each
corresponding authority: clear its application bytes with
`ctx.storage.deleteAll()`, close live sockets, and retain only enough
non-content deletion state to refuse an upgrade that raced the fence. Only then
does it remove address-book rows and the auth account. A failure is retryable:
the fence and remaining rows continue to name every store that still needs
erasure. This deletes only hosted copies. A user's local replicas remain local
data and are never remotely erased.

The self-hosted instance has one literal `instance` partition and no hosted
account lifecycle, so it neither composes this Postgres registry nor exposes
per-account deletion.

## Consequences

- The hosted control plane owns address metadata, not application content. It
  can truthfully locate and erase every hosted authority for an account without
  parsing one byte of workspace data.
- Sync admission now has one additional durable prerequisite. That cost is
  intentional: a namespace that cannot be found later must not be allowed to
  become a cloud replica now.
- `storage_observation` remains storage measurement and allowance evidence. It
  is not reused as the address book: measurement can be stale or absent, while
  deletion enumeration cannot be.
- The deletion route must distinguish a retryable incomplete deletion from a
  completed one. It may not remove the fence or address rows merely because the
  auth row was deleted.
- A WebSocket is authenticated only at upgrade. The Postgres fence therefore
  cannot be the only deletion guard: the authority's seal closes an already
  open socket and refuses an in-flight upgrade after its user bytes are gone.

## Considered alternatives

- **Derive a fixed namespace list in code.** Rejected. It works only for a
  closed first-party application set and fails the open-ecosystem premise.
- **Let Durable Objects be discovered by prefix.** Rejected. The object naming
  API addresses an object; it is not an account-level enumeration index.
- **Store workspace contents in Postgres.** Rejected. That would recreate the
  host-owned application data plane ADR-0226 deletes.
