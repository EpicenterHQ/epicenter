# 0384. Self-hosted credential commits own admission and recovery

- **Status:** Proposed
- **Date:** 2026-09-09
- **Unbuilt:** Application Account integration, Worker operator tooling, and complete optional password flows.

## Context

An enrollment grant must authorize one credential for an admitted user. Recovery
must preserve that user while invalidating old credentials, sessions, and pending
user-bound registration ceremonies. Removing the user must also prevent already-started verification from
issuing new access afterward.

The installed Better Auth passkey plugin, version 1.6.23, invokes its registration
hook before a separate passkey insert. The real-handler reproduction in
`packages/server/evidence/enrollment/passkey-hooks.test.ts` shows that an insert
failure leaves a hook-consumed grant spent. Its authentication hook similarly
precedes the counter update and session creation. Hooks alone cannot own these
commits.

## Decision

Give self-hosted authentication one durable owner for users, admission, grants,
ceremonies, credentials, sessions, and application handoffs. Verify WebAuthn
responses before the transaction. Within the transaction, recheck admission,
expiration, the ceremony's user, and the user's authentication revision before
consuming authorization and persisting the credential or session.

Operator-assisted recovery advances the same user's authentication revision and
invalidates old credentials, sessions, grants, and user-bound registration ceremonies atomically when the
operator issues the recovery grant. Recovery does not create a user or restore
removed admission. A verification started under an old revision cannot publish
new access.

Implement this owner in one SQLite-backed Durable Object per Worker deployment.
Bun uses the same domain commits through its SQLite transaction boundary. Keep cryptographic verification in SimpleWebAuthn. Keep the existing
Cloud authentication composition separate; do not manufacture email addresses to
reuse its user schema.

## Consequences

Grant consumption needs no compensating restore operation. Admission and revision
checks at commit time fence work that started before recovery or removal.
Protected requests must still resolve current admission; this decision does not
revoke previously issued external capabilities or erase offline copies.

The production owner implements callback matching, PKCE, state, freshness, and
cookie/bearer boundaries. Real Worker HTTP tests cover enrollment, named
`/api/session` access, handoff redemption, and removal across object eviction.
Both self-host entries mount this owner and the same passkey sign-in page.
Application connection screens still need to adopt the issuer; these server
tests do not establish completed Account or library integration.

## Considered alternatives

- Consume grants and delete old credentials in the passkey verification hook:
  persistence can fail afterward, or removed credentials can finish signing in.
- Restore a grant after an insert error: adds another crash boundary and cannot
  repair a process that exits before compensation.
- Issue an ordinary session to authorize enrollment: exposes application access
  before the replacement credential exists.
- Intercept generic auth-adapter writes using request context: hides the domain
  transaction inside library-specific mutation ordering.
