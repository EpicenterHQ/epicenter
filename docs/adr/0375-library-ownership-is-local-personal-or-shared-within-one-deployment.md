# 0375. Local and Personal data preserve named account ownership

- **Status:** Proposed
- **Date:** 2026-09-08
- **Amends:** [ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md) at the hosted-only sign-in restriction; [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) at shared-token-only self-hosting; [ADR-0076](0076-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md) at the prohibition on self-hosted session infrastructure; [ADR-0092](0092-identity-is-the-partition.md) at equating authenticated identity with every data partition; [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md) at the account-or-local definition of a library, preserving fixed page ownership.
- **Amends:** [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at the opening API: one App contains device data and the captured Account's personal data. The common application data API, readiness, and closure remain, and ADR-0392 owns the opening call.
- **Revised by:** [ADR-0416](0416-defer-server-wide-shared-data.md) removes Shared from the current model and records server-wide sharing as a deferred direction.
- **Implementation:** Named self-hosted Accounts exist. Honeycrisp selection and current-generation integration pass the local Worker browser checkpoint; complete explicit blob-hosting, Bun sync, and packaged desktop evidence remain.

## Context

The self-hosted reference authenticates one operator-supplied token and resolves
every authorized client to the same `instance` principal. The server uses that
principal to address application data. Epicenter Cloud instead resolves a
session to a named user and keeps users' data separate.

The current application API exposes `openApp(definition, { account })` from
`@epicenter/app/open`. Opening captures the account and returns its device data
and personal data together. Opening without an account returns device data in a
separate namespace.

The desired self-hosted product admits named users without introducing
organizations. Each person keeps personal data and authenticates as themselves.
Signing in as a common account would lose the person's identity. A common
store per application was considered here; ADR-0416 defers it until a product
needs it.

## Decision

**An application exposes Local and, when signed in, Personal data.**

A library is one application's data in one destination. These names describe
ownership and synchronization, not authentication methods or subscription
tiers. The application retains its identity and data definition in each library.
Library ownership names the data destination and synchronization scope; it does
not assign blob ownership. Rows may hold ordinary local BlobIds or remote URLs,
while app-local and account-remote bytes keep independent lifetimes and require
explicit operations.

Both deployments expose the same data destinations:

| Library | Data boundary | Epicenter Cloud | Self-hosted deployment |
| --- | --- | --- | --- |
| Local | The captured owner on this device, with a separate signed-out namespace; no synchronization | Available | Available |
| Personal | One named user on one server; synchronized across that user's devices | Available | Available |

Alice's Personal notes and Bob's Personal notes are separate. Local is a
separate store, not the offline state of Personal. Both use local storage.
Browser-facing descriptions should say "this browser" when separate browser
profiles hold separate Local data.

**One open returns device data and optional personal data; Account names the
signed-in person.**

```ts
const app = await openApp(definition, { account }); // Account | undefined
app.device             // always present; the Local data lives here
app.account?.personal  // present when signed in
```

`device` holds the captured owner's application data on this machine.
`account.personal` is that person's data on their server. Opening initiates no
sign-in and accepts no other person's id as the owner to open.
[ADR-0392](0392-product-boundaries-provide-required-resource-handles.md)
owns the shape of those two scopes and what each carries.

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

**The authenticated person and the library being accessed remain distinct.**

The server authorizes the person making a request and selects their personal
data. A client-supplied destination is not permission to access another person's
data. Both data and credential isolation include the server, so matching user
identifiers on different deployments do not merge data.

**An opened application keeps one auth generation for its lifetime.**

Viewing Local or Personal does not replace the Account. Sign-out and account
replacement retire the old Account: producers and storage close before the new one opens, through
a fresh document or the host's established restart boundary. Credential repair
for the same person retires nothing.

A temporary server outage preserves established local data and identity while
remote work is unavailable. It does not select Local or sign in another person.
Writing to one library neither copies nor merges data from another; a copy is an explicit operation (ADR-0399).

## Consequences

A self-hoster can operate one deployment for several people without distributing
one common login. Personal data remains separate for each person. The same
rule applies when the deployment has only one admitted user.

The self-hosted server gains session persistence, admission and removal,
credential recovery, and authorization for personal data.
The shared-token-only deployment's minimal provisioning is no longer the target.
Removing client token-entry code does not remove this server-side work.

Storage, synchronization, blobs, and local caches must distinguish the
authenticated person from the selected library. A reserved word or a field
rename cannot establish that boundary. Existing `instance` data must remain
intact until an explicit migration or import decision assigns its destination;
the first named user does not inherit it automatically.

Application callers read `app.device` and `app.account?.personal` from one open.
Feature code continues to use the common data API each store exposes. Named
self-hosted authentication does not require a Shared store.

The Honeycrisp checkpoint is historical implementation evidence for atomic
current-generation selection, actor-isolated caches, and self-host Worker sync.
Its scoped data-addressing test did not make local blobs account-scoped: current
app-local blob storage and explicit account-remote hosting keep independent
lifetimes.
Complete explicit blob-hosting evidence, Bun sync, and packaged desktop verification remain
separate work. See the library-ownership execution spec for exact evidence.

Each write uses its intended library's handle (ADR-0401). The desktop host
retains one signed-in person and server. Applications decide which libraries
to expose and whether to offer a picker or remember a destination. The framework
does not impose a Personal default, a copy workflow, or a signed-out Local
fallback. An application may require sign-in even though the Local handle exists.

**Construction resolves reach once.** One `openApp(definition, { account })`
feeds the existing App constructor with the device store and, when an Account is present, that person's
Personal store. A private input type may describe those cases; no
public Library wrapper or binding object gains its own lifecycle. The constructor captures transport and
projects a credential-free replica scope for row storage and library locking.
Recording saves app-local bytes independently. Resource backends validate their
own scope. Inference and credentials remain attached to the authenticated actor.

**Reload ends a lifetime; it does not erase its data.** An ordinary switch submits
buffered edits, awaits App closure, preserves the previous cache and pending work,
records the next choice, and navigates. Confirmed generation retirement instead
fences writes and atomically invalidates the retired replica before closure and
reload. The next page alone opens the replacement through normal startup.
The device store is primary durable data. Personal uses an actor-bound replica
with the same application/Yjs format and its own remote destination. The server
owns one current generation per stable library, as developed in ADR-0379 and
ADR-0385. No generation picker or persisted cache-transition phase is required.

## Considered alternatives

- Keep one operator token and one common data partition: loses personal
  libraries and independent user access management.
- Retain a server-wide Shared store alongside Personal: deferred by ADR-0416.
  Named self-hosted accounts remain useful without this feature.
- Represent shared data as a special user: would conflate the person
  authenticating with the data being accessed if sharing is added later.
- Add organizations, teams, and workspace memberships: adds administration
  beyond named users and personal data.
- Rename Account to Personal: confuses the authenticated person with one of the
  libraries they can access.
- Use one public `open(destination)` that selects one library: passes a
  destination object to answer a question the caller should not have to answer
  once. ADR-0392 removes the parameter instead: one `openApp(definition, { account })` returns
  device data and optional personal data.
