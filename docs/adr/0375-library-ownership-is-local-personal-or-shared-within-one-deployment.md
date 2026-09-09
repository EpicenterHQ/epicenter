# 0375. Library ownership is local, personal, or shared within one deployment

- **Status:** Proposed
- **Date:** 2026-09-08
- **Amends:** [ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md) at the hosted-only sign-in restriction; [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) at shared-token-only self-hosting; [ADR-0076](0076-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md) at the prohibition on self-hosted session infrastructure; [ADR-0092](0092-identity-is-the-partition.md) at equating authenticated identity with every data partition; [ADR-0369](0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md) at the account-or-local definition of a library, preserving fixed page ownership.
- **Amends:** [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at the opening API and account identity as a complete library selector: `openPersonal(account)` replaces `openAccount(account)`, and `openShared(account)` selects a distinct library for the same Account. The common application data API, readiness, and closure remain.
- **Implementation:** Named self-hosted Accounts and the three opening methods exist. Honeycrisp selection and current-generation integration pass the local Worker browser checkpoint; complete attachment, Bun sync, and packaged desktop evidence remain.

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

**The opening API names the library; Account names the signed-in person.**

The target API has three opening methods. Each call below illustrates a separate
opening, not three primary libraries in one application document:

```ts
application.openLocal();
application.openPersonal(account);
application.openShared(account);
```

`openLocal()` opens the application's Local library without an Account.
`openPersonal(account)` opens that person's Personal library on their server.
`openShared(account)` opens the application's Shared library on that server,
authenticated as the same person. Neither account-backed opener initiates
sign-in or accepts another person's ID as the owner to open. Cloud does not
authorize Shared access merely because the client exposes the method.

`openPersonal` replaces `openAccount`; retain no alias. The three verbs share
one internal construction path and return the same application data API with
its existing readiness and close contract. Do not add a second public
`open(destination)` form or a public Library wrapper to express the same choice.

Use Local, Personal, and Shared in library selection and descriptions. Keep
Account for sign-in, profile, credential repair, and sign-out. An Account is
one uninterrupted attachment to one signed-in person on one server; the same
Account can authenticate access to Personal and Shared. Local has no fabricated
account, and Shared is never a special account to sign in as.

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

**Each opened application keeps one primary library for its lifetime.**

Changing from Personal to Shared changes the library, not necessarily the
signed-in person. Application producers and storage close before a replacement
library opens through a fresh document or the host's established restart
boundary. Sign-out and account replacement still retire the old Account;
credential repair for the same person is not a library change.

A temporary server outage preserves established local data and identity while
remote work is unavailable. It does not select Local, sign in another person,
or make Shared public. Choosing another library neither copies nor merges data
from the previous one.

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

Application callers replace `openAccount(account)` with
`openPersonal(account)` and use `openShared(account)` for Shared. Feature code
continues to use the opened App's common data API. No `principalId` rename,
discriminator field, shared route spelling, binary split, or configuration
format is selected here.

The Honeycrisp checkpoint implements atomic current-generation selection, scoped
data and blob addressing, actor-isolated caches, and self-host Worker sync.
Complete attachment evidence, Bun sync, and packaged desktop verification remain
separate work. See the library-ownership execution spec for exact evidence.

Library selection is per application. The desktop host retains one signed-in
person and server; each application remembers its own Local, Personal, or Shared
choice. The browser first opens Local without an Account and defaults an existing
Account to Personal when no choice has been saved. An explicitly remembered
protected choice requires its Account and never falls back during an outage.

**Construction resolves the choice once.** The opening methods feed the existing
App constructor with Local, Personal plus an Account, or Shared plus an Account.
A private input type may describe those cases; no public Library wrapper or
binding object gains its own lifecycle. The constructor captures transport and
projects a credential-free replica scope for storage, locking, and recording
recovery. Resource backends serialize and validate that scope without inferring
Personal from an omitted Shared flag. Inference and credentials remain attached
to the authenticated actor.

**Reload ends a lifetime; it does not erase its data.** An ordinary switch submits
buffered edits, awaits App closure, preserves the previous cache and pending work,
records the next choice, and navigates. Confirmed generation retirement instead
fences writes and atomically invalidates the retired replica before closure and
reload. The next page alone opens the replacement through normal startup.
Local is primary durable data. Personal and Shared use actor-bound local replicas
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
- Use one public `open(destination)` or expose it beside the three verbs: adds
  a destination object or duplicate entrypoint without a caller that needs it.
  The three verbs express the fixed choices and require an Account precisely
  for the two server libraries.
