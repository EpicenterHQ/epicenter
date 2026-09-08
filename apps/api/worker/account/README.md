# Hosted account deletion

This directory owns the hosted deletion endpoint. It currently refuses deletion
before destructive work: `DELETE /api/account` requires a fresh, live session
bound by `x-epicenter-principal`, then returns `503` with
`ACCOUNT_DELETION_UNAVAILABLE`. It accepts no job, tracks no progress, and never
reports completion. The account page disables deletion. The former synchronous
coordinator could remove login access while leaving hosted data behind.

## Storage inventory, inspected 2026-09-08

| Owner | Allocation path | Discovery and deletion gap |
| --- | --- | --- |
| `StoreAuthority`, opaque snapshots and log | `mountStoreSyncApp`: import POST allocates then seeds; socket upgrade addresses any valid data ID and positive generation | No account data-ID registry. Socket-only generations can have bytes without any ledger row. `deleteStore()` only calls `deleteAll()`; it has no tombstone, socket retirement, or delayed-body fence. |
| `GenerationsLedger`, reservations and admitted generations | Collection GET/POST and bootstrap GET address a ledger by principal/data ID; construction creates its SQL table; `allocate()` inserts before import | `list()` filters out reservations. Failed imports remain discoverable only if the data ID is already known and all rows are read. No deletion method or account registry exists. |
| Prior Durable Object layouts | Earlier Worker/name layouts documented in `apps/api/wrangler.jsonc` | Renaming strands objects. Configuration comments requiring a past reset are not evidence that it happened. |
| S3/R2 blob bucket | `routes/blobs.ts` issues 300-second presigned PUTs; clients write directly | Paginated prefix listing finds stored objects, including unattached uploads. A concurrent or previously authorized PUT can land after a sweep. Expiry alone does not prove an in-flight upload has stopped. |
| Postgres `user`, `session`, `account`, `passkey` | Better Auth, social callbacks, passkey ceremonies, session handoff | User deletion cascades to the latter three through actual foreign keys. It does not cancel handlers that already resolved a session. |
| Postgres `verification` | Better Auth OAuth state, passkey challenges, `sessionHandoff` | No user foreign key. Handoff values contain `principalId` and `sourceToken`; installed passkey registration values contain `userData.id`, name, and display name. OAuth linking state carries a link identity. Expiration is not proof of physical removal. Inventory needs explicit attribution at creation and grounded discovery for historical formats. |
| Postgres `storage_observation` | `upsertStorageObservation`; historical registry and billing observation paths | Enumerable by principal, no cascade. Current store transport does not register allocations here. These rows cannot prove store completeness. |
| Autumn customer, subscription/balance/event data; Stripe customer | Billing service, including GET handlers through `getOrCreate`, credit reservations and after-response usage work | Customer deletion requests `deleteInStripe: true` and treats Autumn not-found as success. That does not prove Stripe deletion after an ambiguous partial result or erase every provider-retained business record. Pending work can recreate a customer. |
| Device stores and replicas | Each application's client-owned store and persistence | Hosted deletion cannot erase offline device copies, exported files, or copies another person holds. |

The deployed bindings name no additional R2/KV/D1 application store. Platform
backups, logs, and external provider retention are separate from deletion of
application-addressable records; no immediate physical-erasure guarantee has
been established for them. Better Auth remains the authentication owner.

## Historical ownership blocks complete erasure

Cloudflare's [List Objects API](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/methods/list/)
returns opaque object IDs and `hasStoredData`, not principal or original name.
Accessing those IDs through `idFromString()` leaves
[`ctx.id.name` undefined](https://developers.cloudflare.com/durable-objects/api/id/).
The current authority stores opaque bytes and the ledger stores numbers. Neither
stores the missing account identity. Active sockets or rescheduled alarms might
recover some names; they cannot establish completeness for dormant objects.

Consequently, authorities created through arbitrary socket addresses, ledgers
for unknown data IDs, failed imports under those IDs, and objects under retired
name layouts cannot be safely attributed and erased per account from the
available evidence. A list of the three shipped apps is insufficient.

The smallest prerequisite is verified evidence that the hosted namespaces have
no historical storage, or a complete object-ID-to-owner manifest covering every
historical namespace/layout. If neither exists, the product must separately
authorize retirement and purge of the historical namespaces, with its impact on
all accounts understood. No production inspection, reset, or deployment was
performed for this review. Future-only registration cannot repair this gap.

## Verification boundary

`routes.test.ts` proves refusal, principal binding, session freshness, repeated
requests, and absence of storage/binding access using isolated fixtures. It is
not an erasure test. No durable deletion workflow has been implemented or
verified. Its required design and acceptance cases are in
[the workflow plan](../../../../specs/20260908T020000-hosted-account-deletion.md).
