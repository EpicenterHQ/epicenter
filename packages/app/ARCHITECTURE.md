# Resource ownership

`defineStore` declares data. A Local or Personal store owns document, blob, and SQLite
readiness, admission, and terminal cleanup. The schema remains platform-free.
Other services acquire independent resources.

```text
Definition -> openLocal -> tables, KV, Local blobs, Local SQLite
           -> openPersonal(Account) -> tables, KV, captured Personal blobs, Personal SQLite
Local blobs <- createRecorder({ localBlobs })
Application ID -> openSecrets -> credential namespace
Account -> openEpicenterInference
Installed runtime -> openRuntimeTranscriber -> model listing and transcription
URL + auth callback -> openEndpointInference
Account or local -> connection catalog -> saved records and cached clients
```

A transfer borrows genuine source and destination handles. Both track admitted
work. Closing a recorder leaves its Local destination alive; closing Local retires
its recorders while allowing admitted Stop publication. SQLite remains local, including on Personal; no SQL projection is implemented.

## Documents

`open-store.ts` captures Local or Personal identity and owns one store claim covering document, blob, and SQL access.
`store-runtime.ts` describes store admission, document backing, local blob acquisition, and scoped SQL acquisition.
`platform/documents.ts` provides the default implementation. The data engine
owns tables, KV, persistence, and synchronization; see [its README](src/data/README.md).

A second writer is refused rather than queued. Successful cleanup releases its
claim. Failed or uncertain cleanup retains exclusion until page or process
teardown. Personal generation replacement retires that Personal handle; the
product decides how its UI leaves the old session. Local remains independent.

`openData` owns a document over caller-supplied SQLite and leaves that connection
open on disposal. `openMemory` owns Bun test storage. `createMemoryStoreRuntime`
provides isolated document, blob, and SQL storage with the same admission and persistence paths,
without changing browser globals or pretending capture and network calls succeed.

## Capabilities

The blob owner holds public access and private publication separately. Its private
destination registry proves that a recorder or copy received a real LocalBlobs
handle. An admitted Stop can publish after public access is fenced. Native source
provenance includes the source application ID; the host validates that ID and
streams the exact source file.

SQLite admission belongs to the physical namespace owner. The containing store acquires it
eagerly and exposes dynamic database names. Native close sends cancellation before
waiting for queued work. Secret handles own their pending operations while their
backend retains credential values after close.

`inference.ts` owns the destination check, authentication callback admission,
request cancellation, and response-body drain. Public source constructors live in
`ai.ts`. Network endpoint transport uses the host relay on desktop.
`runtime-transcriber.ts` validates direct native model-listing and transcription
IPC, preserves the exact host catalog ID, and drains admitted compute on close.
Saved catalogs own their persisted records and cached clients. Native catalog keys stay in the
broker, guarded by access versions. Unsaved endpoint handles own their own cleanup.

## Consumers

Product startup owns composition. The shared boot component invokes product opening with a departure signal and captures account
identity. Root handles normally last until browser/WebView destruction; AppBoot
does not close late results or reopen roots in the same document. Product work
must stop admission and capture on departure even if navigation stalls. The host
retires document-owned native access when the document is replaced. Explicit
resource close still owns cleanup and admitted-work drainage.
Svelte's `fromData` adapts each store without owning its lifetime.

Operations that span multiple resources retain product cancellation checks.
Successful copy alone does not authorize a later row mutation after departure.
Document replacement and process restart can interrupt unsaved work; closing a
resource does not turn navigation into a durability guarantee.

## Import boundary

The package root and schema, store, sync, and artifact-format graphs are
platform-free. Resource subpaths load their specific implementations. Clipboard
selects its platform leaf directly because it owns no session resource.
`import-boundaries.test.ts` verifies these graphs and isolated document runtimes.
