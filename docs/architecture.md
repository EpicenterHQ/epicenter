# Epicenter architecture

Epicenter is a local-first personal data platform. An application holds a
complete replica of its own data and reads it synchronously; a hosted or
self-hosted authority keeps a person's devices converged while they sleep.

This page is the five-minute map. Durable decisions live in
[`docs/adr`](adr/README.md). Shared vocabulary lives in
[`docs/CONTEXT.md`](CONTEXT.md). Package-owned current behavior belongs in
package READMEs and code. For how this replaced the previous stack, verb by
verb, see
[`the store and what it replaced`](the-store-and-what-it-replaced.md).

## The direction

> Epicenter keeps your data understandable and your actions explicit. Account
> records synchronize; files have independent local and remote lives. Recordings
> save locally first and reach another device only through an explicit upload.
> Your data can become readable Markdown that you or an agent can edit, then
> push back into the app. Recovering older content uses that same workflow.
> A separate backup product is deferred.

The working folder contains documents, settings, and a checkout manifest. Blob
IDs and remote URLs remain ordinary references; materialization neither copies
local audio nor fetches remote audio. Saving a copy of that folder preserves its
current contents, including unpushed edits, not every byte the app can reference.

Pull writes app data to the folder. Push previews and applies folder edits
relative to the manifest. Deleting a tracked Markdown file deletes its row on
approved Push, but never deletes its blobs. Trash is an application field.
Recover selected old content by first pulling the current working copy, keeping
its manifest, then copying in old content and pushing. Missing rows receive fresh
identities; invalid content can be edited and retried.

This folder workflow is wired into host-backed Honeycrisp. Whispering's existing
Markdown ZIP is a one-way recording export, without a manifest, settings, or
audio; it is not yet the same workflow. Unused backup orchestration and structural
archives are removed; live library safeguards remain under
[ADR-0379](adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md). [ADR-0394](adr/0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md)
and [ADR-0395](adr/0395-restore-is-one-request-that-carries-its-own-safety-copy.md)
record the folder and recovery decisions.

## One runtime

A desktop SPA in a WebView, over a store the client owns (ADR-0227). The Bun
host serves bundles and brokers credentials. It owns no application data and
constructs no database (ADR-0226).

Serving that same bundle over HTTP is not a second runtime, because there is no
platform seam left to differ: every build opens its own store. What ADR-0227
refused was a hosted surface that reached a host-owned replica instead.

## The stack

```text
+---------------------------------------------------------------------------+
| APPS                                                                      |
|                                                                           |
| honeycrisp   whispering   vocab   skills   epicenter   sync-lab           |
| api          self-host    landing  matter  local-books  local-mail        |
+---------------------------------------------------------------------------+
                                     |
                                     v
+---------------------------------------------------------------------------+
| SURFACE                                                                   |
|                                                                           |
| @epicenter/ui        @epicenter/app-shell     @epicenter/svelte         |
| @epicenter/chat      @epicenter/blobs         @epicenter/skills           |
+---------------------------------------------------------------------------+
                                     |
                                     v
+---------------------------------------------------------------------------+
| CORE                                                                      |
|                                                                           |
| @epicenter/app       declarations, lifetime, store, persistence, and sync |
| @epicenter/app/field release-local field declarations                     |
| @epicenter/sqlite    one engine seam over bun:sqlite and sqlite-wasm      |
| @epicenter/sync      route contracts a browser can import                 |
| @epicenter/server    the shared Hono library both deployables consume     |
+---------------------------------------------------------------------------+
```

`@epicenter/app` supplies `defineApp`, `defineTable`, and `field` at its root.
The declaration is platform-free. `openApp(definition, account?)` from
`@epicenter/app/open` acquires the live App.
Independent `/definition`, `/store`, `/sync`, and `/artifact/format`
entrypoints let engine consumers load only their required modules. The Bun
memory opener has a separate entrypoint because it imports `bun:sqlite`.
`/data` opens over caller-owned SQLite; browser persistence is internal to App. See the [application architecture](../packages/app/ARCHITECTURE.md). There is no `./projection`: the packaged SQL
follower was deleted (ADR-0269), and a derived index is now app-owned, in
memory, and rebuilt on read (ADR-0307).

`@epicenter/server` and the core packages above it are AGPL. See
[`licensing strategy`](licensing/licensing-strategy.md).

## An application has one database document

One database `Y.Doc` per application is persisted under the application log
name `app` (ADR-0257). Its current top-level roots are the bare named root
`kv` and one `tables:<name>` root for each declared table. Each table declares
ordinary value fields and one required `content` codec.

```text
Y.Doc "app"
 |- get("kv")               one value: this application's settings
 |- get("tables:notes")
 |   |- <rowId>             a nested Y.Type; holding it IS existing
 |   |   |- title           a field is an attribute on the row
 |   |   `- folderId
 |   `- <rowId> ...
 `- get("tables:folders")
```

A row is an attribute on its table root rather than a root of its own. That is
not a style choice: `Item.write` scans `doc.share` linearly, so one root per row
makes encoding quadratic, measured at 5,417 ms against 13 ms at 20,000 rows.
Deletion removes the row's attribute outright and the whole subtree goes with
it, which leaves one deleted map key rather than a permanent corpse. The row is
flat at the public API: `id`, its value fields, and one live `content` node.

## Content is one live node on the row

The `content` codec only maps that node to and from the artifact body:

```ts
const row = data.tables.notes.get(noteId);
row?.title;
row?.content; // the live Y.Type an editor binds to directly
```

Storage mints an empty `content` node when a row is created without one, and
deleting the row removes the node with the row. Lists and previews read value
fields without opening another document; editors bind the row's live node.

## What granularity an edit has

| edit | merge |
| --- | --- |
| two devices, different fields of one row | both survive |
| two devices, one value field | last write wins |
| two devices, one array or object field | last write wins on the WHOLE value |
| two devices, an edit inside a row's content node | per character |

The third row is a decision, not a gap (ADR-0228). A field is one value, which
is one sentence of semantics instead of a per-field CRDT type system. The cost
is that a set several devices append to concurrently loses an addition, and the
answer is that such a collection wants to be a table, where each element is its
own row and nothing collides.

## Data definitions never migrate user data

A data definition is a release-local view over durable JSON (ADR-0255). A
release may add a field, remove one, or change validation. Rows that no longer
conform stay exactly as written and surface as nonconforming for that release.
Nothing copies a database, runs an upcaster, or reinterprets an old write.

Prevention is not available and asking for it is the wrong axis. A declaration is
release-local and rows arrive from NEWER releases, so no discipline in this
release stops a future one retyping a field. What exists instead is the material
to heal: `rows` and `nonconforming` are separate table reads, each failure carries its
`address`, machine-readable `issues`, the `conforming` survivors and the
unmodified `raw`, and repair is an ordinary `update` because a patch validates
only the values it supplies. A derived index cannot help here: it is built from
rows that conformed, so a repair surface finds its subjects through
`nonconforming` rather than through SQL.

```text
durable JSON stays unchanged
        |
        +-- old release's declaration -> one interpretation
        `-- new release's declaration -> typed rows plus nonconforming diagnostics
```

## Reads are synchronous

`openApp` returns a handle synchronously. `app.ready` waits for storage
acquisition and durable replay. Once ready, row and KV operations read and edit
the in-memory document synchronously; persistence and network work remain async.

```ts
import { openApp } from '@epicenter/app/open';

const app = openApp(honeycrispDefinition, account);
const ready = await app.ready;
if (ready.error !== null) throw ready.error;
const data = app.account.personal;
const rows = data.tables.notes.rows;
const nonconforming = data.tables.notes.nonconforming;
data.tables.notes.update(noteId, { title: 'x' });
data.tables.notes.subscribe(() => { /* refresh the table view */ });
// The page stops producers and awaits app.close() before leaving.
```

`subscribe` names the rows a commit touched (ADR-0221), so a view refreshes
what moved rather than everything. SQL, when an application wants it, is a
follower it composes over this surface, rebuilt from the live document at the
next read (ADR-0241). The package shipped one and nothing composed it, so it
was deleted (ADR-0269): a person who wants to read their data outside the app
reads the export, which is Markdown files (ADR-0268).

## Where the durable facts live

The store keeps the update log and the authority positions a crash cannot
reconstruct (ADR-0238, amended by ADR-0300). Each update record carries its
authority position, so the outbox and cursor are read from the same `updates`
store. There is no worker and no OPFS, and nothing derived is restored, only
rebuilt.

History lives outside the CRDT (ADR-0214). The document runs with garbage
collection on, which is what collapses a field edited five thousand times to two
structs.

## The authority owns availability, not meaning

The mounted authority uses a stable application/library/data address resolved
from the authenticated principal. It owns the current generation and appends
opaque bytes without interpreting row values. Historical per-generation objects
are a different layout; the historical ledger still prevents silently opening
an empty replacement over existing data.

Being signed in is the whole of the sharing model. The route stamps the
principal from the bearer and addresses one Durable Object by it, so every
device on one account converges without anything being paired or invited.

The host supplies only `dial`, a function that makes a socket. The library owns
the cursor, attach and detach, reconnect on close and on `needsResync`, and the
unacknowledged-submission watchdog (ADR-0222).

Blobs are a separate plane and were never CRDT-backed. Rows store opaque minted
keys or ordinary remote URLs. App-local bytes and account-remote objects have
independent lifetimes; uploads are explicit, with no automatic byte sync or
row-driven cleanup.

## Two deployables, one library

`packages/server` is the shared Hono library. `apps/api` is the hosted personal
cloud and `apps/self-host` is the self-hosted single-partition instance
reference, which is community-supported rather than Epicenter-operated. They
differ by principal resolver: an instance resolves every valid bearer to the
literal `instance` principal (ADR-0075, amended by ADR-0092). Billing is
hosted-only and lives in `apps/api/worker/billing/`.

## Implementation status

ADRs describe decisions, not a current build report. Check the affected app's
code and verification scripts before treating historical migration checkpoints
as present failures. The archive/recovery cleanup plan above names the remaining
work without classifying live startup and synchronization safeguards as obsolete.
