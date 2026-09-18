# 0404. The opened account owns application-local storage

- **Status:** Accepted
- **Date:** 2026-09-18
- **Supersedes:** [ADR-0400](0400-device-sqlite-and-secrets-key-by-application-id.md).
- **Relates:** [ADR-0365](0365-ai-owns-inference-access-and-applications-own-workflow-selection.md): the desktop catalog is shared across an account's apps, not across people.

- **Implementation checkpoint:** Account-scoped storage and opening overloads are being implemented in the working tree. This acceptance records the ownership decision; it does not certify completion or migration of existing data.

## Context

Changing Epicenter accounts usually means changing the person using the app.
Local Mail also authenticates with Gmail, but that independent authentication
does not mean the next Epicenter user should inherit the previous user's mail.
Locality and ownership answer different questions. An account can own data
that never synchronizes.

## Decision

The account supplied to `application.open(account)` is the owner of the
application's local storage for that lifetime. `open()` and
`open(undefined)` select a separate `no-account` namespace. Neither sign-in
nor sign-out transfers data. Returning to the same authority and principal
restores the same local storage.

`app.device` describes the local capability scope, not an account-independent
owner. Its tables, named SQLite databases, secrets, and recording destination
use the captured owner. `app.blobs.local` uses that same owner across the
App's libraries. A local file belongs to this account on this device; personal
tables additionally synchronize through that account.

Custom AI endpoints and keys are shared across apps within one account and
profile. They are an account-scoped cross-application catalog, not
application-local storage. Browser sharing is additionally bounded by origin.
The host's native inference capability remains available independently of
account identity.

The App captures a credential-free authority/principal identity once. Every
application-owned local resource derives its namespace from that identity:
storage paths, claims, keychain entries, native capture, and file reads. The
application storage layout is:

```text
apps/<appId>/device/
  no-account/
    data/
    sqlite/
    blobs/
  accounts/<authority>/<principal>/
    data/
    sqlite/
    blobs/
```

Browser storage keys and OS keychain addresses carry the equivalent owner.
Device paths use `no-account` or `accounts/<authority>/<principal>`, with the
two identity components encoded as UTF-8 hex to preserve case on native
filesystems. These namespaces separate trusted applications' data and owners'
data. They are not a sandbox against code with access to the host profile.

The TypeScript return type preserves the opening argument. A definite Account
produces a definite account scope; an omitted or undefined argument produces
`account: undefined`; a union argument retains the union. One no-argument
overload and one generic overload with a required argument prevent callers
from claiming an Account through a type argument without supplying a value.

Checking `app.account` establishes the captured identity, not server reachability
or authorization for a request. Readiness and retirement retain their existing
App-wide lifetime. An account change closes the App before reopening.

## Consequences

Applications no longer prefix device filenames with account identities or clear
another person's cache on sign-out. The storage boundary carries the owner.
Old app-wide local stores and profile-wide AI catalogs remain untouched and
are not automatically adopted. Provider connections must be made in the
intended namespace. Browser secrets still last only for the document.

## Considered alternatives

- **Account-independent device storage.** Refused because switching people
  would retain access to mail, recordings, and provider credentials.
- **Scope only secrets or SQLite.** Refused because blob enumeration and native
  recording would still cross the ownership boundary.
- **`unbound`, `guest`, or `offline`.** `no-account` states the durable identity
  without suggesting future attachment, temporary use, or network state.
- **Separate public openers for local and account storage.** Unnecessary:
  the one captured argument determines ownership and the return type records it.
