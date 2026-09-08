# 0355. Local and account sessions share the application data API

- **Status:** Proposed
- **Date:** 2026-09-07
- **Amends:** [ADR-0336](0336-an-authority-mints-every-generation-so-every-store-has-an-account.md) at account-required storage and generation creation; [ADR-0350](0350-a-data-session-is-a-value-the-tree-owns-and-sync-runs-for-the-life-of-the-store.md) at one active session per app and unconditional sync; [ADR-0352](0352-an-account-s-data-and-a-device-s-files-are-two-packages-because-only-one-of-them-is-removed.md) at account-only access to declared tables and device-only ownership of named SQLite files. Secrets remain a separate device capability.
- **Unbuilt:** Local table sessions, the two explicit openers, the common application blob handle, declared blob fields, authority-scoped storage addresses, scoped named SQLite files, and explicit imports between local and account libraries.

## Context

`createEpicenter({ appId, definition })` in `packages/app/src/index.ts`
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

The target call sites below describe APIs to build, not current exports:

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
});

const localSession = epicenter.openLocal();
const accountSession = epicenter.openAccount(account);
```

`appId` is a reverse-DNS application identity. The data definition ID identifies
its schema independently, even when the strings match. Definitions perform no
storage I/O and capture no account. `field.blob()` belongs with the field
declarations and describes an owning attachment field; it constructs no store.

Both openers return a session with `opened` and `close`. Whole-library removal
belongs to the app factory, with its final public spelling still to be chosen. `opened` resolves a typed Result containing the common
application handle. Acquisition and release are coordinated per storage address;
opening one scope does not supersede another. Account sessions capture one
account for their lifetime. The initial API opens one default local library per
app and definition, without a named-workspace selector.

**Local and account sessions expose the same tables and blob methods.**

```ts
const opened = await localSession.opened;
if (opened.error) return handleError(opened.error);
const app = opened.data;

const created = await app.tables.recordings.create({
  title: 'Meeting notes',
  audio: capturedAudio,
});
if (created.error) return handleError(created.error);

const audioId = created.data.audio; // BlobId, not a URL or embedded bytes.
const source = await app.blobs.open(audioId);
// On success, release source.data with Symbol.dispose after playback use.
```

The table integration commits bytes locally before publishing their row
reference. Rows synchronize references, never attachment bytes. Each attachment
creation mints an independent immutable identity. Replacement creates another
identity. The integration owns recovery and eventual cleanup for its owning
fields; the application chooses retention policy and explicit deletion actions.
Creation is asynchronous and fallible. It does not promise atomicity across the
row store and byte store.

| Application blob member | Contract |
| --- | --- |
| `supportsRemote` | Readonly capability fixed for the session, never a reachability test |
| `add(blob)` | Mint an immutable ID, save locally, return the ID |
| `get(id)` | Read local bytes as a JavaScript `Blob` |
| `stat(id)`, `statMany(ids)` | Read local size and content type |
| `open(id)` | Acquire a disposable local playback/display URL |
| `upload(id)`, `download(id)` | Explicit same-ID copies between local storage and the configured remote |
| `removeLocal(id)`, `removeRemote(id)` | Remove only the named copy |

Operations return typed Results. Local sessions have `supportsRemote === false`;
remote operations return `RemoteNotConfigured` without network I/O. An offline
account session still supports remote operations, which can fail on transport.
Signing in elsewhere never changes a local session's capability. `get` and
`open` have no implicit download fallback.

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

Each resource records its format or schema compatibility in its own metadata.
Openers migrate supported older formats and refuse unsupported newer ones before
mutation. Applications own migrations of their named SQL schemas. Format
versions, application releases, and data generations remain separate concepts.
An incompatible build must not silently create a second usable library. Migration
may stage a temporary copy but must have one authoritative result and a resumable
cutover. Existing v5 addresses require an explicit migration into stable addresses;
this decision does not rename or overwrite existing bytes in place.

An authority ID identifies a synchronization destination independently of its
principal IDs. Its stable identity and authenticated association with a server
must be specified before implementing account addresses. A raw URL is not
silently treated as a stable identity. Hosted and self-hosted authorities use
the same grammar, including instances that resolve all credentials to `instance`.
This local layout does not prescribe a new remote object-key or wire format.

Blobs sit beside data generations so restoring rows can reuse existing bytes.
Erasing an account's local scope leaves the local library and other accounts
untouched. Local-library removal is explicit and independent of sign-out.
Session erasure coordinates active work before removing the selected scope.

**Named SQLite files inherit the session scope and remain local on that device.**

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

Today `device.sqlite.open(name)` in `packages/device/src/index.ts` is device-only.
The native owner uses `<root>/apps/<app-id>/sqlite/<name>.sqlite`; the browser
worker maps it to `/<encoded-app-id>-<encoded-name>.sqlite` inside its OPFS pool.
Moving these files into `local/sqlite/` requires explicit migration. Existing
device files must never move into an account scope merely because someone signs
in. A SQLite-only application must retain an independent scoped opener without
having to declare tables or open a replica. Secrets retain their device lifetime
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
| Session | `opened`, `close()` | One captured ownership scope |
| Opened application | `tables`, `blobs`, `sqlite` | Bound to the session |
| SQLite namespace | `open(name)`, `delete(name)` | Named files within the session scope |
| Opened SQL database | `run(sql, parameters?)`, `all(sql, parameters?)`, `batch(statements)` | Released with its session |

SQL operations preserve the existing asynchronous Result contract. `batch`
executes its statements transactionally; the application API does not accept an
asynchronous transaction callback across a worker or host boundary. Repeated
opens of one name share coordinated underlying ownership. `sqlite.delete(name)`
closes and invalidates existing handles for that name before removing its files;
a later explicit open creates a fresh database. Session closure prevents new
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
A client-only application may export a session at module scope and gate its
consumers on `session.opened`. An application may instead own the session in a
component and pass its resolved handle through props or context. Both use the
same session and application contracts. Framework signals do not change promise
readiness or module evaluation order.

A module-level session exposes lifecycle and readiness immediately; it does not
expose ready tables synchronously. An app that wants descendants to import a
ready-only facade directly must own that facade and the gate that protects its
reads. The exact facade, if needed by Epicenter's apps, remains an app-composition
choice rather than a second storage implementation. Instance scripts below a
successful gate run after readiness; imported module initializers do not gain
that guarantee. Multiple simultaneous library instances need explicit selection
or subtree scoping instead of one ambiguously selected global handle.

## Contracts to resolve before implementation

The public composition above is settled; the following mechanisms still need
concrete designs and validation:

- Stable authority identity and its authenticated binding to hosted and
  self-hosted endpoints, including address changes and legacy migration.
- Resource format metadata, interrupted storage migration, and older-build refusal,
  across IndexedDB, OPFS, and native roots.
- Local generation allocation and compaction without a remote acknowledgment,
  plus coordination across tabs and processes.
- Attachment cleanup and replacement, transfer/deletion races, durable upload
  receipts, and a status API that distinguishes local presence from a historical
  remote acknowledgment. `supportsRemote` answers none of those questions.
- A standalone SQL/blob opener that inherits the same scope without requiring
  a data definition or replica. Its exact constructor remains to be designed.
- Resumable application imports with ID mappings and explicit completion criteria.

## Build toward the decision

1. Specify the authority identity, address codec, and generation bookkeeping.
   Design an explicit, resumable migration from v5 browser stores and existing
   native storage. Preserve ownership and verify copies before deleting sources;
   never assign unscoped legacy bytes to the next account that signs in.
2. Add durable local opening and per-address session coordination. Prove restart
   persistence without credentials, simultaneous local/account opening, and
   isolated close and erasure before changing application boot gates. Add scoped
   SQLite opening with the same address codec, preserving standalone SQL use
   and migrating existing device databases into the local branch.
3. Compose the uniform blob handle over existing primitives. Verify immutable
   identity, unsupported remote Results, offline capability semantics, and
   platform-owned streaming without routing desktop recordings through a WebView.
4. Add the blob field descriptor and table integration. Specify interrupted
   creation, replacement, deletion, synchronized upload receipts, and cleanup
   before claiming lifecycle reliability. A receipt describes an acknowledged
   upload, not verified current remote presence. Arbitrary direct row mutation
   must not bypass the owning-field contract.
5. Move Whispering's first-run path to its local session. Offer account libraries
   and explicit import, then individual and bulk upload. Prove interrupted import
   recovery, source preservation, and download/playback on a second device.

## Consequences

A fresh installation can keep recordings without sign-in. Local and account UI
features accept the same table and blob contracts. Account changes cannot claim
local recordings. Local-only use requires neither SQLite-specific application
code nor a configured self-hosted server.

Two libraries consume separate storage, and importing duplicates rows and bytes.
Applications must explain library selection and import progress. Account storage
migration needs an authority identity that the current address lacks. Uniform
remote methods add an unsupported-operation Result to local handles. Attachment
fields move recovery responsibility into the integration; a field descriptor
alone does not remove failure windows.

## Considered alternatives

- `openLocal()` beside `open(account)`: the asymmetric names obscure the ownership choice. Use `openAccount(account)`.
- Separate local and account table APIs: callers would duplicate features for the same row operations.
- A local session gains synchronization after sign-in: this makes an existing account library's merge policy implicit.
- Account-required storage with offline caching: a fresh installation still cannot create its first recording without credentials.
- App-bound field builders: field declarations need neither an app ID nor a live session.
- Optional remote namespaces: callers must branch through a different object shape. A fixed capability and typed Results preserve one application handle.
