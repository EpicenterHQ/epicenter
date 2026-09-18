# @epicenter/app

An opened App owns this application's device state and its signed-in account
stores for one page lifetime. Whoever opens it stops product work and awaits
`app.close()` before replacing the account. Screens borrow a store or capability;
the page coordinates departure.

```ts
import { defineApplication } from '@epicenter/app';

const application = defineApplication({
 appId: APP_ID,
 definition: honeycrispDefinition,
});
const app = application.open(account);
try {
 const result = await app.ready;
 if (result.error !== null) throw result.error;
 // Device state is always available; account stores are nullable.
 app.device.tables;
 app.device.sqlite;
 app.account?.personal.tables;
 app.account?.shared?.tables;
} finally {
 await app.close();
}
```

The package selects SQLite, secrets, blobs, and recording together for the build.
Browser recording publishes into IndexedDB. Host recording publishes into the
same app directory served by the host's blob API. The complete `browser` runtime
is exported from `@epicenter/app/browser`, and `epicenterHost` from
`@epicenter/app/epicenter-host`. An explicit runtime replaces all four capabilities.
Custom runtimes must publish recordings into the blob store they expose;
TypeScript cannot prove compatibility. ADR-0403 proposes replacing build
conditions with runtime platform selection; that separate change is unbuilt.
An independent `ai` binding replaces all default AI configuration.
The text clipboard is not part of any runtime: `@epicenter/app/clipboard` is a
standalone platform module, described under [Clipboard](#clipboard).
`settingsKey` preserves an existing local AI-settings namespace; new applications
default to their app ID.

The scope API implements the opener portion of ADR-0392. ADR-0391's removal of
runtime overrides and ADR-0396's connection protocol remain separate proposals.
The current declaration supplies the same data definition to each store;
separate device declarations and the remaining preferences migration are unbuilt.

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
local snapshot after `app.ready`. They do not request model discovery.

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

The default AI binding follows the package's build condition (a runtime check under ADR-0403; unbuilt):

| Environment | Connection persistence | Credentials |
| --- | --- | --- |
| Standalone browser | `${settingsKey}.app-ai-connections` in origin-local `localStorage` | Optional key in that local record |
| `epicenter-host` | `ai/connections.json` under the host's profile data directory, shared across its apps | OS keychain, reached through the host broker |

Desktop sharing stays on one profile and does not sync between devices. The host
serializes mutations and sends committed snapshots over SSE to open app windows.
Browser mutations use a Web Lock, reread current storage before writing, and
notify other owners in the same document or origin. Workflow selections remain
product-local under `${settingsKey}.app-ai-selections` in both environments.
Switching libraries retains this configuration while opening new App clients.
An explicit `ai` binding replaces the default. The host build's default already
supplies native file inference as `app.device.connections.runtime`, so no application composes
it; the browser default has no runtime transport.

Applications with saved workflow choices await
`initializeBrowserAiSettings(settingsKey)` from
`@epicenter/app-shell/migrate-ai-settings` before opening. It splits the old
combined envelope under a Web Lock, preserves IDs and successful writes across
retries, and retains old bytes for recovery. Pre-ID settings are normalized once
inside the same lock. A connection-only consumer can use
`initializeAiConnections({ storage, storageKey, locks })` from
`@epicenter/app/ai-connections` for already-normalized records.

Desktop opening imports those normalized product records into the host catalog
before readiness. The host records each product import durably, preserving IDs
and optional keys. Reopening never resurrects subsequently deleted entries.
Conflicting existing IDs fail opening instead of overwriting another endpoint.
Legacy browser bytes remain recovery data. New desktop saves go to the host.

The [native catalog acceptance](scripts/shared-ai-catalog-native/README.md)
exercises two installed test apps through real macOS WebViews and the Rust
keychain bridge. It verifies cross-app updates, process restart, independent
selections, SSE reconnect, and cancellation on App, window, and host closure.
Its optional Whispering mode also verifies the desktop picker, imported audio,
real transcription, and the saved result after document reload.

`defineApplication` is inert. `application.open(account)` returns an App
synchronously and begins acquisition. `app.ready` resolves when every opened
store and the inference catalog are ready, or returns an opening failure.
`open()` or `open(undefined)` performs no authority request or sync dial.

`app.device` always exists. `app.account` is null when signed out. Otherwise it
contains credential-free `identity`, `personal`, nullable `shared`, and nullable
inference `connection`. Shared is available when the Account declares `supportsShared`, including named
people on a self-hosted server. Each store has its own tables, KV, persistence, and sync status.
There is no flat `app.tables`, library discriminator, or alternate opener.

The shared `AppBoot` render gate accepts `ready={app?.ready}`. It handles loading
and opening failures before rendering children. Imperative jobs await the same
promise and handle its Result once. Shared components take the store or
capability they use: `AppStore<T>`, `app.device.connections`, or
`app.account?.connection`.

The document, table handles, and KV handle exist before readiness. Their actual
operations reject premature or closed use, including methods retained by a
consumer. Hydration fills the same document; no forwarding facade replaces it.
Invalid declarations throw before I/O. Library addresses are validated at the
claim and storage boundaries. Auth constructs the immutable Account handle.

The App constructs each resource once and exposes its actual operation object.
The resource owner keeps its cleanup controls; consumers receive SQL, secret,
blob, and recording operations without a separate close obligation. App gates public operations on combined readiness and lifetime. Each data
engine owns hydration, persistence, and sync for its document. Retained methods reject premature or closed use;
ordinary storage and transfer failures remain Results.

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

Browser bytes live in `epicenter/<appId>/blobs` within the browser origin/profile.
Desktop bytes are ordinary files at `<dataRoot>/apps/<appId>/blobs/<blobId>`.
Browser records contain `{ id, bytes, size }`; an index supports listing and
size checks without reading the audio. All libraries of one app on that device share
this local namespace. Signing out does not erase it. Remote storage is scoped
by account and app. The user confirmed zero users and no existing data for the
complete-key cutover. No migration, reset, or fallback reader runs.

Deleting a row leaves its local bytes and uploaded objects intact. An application
may explicitly delete a known local key or remote object when its product
workflow chooses to; storage never infers row ownership or performs automatic
cleanup.

Tools without a data library can use `createLocalBlobs({ appId })` and
`createRemoteBlobs({ appId, account })` from `@epicenter/app/blobs`. These browser/host constructors select
the same platform storage as the App and expose `close()` for their independent
request and display lifetimes. Bun scripts can use `@epicenter/blobs/bun` over
the canonical directory directly. These tools do not open Yjs documents:

```ts
import { join } from 'node:path';
import { createBunBlobStore } from '@epicenter/blobs/bun';

// The CLI receives the chosen profile's dataRoot explicitly.
const storage = createBunBlobStore({
 directory: join(dataRoot, 'apps', appId, 'blobs'),
});
const page = await storage.list({ limit: 100 });
```

The standalone browser/host constructors do not discover desktop profiles from
a Bun process.

Concurrent `close()` calls return one completion promise. A failed cache invalidation
permits another explicit close attempt; failed physical release stays terminal. Close rejects new work
immediately, cancels owned AI requests, settles admitted recording and storage
work, and releases playback sources. The document stops sync and attempts its
final local persistence flush. SQL work drains even if another cleanup fails.
App releases its SQL lifetime and library claim only after dependent resources
have released successfully; failed release retains the claim.

Close discards unresolved capture and temporary native output. Published library
files survive. Finish and save wanted audio while
the App is still usable. Close never signs out,
navigates, deletes credentials, or erases the library. It preserves the store's
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

Library retirement is different: the server has replaced a data generation.
The affected store fences and invalidates its cache. App stops all sibling sync
and refuses further public operations immediately. `app.libraryReplaced` notifies the page without exposing cache operations.
Departure quiesces UI and calls `app.close()`. The store owns invalidation and
completes it before releasing storage. Failed invalidation retains ownership;
`app.canRetryClose` permits another explicit `close()` attempt. Departure also
permits retry when UI cleanup failed, and never closes storage before that
cleanup succeeds.

Library claims validate and serialize only the account's addressing fields.
Browser acquisition receives one account and library and derives both the local
cache address and sync routes from them. It cannot pair one account's cache
with another account's transport.

`app.device.sqlite.open(name)` and `delete(name)` address a file by app ID and
database name. Desktop files live at `<dataRoot>/apps/<appId>/local/sqlite/<name>.sqlite`;
browser files use the serialized `[appId, "local", name]` tuple in the OPFS pool. Each app
has one exclusive SQLite lifetime. Data-library claims remain separate.

`app.device.secrets.put(label, value)`, `get(label)`, and `delete(label)` address
credentials by app ID and label. Browser secrets remain in document memory;
desktop secrets live in the keychain. Closing App preserves values. Secrets
never enter synchronized rows. Neither SQLite nor secrets change namespace
when the Epicenter account changes. Earlier account-scoped storage is not
merged or deleted by this change. Existing device paths and keychain addresses
are preserved.

`app.device.recording.start({})` acquires disposable capture. Successful Stop saves
locally and returns a blob ID, duration, and byte length; it creates no row.
See [Saved recordings](#saved-recordings) for ordering.

Opening is cache-first. A device with a local generation can open it offline;
a device without a cached generation must reach the current authority to atomically
select or download the canonical generation. Personal and Shared caches include
the authenticated actor, so account replacement cannot replay another actor’s writes. The app owns persistence, sync, and teardown.

Account opening requires `authorityId`. The package selects the platform SQLite
owner by default; exceptional runtimes can compose one explicitly. SQL-only
consumers can use the device package without opening a document.
The remaining target contract
and future whole-library removal are recorded in
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
application, library, or account, and it owns no resource, so nothing on it
needs `app.ready` or ends at `app.close()`. A boot-failure screen can copy
diagnostics before any App exists, and a copy button keeps working while a page
departs. Import it directly; do not thread an App handle to reach it.

The package selects the implementation for the build; ADR-0403 replaces the
seam with an `isTauri()` check in the public file (unbuilt). The default leaf uses the
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
App: an application composes its own capture with a connection's `transcribe`
(ADR-0365, ADR-0396). The browser stream/VAD primitives below remain
independent of this saved-artifact API.

Run `bun test` for lifecycle checks and `bun run smoke:recording` for Chromium
capture, storage, decoding, metering, and cancellation with a synthetic microphone.

License: AGPL-3.0-or-later.
