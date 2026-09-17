# @epicenter/app

An opened App is a vanilla TypeScript handle for one fixed Local, Personal, or
Shared library. Whoever opens it stops product work and awaits `app.close()` when they
deliberately finish. Screens borrow the handle; the page or job that owns it
coordinates departure.

```ts
import { defineApplication } from '@epicenter/app';

const application = defineApplication({
 appId: APP_ID,
 definition: honeycrispDefinition,
});
const app = application.openPersonal(account);
try {
 const result = await app.ready;
 if (result.error !== null) throw result.error;
 // Finish product work using app.tables, app.sqlite, and other capabilities.
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
TypeScript cannot prove compatibility.
An independent `ai` binding replaces all default AI configuration.
The text clipboard is not part of any runtime: `@epicenter/app/clipboard` is a
standalone platform module, described under [Clipboard](#clipboard).
`settingsKey` preserves an existing local AI-settings namespace; new applications
default to their app ID.

This paragraph describes the shipped surface. ADR-0391 deletes `runtime`, `ai`,
and `settingsKey` so the build selects every implementation, and ADR-0392
replaces the three openers with one `open(account)` that returns a `device`
scope and an optional `account` scope; both are Proposed and unbuilt, and the
README changes when the code does.

`app.ai.account` and `app.ai.runtime` are fixed nullable SDK client capabilities.
`app.ai.connections` owns device-local custom endpoints, optional bearer keys,
and their clients. A binding without a custom store exposes `connections: null`.

```ts
if (app.ai.connections) {
 const id = await app.ai.connections.add({
  name: 'My server',
  baseUrl: 'https://inference.example/v1',
  apiKey: providerKey,
  models: ['chosen-model'],
 });
 await app.ai.connections.get(id)!.client.chat.completions.create({
  model: 'chosen-model',
  messages,
 });
}
```

Write the full `app.ai.connections` path at call sites so the capability's owner
stays visible. Do not alias the namespace to a local `connections` variable.

`getAll()` and `get(id)` return detached saved fields plus the cached SDK client.
`subscribe(listener)` immediately supplies the current ordered snapshot and then
supplies each committed update; it returns an unsubscribe function. Reads use the
local snapshot after `app.ready`. They do not request model discovery.

```ts
const stop = app.ai.connections!.subscribe((entries) => {
 renderConnections(entries);
});
await app.ai.connections!.update(id, { name: 'Renamed server' });
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

The default AI binding follows the package's build condition:

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
supplies native file inference as `app.ai.runtime`, so no application composes
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

Construction is inert. `openLocal()`, `openPersonal(account)`, and `openShared(account)` return handles
synchronously; `app.ready` resolves once with a usable dataset and hydrated AI catalog, or a typed
failure. Local opening performs no authority request or sync dial.

The open call decides the handle's type. `openLocal()` returns `LocalApp<T>`;
`openPersonal(account)` and `openShared(account)` return `AccountApp<T>`; `App<T>`
is their union, discriminated by `app.library`. A local App has no `account` and
no `retirement`, and its `ai.account` is null. Code that borrows either kind
checks `app.library` once and TypeScript narrows the rest; code that needs sync
or retirement takes `AccountApp<T>` and the compiler refuses a local handle.

```ts
import type { AccountApp } from '@epicenter/app';

function watchRetirement(app: AccountApp<typeof definition>) {
 return app.retirement.then(() => app.close());
}
```

Shared code takes a capability, never the handle or a subset of it. `app.ai`
carries everything inference needs, including the identity its account client
was bound to, so a component that picks a model takes `ai: AppAi` and nothing
else from the App. The rule is
[ADR-0390](../../docs/adr/0390-the-app-is-the-unit-of-ownership-and-a-capability-is-the-unit-of-sharing.md);
the target spelling is
[ADR-0392](../../docs/adr/0392-an-app-has-a-device-scope-and-an-account-scope-and-each-store-sits-under-its-owner.md),
where shared code takes `app.device.connections` and `app.account?.connection`
and there is no `App` union discriminated by `library` (that shape,
[ADR-0389](../../docs/adr/0389-the-open-call-decides-the-app-s-type-and-a-local-app-has-no-account-members.md),
is superseded at the opener).

The document, table handles, and KV handle exist before readiness. Their actual
operations reject premature or closed use, including methods retained by a
consumer. Hydration fills the same document; no forwarding facade replaces it.
Invalid declarations and accounts missing authority identity throw before I/O.

The App constructs each resource once and exposes its actual operation object.
The resource owner keeps its cleanup controls; consumers receive SQL, secret,
blob, and recording operations without a separate close obligation. The data
engine constructs document operations and supplies their readiness guard to the
resource implementations. Retained methods reject premature or closed use;
ordinary storage and transfer failures remain Results.

## Blobs

An immutable blob has one complete, extension-bearing key. The same key names
its desktop file, browser record, and row reference. Successful Stop publishes
that key before the application creates a recording row. The
[blob package](../blobs/README.md) owns storage and format interpretation.

Every App exposes `app.blobs.local`. An AccountApp also exposes
`app.blobs.remote`; a LocalApp has no remote member. Keep these full paths at
call sites. Bytes have independent lifetimes from rows and from each other.
There are no attachment fields, transfer queues, or automatic downloads.

```ts
const added = await app.blobs.local.add(file);
if (added.error) return showError(added.error);
app.tables.recordings.create({ audioBlobId: added.data, audioUrl: null });

// Later, after an explicit Upload action on an AccountApp:
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

Deleting a row leaves its local bytes and uploaded objects intact. Applications
may request best-effort local deletion; they own reference-aware cleanup while
the library is open. The storage APIs do not infer row ownership or promise
background garbage collection while the application is closed.

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

Repeated `close()` calls return one completion promise. Close rejects new work
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

An account App captures account identity and transport at open time as
`app.account`. Sign-out retires that transport without changing the handle's
dataset identity; the owner closes the handle and removes consuming UI.

`LibraryReplicaIdentity` lives in `@epicenter/principal`: the library choice and,
for Personal or Shared, the authenticated actor's credential-free identity.
SQL receives that fixed replica scope. Local blobs and recording capture only
the app ID; remote hosting captures the account. The document
owns document admission and cleanup. App coordinates resource shutdown, and
runtime owners own physical files.

`app.sqlite.open(name)` and `app.sqlite.delete(name)` use the same captured
library scope as the rest of the handle. Every runtime supplies the
same capability, so an app never branches on whether SQLite exists. The app
API validates the plain database name; the runtime owner chooses its
replica-specific address. SQLite is auxiliary app data:
primary tables and their durable Yjs records remain in the data store.

`app.secrets.put(label, value)`, `get(label)`, and `delete(label)` capture the app
and account scope. Browser secrets remain in document memory and disappear on
reload; desktop secrets live in the keychain. Closing an App drains admitted
secret operations and preserves their values. Reopening the same scope in the
same document can read them again. Secrets never enter synchronized rows.

`app.recording.start({})` acquires disposable capture. Successful Stop saves
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

The package selects the implementation for the build. The default leaf uses the
page's Clipboard API, which requires document focus and the browser's clipboard
grant. The `epicenter-host` leaf uses the host's clipboard plugin, which also
works while the window is unfocused, as a global shortcut needs. Trusted app
windows hold the plugin's read-text and write-text permissions.

Text only. `readText()` returns `null` for an empty clipboard. Platform failures
return `ClipboardRead` or `ClipboardWrite` errors with the platform cause.
Pasting into another application's cursor, preserving rich pasteboard contents,
and synthetic keystrokes are not clipboard operations: they need accessibility
grants and foreground focus, and they belong to the product that delivers text,
as Whispering's text service does.

## Saved recordings

Stop is the save boundary:

```ts
const started = await app.recording.start({});
if (started.error) return showError(started.error);
const recording = started.data;
const stopped = await recording.stop();
if (stopped.error) return showError(stopped.error);
app.tables.recordings.create({
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
