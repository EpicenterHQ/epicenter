# Hosted account deletion

This directory owns the hosted deletion endpoint. It currently refuses deletion
before destructive work: `DELETE /api/account` requires a fresh, live session
bound by `x-epicenter-principal`, then returns `503` with
`ACCOUNT_DELETION_UNAVAILABLE`. It accepts no job, tracks no progress, and never
reports completion. The account page disables deletion. The former synchronous
coordinator could remove login access while leaving hosted data behind. Automated
deletion is deferred for the zero-user V1; see
[the decision](../../../../docs/adr/0360-defer-automated-hosted-account-deletion.md).

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

## Historical ownership requires deployment evidence

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
all accounts understood. Future-only registration cannot repair this gap. The
initial review did not inspect production; the subsequent read-only inspection below supplies a
point-in-time baseline.

## Live baseline and smallest reset, 2026-09-08

At `2026-09-08T08:07:43Z`, authenticated Cloudflare REST requests returned
`success: true`, `result: []`, `count: 0`, and an empty pagination cursor for
both namespaces actually bound to the hosted `api` Worker:

| Namespace | Namespace ID | Objects |
| --- | --- | --- |
| `api_StoreAuthority` | `8928d4c933ff48adb4a0de3c5d37d763` | 0 |
| `api_GenerationsLedger` | `c314f26fa32840c7a994602757d0bc0f` | 0 |

Account-wide namespace listing returned three namespaces in total. The third,
`epicenter-sync-lab_SyncLabAuthority`, had 24 stored objects. It belongs to
`epicenter-sync-lab`, the separate throwaway transport harness, and is not bound
to `api`. It is outside the proposed hosted-account reset scope.

`wrangler r2 bucket info epicenter-blobs` reported zero objects and zero bytes.
That is bucket reporting, not an S3 object-list or in-flight-upload proof. The
live Worker has a secret `BLOBS_S3_BUCKET` override; inspecting secret names does
not establish its value. Postgres rows, external billing records, other S3
endpoints, and pending uploads were not inspected. No secret values were printed.
The live API still binds the existing Hyperdrive configuration.

**The smallest reset justified by this evidence is no reset.** Keep the Worker,
domain, secrets, database connection, and existing empty API namespaces. Do not
retire the sync laboratory as part of account deletion. The user has confirmed
there are no real users and historical hosted test data is disposable; no
production deletion or deployment has been authorized or performed.

This observation is not a write fence and is not a permanent empty-baseline
certificate. The following are future cutover checks, not active implementation work. Before
enabling automated deletion:

1. Finish and locally verify inventory registration, mutation retirement,
   durable retries, and every storage-owner deletion path.
2. Prepare an approved deployment that temporarily refuses storage allocations
   and upload issuance, including ledger-creating GETs. Retire existing sockets
   and drain delayed requests and old Worker/DO versions; deployment alone does
   not quiesce them. A past empty listing cannot stand in for this step.
3. Repeat namespace enumeration after the gate is active, verify the actual blob
   endpoint/bucket, and establish the disposition of outstanding upload writes.
   Inspect relational and billing records through their enumerable owner keys;
   an empty Durable Object namespace does not imply an empty account database.
4. If the API namespaces remain empty, enable the new allocation owner without
   deleting infrastructure. If either acquired unregistered objects, propose
   retiring only the affected API Durable Object classes and creating fresh
   namespaces as part of the gated cutover. Include exact namespace IDs and
   irreversible data loss in that separate approval. A name change alone leaves
   the old data behind; use a supported class deletion migration.
5. Admit traffic only through inventory-backed allocation. Keep deletion
   unavailable until blob completion/drain and the other owner guarantees pass.

Cloudflare documents [class deletion as permanent namespace and data removal](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).
That is the bounded fallback if storage appears before cutover; deleting and
recreating the entire project is unnecessary.

## Verification boundary

`routes.test.ts` proves refusal, principal binding, session freshness, repeated
requests, and absence of storage/binding access using isolated fixtures. It is
not an erasure test. No durable deletion workflow has been implemented or
verified. Automation is deferred. Complete ownership and a tested operator
procedure are prerequisites to onboarding external users; the follow-up is
tracked in [the backlog](../../../../BACKLOG.md).
