# 0436. Stores own local SQLite namespaces

- **Status:** Accepted
- **Date:** 2026-09-23
- **Implemented:** Store-owned SQL acquisition, complete isolated runtimes, and consumer API migration. See the [implementation evidence](../reports/20260923-store-owned-sqlite.md). Legacy Local Mail recovery remains unbuilt.
- **Relates:** [ADR-0430](0430-define-store-declares-data-and-products-compose-resources.md) names declarations and product composition. Its proposed composition is updated alongside this record.
- **Relates:** [ADR-0429](0429-store-handles-keep-account-identity-private.md), whose private captured account identity remains; [ADR-0437](0437-sign-out-offers-removal-of-downloaded-account-data.md) separates account departure from data removal.

## Context

The former `openSqlite({ id })` opened an independent namespace and passed no
Account to the lower-level SQL owner. That owner already supports account
identity. Local Mail previously opened Personal data alongside account-independent SQL,
although its storage comments described account-isolated files.

A store already captures its definition ID, Local or Personal scope, admission,
and document/blob lifetime. Repeating that selection at a separate SQL opener
adds an opportunity to choose the wrong namespace. An account's local SQL is
local storage even though its ownership is account-specific.

## Decision

**Every Local and Personal store exposes a borrowed `sqlite` namespace alongside
tables, KV, and blobs.** The definition remains `defineStore({ id, title?, tables,
kv })`. SQLite adds no declaration field or opt-in mode. The package remains
`@epicenter/app`; no aggregate App constructor returns.

Current API:

```ts
const personal = await openPersonal(definition, { account });
try {
  const opened = await personal.sqlite.open('search-index');
  if (opened.error) throw opened.error;
  const database = opened.data;
  // Use database's existing query methods.
} finally {
  await personal.close(); // Closes the document, blobs, and SQL access.
}

// Device-owned workflows instead use openLocal(definition) and local.sqlite.
// Opening either scope does not open the other.
```

`sqlite.open(name)` and `sqlite.delete(name)` retain their Result contracts.
The borrowed namespace has no public `close()`. The store closes its SQL
namespace; individual database deletion retains its existing connection-fencing
semantics. Ordinary store close preserves committed data.

Local SQL is keyed by the definition ID and database name within the device
profile. Personal SQL additionally captures authority and principal before the
first asynchronous acquisition. Alice, Bob, and signed-out Local have separate
namespaces. Handles never retarget after sign-in or account replacement. These
identifiers remain private on store handles. SQL is not synchronized, a mirror
of Yjs tables, or a source of automatic Yjs mutations.

Store opening reserves and acquires the SQL namespace together with its document
and blobs. A ready store has usable SQL namespace access. Named databases still
open explicitly on `.sqlite.open(name)`; they are not eagerly opened at store
startup. If namespace acquisition fails, store opening fails and unwinds all
acquired resources. This deliberately makes SQL namespace availability part of
store readiness; there is no optional SQL failure mode.

Close fences all store capabilities before awaiting cleanup, settles admitted
SQL operations and late acquisitions, and releases ownership only when every
owned resource is safe. Failed cleanup retains the necessary exclusion. The
existing SQL owner continues protecting physical connections; ownership nesting
does not justify deleting its admission or operation ordering.

Store test runtimes supply isolated, complete SQL bindings alongside documents
and blobs. An explicit test runtime must never fall through to production SQL.
The low-level SQL engine and protocol owners remain reusable implementation
boundaries. Remove the public standalone `openSqlite` constructor after all
product callers use the containing store. A real SQL-only caller must be audited
before that removal; do not manufacture an empty store merely to hide a gap.

## Consequences

An application chooses storage ownership once. Services receive the containing
store's SQL capability instead of choosing another ID or account. Secrets,
recording, and inference keep their separate contracts. SQL projections of Yjs
remain a separate, unbuilt feature.

Preserve existing namespace encodings. Local keeps its current no-account SQL
address; Personal uses the existing authority/principal encoding. Previously
account-independent Local Mail files cannot be assigned to the current account
by guessing. Do not copy, rename, delete, or silently adopt those files. Document
the fresh Personal namespace and any needed recovery workflow before claiming
product migration is complete.

This decision changes API ownership, not stored document layout, sync protocol,
or retention policy. In particular, an account-scoped SQL database can contain
the only copy of pending work and is not automatically disposable.

## Considered alternatives

- Separate device and account SQL constructors: preserve repeated identity and
  lifetime selection that the containing store already owns.
- `openSqlite({ id, account? })`: a missing account silently changes ownership.
- `personal.sqlite` with an independent closer: exposes two owners of one lifetime.
- Eagerly open every named database: products select names dynamically and may
  never need SQL during a session.
- Restore a generic App handle: recording and inference do not need to share
  the data store's ownership or readiness.

## Migration and cleanup boundary

Local Mail now borrows Personal SQL. Its old `no-account` databases remain untouched
and are not automatically visible. Recovery requires explicit ownership selection
and import tooling, which is not implemented. Reconnecting Gmail cannot reconstruct
old pending triage. The [Local Mail README](../../apps/local-mail/README.md#existing-local-mail-data)
records the inventory and user-visible limitation. Secrets retain their independent
application-scoped identity; this change does not claim credential isolation.

ADR-0437 remains proposed. No sign-out checkbox, account-data erasure, SQL
disposability classification, or interruption recovery is implemented here.
