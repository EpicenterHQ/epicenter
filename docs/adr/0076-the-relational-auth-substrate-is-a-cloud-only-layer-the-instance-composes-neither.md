# 0076. The relational-auth substrate (Better Auth + Postgres) is a Cloud-only layer; the instance composes neither

- **Status:** Accepted
- **Date:** 2026-06-27
- **Amended by:** [ADR-0375](0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md) at the prohibition on self-hosted session infrastructure; named-user self-hosted sign-in requires session infrastructure, while its database and provider remain undecided and deployment-owned composition remains.
- **Relates:** [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) (the instance is one pinned partition behind one operator bearer; this is its server-substrate consequence), [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md) (the db handle is a per-concern injected seam; this makes that seam optional so a deployment can decline it), [ADR-0092](0092-identity-is-the-partition.md) (the instance still composes no Better Auth; its bearer resolver returns the `instance` principal)

## Context

ADR-0075 made the self-hosted instance one pinned `owners/instance` partition behind one operator bearer, with no OAuth and no sessions. The shared server library did not follow: `createServerApp` still constructed Better Auth (a Postgres-backed `c.var.auth`) on every request, and the rooms route still wrote a fire-and-forget upsert into the `durableObjectInstance` table. So the instance composed a full relational-auth substrate (Better Auth plus a Postgres pool plus `BETTER_AUTH_SECRET`) that none of its bearer-only request paths read. The `durableObjectInstance` table is write-only across the entire repo (zero SELECTs; billing reads Autumn balances, not this table), so once the instance stops the telemetry upsert and stops constructing Better Auth, it has zero Postgres consumers.

## Decision

The relational-auth substrate is a Cloud-only layer; the instance composes neither Better Auth nor Postgres.

1. **Better Auth moves out of the shared core into `mountCloudAuth`,** which the hosted cloud calls once after `createServerApp`. It installs the per-request `c.var.auth` instance and the `authApp` surface (sign-in, consent, OAuth metadata). `createServerApp` wires only the portable core (the auth origin and trust set, CORS, the cookie-CSRF gate, the rooms registry, and the injected `resolveUser`), and `resolveUser` is required: the OAuth bearer resolver reads `c.var.auth`, which only the cloud has.
2. **The db lifecycle middleware installs only when the runtime provides `connectDb`.** The `RuntimeAdapter` db legs (`connectDb` and `afterResponse`) are optional; `bun()` and `cloudflare()` omit them when no db handle or Hyperdrive binding is passed. `resolveRooms` is the one leg every deployment provides.
3. **Room telemetry is removed, not injected.** The branch first made the `durableObjectInstance` upsert an injected `RoomAccessRecorder` the cloud passed to `mountRoomsApp` and the instance omitted. That seam then proved to exist only to feed a write-only table, so the table and the seam were both deleted: the rooms route now records nothing and reads neither `c.var.db` nor `c.var.afterResponseQueue` on any deployment (see Consequences).

The instance therefore composes only the rooms registry and the bearer surfaces (session, rooms, inference). It runs identically on Bun and Cloudflare with no database.

## Consequences

- **The instance drops Postgres entirely:** no `pg.Pool`, no `DATABASE_URL`, no Hyperdrive binding, no `pg`/`@types/pg` dependency. `BETTER_AUTH_SECRET` becomes register-when-present in `ServerBindings` (the same precedent as the OAuth secrets, ADR-0071): the cloud carries it as a deploy-gated Worker secret and the instance never reads it. `createAuth` fails closed on an empty or missing secret at the one place it reaches Better Auth, so the guarantee is runtime (covering the Worker, which has no boot phase, not just the Bun entry's boot validation): with `secret: undefined` Better Auth would fall back to a public default and only reject it under `NODE_ENV=production`, which Workers do not set.
- **The two Bun entries diverge honestly.** The hosted cloud's Bun entry (apps/api/server.ts) composes its bootstrap inline (it builds `mountCloudAuth` and cookie-or-bearer sessions over a `pg.Pool`); the instance Bun entry composes its thin bearer-only surface inline too. Both share only a small product-blind serve helper, never a mode knob, which is the same "false unification" warning ADR-0066 and ADR-0075 carry.
- **The pure instance-token primitives move to `@epicenter/auth`** (`generateInstanceToken`, `assertStrongToken`): a token can be minted and validated without the server graph, which is what lets a future `epicenter gen-token` live in the CLI. `assertStrongToken` runs the entropy gate on both runtimes (the Bun entry at boot, the Cloudflare instance per request, since a Worker has no boot phase), so a weak token fails closed everywhere.
- **The write-only `durableObjectInstance` table is deleted repo-wide.** It had zero readers (one rooms-route upsert, one account-delete cleanup, no SELECTs), so the injected `RoomAccessRecorder` seam existed only to keep feeding it. Deleting the table collapses the seam with it: the rooms route now records nothing and reads neither `c.var.db` nor `c.var.afterResponseQueue` on any deployment. The cloud keeps the db lifecycle and after-response queue for Better Auth sessions and the Autumn billing charge; only the telemetry producer is gone. (This adopts what the Considered alternative below first deferred; it landed on the same branch via a `DROP TABLE` migration.)

## Considered alternatives

- **Keep one `createServerApp` god-factory and give the instance a no-op `connectDb`.** Rejected: a stub `c.var.db` is a lie the type system would carry everywhere, and the instance would still construct Better Auth. Declining the leg entirely (optional `connectDb`, no db middleware) is honest.
- **Delete the write-only `durableObjectInstance` table repo-wide.** First deferred (it touches the schema and the Better Auth account-delete hook), then adopted on the same branch once the recorder seam proved to exist only to feed a sink with no readers. It landed as its own commit with a `DROP TABLE` migration after the auth-substrate split, so the two concerns stayed unentangled.
