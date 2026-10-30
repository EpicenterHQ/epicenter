# 0225. A store authority is one Durable Object per principal and application, and being signed in is the sharing model

- **Status:** Accepted
- **Date:** 2026-08-08
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Relates:** [ADR-0220](0220-the-authority-keeps-a-snapshot-and-a-tail-and-a-deletion-becomes-real.md)
  (what the authority holds),
  [ADR-0218](0218-the-authority-reads-nothing-and-a-poison-entry-is-repaired-rather-than-prevented.md)
  (it reads nothing),
  [ADR-0222](0222-a-host-owns-how-to-make-a-socket-and-the-library-owns-everything-done-with-one.md)
  (the client half),
  [ADR-0092](0092-identity-is-the-partition.md) (identity is the partition),
  [ADR-0095](0095-websocket-room-auth-uses-route-owned-subprotocol-bearers.md)
  (the upgrade credential).
- **Amended by:** [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md).
  The authority owns the workspace's current opaque document ID. A connection
  declares that ID as well as its cursor and is admitted only on equality.
- **Amended by:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) at the Durable Object name. An authority is a succession of generations, so the name gains a `generations/<n>` segment and the bare name becomes a small object holding which one is current. `stores` becomes `data`.
- **Amended by:** [ADR-0242](0242-hosted-postgres-registers-store-addresses-before-an-authority-accepts-data.md)
  (**Proposed**) at lifecycle only. An open hosted ecosystem needs an account's
  complete authority address book for hard account deletion; Postgres records
  `(principal, namespace)` metadata and never workspace contents.
<!-- doc-path-check: ignore-next-line -->
- Evidence: `packages/server/workers/e2e.test.ts`.

## Context

The transport was settled, evidenced and deployed, and had no endpoint outside a
throwaway lab. `apps/api` bound `EPICENTER_SYNC`, but that is the SUPERSEDED
stack's authority speaking `exchange` / `publishDocument` / `pullDocument`.
Nothing there spoke the new transport, so no application could sync however its
client was wired.

## Decision

**One Durable Object per (principal, application namespace), named
`principals/<principalId>/stores/<namespace>`.**

Per application rather than per principal, because ADR-0215 makes an application
ONE document and the authority's log is that document's; two applications
sharing a log would interleave positions neither could read past.

**The principal comes from the resolved bearer, and the object is addressed by
it.** That single fact is the whole of the authorization. A client supplies a
namespace, cursor, and opaque current-document ID. The ID never selects another
partition: the resolved bearer and namespace do that. The isolation is structural rather than
checked.

**Being signed in on two devices IS the sharing model.** There is nothing to
pair, invite, approve or enumerate: both devices resolve to one principal, both
address one authority, and they converge. A device that was never connected
while any of it happened catches up from the log when it first dials, which is
the same catch-up a returning device runs.

**The upgrade carries the same credential every other Epicenter surface uses.**
A WebSocket upgrade cannot set `Authorization`, so it arrives as a single
`bearer.<token>` subprotocol and the 101 echoes only the main one, so the token
never round-trips (ADR-0095). Honeycrisp reaches this through
`auth.openWebSocket`, which already existed for exactly this handshake.

**The route contract lives in `@epicenter/sync`.** Both halves need it and only
one of them is a server: a browser replica builds the same URL, and a page has
no business importing Hono to learn what path to ask for.

## Consequences

An application's whole share of sync is a URL, which is what ADR-0222 was for.

The authority still reads nothing. Nothing in the Durable Object imports Yjs or
a lens, and there is no verb here that could; what it stores is opaque and what
it enforces is who is asking.

Two claims are now separable, and worth keeping separate. That the ENDPOINT
carries a note between two devices with its prose, in both directions, with
catch-up on arrival, is proved in real `workerd` against the deployed route and
the deployed Durable Object. That HONEYCRISP does it between two signed-in
browsers is not proved here: it needs a running hosted API, which needs secrets,
and that is an environment gate rather than a design question.

The control that gives the isolation test meaning is that a device on another
principal sees nothing, and it is load-bearing rather than decorative: removing
the principal from the Durable Object name makes it fail. That was checked, not
assumed.

The wrangler migration is purely additive: a new class, nothing deleted or
renamed, which is the only kind of Durable Object migration worth adding without
a deploy rehearsal.
