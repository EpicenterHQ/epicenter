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

The package selects SQLite and secrets for the build. Standard applications use
browser blob storage and recording, including in host-served WebViews. An
application with native capture requirements selects `runtime: epicenterHost`
from `@epicenter/app/epicenter-host`, as Whispering does. The complete `browser`
runtime is exported from `@epicenter/app/browser`. An explicit runtime replaces
SQLite, secrets, blobs, and recording together. Custom runtimes must publish
recordings into the blob store they expose; TypeScript cannot prove compatibility.
An independent `ai` binding replaces all default AI configuration.
`settingsKey` preserves an existing local AI-settings namespace; new applications
default to their app ID.

Construction is inert. `openLocal()`, `openPersonal(account)`, and `openShared(account)` return handles
synchronously; `app.ready` resolves once with a usable dataset or a typed
failure. Local opening performs no authority request or sync dial.

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

Tables declaring `field.blob()` create attachments directly:

```ts
const created = await app.tables.recordings.create({
 title: 'Meeting',
 audio: new Blob(['recording bytes']),
});
if (created.error !== null) return handleError(created.error);
// created.data.audio is a BlobId; app.blobs reads its locally stored bytes.
```

`CreateRowOf` accepts bytes or a local `BlobId` to copy for owning fields, plus
`null` for nullable fields. Every attachment gets a new ID; creation preserves
the source, even when it already belongs to another row. Plain tables still
create synchronously. A branded string field does not
own bytes. Owning fields cannot be patched by ID, declared in KV, or created inside
a synchronous `transact()` callback.

The document stores bytes before accepting their row references. If creation
fails or close begins before that commit, it removes successfully written bytes
that the row did not accept. Close drains this compensation too. Cleanup failures
are logged with their IDs without replacing the original creation failure.
Success means local bytes stored and row accepted; row durability still follows
the document's persistence contract. This is not a cross-store atomic transaction
or crash-recovery journal.

Repeated `close()` calls return one completion promise. Close rejects new work
immediately, cancels owned AI requests, settles admitted recording and storage
work, and releases playback sources. The document stops sync and attempts its
final local persistence flush. SQL work drains even if another cleanup fails.
App releases its SQL lifetime and library claim only after dependent resources
have released successfully; failed release retains the claim.

Close cancels unresolved recording rather than saving a recording row. Finish
and save a recording while the App is still usable. Close never signs out,
navigates, deletes credentials, or erases the library. It preserves the store's
existing persistence failure reporting; completed cleanup does not prove every
edit reached durable storage or the server.

Current transfer primitives cannot be cancelled. A transfer that never settles
can therefore keep close pending; close does not release ownership while that
transfer can still write. Raw Yjs content is borrowed: stop editor bindings before
closing its owner. App workflows spanning multiple awaited calls must also handle
closure between those calls.

The app handle captures account identity and transport at open time. Sign-out
retires that transport without changing the handle's dataset identity; the
owner closes the handle and removes consuming UI.

`LibraryReplicaIdentity` lives in `@epicenter/principal`: the library choice and,
for Personal or Shared, the authenticated actor's credential-free identity.
SQL, saved recording, and blob factories receive that fixed replica scope. The document
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

`app.recording` captures saved audio into the opened library.
Its browser binding publishes into the App's own local blob store. The explicit
`epicenterHost` runtime pairs native capture with host blob routes.
Opening binds the app ID and destination once:
`openLocal()` selects the local library; `openPersonal(account)` selects that
Personal library; `openShared(account)` selects the application's Shared library. After `app.ready` succeeds, call `app.recording.start()`.
Neither `start()` nor `current()` takes an account. Closing waits for admitted
work and cancels unresolved capture before releasing storage.
Stop returns a published blob ID, duration, and byte length. The app owns the row
and subsequent transcription or retention policy. See
[the recording contract](#saved-recordings) for ownership
and closure behavior.

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
release. A disposable-profile WebKit and Chromium probe also verified
attachment-created row/blob persistence across browser-process restart,
playback bytes, and URL release. This does not establish native recording or
account-transfer behavior.

## Saved recordings

A workflow borrows the ready App from its caller, which owns shutdown:

```ts
const started = await app.recording.start();
if (started.error) return showError(started.error);
const recording = started.data;
const unlevel = recording.onLevel(showLevel);
const stopped = await recording.stop();
unlevel();
if (stopped.error) return showError(stopped.error);
// stopped.data: { audioBlobId, durationMs, byteLength }
```

`@epicenter/app/recorder` owns the saved-recording contract. The runtime's
internal recorder receives the captured identity and local blob store from App.
Construction opens no microphone, dataset, or model. App exposes recording
operations and retains their cleanup owner. `selectedDeviceId` uses the portable
device vocabulary from `@epicenter/recorder`.

Opening the app captures its local or account destination before permission acquisition.
`openLocal()` binds the local library; `openPersonal(account)` binds that account's
Personal library; `openShared(account)` binds the application's Shared library. These platform factories receive the captured identity at composition;
feature code never passes an account into a recording operation.
Stop publishes complete bytes there; cancel discards them. Each session resolves
once, and subsequent stop/cancel calls return `NoActiveRecording`. Identity is
immutable. An unexpected capture ending leaves accepted audio available to stop
or cancel; `onEnded` reports that fact, including to a late subscriber.

`app.recording.current()` recovers only the opened app's destination. Desktop recordings
can survive a reload of their owning window, and window destruction cancels
them. Browser recordings belong to their document. Recording methods share the
app's readiness and close gate. `app.close()` waits for admitted starts and stops,
then cancels unresolved capture before releasing storage. Applications that want
to save that audio must stop and save it before closing. Recording does
not insert rows, upload audio, or apply transcription policy.

Text-only dictation should own temporary capture and release it with its session;
it need not publish saved recordings. The browser stream/VAD primitives below
remain independent of this saved-artifact API.

Run `bun test` for lifecycle checks and `bun run smoke:recording` for Chromium
capture, storage, decoding, metering, and cancellation with a synthetic microphone.

License: AGPL-3.0-or-later.
