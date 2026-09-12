# 0355. Local and account sessions share the application data API

- **Status:** Accepted
- **Date:** 2026-09-07
- **Amended by:** [ADR-0359](0359-the-document-factory-owns-readiness-and-closure.md) at the live handle's construction mechanism: the document factory owns readiness and closure.
- **Amended by:** [ADR-0375](0375-library-ownership-is-local-personal-or-shared-within-one-deployment.md) at the opening API and account identity as a complete library selector: `openPersonal(account)` replaces `openAccount(account)`, and `openShared(account)` opens a distinct library as the same person. The common data API, readiness, and closure remain.
- **Amended by:** [ADR-0389](0389-the-open-call-decides-the-app-s-type-and-a-local-app-has-no-account-members.md) at the shape of the returned handle: the shared data API stands, and the account-only members `account`, `retirement`, and account inference exist only on an account session's type.
- **Amended by:** [ADR-0392](0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md) at the opening API: one `open(account)` returns one App with a `device` scope and an optional `account` scope, rather than separate local and account sessions. The common data API, readiness, and closure remain, and `openLocal`, `openPersonal`, and `openShared` go with the old shape.
- **Amended by:** [ADR-0400](0400-device-sqlite-and-secrets-key-by-application-id.md) at the storage address of named SQLite files: `sqlite/<database-name>.sqlite` exists under `local/` only, not under `accounts/<authority-id>/<principal-id>/`.
- **Amends:** [ADR-0336](0336-an-authority-mints-every-generation-so-every-store-has-an-account.md) at account-required storage and generation creation; [ADR-0350](0350-a-data-session-is-a-value-the-tree-owns-and-sync-runs-for-the-life-of-the-store.md) at one active session per app and unconditional sync; [ADR-0352](0352-an-account-s-data-and-a-device-s-files-are-two-packages-because-only-one-of-them-is-removed.md) at account-only access to declared tables and the ownership of named SQLite files. Secrets remain a separate device capability.
- **Implementation note:** Local and account openers, the common application blob handle, declared blob fields, authority-scoped data/blob addresses, and scoped named SQLite owner protocol are implemented. Every application composes a runtime SQLite owner through its build-time platform seam; the app handle never exposes an absent or frozen compatibility capability.

## Context

`createEpicenter({ appId, definition, sqlite })` in `packages/app/src/index.ts`
currently opens one account-bound session through `open(account)`. The store
apps gate interaction on identity. An existing account replica can open offline,
but a fresh installation cannot create a durable recording library without an
account. The product must let a person install an app, record, quit, and reopen
the recording without configuring an account or server.

`packages/blobs/src/browser.ts` stores account bytes in IndexedDB at
`epicenter/v5/<app-id>/<principal-id>/blobs`. Its portable `BlobStore`,
`BlobRemote`, and `BlobSources` contracts already separate local persistence,
explicit transfer, and playback sources. Whispering composes these with its
recording rows. `defineTable` currently requires an explicit content codec;
audio is a string field containing a blob ID, with a separate `uploadedAt` field.

The account-required rule is being reconsidered. Sign-in must not adopt a local
library or merge it into an existing account library. An explicit import can
read both libraries while preserving the source.

## Decision

**An application declares its data once and opens separate local and account sessions.**

The canonical call site is:

```ts
import { createEpicenter } from '@epicenter/app';
import {
  defineData,
  defineTable,
  field,
  plainText,
} from '@epicenter/data/definition';

const definition = defineData({
  id: 'so.epicenter.whispering',
  kv: {},
  tables: {
    recordings: defineTable({
      title: field.string(),
      audio: field.blob(),
      content: plainText(),
    }),
  },
});

const epicenter = createEpicenter({
  appId: 'so.epicenter.whispering',
  definition,
  sqlite: platformSqliteOwner,
});

const localApp = epicenter.openLocal();
const accountApp = epicenter.openAccount(account);
```

`appId` is a reverse-DNS application identity. The data definition ID identifies
its schema independently, even when the strings match. Definitions perform no
storage I/O and capture no account. `field.blob()` belongs with the field
declarations and describes an owning attachment field; it constructs no store.

Both openers return one live application handle. It owns readiness, operations,
and closure; there is no separate `session.app` or resolved application object.
Acquisition and release are coordinated per storage address, so opening local
and account data simultaneously does not supersede either handle. The initial
API opens one default local library per app and definition.

**Each application runtime opens a given address once.**

Applications construct a handle once and distribute it by import, props, or
context. A second live open of the same address is unsupported and resolves its
`ready` with a typed duplicate-open failure; it never replaces or shares the
first handle. Closing the rejected handle cannot close the first. After complete
closure, an explicit open may acquire the address again. Local and account
addresses are distinct and can coexist. Another browser tab is another runtime;
storage locks and the platform owner must still prevent conflicting writes.
This rule adds no public registry, lease, or reference-counted handle.

**The application exposes account identity once and readiness once.**

`app.account` is readonly `AccountIdentity | null`, available immediately and
fixed for the handle's lifetime. `AccountIdentity` contains `authorityId` and
`principalId`, without credentials. Null means this device's local dataset;
non-null means the dataset selected by that account identity. The public handle
has no `scope`, `isLocal`, or blob-specific remote-availability flag. Account
identity describes the opened dataset, not the current global sign-in state.
Account transport remains bound to the account captured by the opener. Sign-out
can retire that transport without changing the dataset identity; a non-null
`app.account` is not proof of current authorization.

`app.ready` settles once as `Promise<Result<void, OpenError>>`. Success means
this dataset's local tables and capabilities can be used. Account opening does
not initiate sign-in: it receives an already established account. An existing
local replica can become ready offline; a first account open may need the
authority to resolve or create a generation. Readiness does not await full sync,
blob downloads, or backup completion.

Storage-dependent access before readiness or after closure fails explicitly.
The ordinary UI prevents premature access by rendering children only after a
successful ready Result. A failed initialization never renders those children.
`close()` owns release while opening or ready and is idempotent. Its completion
means acquisition and resource release have settled, not merely that a closed
flag was set. `ready` does not become pending again on closure; the owner must
remove consuming UI before or with closing the handle. The gate proves initial
readiness, not perpetual liveness. Closing preserves durable data. Whole-library
removal is separate.

**Local and account handles expose the same table and blob methods.**

```ts
const app = epicenter.openLocal();
const ready = await app.ready;
if (ready.error) return handleError(ready.error);

const created = await app.tables.recordings.create({
  title: 'Meeting notes',
  audio: capturedAudio,
});
if (created.error) return handleError(created.error);

const source = await app.blobs.open(created.data.audio);
// On success, release source.data with Symbol.dispose after playback use.
```

Examples retain full paths such as `app.tables.recordings.create(...)` instead
of introducing aliases for namespaces that add no meaning.

The table integration commits bytes locally before publishing their row
reference. Rows synchronize references, never attachment bytes. Each attachment
creation mints an independent immutable identity. Replacement creates another
identity. The integration owns recovery and eventual cleanup for its owning
fields; the application chooses retention policy and explicit deletion actions.
Creation is asynchronous and fallible. It does not promise atomicity across the
row store and byte store.

| Application blob member | Contract |
| --- | --- |
| `add(blob)` | Mint an immutable ID, save locally, return the ID |
| `get(id)` | Read local bytes as a JavaScript `Blob` |
| `stat(id)`, `statMany(ids)` | Read local size and content type |
| `open(id)` | Acquire a disposable local playback/display URL |
| `upload(id)`, `download(id)` | Explicit same-ID copies between local storage and the configured remote |
| `removeLocal(id)`, `removeRemote(id)` | Remove only the named copy |

Operations return typed Results. `app.account === null` means remote operations
return `RemoteNotConfigured` without network I/O. Every account handle configures
remote transfer, even while offline; transport and authorization can still fail.
There is no second capability fact to maintain. Signing in elsewhere never
changes a local handle's identity. `get` and `open` have no implicit download
fallback. Independently composed blob primitives still receive their remote
explicitly and need no application account metadata.

The portable storage contract retains `put(id, blob)` for caller-supplied IDs,
including downloads. The application handle composes storage, transfer, and
source contracts. SQLite-only applications can use those contracts independently
of declared tables. SQLite-backed bytes can participate in a row transaction
only through an explicit same-database transactional write path.

**Storage addresses separate local ownership from account ownership on every platform.**

Under a stable storage root, the target hierarchy is:

```text
<app-id>/
  local/
    data/<definition-id>/<generation-id>/
    blobs/
    sqlite/<database-name>.sqlite
  accounts/<authority-id>/<principal-id>/
    data/<definition-id>/<generation-id>/
    blobs/
    sqlite/<database-name>.sqlite
```

Filesystem implementations mirror these directories beneath their configured
root. Generation directories contain the engine's database files; `blobs/`
contains objects addressed by blob ID. IndexedDB uses the corresponding
slash-separated address as each database name: one database per generation and
one blob database per ownership scope, with blob IDs as keys inside it. Slashes
in IndexedDB names do not create directories. Physical file leaves remain
engine-owned.

The root is `epicenter/` in browser storage names and
`<configured-root>/epicenter/` on the filesystem. It contains no `vN` directory.
One shared address codec owns validation and encoding across data, blobs, and
named SQLite files. Segments must be unambiguous and safe; a fabricated principal
named `local` is not a scope. The browser origin and filesystem root remain outer
isolation boundaries.

**The implementation is a clean break with no legacy data migration.**

The new stable layout is the only layout the new implementation reads or writes.
Delete old address builders, migration readers, unscoped-blob claiming workflows,
compatibility overloads, and fallback storage paths. Existing v5 and native flat
stores are not imported, adopted, or consulted. No storage-format version belongs
in the root. Future resource formats may declare compatibility in resource-local
metadata, but this work adds no general migration framework.

Temporary repository breakage is allowed while replacing the implementation and
its callers. Final verification must pass; intermediate compatibility adapters
are not required to keep old call sites compiling. This authorizes removing
legacy support, not an unsolicited sweep deleting files from a person's device.
Development and verification use fresh disposable storage roots and origins.

An authority ID identifies a synchronization destination independently of its
principal IDs. Its stable identity and authenticated association with a server
must be specified before implementing account addresses. A raw URL is not
silently treated as a stable identity. Hosted and self-hosted authorities use
the same grammar, including instances that resolve all credentials to `instance`.
This local layout does not prescribe a new remote object-key or wire format.

Blobs sit beside data generations so restoring rows can reuse existing bytes.
Erasing an account's local scope leaves the local library and other accounts
untouched. Local-library removal is explicit and independent of sign-out.
Library removal coordinates active work before removing the selected scope.

**Named SQLite files inherit the app handle’s storage address and remain local on that device.**

The target application handle exposes `app.sqlite.open(name)` in both local and
account sessions. The caller supplies a database name without an extension; the
storage owner appends `.sqlite` exactly once. `open` and `delete` accept plain
strings and validate the existing name grammar, `^[a-z][a-z0-9_-]*$`, returning
`InvalidDatabaseName` before I/O. Paths, extensions, and case normalization are
not accepted. The application call site needs no `databaseName()` wrapper;
validated brands may remain internal. The native request boundary independently
validates incoming names. These are application-owned SQL
databases, separate from engine database files under `data/`.

```ts
// Proposed calls on successfully opened application handles.
const localDb = await localApp.sqlite.open('search');
const accountDb = await accountApp.sqlite.open('search');
```

The resulting relative addresses are:

```text
<app-id>/local/sqlite/search.sqlite
<app-id>/accounts/<authority-id>/<principal-id>/sqlite/search.sqlite
```

Each opener returns the same SQL database contract. Account-scoped SQL does not
synchronize automatically and accrues no remote delivery obligation. Its scope
controls isolation and local erasure. SQLite files sit outside generations, so a
generation change does not delete them; an application that uses one as a derived
index must invalidate or rebuild it when its source generation changes.

Native storage uses these physical paths beneath the stable root. Browser
SQLite uses OPFS, not an IndexedDB database containing SQL rows. Its VFS receives
the same logical address. A pooled VFS may map that address to opaque physical
OPFS files; the contract does not require those pool files to mirror directory
names. SQLite journal and WAL sidecars belong to the same database lifecycle.
Closing and erasing a scope must coordinate its SQL handles and sidecars as well
as its table and blob stores.

The runtime constructors expose the same scoped SQLite capability as the app
handle, bound to `{ kind: 'local' }` for device-local consumers. The app
composition uses the same owner protocol with the captured local or account
scope: the native owner writes `<root>/apps/<app-id>/local/...`
or `<root>/apps/<app-id>/accounts/<authority-id>/<principal-id>/...`, while the
browser worker maps the same logical scope to an opaque OPFS filename. It has no
reader or migration for the earlier flat files. Signing in never adopts local files
into an account directory. A SQLite-only application can use the scoped opener
without declaring tables or opening a replica. Secrets retain their device lifetime
outside local/account library erasure.

**A local generation is created locally and never becomes an account generation.**

The local opener creates and durably records its initial generation without an
HTTP request, then reopens it on subsequent launches. The account authority
continues to mint account generations. Local writes accrue no remote delivery
obligation and start no sync driver. Generation representation and compaction
rules must be verified against the engine before implementation; sharing the
public table API does not imply identical replication bookkeeping.

**Import copies between independently opened libraries without changing either library's ownership.**

An application reads source rows and bytes and creates destination rows and
attachments. The destination receives new identities. The application owns
selection, relationship remapping, duplicate handling, and progress reporting.
The framework can supply copying mechanics without choosing those policies.
Source data remains until separately deleted. Copying into an account library
commits to that account's local storage; remote backup is a separate operation.
Retryable imports must track completed mappings or otherwise prevent duplicates.
Missing source bytes are reported, never treated as a completed copy.

## Application API inventory

These are target members, not additional current exports:

| Owner | Members | Lifetime |
| --- | --- | --- |
| App factory | `openLocal()`, `openAccount(account)` | Inert app identity and definition |
| Live application | `account`, `ready`, `tables`, `kv`, `blobs`, `sqlite`, `close()` | One local or account dataset |
| SQLite namespace | `open(name)`, `delete(name)` | Named files within the session scope |
| Opened SQL database | `run(sql, parameters?)`, `all(sql, parameters?)`, `batch(statements)` | Released with its session |

The inventory names the main capabilities, not permission to delete existing
data behavior. Preserve declared KV access on `app.kv`, content operations, and
observation capabilities where real callers need them, without a second data
wrapper.

SQL operations preserve the existing asynchronous Result contract. `batch`
executes its statements transactionally; the application API does not accept an
asynchronous transaction callback across a worker or host boundary. Repeated
opens of one name share coordinated underlying ownership. `sqlite.delete(name)`
closes and invalidates existing handles for that name before removing its files;
a later explicit open creates a fresh database. App closure prevents new
operations and coordinates in-flight work before releasing resources.

Whole-library removal is an app-factory operation that removes a selected local
ownership scope: data generations, blobs, and named SQL files. It does not delete remote
account data or secrets. Since blobs and SQL files are shared across definitions
within that scope, erasure must exclude or close every active session using the
scope, not only one definition. Failure leaves affected sessions closed and reports
incomplete erasure; it never reopens implicitly. The existing account-side use
case is "Sign out and remove local data" on a shared device. Local-library
removal is a destructive reset, not cache eviction: it can delete the only copy
of recordings. Remote account deletion and safe cache eviction are separate
operations and are not added by this decision. Final factory method names and
the need for a public local reset remain open for product review.

**Applications can distribute a handle through singleton imports, props, or framework context.**

The API requires no context provider or framework-specific reactive wrapper.
A client-only application can export `const app = epicenter.openLocal()` at
module scope and gate consumers on `app.ready`. The successful branch can render
children that import that same `app`, or pass that same object through props or
context. No second facade is needed. Both distribution styles use one contract.
Framework signals do not change promise readiness or module evaluation order.

Instance scripts below a successful gate run after readiness; imported module
initializers do not gain that guarantee. Multiple simultaneous dataset handles
need explicit selection or subtree scoping instead of one ambiguously selected
global handle. Account-specific module singletons must not leak across server
requests. The singleton examples describe client-only ownership.

## Contracts to resolve before implementation

The public composition above is settled; the following mechanisms still need
concrete designs and validation:

- Stable authority identity and its authenticated binding to hosted and
  self-hosted endpoints, including address changes; no legacy migration is required.
- Resource-local format validation across IndexedDB, OPFS, and native roots,
  without adding compatibility readers for previous layouts.
- Local generation allocation and compaction without a remote acknowledgment,
  plus coordination across tabs and processes.
- Attachment cleanup and replacement, transfer/deletion races, durable upload
  receipts, and a status API that distinguishes local presence from a historical
  remote acknowledgment. `app.account` answers none of those questions.
- A standalone SQL/blob opener that inherits the same scope without requiring
  a data definition or replica. Its exact constructor remains to be designed.
- Resumable application imports with ID mappings and explicit completion criteria.

## Build toward the decision

Implement from the final call sites backward: identity and addresses, one-handle
lifecycle, local persistence, blob and SQL composition, attachment fields, then
application integration. Validate Whispering's record/restart/play path before
broadening the consumer sweep. An independent GPT-6 review follows each meaningful
slice, looking for duplicate facts and boundaries that no longer own a distinct
job. The implementing agent owns integration and verifies review findings.

Execution checkpoints and evidence targets live in
[the implementation spec](../../specs/20260907T231907-local-account-app-clean-break.md).

## Consequences

A fresh installation can keep recordings without sign-in. Local and account UI
features accept the same table and blob contracts. Account changes cannot claim
local recordings. Local-only use requires neither SQLite-specific application
code nor a configured self-hosted server.

Two libraries consume separate storage, and importing duplicates rows and bytes.
Applications must explain dataset selection and import progress. Account storage
needs an authority identity that the current address lacks. Previous on-disk
layouts are unsupported by the new implementation. Uniform
remote methods add an unsupported-operation Result to local handles. Attachment
fields move recovery responsibility into the integration; a field descriptor
alone does not remove failure windows.

## Considered alternatives

- `openLocal()` beside `open(account)`: the asymmetric names obscure the ownership choice. Use `openAccount(account)`.
- Separate local and account table APIs: callers would duplicate features for the same row operations.
- A local session gains synchronization after sign-in: this makes an existing account library's merge policy implicit.
- Account-required storage with offline caching: a fresh installation still cannot create its first recording without credentials.
- App-bound field builders: field declarations need neither an app ID nor a live session.
- Optional remote namespaces: callers must branch through a different object shape. `app.account` and typed Results preserve one application handle.

- Separate session and ready-app objects: one handle can own readiness, operations, and closure without a forwarding facade.
- `supportsRemote`, `isLocal`, or `scope` beside `app.account`: they repeat a fact already determined by account identity.
- Versioned storage roots and legacy import-on-open: they preserve an old format at the cost of duplicate paths; this implementation is a clean break.
- Same-address handle sharing: it makes one caller's close affect another caller; applications open an address once.
