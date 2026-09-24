# 0400. Device SQLite and secrets key by application id

- **Status:** Superseded
- **Date:** 2026-09-12
- **Superseded by:** [ADR-0404](0404-the-opened-account-owns-application-local-storage.md): the captured account now scopes device storage as well as synchronized stores.
- **Amends:** [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at the storage address of named SQLite files: `sqlite/<database-name>.sqlite` lives under the existing `local/` directory only, independent of the signed-in account. The data and blob addresses in that tree stand.
- **Relates:** [ADR-0352](0352-an-account-s-data-and-a-device-s-files-are-two-packages-because-only-one-of-them-is-removed.md) (a device file is scoped by app, a replica by app and principal), [ADR-0310](0310-an-applications-provider-credential-is-a-labeled-secret-and-the-browser-keeps-none.md) (a secret is namespaced per application), [ADR-0306](0306-borrowed-data-is-disposable-and-a-persons-own-data-is-not.md) (what a device database holds), [ADR-0392](0392-product-boundaries-provide-required-resource-handles.md) (the scope that owns both)
- **Implemented:** 2026-09-18. SQLite owner, browser worker, host protocol, native paths, and secret stores accept app identity without replica/account scope. Existing device paths and serialized keychain addresses are preserved. Account namespaces are not merged or deleted.

## Context

`DeviceSqliteOwner.acquire(appId, replica)` keys a named database by the
application id and the identity of the replica that opened it, and secrets are
scoped the same way. That was correct while a page held one library: the
library was the only thing an App had, so scoping to it and scoping to the App
were the same scope.

ADR-0392 makes `sqlite` and `secrets` members of `app.device`, which is present
in every page whatever the account. Under the old keying, the same file name
would name a different file after sign-in, and a provider key stored while
signed out would be unreadable while signed in.

## Decision

**A named device database and a secret are keyed by application id alone.**

```ts
DeviceSqliteOwner.acquire(appId);
app.device.sqlite.open('search-index');   // same file, every account state
app.device.secrets.get(accountId);        // same value, every account state
```

A database that derives from one library's data names its source in its own
file name, which the application chooses. `search-index` and
`search-index-personal` are two names the application picked; the owner reads
neither.

Exclusive SQLite ownership is per application lifetime within the profile.
That lifetime owns all named databases until physical cleanup finishes.
Data-library claims have their own namespace.

## Consequences

- One page can hold a personal library and a derived database built from it
  without the database moving when the account changes, which is why the App
  can survive a same-owner refresh.
- A second application cannot read the first's file or secret, unchanged from
  ADR-0310: the application id is still the namespace, and it is for collision,
  not protection.
- Removing an account's local data (ADR-0351) touches no device file. A derived
  database whose source is gone is stale until the application deletes or
  rebuilds it, and the application owns that decision because the data is
  borrowed (ADR-0306).
- `packages/device` tests lose their replica-identity permutations.

## Considered alternatives

- **Key by application id and library name.** Rejected because a device
  database derived from Personal data is still one file on one machine, and the
  segment would forget it on sign-out while promising an isolation the
  filesystem does not give (ADR-0310).
- **Key by application id and principal for secrets only.** Rejected because a
  provider API key belongs to the person at the machine, and a key entered
  before signing in is the common case.
