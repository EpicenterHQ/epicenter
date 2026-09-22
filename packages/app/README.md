# @epicenter/app

The identity-preserving blob API is an implementation target in
[ADR-0372](../../docs/adr/0372-local-and-remote-blobs-open-independently.md),
[ADR-0426](../../docs/adr/0426-blob-identities-survive-copies-between-scoped-locations.md),
and [ADR-0427](../../docs/adr/0427-opening-a-blob-acquires-presentation-without-retaining-a-copy.md).
The methods described below reflect current code; `copyFrom` is not implemented
by this documentation change.

Open the resource your operation needs. Each handle captures its destination,
becomes usable when acquisition completes, and owns terminal cleanup. Products
choose which handles to acquire together and unwind earlier acquisitions if a
later one fails.

`defineApp` declares data. Importing the package root acquires nothing and loads
no browser or native implementation. A schema is required only for data stores.

```ts
import { defineApp, defineTable, field } from '@epicenter/app';
import { openLocal, openPersonal } from '@epicenter/app/open';

const definition = defineApp({
  id: 'so.epicenter.notes',
  kv: { language: field.string() },
  tables: { notes: defineTable({ title: field.string() }) },
});
const local = await openLocal(definition);
// Acquire separately when an authenticated workflow needs synchronized data.
const personal = await openPersonal(definition, { account });
```

Local retains the same address across account changes. Personal captures the
account's authority, principal, and transport before asynchronous acquisition.
It never retargets. Closing either store leaves the other usable. Both expose
`tables`, `kv`, `persistence`, `signal`, and `close()`; their ID is `definition.id`.
Personal opens from its cached generation offline, or asks the authority to
select a generation when no cache exists. No Shared opener is exported.

## Resource constructors

| Subpath | Constructors | Required destination |
| --- | --- | --- |
| `/open` | `openLocal`, `openPersonal` | Definition; Personal also requires `account` |
| `/blobs` | `openLocalBlobs`, `openRemoteBlobs` | `{ id }`; remote also requires `account` |
| `/sqlite` | `openSqlite` | `{ id }` |
| `/secrets` | `openSecrets` | `{ id }` |
| `/recorder` | `createRecorder` | `{ blobs: localBlobs }` |
| `/ai` | `openEpicenterInference`, `openRuntimeInference`, `openEndpointInference` | Account, installed runtime, or endpoint URL |
| `/ai-connections` | `openLocalConnectionCatalog`, `openAccountConnectionCatalog` | No account, or `{ account }` |

Each owner exposes an abort signal and an idempotent asynchronous `close()`.
Close fences new operations immediately, then settles admitted work. Repeated
calls return the same completion, including a cleanup failure. Storage owners
retain exclusion when cleanup cannot prove competing writers would be safe.
Closing preserves committed data and credentials. It does not sign out, navigate,
or prove every edit reached durable storage or a server.

Default constructors select browser or host implementations with `isTauri()`.
`StoreRuntime` supplies only document storage and admission to store openers.
`createMemoryStoreRuntime()` from `/testing` provides isolated IndexedDB-backed
store tests without changing globals. It retains committed data across handle
close and refuses disposal while a store still owns it. It supplies no simulated
recording, network, SQL, or credential capabilities.

## Blobs and recording

```ts
import { openLocalBlobs, openRemoteBlobs } from '@epicenter/app/blobs';
import { createRecorder } from '@epicenter/app/recorder';

const blobs = await openLocalBlobs({ id: definition.id });
const recorder = createRecorder({ blobs });
const started = await recorder.start({});
if (started.error) throw started.error;
const saved = await started.data.stop();
if (saved.error) throw saved.error;
// The product stores saved.data.blobId in its own recording schema.
await recorder.close();
// Closing capture leaves its destination usable.
const audio = await blobs.get(saved.data.blobId);
```

Stop publishes bytes into the supplied LocalBlobs destination on both platforms.
It returns a blob ID, duration, and byte length without creating a row. Cancel
removes unfinished capture; it cannot retract published bytes. Closing LocalBlobs
retires its recorders and waits for admitted Stop publication through a private
writer even though public blob access is fenced. Finish wanted capture before
closing. Reload or process restart may discard unfinished capture.

Local bytes use the fixed `no-account` owner under the application ID. Browser
storage is `epicenter/<id>/device/no-account/blobs`; native files are under
`<dataRoot>/apps/<id>/device/no-account/blobs`. Account changes do not move bytes.
Historical account-local bytes remain untouched, with no adoption or fallback.

```ts
const remote = await openRemoteBlobs({ id: definition.id, account });
const uploaded = await remote.addFrom(blobs, saved.data.blobId, { signal });
```

`addFrom` receives the actual source handle. Native upload carries its validated
source namespace to the host and streams that file; it does not infer the source
from the remote destination. Size checks precede byte reads. Closing either
participant cancels and settles the transfer without closing the other handle.
An interrupted upload may leave a committed remote object. A workflow that then
updates a row must check its own cancellation before writing.

`get` returns bytes. `open` returns a disposable display URL; release it when
playback ends. Remote URLs returned by upload are account-scoped locators.
Sharing a row does not grant access to its audio. Row deletion does not delete
local or remote bytes.

## SQLite and secrets

`openSqlite({ id })` acquires a namespace eagerly. `open(name)` and `delete(name)`
address dynamically named databases under that application's fixed local owner.
Deleting a database retires its old connections. Closing drains the namespace
and releases its physical connections; failed cleanup retains exclusion.
Browser storage uses an owner-specific OPFS pool. Native storage uses the host
SQLite lifetime socket. The previous origin-wide OPFS pool remains untouched.

`openSecrets({ id })` addresses credentials by application ID and label.
Browser credentials remain in document memory; native credentials use the OS
keychain. Closing a handle preserves values. Credentials never enter Personal
rows. Saved inference keys use their separate catalog namespace.

## Inference

```ts
import {
  openEpicenterInference,
  openRuntimeInference,
  openEndpointInference,
} from '@epicenter/app/ai';

const hosted = await openEpicenterInference({ account });
const runtime = await openRuntimeInference(); // null when absent
const endpoint = await openEndpointInference({
  baseURL: 'https://inference.example/v1',
  getAuthHeaders: async ({ signal }) => ({
    Authorization: `Bearer ${await credentials.getToken({ signal })}`,
  }),
});
await endpoint.client.models.list();
await endpoint.close();
```

Each handle owns one OpenAI-compatible client. An available runtime's failure
remains an error; no constructor chooses a fallback. Protocol compatibility does
not imply support for every SDK operation.

Endpoint authentication has one option: `getAuthHeaders({ signal })`. Omit it
for an unauthenticated endpoint; return constant headers for a static key.
Callbacks are not persisted. The API supports HTTP authentication headers, not
request signing, mTLS, or provider-specific protocol transformations.

The client validates and fixes the destination before resolving credentials,
registers pending work before calling the callback, and combines handle and
request cancellation. Captured authentication overrides SDK request headers.
It suppresses SDK environment credentials, omits ambient cookies, refuses
redirects, and rechecks cancellation after authentication. Close waits for
credential resolution and response-body cancellation. Authentication failure
never dispatches an unauthenticated request. Native unsaved requests use a
protected host relay for SDK operations, including multipart transcription.

## Saved connections

Both catalogs persist locally and are shared across application IDs. The account
catalog partitions records by captured authority and principal; it does not sync
through Personal. The local catalog uses the `no-account` partition.

```ts
import { openAccountConnectionCatalog } from '@epicenter/app/ai-connections';
const connections = await openAccountConnectionCatalog({ account });
const id = await connections.add({
  name: 'My endpoint', baseUrl: 'https://inference.example/v1', apiKey: key,
});
const saved = connections.get(id)!;
await saved.client.models.list();
await connections.close();
```

Await mutations before showing success. Reads return saved fields and cached
clients without model discovery. Rename, reorder, and model-list changes retain
clients; destination or credential changes retire them. Omit `apiKey` when
updating to retain it; supply an empty string to remove it. Native explicit key
assignment changes the access version even when the value is unchanged.

Browser records may contain the explicit bearer key. Native snapshots expose
`hasApiKey` and an access version while the broker retains the key. Stale versions
cannot authorize requests. Do not sync or log client-bearing records.

Discover models through the selected client's `models.list()`. An unsaved preview
opens its own endpoint handle and closes it when finished or dismissed.
Applications own workflow selection; missing connections and changed accounts do
not select another destination.

## Data engine and adapters

`/definition`, `/field`, `/store`, `/sync`, and artifact entrypoints remain
platform-free. `/data` opens a document over caller-owned SQLite; disposal leaves
that connection open. `/memory` owns Bun test storage. See the
[data engine README](src/data/README.md) and [architecture map](ARCHITECTURE.md).

Svelte consumers call `fromData(store)` for each selected store. Products own
startup rollback and handles that finish opening after unmount. Shared AppBoot
accepts a product opening function and closes a late result. Startup cancellation retires earlier acquisitions immediately. Document
replacement keeps its interruption policy; it is not a save barrier.

Clipboard is stateless: import `clipboard` from `/clipboard` directly. It needs
no resource handle and has no artificial close operation.

Run `bun run --cwd packages/app test` and `typecheck` from the repository root.
`smoke:recording` exercises synthetic Chromium capture and playback;
`smoke:admission` exercises real browser document ownership. Synthetic capture
does not establish physical microphone behavior or restart recovery.

License: AGPL-3.0-or-later.
