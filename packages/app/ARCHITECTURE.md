# Resource ownership

This page describes the implemented constructors. The target in ADR-0372 and
ADR-0423 makes each store own its blob namespace as `store.blobs`, removing
standalone public blob openers. That ownership cut is not implemented yet.

`defineApp` is an inert data declaration. Each resource constructor establishes
its own destination and lifetime. A product opens the resources its workflows
need, handles partial startup failure, and closes late results after unmount.

```text
Data declaration ──> openLocal ─────> local document admission and persistence
                 └─> openPersonal ─> captured account, cache, sync, admission
Application ID ────> openSqlite ────> named databases and physical SQL lifetime
                 ├─> openSecrets ──> credential namespace
                 └─> openLocalBlobs ─> bytes, display sources, admitted producers
                          ↑
                  createRecorder({ blobs })
Account + ID ──────> openRemoteBlobs ─> captured transport and transfers
Account ───────────> openEpicenterInference
Installed runtime ─> openRuntimeInference
URL + auth callback > openEndpointInference
                        each owns one client, requests, and response bodies
Account or local ──> connection catalog ─> saved records and their cached clients
```

Closing a dependency ends the operations that need it. Closing a recorder leaves
its destination alive; closing that destination retires the recorder. A transfer
borrows both blob handles and is cancelled by either. These relationships live
at their concrete boundaries, without a generic dependency container.

## Documents

`open-store.ts` captures Local or Personal identity and owns one document claim.
`store-runtime.ts` describes document admission and backing acquisition only.
`platform/documents.ts` provides the default implementation. The data engine
owns tables, KV, persistence, and synchronization; see [its README](src/data/README.md).

A second writer is refused rather than queued. Successful cleanup releases its
claim. Failed or uncertain cleanup retains exclusion until page or process
teardown. Personal generation replacement retires that Personal handle; the
product decides how its UI leaves the old session. Local remains independent.

`openData` owns a document over caller-supplied SQLite and leaves that connection
open on disposal. `openMemory` owns Bun test storage. `createMemoryStoreRuntime`
provides isolated document storage with the same admission and persistence paths,
without changing browser globals or pretending capture and network calls succeed.

## Capabilities

The blob owner holds public access and private publication separately. Its private
destination registry proves that a recorder or upload received a real LocalBlobs
handle. An admitted Stop can publish after public access is fenced. Native source
provenance includes the source application ID; the host validates that ID and
streams the exact source file.

SQLite admission belongs to the physical namespace owner. The opener acquires it
eagerly and exposes dynamic database names. Native close sends cancellation before
waiting for queued work. Secret handles own their pending operations while their
backend retains credential values after close.

`inference.ts` owns the destination check, authentication callback admission,
request cancellation, and response-body drain. Public source constructors live in
`ai.ts`; the native endpoint transport uses the host relay. Saved catalogs own
only their persisted records and cached clients. Native catalog keys stay in the
broker, guarded by access versions. Unsaved endpoint handles own their own cleanup.

## Consumers

Whispering, Local Mail, Honeycrisp, and Vocab compose named resources at product
startup. Their composition functions unwind partial acquisition. The shared boot
component invokes the product opening function with a cancellation signal, observes retirement, and releases a result
that arrives after unmount. It does not choose storage or inference resources.
Svelte's `fromData` adapts each store without owning its lifetime.

Operations that span multiple resources retain product cancellation checks.
Successful upload alone does not authorize a later row mutation after departure.
Document replacement and process restart can interrupt unsaved work; closing a
resource does not turn navigation into a durability guarantee.

## Import boundary

The package root and schema, store, sync, and artifact-format graphs are
platform-free. Resource subpaths load their specific implementations. Clipboard
selects its platform leaf directly because it owns no session resource.
`import-boundaries.test.ts` verifies these graphs and isolated document runtimes.
