# 0408. One App opener uses a complete runtime

- **Status:** Accepted
- **Date:** 2026-09-18
- **Amends:** [ADR-0407](0407-app-owns-the-declaration-and-data-engine.md) at App opening: an options object replaces the positional Account, and a complete runtime can be supplied publicly. Declaration and data-engine boundaries remain.
- **Amends:** [ADR-0391](0391-the-build-selects-every-implementation-and-an-application-declares-only-its-id-and-data.md) at implementation selection: the build selects the default runtime; explicit runtime injection is allowed at opening, never in declarations.
- **Implementation checkpoint:** The options opener, complete runtime, memory test support, and caller migration are implemented. The constructor boundary is under further review in the active execution spec.

## Context

Application tests should open the same App that production uses. Today,
`composeApp` accepts SQLite, blobs, secrets, recording, and AI internally, but
imports document acquisition and library claims directly. SQL acquisition
contains another global lock dependency. External tests either install browser
globals or assemble partial App handles around the data opener.

A second App implementation would duplicate the readiness, retirement, and
shutdown behavior these tests need to exercise. A memory runtime can instead
supply the resources beneath that behavior.

## Decision

**Production and application tests use `openApp(definition, { account?, runtime? })`.**

The public opening API is:

```ts
// Production: the package build selects the default runtime.
const app = openApp(definition, { account });

// Test: the same opener returns the same App handle.
const runtime = createMemoryRuntime();
const first = openApp(definition, { runtime });
const ready = await first.ready;
if (ready.error !== null) throw ready.error;
// Exercise application behavior through first.
await first.close();

// Same storage, fresh App lifetime.
const reopened = openApp(definition, { runtime });
```

`openApp(definition)` remains valid. Opening returns a synchronous handle;
`ready` reports acquisition and `close()` drains and releases resources.
The Account type still determines whether `app.account` exists. Definitions
remain inert. A supplied runtime replaces the complete default; missing
members never fall back to browser or native resources.

The runtime contract belongs with the App opener. `createMemoryRuntime` has a
separate test-support entrypoint, unreachable from production defaults and
declaration imports. Its export path is an implementation choice. There is no
second application opener, per-declaration runtime, or separate AI override.

**The App owns policy and lifetime; the runtime supplies resources.**

```text
defineApp(...)                       inert schema and identity
      |
openApp(definition, { account?, runtime? })
      |
      +-- one App lifecycle
      |   scopes, readiness, sync, retirement, draining, close
      |
      `-- complete runtime
          document storage, ownership, named SQL, blobs,
          secrets, recording, AI connections
          |
          +-- browser default
          +-- host default
          `-- explicit memory runtime
```

App scope selection, account capture, claim ordering, retirement fences, and
claim retention after failed cleanup remain shared. Account supplies identity
and account-bound network transport separately from runtime selection. A
memory runtime does not turn an account library into a disconnected local
store. Account tests supply a fixture Account when they need a simulated server.

**The memory runtime reuses production services over temporary resources.**

Document acquisition and blob storage use the existing IndexedDB logic over
an isolated `fake-indexeddb` factory. Named SQL uses SQLite WASM in memory and
shares the SQL adapter and restricted-query implementation with the browser
path. Shared service code owns formats, addresses, generation installation,
and invalidation. The runtime supplies storage and coordination mechanisms.
Native services remain separate where they use host capabilities.

Memory storage and claims belong to the runtime instance. App closure releases
handles without erasing that storage. Reopening against the same runtime
restores committed data; a fresh runtime starts an independent environment.
Explicit memory-runtime disposal requires its Apps to have closed and releases
the temporary resources. App never disposes its runtime.

This models close/reopen in one runtime, not browser reload or process-crash
recovery. Browser secrets, for example, have a different reload lifetime from
durable IndexedDB data. Reload simulation is outside this decision.

Recording and inference are explicitly unavailable unless an implementation
or test transport supplies them. Memory selection never silently accesses a
real microphone or ambient inference endpoint. Runtime construction pairs a
recorder with the blob storage it publishes into.

**Ownership is acquired once at its boundary and held until cleanup permits release.**

For each existing canonical library ownership key, only one live producer may
own its backing storage. Competing opens are refused before storage or network
acquisition. The coordination domain must match the storage domain: across
browser contexts for shared browser storage, and across Apps sharing one memory
runtime for isolated memory storage. An object-local singleton alone cannot
enforce browser-wide ownership.

Locks implement this invariant internally. Callers do not acquire or release
them. This record does not require today's number of lock layers. Redundant
claims can be removed when the remaining owner covers every acquisition path,
including lower-level consumers, and retains exclusion after failed cleanup.
Keep claims separate from document acquisition so App can claim all scopes
before opening resources.

Blob operations versus whole-store erasure and account-wide AI configuration
writes have separate concurrency requirements. An App claim does not
automatically cover them. Shared service reuse requires a memory coordinator
that supports the actually used shared, exclusive, and queued operations;
the current exclusive-only test helper is insufficient.

## Consequences

Application tests can delete partial App fixtures, document-module spies, and
duplicate SQL adapters. Engine and protocol tests keep `openData` and
`openMemory`: their caller-owned connections and independent replicas are
different boundaries from a complete App.

The runtime adds an explicit resource contract and temporary implementations.
It does not promise fewer total lines or replace browser and host integration
coverage. There is no dependency-injection container, generic service registry,
full browser emulator, fake authority, or App-specific test mode.

Migration replaces positional Account callers, including untyped evidence
scripts. The old shape must not silently open a signed-out App. Current package
documentation changes when the implementation lands; this ADR records the runtime boundary; delivery evidence belongs in tests.

Implementation must demonstrate isolated runtime instances, same-runtime
reopen, duplicate-open refusal, draining and retained claims on close failure,
account retirement, restricted SQL queries, and import-time independence from
browser globals when an explicit memory runtime is used. The existing `idb`
wrapper expects global IndexedDB constructors even with an injected factory;
test setup must contain that dependency without swapping storage globals per
App. Browser and host smoke tests remain necessary.

This changes no persisted namespace, format, wire protocol, or ownership key.
Internal claim consolidation is a proof obligation, not authorization to
weaken exclusion or silently change which contexts can write concurrently.

## Considered alternatives

- A separate memory App or test-only opener. This duplicates the lifecycle or
  makes application tests use a different public API.
- A partial runtime merged with platform defaults. An omitted resource can
  escape into real storage, capture, or network behavior.
- New memory document and blob services. Existing IndexedDB services can run
  over temporary storage while preserving their behavior.
- Remove exclusion because callers open one App per page. Different pages
  have independent singletons but can address the same persisted library.
- Centralize every App in a shared worker or host to eliminate client claims.
  This moves ownership and adds transport and failure handling; runtime
  injection does not require that architecture change.
- Consolidate every data opener into App. Worker and engine consumers would
  acquire an unrelated application lifetime and capabilities.
