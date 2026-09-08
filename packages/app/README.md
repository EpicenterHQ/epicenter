# @epicenter/app

An app opens one local or account dataset and owns that application handle until it closes.

```ts
import { createEpicenter } from '@epicenter/app';
import { createBrowserAppBlobs } from '@epicenter/app/browser';

const epicenter = createEpicenter({
 appId: APP_ID,
 definition: honeycrispDefinition,
	// Every app supplies its build's SQLite owner.
	sqlite: deviceSqliteOwner,
	blobs: createBrowserAppBlobs(),
});
const app = epicenter.openAccount(account);
const result = await app.ready;
// Use app.tables, app.kv, and app.blobs after a successful result.
await app.close();
```

Construction is inert. `openLocal()` and `openAccount(account)` return handles
synchronously; `app.ready` resolves once with a usable dataset or a typed
failure. Local opening performs no authority request or sync dial.

The document, table handles, and KV handle exist before readiness. Their actual
operations reject premature or closed use, including methods retained by a
consumer. Hydration fills the same document; no forwarding facade replaces it.
Invalid declarations and accounts missing authority identity throw before I/O.

The same document factory constructs blob and SQL operations. The app selects platform
primitives and the browser opener composes the actual capabilities before one
final freeze. There is no prototype facade or second closure flag. Retained blob
and SQL methods throw on premature or closed use just as table
methods do; ordinary storage and transfer failures remain Results.

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

Repeated `close()` calls return one completion promise. Close disables new
operations immediately, then drains acquisition, persistence, and admitted blob/SQL
operations before releasing resources. Acquired playback sources are released
once, including sources that arrive during close. Consumers can release them
earlier and can safely repeat disposal after close.

Current transfer primitives cannot be cancelled. A transfer that never settles
can therefore keep close pending; close does not release ownership while that
transfer can still write. Raw Yjs content is borrowed: stop editor bindings before
closing its owner. App workflows spanning multiple awaited calls must also handle
closure between those calls.

The app handle captures account identity and transport at open time. Sign-out
retires that transport without changing the handle's dataset identity; the
owner closes the handle and removes consuming UI.

`app.sqlite.open(name)` and `app.sqlite.delete(name)` use the same captured
local or account scope as the rest of the handle. Every runtime supplies the
same capability, so an app never branches on whether SQLite exists. The app
API validates the plain database name; the runtime owner stores local files
below `local/sqlite/` and account files below
`accounts/<authority-id>/<principal-id>/sqlite/`. SQLite is auxiliary app data:
primary tables and their durable Yjs records remain in the data store.

Opening is cache-first. A device with a local generation can open it offline;
a device without an account generation must reach the authority to list, fetch,
or create one. The app owns persistence, sync, and teardown.

Account opening requires `authorityId`. Every app supplies its platform SQLite
owner; SQL-only consumers can use the device package without opening a document.
The remaining target contract
and future whole-library removal are recorded in
[ADR-0355](../../docs/adr/0355-local-and-account-sessions-share-the-application-data-api.md).

Focused tests cover deferred acquisition, retained operations, and resource
release. A disposable-profile WebKit and Chromium probe also verified
attachment-created row/blob persistence across browser-process restart,
playback bytes, and URL release. This does not establish native recording or
account-transfer behavior.

License: AGPL-3.0-or-later.
