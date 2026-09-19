# @epicenter/app

An opened App owns this application's device state and its signed-in account
stores for one page lifetime. Whoever opens it stops product work and awaits
`app.close()` before replacing the account. Screens borrow a store or capability;
the page coordinates departure.

The captured account scopes local storage as well as synchronized stores.
`openApp(definition)` and `openApp(definition, { account: undefined })` select a separate
`no-account` namespace.
Signing in never adopts that namespace; returning to an account restores its
own device data. Device storage stays local even when it belongs to an account.
In apps that support signed-out use, sign-out returns to the no-account
workspace, including recordings and audio created there before sign-in. That
workspace is shared by everyone using the app signed out in the same profile.
Account presence is a runtime fact. Narrow `app.account` before using its
stores, even when the opening call supplied an Account. This checks the captured
identity, not network reachability or authorization for a particular request.

```ts
import { defineApp, defineTable, field } from '@epicenter/app';
import { openApp } from '@epicenter/app/open';

const application = defineApp({
 id: 'so.epicenter.notes',
 title: 'Notes',
 kv: { language: field.string() },
 tables: { notes: defineTable({ title: field.string() }) },
});
const app = await openApp(application, { account });
try {
 // Every returned App is ready. Account remains optional in the type.
 app.device.tables;
 app.device.sqlite;
 app.account?.personal.tables;
} finally {
 await app.close();
}
```

The declaration exposes `id`, `title`, `kv`, and `tables` without opening
storage or capturing an Account. Schema tools, artifact import/export, and
`openMemory` accept that same declaration. Its tables describe fields; live
rows belong to `app.device` or `app.account.personal`.
The one `id` names both the application and its data. `defineApp` is the only
full declaration constructor. The declaration graph is platform-free. Schema
tools and engine tests consume it directly. Application tests use the same
`openApp` lifecycle as production, with a complete memory runtime.

## Package boundaries

`@epicenter/app` owns the declaration, application lifetime, and data engine.
The root supplies `defineApp`, `defineTable`, `field`, content codecs, and
inferred schema types. Engine consumers use independent entrypoints:

| Import | Consumer and purpose |
| --- | --- |
| `@epicenter/app/open` | `openApp(definition, { account?, runtime? })` and App capability types |
| `@epicenter/app/definition` | Reusable table declarations, schema inspection, compilation |
| `@epicenter/app/store` | Store handle and error types |
| `@epicenter/app/sync` | Client transport and server authority |
| `@epicenter/app/artifact` | Render and read application files |
| `@epicenter/app/artifact/format` | Host-side file framing without loading the store |
| `@epicenter/app/artifact/checkout` | Working-copy pull and push |
| `@epicenter/app/testing` | `createMemoryRuntime()` for complete App tests in isolated test processes |
| `@epicenter/app/memory` | Bun-backed in-memory stores for data-engine tests |
| `@epicenter/app/data` | `openData(definition, sqlite)` and `syncEngineOf`; caller owns SQLite |
| `@epicenter/app/field` | Field descriptors and date/string validation |

The root, schema, store, sync, and format entrypoints do not import the App
opener or browser/native platform implementations. Importing `openApp` loads
the browser and host implementations; calling it acquires resources.
`import-boundaries.test.ts` checks the platform-free graphs.

`openData` opens a data document over caller-supplied SQLite and leaves the
SQLite connection open when the document is disposed. `openMemory` is Bun test
support: it owns a fresh in-memory connection unless given a reusable
`MemoryRecord`. Neither function constructs an App or captures an Account.

`src/data/` holds the engine. Its [README](src/data/README.md) describes row,
persistence, and synchronization behavior. The [architecture map](ARCHITECTURE.md)
shows the package's consumers, module boundaries, and lifetime.

## Runtime selection

`openApp(definition, { account, runtime })` captures identity and uses one
complete runtime. Omit `runtime` to select browser or native services with
`isTauri()`. An explicit runtime supplies admission,
document storage, SQLite, blobs, secrets, recording, and AI connections. It
replaces the default completely; missing capabilities never fall back to
ambient browser or native resources.

The App owns readiness, sync, retirement, and cleanup. Its runtime owns the
storage behind those lifetimes. Browser recording publishes into IndexedDB.
Host recording publishes into the same app directory served by the host's blob
API. Account transport stays on the captured Account; a memory runtime does
not replace a server with simulated success.

```ts
import { openApp } from '@epicenter/app/open';
import { createMemoryRuntime } from '@epicenter/app/testing';

const runtime = createMemoryRuntime();
const app = await openApp(application, { runtime });
app.device.tables.notes.create({ title: 'Retained across App lifetimes' });
await app.close();

const reopened = await openApp(application, { runtime });
// The same runtime retains the committed rows, blobs, secrets, and SQL data.
await reopened.close();
await runtime.dispose();
```

`createMemoryRuntime` owns an isolated IndexedDB factory, its matching key-range
constructor, and in-memory SQL storage. It changes no globals and can coexist
with native browser storage. Browser integration tests also exercise the default
platform runtime. Closing an App releases its connections while retaining committed
records for another App lifetime. SQLite WASM `memdb` anchor connections belong
to the runtime. Each App gets separate connections, so close rolls back its
unfinished transactions and discards temporary tables without losing committed
data. Disposing the runtime closes the anchors and releases its storage
and refuses while an App still holds ownership. Failed cleanup is terminal;
page or process teardown releases the failed lifetime. Memory tests exercise production
persistence and query implementations; capture and network operations do not
pretend to succeed.

A second opening for the same app/account in one runtime rejects with
`AlreadyOpen`. Browser tabs coordinate through one Web Lock. There is no waiting
queue or takeover. A successful close permits another opening. Failed opening or
cleanup requires page teardown; cleanup failure retains ownership to prevent an
unsafe replacement. Reload does not prove unsaved changes survived.

The default runtime selects host services when `isTauri()` is true and browser
services otherwise (ADR-0403). An explicit runtime bypasses detection. App-level
authentication and UI build conditions remain independent.
The text clipboard is not part of any runtime: `@epicenter/app/clipboard` is a
standalone platform module, described under [Clipboard](#clipboard).
Custom AI configuration uses one account-scoped catalog across applications
in the same profile/origin. Application declarations do not choose its storage key.

The scope API implements the opener portion of ADR-0392. ADR-0396's unified
connection protocol remains a separate proposal.
The current declaration supplies the same data definition to each store;
ADR-0406 rejects separate device declarations. The remaining preferences
migration is unbuilt.

`app.account?.connection` and `app.device.connections.runtime` are fixed nullable SDK client capabilities.
`app.device.connections.custom` owns device-local custom endpoints, optional bearer keys,
and their clients. A binding without a custom store exposes `connections: null`.

```ts
if (app.device.connections.custom) {
 const id = await app.device.connections.custom.add({
  name: 'My server',
  baseUrl: 'https://inference.example/v1',
  apiKey: providerKey,
  models: ['chosen-model'],
 });
 await app.device.connections.custom.get(id)!.client.chat.completions.create({
  model: 'chosen-model',
  messages,
 });
}
```

Write the full `app.device.connections.custom` path at call sites so the capability's owner
stays visible. Do not alias the namespace to a local `connections` variable.

`getAll()` and `get(id)` return detached saved fields plus the cached SDK client.
`subscribe(listener)` immediately supplies the current ordered snapshot and then
supplies each committed update; it returns an unsubscribe function. Reads use the
local snapshot available when `openApp` resolves. They do not request model discovery.

```ts
const stop = app.device.connections.custom!.subscribe((entries) => {
 renderConnections(entries);
});
await app.device.connections.custom!.update(id, { name: 'Renamed server' });
stop();
```

`add`, `update`, `remove`, and `reorder` return promises. Await them before
selecting a new connection or showing success. Rename, reorder, and model-list
edits preserve clients; endpoint and credential changes retire them. Desktop
explicit key assignment always retires the old client, including assigning the
same value. Omit `apiKey` from an update to retain it; supply `''` to remove it.

Browser entries may contain the explicit key. Desktop entries expose
`hasApiKey` and omit the key; the host applies it to requests. Never sync, log,
or serialize a client-bearing entry. `preview({ baseUrl, apiKey? })` creates an
unsaved client for `models.list()` discovery. All clients and collection methods
obey App readiness and retirement. App close drains their requests. A client
does not promise reachability or support for every SDK endpoint.

Applications own workflow selections. Whispering and Vocab use the plain
TypeScript selection owner and exact matcher in
`@epicenter/app-shell/inference-selections`; Svelte only observes those choices.
Missing connections, changed accounts, and mismatched models never select a
replacement destination. See the [AI boundary decision](../../docs/adr/0365-ai-owns-inference-access-and-applications-own-workflow-selection.md).

The default AI binding follows the package's `isTauri()` selection:

| Environment | Connection persistence | Credentials |
| --- | --- | --- |
| Standalone browser | `epicenter/ai/<owner>.app-ai-connections` in origin-local `localStorage` | Optional key in that local record |
| `epicenter-host` | `ai/<owner>/connections.json` under the host's profile data directory, shared across that account's apps | Account-scoped OS keychain, reached through the host broker |

`<owner>` is `no-account` or `accounts/<encoded-authority>/<encoded-principal>`.
Identity components use UTF-8 hex to preserve case on native filesystems.
Desktop sharing stays on one profile and does not sync between devices. The host
serializes mutations and sends committed snapshots over SSE to open app windows.
Browser mutations use a Web Lock, reread current storage before writing, and
notify other owners in the same document or origin. This catalog spans app IDs,
so its mutation lock remains separate from App admission. Memory catalog
mutations run synchronously within one process and publish changes to sibling
Apps in that runtime. Workflow selections remain
product- and owner-local under `${settingsKey}/${owner}.app-ai-selections` in both environments.
Switching libraries retains this configuration while opening new App clients.
A complete runtime supplies its own `ai` binding. The native default runtime already
supplies native file inference as `app.device.connections.runtime`, so no application composes
it; the browser default has no runtime transport.

Whispering and Vocab open workflow selections with the same captured account as
the App. No-account, different principals, and different authorities have separate
choices. Returning to an owner restores that owner's selections and catalog.

Old product-scoped and profile-wide catalogs, selections, and provider settings
remain untouched and unread. Opening does not migrate them, including when old
values are malformed. Connect providers explicitly in the intended account.
Whispering uses only the selected App client; its former Deepgram, ElevenLabs,
and Mistral adapters are removed. Custom endpoints must accept the workflow's
OpenAI SDK requests. There is no bespoke-protocol fallback or provider registry.

The [native catalog acceptance](scripts/shared-ai-catalog-native/README.md)
exercises two installed test apps through real macOS WebViews and the Rust
keychain bridge. It verifies cross-app updates, process restart, independent
selections, SSE reconnect, and cancellation on App, window, and host closure.
Its optional Whispering mode also verifies the desktop picker, imported audio,
real transcription, and the saved result after document reload.

`defineApp` is inert. `await openApp(application, { account })` returns a ready
App after document and inference-catalog hydration. Failed opening rejects
without publishing a partial handle. If rollback also fails, an `AggregateError`
preserves the opening error as its cause and the claim stays held.
`openApp(application)` performs no authority request or sync dial.

`app.device` always exists. `app.account` is undefined when opened without an account. Otherwise it
contains credential-free `identity`, `personal`, and nullable inference `connection`.
Each store has its own tables, KV, persistence, and sync status.
There is no flat `app.tables`, library discriminator, or alternate opener.

The opener has one schema generic and infers its handle from the implementation.
`App<T>` names that handle; `AppRuntime` is the contract for runtime implementations.
Account presence is a runtime fact: narrow `app.account` before using its stores,
even when the opening call supplied an Account. There is no account type argument,
separate composition opener, or `AppStore` alias. Code that needs only tables and
KV uses `DeclaredData<T>` from `@epicenter/app/store`; broader capability types
can be derived from the application's own handle.

```ts
const app = await openApp(definition, { account });
if (app.account) {
  const personal = app.account.personal;
  // Use personal.tables and personal.kv here.
}
```

Opening waits for acquired resources to settle before reporting a rollback outcome.
An unfinished acquisition can therefore keep the opening promise pending; page
teardown ends that attempt.

The page owns the opening promise. `AppBoot` accepts `opening={opening}` and
renders its children snippet with the resolved value. Rejection renders a
terminal failure screen with page reload. Imperative jobs await that same promise.
Shared components borrow the store or capability they use: `DeclaredData<T>` for
tables and KV, `app.device.connections`, or `app.account?.connection`.

The App constructs each resource once and exposes its actual operation object.
The resource owner keeps cleanup controls. Consumers receive SQL, secret, blob,
and recording operations without a separate close obligation. Retained methods
reject closed or retired use; ordinary storage and transfer failures remain
Results. The declaration is validated before storage acquisition. Auth constructs
the immutable Account handle.

## Blobs

An immutable blob has one complete, extension-bearing key. The same key names
its desktop file, browser record, and row reference. Successful Stop publishes
that key before the application creates a recording row. The
[blob package](../blobs/README.md) owns storage and format interpretation.

Every App exposes `app.blobs.local`. `app.blobs.remote` is null without an
account and exposes remote hosting when signed in. Keep these full paths at
call sites. Bytes have independent lifetimes from rows and from each other.
There are no attachment fields, transfer queues, or automatic downloads.

```ts
const added = await app.blobs.local.add(file);
if (added.error) return showError(added.error);
app.device.tables.recordings.create({ audioBlobId: added.data, audioUrl: null });

// Later, after an explicit Upload action while signed in:
if (!app.blobs.remote) return;
const uploaded = await app.blobs.remote.addLocal(added.data);
if (uploaded.error) return showError(uploaded.error);
// Save uploaded.data, the durable remote URL, in the row.
```

Local access supports `add`, `get`, `open`, `stat`, `list`, and `delete`.
`list({ cursor?, limit? })` returns metadata and an optional `nextCursor`;
it enumerates committed IDs without loading their bodies. Its cursor is an
exclusive BlobId in lexical order, with a default page size of 100 and a maximum
of 1,000. Concurrent writes do not make enumeration a snapshot.

Remote access supports `add(Blob)`, `addLocal(blobId)`, `get(url)`, `open(url)`,
and `delete(url)`. Each upload creates a new remote object, initially limited
to 25 MiB. A native `addLocal` sends a descriptor through the captured account
broker; the host reads and uploads its file without putting the audio in the
WebView. It does not create a synchronization obligation.

`get` returns bytes. `open` returns `{ url, [Symbol.dispose]() }` for display;
release that source when its image, video, or audio player is done. Store the
URL returned by remote `add`, never a temporary display URL. The remote locator
includes server, app, authenticated owner, and object ID. Reads require that
account; sharing a row does not grant another account access to its audio.

Browser bytes live in `epicenter/<appId>/device/<owner>/blobs` within the browser origin/profile.
Desktop bytes are ordinary files at `<dataRoot>/apps/<appId>/device/<owner>/blobs/<blobId>`.
Browser records contain `{ id, bytes, size }`; an index supports listing and
size checks without reading the audio. All libraries in one captured App share
this local namespace. Changing accounts selects another namespace; signing out
does not erase the previous account's bytes. Remote storage is scoped
by account and app. The user confirmed zero users and no existing data for the
complete-key cutover. No migration, reset, or fallback reader runs.

Deleting a row leaves its local bytes and uploaded objects intact. An application
may explicitly delete a known local key or remote object when its product
workflow chooses to; storage never infers row ownership or performs automatic
cleanup.

Applications access blobs through their opened App. Its ownership, readiness,
and closure cover blob requests and display resources.

Concurrent `close()` calls return one terminal completion promise, including
when cleanup fails. Close revokes public operations immediately, cancels owned AI
requests, settles admitted recording and storage work, and releases playback
sources. Each document stops sync and attempts its final local persistence flush.
Independent resources drain concurrently; one cleanup failure does not skip SQL
cleanup. Admission is released only when all resource cleanup succeeds and no
acquisition has left release unproven.

Close discards unresolved capture and temporary native output. Published data
files survive. Finish and save wanted audio while
the App is still usable. Close never signs out,
navigates, deletes credentials, or erases data. It preserves the store's
existing persistence failure reporting; completed cleanup does not prove every
edit reached durable storage or the server.

The App cancels remote blob requests on closure and drains admitted work before
releasing ownership. An interrupted upload may have committed a remote orphan.
Raw Yjs content is borrowed: stop editor bindings before
closing its owner. App workflows spanning multiple awaited calls must also handle
closure between those calls.

App retains the immutable Account supplied by auth. Same-owner credential
refresh preserves that handle. Sign-out or replacement ends its transport;
departure quiesces UI and closes App without erasing data.

Data retirement means the server replaced a data generation. The affected
store fences and invalidates its cache. App closes its sibling resources and
revokes retained operations through `app.signal`. Departure stops UI producers
and observes the same terminal close. Failed invalidation retains ownership until
page teardown. There is no close retry or separate replacement notification.

Departure observes retirement through page cleanup, then invokes `app.close()`
directly. A successful close permits an authentication change and full navigation.
A preflight refusal leaves the page usable. Failure after teardown begins is
terminal. Recovery requires a fresh document; opening never retries in place.

App admission validates and serializes only the account's addressing fields.
Browser acquisition receives one account and data scope and derives both the local
cache address and sync routes from them. It cannot pair one account's cache
with another account's transport.

`app.device.sqlite.open(name)` and `delete(name)` address a file by app ID,
captured account, and database name. Desktop files live at
`<dataRoot>/apps/<appId>/device/<owner>/sqlite/<name>.sqlite`; browser files use
the serialized `[appId, owner, name]` tuple in a separate OPFS pool for each
app/owner. The first SQL open or delete acquires the SQL lifetime; App readiness
does not start a SQLite worker or native socket. The App already holds
admission for this owner, so documents and SQL need no subordinate Web Locks.
The host SQLite owner still excludes independent windows at its own boundary.

Browser close drains admitted work, closes every connection, then pauses that
owner's pool before the App releases admission. Other owners can keep using SQLite in
the same page or another window. Returning to a closed owner reactivates its
pool without deleting files. A failed physical close or pool release is terminal
and retains ownership; repeating close returns the same failure. Failed pool
activation can retry on the next SQL operation. Failed lifetime acquisition
requires closing the rejected handle and constructing a fresh one.

Pool capacity includes a journal slot per named database, including transactions
held across calls. It is not an exclusive claim or an unlimited budget for
SQL-created attached databases and temporary files. The installed SQLite build
defaults to memory-backed temporary storage. Prefer `batch()` for transactions
that should complete in one operation.

The per-owner pool layout is a clean break. Files in the old origin-wide
`.epicenter` pool remain untouched and are not opened or adopted automatically.
Row stores, blobs, and recordings keep their existing locations.

`app.device.secrets.put(label, value)`, `get(label)`, and `delete(label)` address
credentials by app ID, captured account, and label. Browser secrets remain in document memory;
desktop secrets live in the keychain. Closing App preserves values. Secrets
never enter synchronized rows. SQLite, secrets, device tables, blobs, and native
recording use the same captured owner. Earlier storage is neither merged nor
deleted; reconnect providers in the intended account namespace.

`app.device.recording.start({})` acquires disposable capture. Successful Stop saves
locally and returns a blob ID, duration, and byte length; it creates no row.
See [Saved recordings](#saved-recordings) for ordering.

Opening is cache-first. A device with a local generation can open it offline;
a device without a cached generation must reach the current authority to atomically
select or download the canonical generation. Personal caches include
the authenticated actor, so account replacement cannot replay another actor’s writes. The app owns persistence, sync, and teardown.

Account opening requires `authorityId`. The package selects the platform SQLite
owner by default; exceptional runtimes can compose one explicitly. SQL-only
consumers can use the device package without opening a document.
The remaining target contract
and future whole-App data removal are recorded in
[ADR-0355](../../docs/adr/0355-local-and-account-sessions-share-the-application-data-api.md).

Focused tests cover deferred acquisition, retained operations, and resource
release. The saved-recording smoke captures synthetic microphone input
in Chromium, plays it offline, and verifies identical bytes after App
close/reopen. This does not establish browser-process capture recovery,
physical microphone behavior, or physical device acceptance.

## Clipboard

```ts
import { clipboard } from '@epicenter/app/clipboard';

const read = await clipboard.readText(); // Result<string | null, ClipboardError>
const wrote = await clipboard.writeText(text); // Result<void, ClipboardError>
```

`clipboard` is a platform module, not an App capability. A clipboard captures no
application or account, and it owns no resource, so nothing on it
needs an opened App or ends at `app.close()`. A boot-failure screen can copy
diagnostics before any App exists, and a copy button keeps working while a page
departs. Import it directly; do not thread an App handle to reach it.

The public module selects its implementation with `isTauri()` (ADR-0403).
The browser leaf uses the
page's Clipboard API, which requires document focus and the browser's clipboard
grant. The `epicenter-host` leaf uses the host's clipboard plugin, which also
works while the window is unfocused, as a global shortcut needs. Today only the
`app-*` and `whispering` windows hold the plugin's read-text and write-text
permissions; ADR-0402 grants every native verb to every window (unbuilt).

Text only. `readText()` returns `null` for an empty clipboard. Platform failures
return `ClipboardRead` or `ClipboardWrite` errors with the platform cause.
Pasting into another application's cursor, preserving rich pasteboard contents,
and synthetic keystrokes are not clipboard operations: they need accessibility
grants and foreground focus, and they belong to the product that delivers text,
as Whispering's text service does.

## Saved recordings

Stop is the save boundary:

```ts
const started = await app.device.recording.start({});
if (started.error) return showError(started.error);
const recording = started.data;
const stopped = await recording.stop();
if (stopped.error) return showError(stopped.error);
app.device.tables.recordings.create({
 audioBlobId: stopped.data.blobId,
 audioUrl: null,
});
const source = await app.blobs.local.open(stopped.data.blobId);
// Release source.data with Symbol.dispose when playback ends.
```

`@epicenter/app/recorder` owns capture sessions with an immutable ID and device
information. The live capture ID and saved blob key have separate roles.
Stop publishes into the same app-local store used by
`app.blobs.local`. Native WAV capture writes progressively; browser capture
publishes its completed Blob under a key selected from its actual output format.
The returned key includes its extension and remains fixed through save retries.
No finished-file token crosses the public API.
A failed row creation leaves saved audio discoverable through local `list()`.

Cancel removes unfinished capture. It cannot retract a committed blob.
`onEnded` reports unexpected termination, including to a late subscriber;
the application decides whether to stop or cancel. `current()` inspects this
document's held session, without recovering capture from another document.
Reload and host restart may discard unfinished capture.

App close cancels unfinished capture and drains an already-admitted Stop using
its private storage writer. Public blob access is already revoked at that point.
Applications finish wanted capture before deliberate closure. The recorder
owns neither upload nor inference policy.

Text-only dictation should own temporary capture and release it with its session;
it need not publish saved recordings. There is no dictation capability on the
App: an application composes capture with its selected connection's
`client.audio.transcriptions.create` SDK operation. The browser stream/VAD
primitives remain independent of this saved-artifact API.

Run `bun run test` for lifecycle checks and `bun run smoke:recording` for Chromium
capture, storage, decoding, metering, and cancellation with a synthetic microphone.
The test command isolates each file's module mocks. For combined App and app-shell
checks from the repository root, use `bun test --isolate packages/app`.

License: AGPL-3.0-or-later.
