# @epicenter/app

A store owns its tables, KV, blob namespace, and SQLite namespace. `openLocal` and `openPersonal`
return only after document, blob, and SQL namespace acquisition finish; `store.close()` fences
all three and drains their admitted work. Other services keep independent lifetimes.

Whispering borrows blob access from its Local and Personal stores. The earlier
[implementation report](../../docs/reports/20260922-store-owned-blobs-implementation.md)
records the initial transport milestone.

`defineStore` declares a store's stable ID and schema. An application composes
the stores and services its workflows need; there is no aggregate App handle.
Importing the package root acquires nothing and loads no browser or native
implementation. A schema is required only for data stores.

```ts
import { defineStore, defineTable, field } from '@epicenter/app';
import { openLocal, openPersonal } from '@epicenter/app/open';

const definition = defineStore({
  id: 'so.epicenter.notes',
  kv: { language: field.string() },
  tables: { notes: defineTable({ fields: { title: field.string() } }) },
});
const local = await openLocal(definition);
// Acquire separately when an authenticated workflow needs synchronized data.
const personal = await openPersonal(definition, { account });
```

The definition ID names the document, blob, and SQLite namespaces. It uses the same
reverse-domain grammar as a host application ID, but an application may open
several definitions. Reusing a definition for Local and Personal preserves the
declared shape, not the dataset. Changing its ID selects a different persistent
address. Secrets take their own namespace IDs without a store definition.

For the naming decision, see [ADR-0430](../../docs/adr/0430-define-store-declares-data-and-products-compose-resources.md).

Local retains the same address across account changes. Personal captures the
account's authority, principal, and transport before asynchronous acquisition.
It never retargets. Closing either store leaves the other usable. Both expose
`tables`, `kv`, `blobs`, `sqlite`, `persistence`, `signal`, and `close()`; their ID is `definition.id`.
Personal opens from its cached generation offline, or asks the authority to
select a generation when no cache exists. No Shared opener is exported.

## Resource constructors

| Subpath | Constructors | Required destination |
| --- | --- | --- |
| `/open` | `openLocal`, `openPersonal` | Definition; Personal also requires `account` |
| `/blobs` | `LocalBlobs`, `PersonalBlobs` types | Borrow `store.blobs` |
| `/secrets` | `openSecrets` | `{ id }` |
| `/recorder` | `createRecorder` | `{ localBlobs }` |
| `/ai` | `openEpicenterInference`, `openRuntimeTranscriber`, `openEndpointInference` | Account, installed runtime, or endpoint URL |
| `/ai-connections` | `openLocalConnectionCatalog`, `openAccountConnectionCatalog` | No account, or `{ account }` |

Each owner exposes an abort signal and an idempotent asynchronous `close()`.
Close fences new operations immediately, then settles admitted work. Repeated
calls return the same completion, including a cleanup failure. Storage owners
retain exclusion when cleanup cannot prove competing writers would be safe.
Closing preserves committed data and credentials. It does not sign out, navigate,
or prove every edit reached durable storage or a server.

Default constructors select browser or host implementations with `isTauri()`.
`StoreRuntime` supplies document storage, local blob storage, SQLite acquisition, and admission to store openers.
`createMemoryStoreRuntime()` from `/testing` provides isolated IndexedDB-backed
store tests and a private WASM SQLite owner without changing globals. It retains committed data across handle
close and refuses disposal while a store still owns it. It supplies no simulated
recording, network, or credential capabilities.

## Blobs and recording

```ts
import { createRecorder } from '@epicenter/app/recorder';

const local = await openLocal(localDefinition);
const personal = await openPersonal(personalDefinition, { account });
const recorder = createRecorder({ localBlobs: local.blobs });

const added = await local.blobs.add(file);
if (!added.error) {
  const copied = await personal.blobs.copyFrom(local.blobs, added.data);
  // On success, copied.data is the new destination BlobId.
}
```

Definitions can differ. A Personal document containing text need not have Local
audio. `add(Blob)` creates an identity at its destination. `copyFrom(source, id)`
returns a fresh destination ID and preserves exact bytes. Repeated calls may
create duplicate objects. Supported directions are Local from Local or Personal, and
Personal from Local. Handles must be genuine store-owned sources. There are no
public arbitrary-ID writers, upload/download aliases, or destination overrides.

Both scopes expose `get`, `open`, and `delete`; Local also exposes `stat` and
`list`. Deleting a copy leaves the source, other placements, and rows alone.
Personal objects use the privately captured authority, principal, and definition ID.
Store handles expose no `identity`, `account`, `authorityId`, or `principalId`;
applications retain an Account separately when they need account data.
Local bytes stay under the definition's fixed `no-account` namespace. Account
changes do not move bytes or retarget handles.

Recorder Stop publishes locally and returns a Result containing
`{ blobId, durationMs, byteLength }`. The product separately creates its row.
Closing the Local store retires its recorders and waits for an admitted Stop
through the private writer after public admission is fenced. Closing the recorder
leaves Local usable. There is no `local.recorder` or remote recording destination.

Native copies retain descriptor snapshots and stream outside the WebView.
Browser copies acquire a Blob snapshot. Each transfer belongs to both stores.
Remote publication is limited to 25 MiB. Local publication failures retain the destination ID when known. A lost remote
creation response may leave that ID unknown. If native host cleanup cannot be
confirmed, closing both participating stores rejects and retains their claims
until context teardown, even if the host later finishes. An ordinary conflict
does not poison cleanup.

`get(id)` returns complete bytes. `open(id)` returns independently disposable
presentation. Personal presentation streams with HEAD, Range, and a pinned strong
ETag through the original Account; it creates no persistent Local placement.
Serve the exact `@epicenter/client/blob-worker` asset at
`/epicenter-blob-worker.js` and register it with scope `/` before presentation:

```ts
await navigator.serviceWorker.register('/epicenter-blob-worker.js', { scope: '/' });
// Wait until this exact worker controls the page before personal.blobs.open(id).
```

The desktop host serves that asset. Whispering registers it independently of Local
readiness and waits for its script URL to control the document.
A missing or incompatible controlling worker fails `open`; opening a cached
Personal store does not require the worker or a remote health probe.

A presentation expires after five minutes. Reacquire deliberately for continued
playback. Disposal, store close, version replacement, and Account retirement
refuse later requests. Already received or decoded media cannot be retracted.
Retiring Account does not close or erase the Personal cache; product departure
owns closing or replacing the store. Persist BlobIds, never presentation URLs.

## Results and presentation

Resource operations return typed Results for expected failures. Application
operations preserve those Results until a caller chooses recovery or presentation.
A UI boundary can use `toastOnError(result, title)` from `@epicenter/ui/sonner`;
it presents the error and returns the same Result. The resource package does not
import UI, show toasts, or choose retry behavior.

A workflow spanning bytes and rows must preserve completed work in its outcome.
If Stop saved audio but row creation failed, retain the blob ID. If copying
succeeded but storing its reference failed, retain the BlobId and placement. Retrying the
row write must not require recording or copying again.

Cancellation and presentation belong to the workflow owner. Deliberate departure
need not show an error toast. Startup failures need a persistent failure state.
Openers and `close()` retain their rejecting Promise contracts; invalid or closed
handle use can throw. The product owns cleanup and the error boundary for these
failures. A Result presenter does not catch arbitrary exceptions.

## SQLite and secrets

Every store acquires a local SQLite namespace as part of opening. Named databases
open explicitly through `store.sqlite.open(name)` and return Results. Use
`store.sqlite.delete(name)` to delete one named database and retire its old
connections. The borrowed namespace has no `close()`; close the containing store.

Local uses the existing `no-account` address. Personal adds the captured authority
and principal using the existing hex path encoding. Personal SQL remains local:
it does not sync or project Yjs tables automatically. Closing drains admitted SQL
work and releases physical connections; failed cleanup retains exclusion.
Browser storage uses an owner-specific OPFS pool. Native storage uses the host
SQLite lifetime socket. Older pools and account-independent files remain untouched.
See [Local Mail's migration limitation](../../apps/local-mail/README.md#existing-local-mail-data).

`openSecrets({ id })` addresses credentials by application ID and label.
Browser credentials remain in document memory; native credentials use the OS
keychain. Closing a handle preserves values. Credentials never enter Personal
rows. Saved inference keys use their separate catalog namespace.

## Inference

```ts
import {
  openEpicenterInference,
  openRuntimeTranscriber,
  openEndpointInference,
} from '@epicenter/app/ai';

const hosted = await openEpicenterInference({ account });
const runtime = await openRuntimeTranscriber(); // null when absent
const endpoint = await openEndpointInference({
  baseURL: 'https://inference.example/v1',
  getAuthHeaders: async ({ signal }) => ({
    Authorization: `Bearer ${await credentials.getToken({ signal })}`,
  }),
});
await endpoint.client.models.list();
await endpoint.close();
```

Hosted and endpoint handles own OpenAI-compatible clients. The native runtime
exposes `listModels()` and `transcribe()` directly; it does not emulate HTTP or
provide chat. An available runtime's failure remains an error; no constructor
chooses a fallback. Protocol compatibility does not imply support for every
network SDK operation.

```ts
const runtime = await openRuntimeTranscriber();
if (runtime) {
  const models = await runtime.listModels();
  // Present models.data for selection when models.error is null.
  // modelId is the exact ID selected from that host-provided list.
  const transcript = await runtime.transcribe(
    { audio, model: modelId, language: 'en' },
    { signal },
  );
}
```

Model IDs are opaque host catalog strings, not a TypeScript literal union.
The host lists installed models and validates the requested ID at execution.
An unknown or removed model fails; no active-model fallback is selected.
Explicit requests do not change the host's active-model setting. Cancellation
suppresses delivery and close drains admitted native work without unloading
the shared engine.

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

Svelte consumers call `fromData(store)` for each selected store. Root handles
normally live for the browser/WebView lifetime. Shared AppBoot captures the
account and gives product work a departure signal; it does not close returned
roots or retry acquisition in the same document. Document destruction ends the
roots, and the host retires document-owned native access. Products stop capture
when departure begins, even if navigation stalls. Explicit close remains useful
for earlier retirement and library cleanup. Reload is not a save barrier.

Clipboard is stateless: import `clipboard` from `/clipboard` directly. It needs
no resource handle and has no artificial close operation.

Run `bun run --cwd packages/app test` and `typecheck` from the repository root.
`smoke:recording` exercises synthetic Chromium capture and playback;
`smoke:admission` exercises real browser document ownership. Synthetic capture
does not establish physical microphone behavior or restart recovery.

License: AGPL-3.0-or-later.
