# 0092. Identity is the partition

- **Status:** Accepted
- **Date:** 2026-07-02
- **Amended by:** [ADR-0375](0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md) at equating authenticated identity with every data partition: a named user retains their identity while accessing Personal or deployment-shared data, without prescribing replacement identifiers or storage keys.
- **Restated by:** [ADR-0263](0263-a-connection-is-one-server-at-a-time-and-a-replica-is-derived-from-it.md) as the reader-facing Cloud/self-host contract
- **Amends:** [ADR-0067](0067-auth-owns-the-session-endpoint-the-data-client-is-owner-scoped.md), [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md)
- **Relates:** [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md), [ADR-0070](0070-self-host-adds-no-new-ownership-or-auth-mode.md), [ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md), [ADR-0076](0076-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md)

- **Amended by:** [ADR-0426](0426-copies-create-independent-blobs-at-their-destination.md) at blob identity and physical/HTTP addresses. Local blobs use the fixed `device/no-account` path; copies return fresh BlobIds within separately authorized principal/app namespaces. Historical hash-based and row-owned addresses below do not define this target.

## Context

Epicenter currently has two deployment seams that move together: the server resolves a user, then an ownership rule maps that user to a partition. Cloud always resolves Better Auth users with the per-user ownership rule. The self-hosted instance always resolves the operator bearer with the instance ownership rule. No deployment mixes the axes, so the second seam names optionality the product does not have.

The instance also exposed the lie in the vocabulary. ADR-0075 intentionally decoupled the authenticated principal from the partition so future named instance tokens could share one partition; that preserved the single-partition invariant, but it kept "owner" alive as a second thing the server had to derive. The new refusal is sharper: a self-hosted instance has exactly one tenant, and per-person server-side attribution belongs to Cloud unless real offboarding pain earns a same-principal token registry.

## Decision

Epicenter treats the authenticated principal id as the partition id by definition. The server has one auth seam, `ResolvePrincipal`, which returns `Principal = { id: PrincipalId, email?: string }`. Every request runs through that seam, and routes use `principal.id` as the partition key. `OwnershipRule`, `perUser`, `instance`, `resolveOwnerId`, `createRequireOwnership`, `ownerId`, and `userId` vocabulary are deleted from live code.

`PrincipalId` lives in `@epicenter/identity`, the MIT package that already carries identity state through browser, extension, CLI, daemon, and workspace code. Cloud principals may include email because Better Auth supplies one; instance principals do not. `/api/session` returns `{ principalId, email? }`, and clients persist only `{ grant, principalId }`. Email is presentational profile data, read when displayed and never cached.

The public API drops owner path segments. Rooms and blobs are addressed as `/api/rooms/:roomId`, `/api/blobs`, and `/api/blobs/:sha256`. Durable storage also takes the clean-break shape because there are no durable users or data to preserve: R2 keys, Durable Object names, Bun room filenames, IndexedDB names, and HKDF info labels use `principals/<principalId>/...` and `principal:${label}`. There is no byte-pinned `owners/` fossil.

The forward seam is resolver shaped, not ownership shaped. A future hosted team brain may map many Better Auth accounts to one shared principal; that is still `ResolvePrincipal` deciding which principal the session represents. It does not require a second ownership rule.

The surviving word is `principal`, not `user`, because Better Auth still owns `user`: its `user` table and `session.user` remain live, and Epicenter OAuth bearers cannot be handed to Better Auth profile endpoints. Better Auth users are one source of principals; the instance bearer is another.

## Consequences

The shared server keeps ADR-0066's injection posture, but one injected concern disappears. Deployments differ only in how they authenticate principals: Better Auth mints many Cloud principals, and the instance bearer mints the one `INSTANCE_PRINCIPAL_ID` principal. The server no longer compares a URL owner against an authenticated owner, because the URL no longer echoes the owner. Partition bugs become auth bugs, audited at the one resolver path.

ADR-0067's session contract changes. Auth still owns `/api/session`, but the response is flat and principal-scoped. `getProfile()` continues to read the session endpoint because Better Auth endpoints do not accept Epicenter OAuth bearers; when `email` is absent, profile display falls back to instance identity such as the base URL.

ADR-0075's self-host conclusion is tightened. The instance remains one partition behind one operator bearer, but the partition principal is the literal `instance` principal. The old named `instance-owner` principal goes away because it was never durable input. Named instance tokens remain refused for now; if they are earned, they map to the same principal id and put attribution in presence or audit metadata, not in storage partitioning.

This is a clean break under the zero-users and no-durable-data assumption. Old clients that still call `/api/owners/:ownerId/...` or persist `ownerId` may fail to sync until upgraded. Durable local or server data written under the old shape is allowed to become unreachable because there is no data to preserve.

Encrypted payloads derived with the old `owner:${label}` HKDF info bytes are also intentionally unreadable. That compatibility break is accepted only because no deployed durable data exists yet.

## Considered alternatives

**Keep identity and partition as separate axes.** Rejected: every shipped deployment selects the same pair every time, so the second seam is an attractive nuisance. It also keeps the "owner" vocabulary alive after the product has refused cross-owner access.

**Rename the brand to `UserId`.** Rejected: the instance principal is not a Better Auth user, and future hosted shared principals may not be one human account either. `UserId` would also collide with Better Auth's live `user` table and `session.user`, making it look like Epicenter principal ids can be sent back to Better Auth profile APIs. They cannot.

**Rename the brand to `PartitionId`.** Rejected: the resolver authenticates a principal. Storage derives a partition from that principal id by definition, not the other way around.

**Add `/api/profile` for email.** Rejected for now: email is the only profile fact, and `auth.getProfile()` already reads through `/api/session`. A profile route earns itself when profile facts grow beyond email.
