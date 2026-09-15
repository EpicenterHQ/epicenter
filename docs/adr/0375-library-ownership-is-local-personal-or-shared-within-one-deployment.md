# 0375. Library ownership is local, personal, or shared within one deployment

- **Status:** Proposed
- **Date:** 2026-09-08
- **Amends:** [ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md) at the hosted-only sign-in restriction; [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) at shared-token-only self-hosting; [ADR-0076](0076-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md) at the prohibition on self-hosted session infrastructure; [ADR-0092](0092-identity-is-the-partition.md) at equating authenticated identity with every data partition; [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md) at the account-or-local definition of a library, preserving fixed page ownership.
- **Amends:** [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at account identity as a complete library selector: an Account does not name a library by itself, because Personal and Shared are distinct libraries for the same person. The common application data API, readiness, and closure remain, and ADR-0392 owns the opening call.
- **Unbuilt:** One `open(account)` that returns the device scope and the account scope. The three opening methods `openLocal`, `openPersonal`, and `openShared` exist instead.
- **Implementation:** Named self-hosted Accounts exist. Honeycrisp selection and current-generation integration pass the local Worker browser checkpoint; complete attachment, Bun sync, and packaged desktop evidence remain.

## Context

The self-hosted reference authenticates one operator-supplied token and resolves
every authorized client to the same `instance` principal. The server uses that
principal to address application data. Epicenter Cloud instead resolves a
session to a named user and keeps users' data separate.

The application API exposes `openLocal()` and `openAccount(account)` in
`packages/app/src/index.ts`. The account selects both the authenticated identity
and the data destination. That is sufficient while every account opens only its
own data, but not when Alice and Bob sign in separately and also use a common
library.

The desired self-hosted product admits named users without introducing
organizations. Each person keeps personal data and can use one common library
per application. Everyone admitted to that deployment has the same read/write
access to its shared libraries. Signing in as a common account would lose the
person's identity; creating teams and workspace memberships would add choices
that the product does not need.

## Decision

**An application library is Local, Personal, or Shared.**

A library is one application's data in one destination. These names describe
ownership and synchronization, not three authentication methods or subscription
tiers. The application retains its identity and data definition in each library.

The deployment determines which destinations are available:

| Library | Data boundary | Epicenter Cloud | Self-hosted deployment |
| --- | --- | --- | --- |
| Local | This device; no account or server synchronization | Available | Available |
| Personal | One named user on one server; synchronized across that user's devices | Available | Available |
| Shared | One application on one self-hosted server; synchronized among that deployment's admitted users | Not offered | Available |

Alice's Personal notes and Bob's Personal notes are separate. Both can open the
same Shared notes on their server. Another self-hosted server has a different
Shared notes library. Shared notes and Shared recordings remain different
applications' data; the word Shared does not merge schemas or expose every
local library on a device.

Local is a separate library, not the offline state of Personal or Shared. All
three use local storage. Browser-facing descriptions should say "this browser"
when separate browser profiles hold separate Local libraries.

**One open returns every library the person can reach; Account names the
signed-in person.**

```ts
const app = await open(account);   // Account | null
app.device             // always present; the Local library lives here
app.account?.personal  // present when signed in
app.account?.shared    // present on a deployment that offers it, to an admitted person
```

`device` holds the application's library on this machine and needs no Account.
`account.personal` is that person's library on their server. `account.shared`
is the application's one library on that server, reached as the same person. Opening
initiates no sign-in and accepts no other person's id as the owner to open.
Cloud authorizes no Shared library merely because the member exists.
[ADR-0392](0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md)
owns the shape of those two scopes and what each library carries.

Keep Account for sign-in, profile, credential repair, and sign-out. An Account
is one uninterrupted attachment to one signed-in person on one server; the same
Account authenticates access to Personal and Shared. Local has no fabricated
account, and Shared is never a special account to sign in as.

Use Local, Personal, and Shared wherever a person picks a destination or
reads a description of one.

**Self-hosted users authenticate as themselves when accessing either Personal or Shared libraries.**

A self-hosted deployment supports named-user sign-in and user-bound sessions.
Its operator controls admission and removal. Entering Shared does not replace
the authenticated person with a special shared account. The same signed-in
identity can be authorized for personal data and deployment-shared data.

Authentication and session lifetime are shared concerns across Cloud and
self-hosting. An authentication provider, a database product, a login-page
layout, and an administrative interface are implementation choices left open.
Self-hosting does not require an Epicenter Cloud account or a particular social
identity provider. Billing remains exclusive to the Epicenter-operated service.

**Every admitted user has full read/write access to the deployment's Shared libraries.**

Admission to the deployment is the only membership boundary for Shared. There
are no organizations, groups, per-library invitations, per-document permissions,
or read-only shared members. A newly admitted person can read existing shared
content. Every admitted person can change or delete shared content; the author
of an item does not receive exclusive control over it.

Content access does not confer deployment administration. The operator controls
user admission and removal without a product-level organization hierarchy.
Removing a person stops their future authorized server access according to the
session-revocation contract. It cannot retract data already copied to a device.

**The authenticated person and the library being accessed remain distinct.**

The server authorizes both who is making a request and which library that person
may access. A client-supplied library choice is not permission. Personal access
does not expose another person's library. Shared access does not authenticate
the caller as everyone else. Both data and credential isolation include the
server, so matching user identifiers on different deployments do not merge data.

Shared is the user-facing name because it states who can use the data without
introducing a Team or Organization object. It does not promise public or
anonymous access. Internal library identifiers, storage keys, routes, and type
representations remain implementation design work; the opening verbs do not
prescribe them.

**An opened application keeps one auth generation for its lifetime.**

Personal and Shared are two libraries one signed-in person reaches at once, so
moving between them is not an event. Sign-out and account replacement retire
the old Account: producers and storage close before the new one opens, through
a fresh document or the host's established restart boundary. Credential repair
for the same person retires nothing.

A temporary server outage preserves established local data and identity while
remote work is unavailable. It does not select Local, sign in another person,
or make Shared public. Writing to one library neither copies nor merges data
from another; a copy is an explicit operation (ADR-0399).

## Consequences

A self-hoster can operate one deployment for several people without distributing
one common login. Personal libraries provide separation, and Shared provides a
common destination without membership management for each library. The same
rule applies when the deployment has only one admitted user.

The self-hosted server gains session persistence, admission and removal,
credential recovery, and authorization for two account-backed destinations.
The shared-token-only deployment's minimal provisioning is no longer the target.
Removing client token-entry code does not remove this server-side work.

Storage, synchronization, blobs, and local caches must distinguish the
authenticated person from the selected library. A reserved word or a field
rename cannot establish that boundary. Existing `instance` data must remain
intact until an explicit migration or import decision assigns its destination;
the first named user does not inherit it automatically.

Application callers read `app.account?.personal` and `app.account?.shared` from
one open. Feature
code continues to use the common data API each library exposes. No `principalId` rename,
discriminator field, shared route spelling, binary split, or configuration
format is selected here.

The Honeycrisp checkpoint implements atomic current-generation selection, scoped
data and blob addressing, actor-isolated caches, and self-host Worker sync.
Complete attachment evidence, Bun sync, and packaged desktop verification remain
separate work. See the library-ownership execution spec for exact evidence.

Each write uses its intended library's handle (ADR-0401). The desktop host
retains one signed-in person and server. Applications decide which libraries
to expose and whether to offer a picker or remember a destination. The framework
does not impose a Personal default, a copy workflow, or a signed-out Local
fallback. An application may require sign-in even though the Local handle exists.

**Construction resolves reach once.** One `open(account)` feeds the existing App
constructor with the device store and, when an Account is present, that person's
Personal and Shared libraries. A private input type may describe those cases; no
public Library wrapper or binding object gains its own lifecycle. The constructor captures transport and
projects a credential-free replica scope for storage, locking, and recording
recovery. Resource backends serialize and validate that scope without inferring
Personal from an omitted Shared flag. Inference and credentials remain attached
to the authenticated actor.

**Reload ends a lifetime; it does not erase its data.** An ordinary switch submits
buffered edits, awaits App closure, preserves the previous cache and pending work,
records the next choice, and navigates. Confirmed generation retirement instead
fences writes and atomically invalidates the retired replica before closure and
reload. The next page alone opens the replacement through normal startup.
The device store is primary durable data. Personal and Shared use actor-bound replicas
with the same application/Yjs format and distinct remote destinations. The server
owns one current generation per stable library, as developed in ADR-0379 and
ADR-0385. No generation picker or persisted cache-transition phase is required.

## Considered alternatives

- Keep one operator token and one common data partition: loses personal
  libraries and independent user access management.
- Offer only personal self-hosted libraries: omits the explicitly requested
  common library for a deployment's admitted users.
- Represent Shared as a special user: conflates the person authenticating with
  the data being accessed.
- Add organizations, teams, and workspace memberships: adds administration
  without changing the chosen rule that every admitted user has equal access.
- Add a mutable shared-versus-private deployment mode: changes the meaning of
  stored data instead of offering distinct libraries alongside each other.
- Keep `openAccount(account)`: names the credential boundary while leaving the
  Personal destination implicit, even though the same Account can open Shared.
- Rename Account to Personal: confuses the authenticated person with one of the
  libraries they can access.
- Use one public `open(destination)` that selects one library: passes a
  destination object to answer a question the caller should not have to answer
  once. ADR-0392 removes the parameter instead: one `open(account)` returns
  every library the person can reach.
