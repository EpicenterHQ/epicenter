# 0375. Local and Personal data preserve named account ownership

- **Status:** Proposed
- **Date:** 2026-09-08
- **Amends:** [ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md) at the hosted-only sign-in restriction; [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) at shared-token-only self-hosting; [ADR-0076](0076-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md) at the prohibition on self-hosted session infrastructure; [ADR-0092](0092-identity-is-the-partition.md) at equating authenticated identity with every data partition; [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md) at the account-or-local definition of a library, preserving fixed page ownership.
- **Amends:** [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at the opening API: Local and Personal open independently and each owns its blobs. The common application data API, readiness, and closure remain, and ADR-0392 owns the opening call.
- **Revised by:** [ADR-0416](0416-defer-server-wide-shared-data.md) removes Shared from the current model and records server-wide sharing as a deferred direction.
- **Implementation:** Named self-hosted Accounts exist. Honeycrisp selection and current-generation integration pass the local Worker browser checkpoint; complete explicit blob-hosting, Bun sync, and packaged desktop evidence remain.

## Context

The self-hosted reference authenticates one operator-supplied token and resolves
every authorized client to the same `instance` principal. The server uses that
principal to address application data. Epicenter Cloud instead resolves a
session to a named user and keeps users' data separate.

The current API opens Local and Personal independently. The target also places
blob access on those stores. Local keeps one device-profile namespace across
account changes. Personal captures one account and deployment.

The desired self-hosted product admits named users without introducing
organizations. Each person keeps personal data and authenticates as themselves.
Signing in as a common account would lose the person's identity. A common
store per application was considered here; ADR-0416 defers it until a product
needs it.

## Decision

**An application exposes Local and, when signed in, Personal data.**

A Local or Personal store holds one application's data in one destination.
These names describe ownership and synchronization, not authentication methods
or subscription tiers. Definitions may differ by workflow. Each store owns
tables, KV, and its blob namespace; rows reference bytes without owning their
lifetime. Copying bytes between stores requires an explicit operation.

Both deployments expose the same data destinations:

| Store | Data boundary | Epicenter Cloud | Self-hosted deployment |
| --- | --- | --- | --- |
| Local | The device profile across account changes; no synchronization | Available | Available |
| Personal | One named user on one server; synchronized across that user's devices | Available | Available |

Alice's Personal notes and Bob's Personal notes are separate. Local is a
separate store, not the offline state of Personal. Both use local storage.
Browser-facing descriptions should say "this browser" when separate browser
profiles hold separate Local data.

**Local needs a definition; Personal also needs a definite Account.**

```ts
const local = await openLocal(captureDefinition);
const personal = await openPersonal(savedDefinition, { account });
```

Each provides `tables`, `kv`, and `blobs`. Opening initiates no sign-in and
accepts no other person's ID as the owner. ADR-0392 owns product composition.

An Account is one uninterrupted attachment to one signed-in person on one
server. Local has no fabricated account. Use Local and Personal wherever a
person picks a destination or reads a description of one.

**Self-hosted users authenticate as themselves when accessing Personal data.**

A self-hosted deployment supports named-user sign-in and user-bound sessions.
Its operator controls admission and removal.

Authentication and session lifetime are shared concerns across Cloud and
self-hosting. An authentication provider, a database product, a login-page
layout, and an administrative interface are implementation choices left open.
Self-hosting does not require an Epicenter Cloud account or a particular social
identity provider. Billing remains exclusive to the Epicenter-operated service.

Content access does not confer deployment administration. The operator controls
user admission and removal without a product-level organization hierarchy.
Removing a person stops their future authorized server access according to the
session-revocation contract. It cannot retract data already copied to a device.

**The authenticated person and the Personal store being accessed remain distinct.**

The server authorizes the person making a request and selects their personal
data. A client-supplied destination is not permission to access another person's
data. Both data and credential isolation include the server, so matching user
identifiers on different deployments do not merge data.

**An opened application keeps one auth generation for its lifetime.**

Viewing Local or Personal does not replace the Account. Sign-out and account
replacement retire the old Account's network authority. The product lifetime
owner ends dependent work and closes or replaces Personal through its established
departure boundary. Account retirement does not itself close or erase the cached
store. Credential repair for the same person retires nothing.

A temporary server outage preserves established local data and identity while
remote work is unavailable. It does not select Local or sign in another person.
Writing to one store neither copies nor merges data from another; a copy is an
explicit operation (ADR-0399).

## Consequences

A self-hoster can operate one deployment for several people without distributing
one common login. Personal data remains separate for each person. The same
rule applies when the deployment has only one admitted user.

The self-hosted server gains session persistence, admission and removal,
credential recovery, and authorization for personal data.
The shared-token-only deployment's minimal provisioning is no longer the target.
Removing client token-entry code does not remove this server-side work.

Storage, synchronization, blobs, and local caches must distinguish the
authenticated person from the selected store. A reserved word or a field
rename cannot establish that boundary. Existing `instance` data must remain
intact until an explicit migration or import decision assigns its destination;
the first named user does not inherit it automatically.

Application callers use explicit Local and Personal store handles.
Feature code continues to use the common data API each store exposes. Named
self-hosted authentication does not require a Shared store.

The Honeycrisp checkpoint is historical implementation evidence for atomic
current-generation selection, actor-isolated caches, and self-host Worker sync.
It is not evidence for the new store-owned blob contract.
Complete blob-hosting, Bun sync, and packaged desktop verification remain
separate work.

Each write uses its intended store handle (ADR-0401). The desktop host
retains one signed-in person and server. Applications decide which stores
to expose and whether to offer a picker or remember a destination. The framework
does not impose a Personal default, a copy workflow, or a signed-out Local
fallback. An application may require sign-in even though the Local handle exists.

**Construction resolves reach once.** Personal captures account identity and
transport before asynchronous acquisition. No extra data-selection wrapper or binding
object gains its own lifecycle. Recording borrows Local blobs independently of
Account. Inference and credentials remain attached to their explicit actor.

**Reload ends a lifetime; it does not erase its data.** Departure preserves the
previous cache and pending work. Navigation is not proof of a successful flush.
Only confirmed generation retirement invalidates a replica; sign-out, an outage,
or store closure does not. Personal uses an actor-bound replica with its own
remote destination. ADR-0379 and ADR-0385 own generation rules.

## Considered alternatives

- Keep one operator token and one common data partition: loses separate
  Personal data and independent user access management.
- Retain a server-wide Shared store alongside Personal: deferred by ADR-0416.
  Named self-hosted accounts remain useful without this feature.
- Represent shared data as a special user: would conflate the person
  authenticating with the data being accessed if sharing is added later.
- Add organizations, teams, and workspace memberships: adds administration
  beyond named users and personal data.
- Rename Account to Personal: confuses the authenticated person with one of the
  stores they can access.
- Use one aggregate opener: couples device access to account acquisition and
  hides the store each workflow owns.
