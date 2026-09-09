# One current generation, cache-first startup, and restore by reload

**Status:** In Progress

## Shared startup integration and remaining proof

The user assigned the overlapping startup boundary to the Honeycrisp
library-ownership continuation and selected one current authority with full
page reopening. Follow `20260909T004225-library-ownership-execution.md` for its
active implementation and exact evidence. The paused initializer proposal in
ADR-0385 has been reconciled with this contract: no list/max adoption or separate
initial-generation owner participates in startup.

The continuation owns `packages/server/src/store-sync/`, the shared route
constants, and browser acquisition. It mounts the existing current-authority
transaction, binds hibernated sockets to their admitted generation, and uses the
optional-header cache for App startup. Historical numbered libraries remain
untouched and their rollout remains a separate decision. The Honeycrisp Alice/Bob browser slice and 31 Worker tests pass. Exact commands
and limits are in the ownership execution spec; production restore remains
unmounted.

Remaining restore work:

1. Compose verified archive storage and blob installation with a retained backup
   and durable activation request. Prove durability, retention, request-bound
   receipt recovery, and the deliberate restore operation.
2. Extend complete browser and Worker proof to production restore activation,
   interruption, failed invalidation, obsolete downloads, and real hibernation.
   Preserve working-copy mismatch refusal.
3. Keep restore generation retirement distinct from Account retirement and
   ordinary library switching. Only confirmed generation retirement authorizes
   discarding a replica's pending edits.

No restore endpoint, deployment, destructive migration, or real-library deletion
is authorized by the Honeycrisp slice. This spec remains In Progress.


## Restore scope

Restore replaces the library's current generation; devices invalidate retired
IndexedDB replicas and reload, while ordinary use stays cache-first and
offline-capable.

The design is in [ADR-0379](../docs/adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md).
The current authority now lives in `packages/data/src/sync/authority.ts`.
Its portable transactions and generation-bound hub lifetimes are exercised under
`packages/data/evidence/current-generation/`. The replaced native Bun harness has
been deleted. Production browser startup now uses the stable current authority. Done means the
authority rejects all retired writes, browser invalidation survives interruptions,
restore preserves its promised archive contents, and affected applications reload
through normal bootstrap without a generation picker.

## Settled product contract

- One current numeric generation per synchronized library, under one stable
  library address. No UUID change is needed to solve this problem.
- Restore reconstructs application data into a fresh Yjs lineage. Replaying an
  archived Yjs binary carries old history and is not this reconstruction.
- The authority activates the replacement and permanently rejects old identities.
  Retired bytes can be removed after installation and backup requirements hold.
- Every reconnecting device discards all unsynchronized work in a retired
  generation. The user explicitly chose this loss policy. Do not add stranded-work
  recovery, generation selection, or read-only predecessor browsing.
- Cached IndexedDB data opens offline until retirement is learned. An optional
  generation header identifies a valid complete cache; absence means bootstrap.
  There is no persisted `held/rejoining` state machine.
- Retirement fences old writes, invalidates the cache under the library claim,
  closes the App, and reloads the page. The new page downloads and opens the
  replacement. No document swap happens inside a live App.
- Ordinary folding stays automatic. Archives are immutable recovery artifacts.
  No automatic fresh-document or nested-container replacement for maintenance.

## Evidence and current entrypoints

Read actual signatures before editing; the working tree is active and these
paths can change independently of this spec.

```txt
packages/server/src/store-sync/
  generations.ts       number allocation and admission ledger
  authority.ts         one independently writable generation per authority
  mount.ts             allocate/store/admit import; generation-routed sockets
packages/data/src/
  store/browser.ts     generation-named IDB, list/max discovery, bootstrap
  store/store.ts       App resources, sync, close and persistence ownership
  store/persistence.ts pending writes; close drains the queue
  store/log.ts         acknowledged-log folding
  sync/connection.ts   waits for admitted; retirement stops the driver
  sync/attach.ts       socket adaptation; retirement result must reach lifecycle
  sync/authority.ts    log/snapshot semantics
  sync/hub.ts          membership, frames, in-flight chunks
  artifact/checkout.ts working-copy push/pull; manifest identifies generation
packages/device/src/library-claim.ts origin-wide app/account exclusion
packages/app/src/open.ts             App resources and retirement forwarding
apps/honeycrisp/src/lib/application.ts page-owned App and departure
packages/sync/src/{store-route,generations-route}.ts wire addresses
```

At task start, the mount skipped ledger admission for WebSocket upgrades. A
concurrent task has since added that check and a server-selected initial
generation. Route admission still cannot retire an already-open socket. Browser
discovery still scans locally named generations and otherwise takes a remote
maximum. Ordinary close drains pending writes; retirement now has a separate
discard path. The new current authority and cache remain unmounted.

## Target ownership

One stable library authority owns the current number, active log/snapshot, socket
admission, and replacement transaction. Generation checks and writes must share
one serialization domain. Removing the separate generation ledger is a target
collapse, not permission to distribute its invariants among callers.

Current discovery returns the authoritative generation with snapshot bytes and
their log position. Never attach a number fetched separately to downloaded bytes.
First-run `ensureCurrent` is atomic: two empty-cache devices get the same library.
Local absence or network failure never authorizes creation of another history.

Replacement preparation can happen outside the transaction. Activation compares
the destination generation and exact head covered by its capture, installs the
complete replacement, advances the generation, and records an operation receipt.
A retry after a lost response returns that receipt rather than replacing again.
The stored snapshot alone can lag the authoritative head; capture must include
the tail. Archive identity does not become the new synchronization identity.

All old sockets, hibernated attachments, queued frames, chunk assembly, snapshot
offers, and acknowledgements belong to their generation. Rebuild or invalidate
old hub state during activation. There must be no asynchronous gap between the
decisive generation check and acceptance of a write.

One stable IndexedDB database holds an optional generation header and update rows.
The outbox and cursor stay derived from those rows. Keep append-sized persistence;
do not rewrite the entire library as one cache object per edit. Invalidation and
baseline installation atomically change the header and rows together.

Conceptual responsibilities, not existing public APIs:

```ts
async function openLibrary() {
  const cached = await readGenerationAndUpdates();
  if (cached.generation !== undefined) return hydrateAndConnect(cached);
  const current = await ensureAndDownloadCurrent();
  await installAtomically(current);
  return hydrateAndConnect(current);
}
```

Retirement stops sending and invokes one backing-owned discard operation.
That operation fences writes synchronously before returning its invalidation
promise. The App owner stops producers, awaits invalidation, closes the App,
and reloads only after successful cleanup. Separate public fence and invalidate
methods would make callers coordinate an invariant the backing already owns.

Previously submitted overlapping transactions finish before invalidation clears
their effects; later old writes cannot succeed. Repeated discard shares in-flight
work. Failed invalidation keeps the write fence closed and permits an explicit
retry of invalidation. Ordinary close retains its flush behavior; discard is a
different durability promise, not another close mode.

Retain the library claim through invalidation and cleanup. Do not use whole-IDB
deletion as the correctness gate: other connections can block it. If invalidation
fails, keep the old App unusable and surface/retry the storage failure; do not
reload as if invalidation succeeded. A crash before the invalidation commit can
leave the prior cache; after commit, no restart may hydrate it.

Download failure uses ordinary bootstrap retry with no valid cache. It must not
seed an empty remote document or reload in a loop. Boot ownership rejects late
responses. A restore during download may obsolete its generation; admission
checks it again before sending. Cached open never proves perpetual currency.

## Implementation sequence

1. Re-read current code and capture a focused validation baseline in the dirty
   checkout. Trace hosted and self-hosted wiring, app openers, checkout callers,
   and persistence ownership. Produce failing invariant tests in isolated storage
   before changing production discovery or deleting the ledger.
2. **Checkpoint implemented and reviewed:** replace the private storage harness
   with one portable authority transaction owner and generation-bound hub lifetimes. Move the
   existing log SQL into transaction-local operations shared by the current
   deployed wrapper and the unmounted replacement. Preserve activation and
   receipt tests, and add retired-delivery, queued-push, partial-chunk, offer,
   synchronous-reply, and reconstructed-attachment cases. Delete the replaced
   harness implementation. Keep activation unmounted until complete backup and
   restore fidelity is established.
3. Add explicit admitted/retired synchronization outcomes. Socket open alone
   must not send the outbox. Ordinary transient failures preserve cache and
   retry; authenticated retirement terminates that App lifetime.
4. Prove the optional-header IDB cache, write fence, atomic invalidation, and
   complete install in a real browser. Wire retirement to App cleanup and page
   reload. Reuse the normal bootstrap path. Preserve local-only startup and
   account/authority isolation; update all affected app consumers.
5. Establish complete archive capture and reconstruction fidelity, including
   rich content, settings, unknown stored values as promised by the format, and
   referenced blobs. Define archive version/migration behavior. Verify a backup
   before destructive activation. A rendered folder or ZIP of current files
   does not establish a complete consistent backup by itself.
6. Integrate deliberate restore and remove independently writable-generation
   APIs, list/max discovery, and obsolete tests. Keep push/pull rejecting a
   manifest from a different generation. Apply design review at the meaningful
   structural checkpoint and local post-implementation review before handoff.

These are dependency checkpoints, not a prescription for new helper layers.
Before implementation, inspect consumers and select the smallest complete first
slice. Do not deploy or delete real libraries as part of proving the protocol.

## Required proof

| Case | Required result |
| --- | --- |
| Two first devices with empty caches | One current generation, not two imports |
| Accepted write during replacement preparation | Activation fails its captured-head condition |
| Two concurrent restores | One winner for the same expected generation/head |
| Lost restore response and retry | Same durable receipt, no second activation |
| Ten sequential restores | Fresh lineages; no merge into prior document |
| Old socket, queued push, partial chunk, or hibernated socket | No write accepted into current generation |
| Old generation bytes already deleted | Old identity cannot recreate a writable history |
| Cached device opens offline | Existing valid cache remains usable |
| Retirement with pending writes | All pending work discarded; no automatic recovery |
| Persistence transaction paused across retirement plus late edit | No old writes survive invalidation or contaminate replacement |
| Crash around invalidation/install | Prior valid cache before invalidation, absence after it, or complete new baseline |
| Another raw IndexedDB connection stays open | Invalidation completes without database deletion |
| Failed download or missing local cache | Ordinary retry; no empty remote creation or reload loop |
| Late response after App closure; restore during download | Obsolete owner cannot install; admission rejects retired generation |
| Existing editor or recorder still holds old references | Old lifetime cannot produce accepted/persisted writes |
| Different-generation working-copy manifest | Push refuses; no reinterpretation as mass edits/deletions |
| Archive round trip | Promised fields, content structure, and blobs survive reconstruction |

## First storage checkpoint, 2026-09-09

The private harness owns one current number and reuses the existing opaque log.
It has no production imports, route, or package export. Its raw activation input
is trusted test data; it does not verify a backup or reconstruct application data.

Twelve tests establish the following within one synchronous SQLite serialization
domain: competing first callers observe one baseline; capture includes a tail
longer than one read batch; accepted writes invalidate the capture condition;
competing activations have one winner; retired appends and folds are refused;
receipt retries survive reopening and later activations; operation ID reuse with
different inputs is refused; failed receipt or replacement-snapshot storage rolls
back the replacement, including the prior tail;
failed initial seeding leaves no current number; ten raw replacements retain only
their own bytes; ordinary folding preserves the generation and uncovered tail.

The first test run failed because the new authority module did not yet exist.
After implementation and review, the suite passed 12 tests with 102 assertions. This is
test-first construction, not a demonstrated production retirement regression.
The competing calls are scheduled in one process. They do not prove contention
between independent processes or Durable Object event handling.

The harness accepts Bun's native `Database`. Its outer transaction encloses the
existing log's transactions using Bun savepoints. The shared `SqliteDatabase`
contract explicitly does not support nesting. Before production integration,
give the stable authority ownership of log mutations within one transaction;
do not export this harness or widen the shared adapter promise to accommodate it.
Receipts currently remain indefinitely in isolated storage. Their production
retention and storage bounds remain undecided.

Validation from repository root:

```sh
bun test packages/data/evidence/current-generation/authority.test.ts
bun test packages/data/src/sync packages/data/src/store/persistence.test.ts
bun x tsc --noEmit --strict --skipLibCheck --module preserve --moduleResolution bundler --target esnext --lib esnext --types bun --noUncheckedIndexedAccess packages/data/src/sync/authority.ts packages/data/src/sync/hub.ts packages/data/evidence/current-generation/authority.test.ts packages/data/evidence/current-generation/hub.test.ts
```

The task-start sync/persistence baseline passed 128 tests with 799 assertions.
The final combined run passed 140 tests with 901 assertions.
The task-start data package typecheck failed on browser globals in
`evidence/library-ownership/device.ts` and `src/store/browser.ts`. A subsequent
run also encountered concurrent changes in `src/store/store.ts`. The focused
harness typecheck passes; the full package is not claimed green.

Independent design review accepted the bounded storage proof with no correctness
blocker in its stated scope. It identified one missing rollback test: a nested
log failure after deletion must restore the old snapshot and tail. That test was
added and passes. The review also confirmed the next ownership change below:
the portable authority must own log mutations directly, without cross-owner table
deletion or nested transactions. No production API or rollout decision was made.

Next proof obligations, in dependency order:

1. The authority-plus-hub checkpoint below now covers delivery and mutation,
   including retained old hub references. Continue with observable wire admission;
   the unmounted owner alone does not retire an application's socket.
2. Add explicit admission before replica sending. Prove the optional-header
   backing with a paused persistence transaction, late edits, failed invalidation,
   interrupted installation, and another open IDB connection in a real browser.
   Keep the library claim through invalidation and App cleanup before reload.
3. Prove complete archive capture and fresh-lineage reconstruction, including
   rich content, settings, unknown values promised by the format, and blobs.
   Ten opaque replacements do not establish ten fresh Yjs lineages.
4. Integrate normal bootstrap and restore consumers, preserve manifest refusal,
   and remove old discovery only after the protocol passes. Existing-history
   rollout remains a separate decision; this checkpoint authorizes no migration.

## Portable authority and hub checkpoint, 2026-09-09

`openCurrentAuthority` now shares private transaction-local log operations with
`openSyncAuthority`. It accepts the shared `SqliteDatabase` contract. The old
`evidence/current-generation/authority.ts` implementation has been deleted.
Neither a route nor the package barrel exposes raw activation.

The owner provides atomic `ensureCurrent`, complete snapshot-plus-tail `capture`,
and a fixed-generation `bind` capability. Each bound operation checks the durable
current number in the same transaction as its read or mutation. Preparation
copies the request and hashes its bytes with Web Crypto; the returned `activate`
method compares the captured generation/head and installs the replacement and
request-bound receipt synchronously. Historical retries retain their original
receipt after reopening and later activations. The current number is independent
of receipt retention. Existing log bytes without a current number refuse first
creation; the owner does not choose an existing history to adopt.

Each hub holds one fixed capability. Activation retires its old lifetime after
commit; rollback preserves membership and partial submissions. Retirement drops
membership, collectors, and queued replies together. Admission checks before and
after outbound sends also fence bytes already read into memory when a synchronous
callback activates a replacement, including through a separately reopened owner.
The authority retains only its current hub. `createHub` returns a Result;
failed admission exposes no hub. Retrying through the owner returns its shared
current lifetime. The follow-up review caught why an unretained failed candidate
was unsafe: it could later become usable and split same-generation peers across
two relay groups. Tests now cover both future-generation requests and transient
storage recovery.

The independent review accepted this ownership and found one preservation gap:
a failing admission transaction silently dropped a push. The repair gives
history-free refusals a separate send path guarded by live membership, forgetting
any partial bytes for the refused submission. Storage failure does not prove
retirement. Snapshots, entries, and acknowledgements still require durable
admission. Regression tests cover failures before and during collection,
persistent storage failure, and activation inside a refusal callback.

Validation for this checkpoint:

- Sync, persistence, and current-generation suites: 156 tests, 996 assertions.
- Existing server browser-dial suite: 4 tests, 13 assertions.
- Checkout and root-rotation suites: 74 tests, 219 assertions.
- Focused TypeScript checks of the authority, hub, and their proof tests pass.
- The full data typecheck reproduces the exact task-start failures in browser
  globals under `evidence/library-ownership/device.ts` and `src/store/browser.ts`.
- Before documentation edits, doc hygiene reported 40 existing ADR status and
  dependency issues. This checkpoint changes no ADR status.

The adapter used by the storage proof rejects nested transactions. Tests preserve
activation rollback, exact receipt identity, complete capture, ordinary folding,
retained-handle refusal, and immutable prepared requests. Hub tests cover retired
joins, simulated attachment reconstruction, partial pushes and offers, queued
replies, materialized chunks, receipt retries, and failed activation. These are
in-process proofs, not independent-process or deployed Durable Object evidence.

## Browser, wire, lifecycle, and archive checkpoints, 2026-09-09

The browser backing in `src/store/current-cache.ts` stores one optional generation
header with update rows. Installation and invalidation are atomic. `discard()`
fences synchronously, shares pending invalidation, and keeps the fence closed
when storage failure requires retry. Existing backing and new cache share
`idb-updates.ts`; ordinary edits retain append-sized persistence.

Native Chromium and WebKit each pass 27 checks, independently reproduced during
review. These cover overlapping writes, late calls, transaction failure/retry,
another open connection, caller mutation, and real page interruption around
invalidation and installation. They prove native storage behavior, not the full
App reload loop or process/power-loss durability.

The wire now sends explicit `admitted` and `retired` control frames. Socket open
cannot start the outbox. The driver waits for admission, bounds that wait, and
stops synchronously on retirement. Hub retirement notifies idle sockets and
fences outbound chunks even when retirement occurs inside a send callback.
Notification failure cannot roll back activation or skip other members. A
review regression also proves a throwing host socket teardown cannot prevent
the backing-fence callback or leave send/retry work running.

Store retirement discards pending persistence and revokes its lifetime before
publishing `LibraryRetirement`. App forwards that notice. The page stops UI
producers, awaits cache invalidation, closes App, then reloads. Failure retains
the claim and allows explicit invalidation/producer-cleanup retry. The deployed
backing does not yet implement retirement discard; that case deliberately fails
closed and retains resources. Do not mount restore before replacing bootstrap.
The real App regression proves failed invalidation refuses close and a competing
open, then successful retry permits close and reacquisition. Retirement starts
recorder-owner closure while invalidation is pending; final App cleanup still
observes that release result. Native browser proof
of this complete lifecycle remains an integration obligation.

Unmounted `src/artifact/archive.ts` captures visible Yjs structure into a versioned
archive, including named roots, attributes, formatting, settings, unknown stored
values, and referenced blob bytes/MIME types. Reconstruction authors a fresh
lineage and verifies both its values and its serialized replay. Version 1 refuses
unsupported versions, subdocuments, unresolved Yjs dependencies, malformed
manifests, and missing blobs. Tagged values preserve binary, undefined, bigint,
and special numbers.

Blob storage cannot enumerate references, so v1 requires every nominal BlobId
found in stored strings and keys, including URLs. A plain-text mention of an
unavailable BlobId therefore refuses capture. This conservative behavior is
explicit; it needs product acceptance before the format becomes public.
Thirteen archive tests pass with 92 assertions, including ten sequential fresh
lineages and a concurrent accepted write that prevents stale activation. Review
found that BlobIds split across formatted text runs were missed. Capture and
preparation now scan adjacent text runs together, preserving embed boundaries;
regressions prove missing blobs cannot pass either boundary.

## Reviewed checkpoint validation

- Sync, current-authority, persistence, store-retirement, archive, and departure:
  208 tests, 1,244 assertions, passing.
- App retirement: two tests, 10 assertions, passing.
- Recorder owner and Whispering producer cleanup: 11 tests, 41 assertions,
  passing. Failed VAD destruction retains its owner, and retry uses the same UI
  cleanup capability after unmount before permitting App closure.
- Native browser cache: 27 checks in Chromium and 27 in WebKit, independently
  reproduced during review.
- Focused TypeScript checks pass for the authority/hub, archive, DOM backing,
  and lifecycle. App and Recorder package typechecks pass.
- Whispering Svelte checking has seven errors across five files in auth and SQL
  fixture integration, including bootstrap auth-client members. App-shell checking
  reports an inference-picker test null/undefined mismatch. No diagnostics point
  to the recorder cleanup or layout repair. These package checks remain failing;
  reconcile them with the concurrent owners before full integration.
- Full data typecheck still reports eight browser-global diagnostics from the
  task baseline. The extracted engine now owns the `IDBKeyRange` diagnostic;
  the remaining diagnostics are in browser discovery and library-owner evidence.
- Workerd authorization-deadline tests: eight pass after expectations include
  the new admission control. The full workerd and App suites remain unresolved
  against concurrent initialization changes; do not count them as green.
- Documentation hygiene still reports the same 40 existing ADR issues. No ADR
  status changed, and the focused diff whitespace check passes.

The independent final review accepted all three repairs: guaranteed retirement
notification after socket-close failure, BlobId recognition across formatting,
and retryable producer cleanup with ownership retained.

Reproduce the main checkpoint from the repository root:

```sh
bun test packages/data/src/sync packages/data/evidence/current-generation packages/data/src/store/persistence.test.ts packages/data/src/store/store-retirement.test.ts packages/data/src/artifact/archive.test.ts packages/app-shell/src/boot-screens/departure.test.ts
bun test packages/recorder/src/vad-recorder.test.ts apps/whispering/src/lib/operations/recording-close.test.ts
bun test packages/app/src/app.test.ts -t 'App retirement'
bun packages/data/evidence/browser/current-cache.ts
bun packages/data/evidence/browser/current-cache.ts --webkit
```

## Commit verification, 2026-09-09

The staged source was materialized in a separate checkout, with workspace
packages resolving inside that checkout and installed third-party dependencies
reused. This excludes concurrent auth, SQL, and bootstrap source changes.

- Authority, sync, persistence, store retirement, and departure: 195 tests,
  1,152 assertions, passing.
- The complete App test file: 36 tests, 185 assertions, passing. App typecheck
  also passes. The earlier full-App failures belong to the combined working
  tree's bootstrap integration; the isolated restore commit does not reproduce
  them.
- Recorder and Whispering producer cleanup: 11 tests, 41 assertions, passing.
- Structural archive: 13 tests, 92 assertions, passing.
- The staged cache passes 27 native checks in Chromium and 27 in WebKit.

Partial staging preserves the existing app composition in committed source.
Retirement is wired into each committed application module. The working tree
also has another task's lazy Whispering bootstrap and auth changes; its
retirement wiring and readiness cleanup remain in that ongoing composition.
Preserve them when committing that refactor. The restore commits do not include
that unrelated refactor or server initialization work.

## Integration pause and remaining proof

Another active task changed server generation routing, the initialization ledger,
and browser discovery during this execution. It now owns changes in
`packages/server/src/store-sync/`, `packages/sync/src/generations-route.ts`, and
the bootstrap portion of `packages/data/src/store/browser.ts`. The attempted
current-server replacement was backed out to preserve that work. The user has
been asked which task should own their integration. No answer has been received.

After ownership is settled:

1. Mount one current authority per stable library address, retaining generation
   identity in hibernated socket attachments. Replace discovery with atomic
   current download and the optional-header cache. Remove independently writable
   histories only after a grounded existing-history rollout decision.
2. Persist an immutable backup and verify its read-back before activation.
   Install and verify destination blobs, capture the destination condition, and
   expose a deliberate restore operation with durable receipt retry.
3. Prove the complete browser App loop, offline cached startup, failed download,
   obsolete boot responses, editor/recorder cleanup, and real Durable Object
   eviction/hibernation around restore. Preserve working-copy mismatch refusal.
4. Run affected integration suites after the concurrent bootstrap work settles.
   The current old App test fixtures expect the earlier initialization protocol;
   the full workerd run also has initialization/connection failures. These are
   unresolved integration results, not a passing restore checkpoint.

No restore endpoint, deployment, destructive migration, or real-library deletion
was performed. The spec remains In Progress.

## Evidence already gathered

- [Root-replacement experiment](../docs/benchmarks/yjs-root-rotation/README.md):
  16 cases, 48 isolated cold-open samples. Nested replacement discards stale edits
  and retains historical writer IDs; it is comparative evidence, not the target.
- [Actual checkout benchmark](../docs/benchmarks/yjs-root-rotation/checkout.md):
  24 cases. One hundred one-character changes to a 1 MB body author about 100 MB
  of updates; persisted bytes are about 101 MB offline and 39 MB acknowledged,
  while fully folded state is about 1 MB. Unchanged pushes and pulls author none.
- Checkout and root-replacement suites: 74 pass, 219 assertions. Data typecheck
  passed after the benchmark changes. These do not prove the new protocol.
- All runtime experiments use `@y/y` **14.0.0-rc.24**. Do not substitute Yjs 13.

Useful baseline commands, from repository root:

```sh
bun test packages/data/src/artifact/checkout.test.ts packages/data/src/__benchmarks__/root-rotation.test.ts
bun run --filter @epicenter/data typecheck
bun packages/data/src/__benchmarks__/checkout.bench.ts
```

Add focused sync/authority and real-browser interruption tests for the code
changed. Locate current browser runners under `packages/data/evidence/browser/`;
the existing benchmark and unit tests alone are not completion evidence.

## Remaining judgments and separate work

The lifetime design is settled. Archive format/versioning, exact endpoint/frame
names, receipt retention, temporary replacement storage limits, and rollout of
existing independently writable generations still need implementation evidence.
Do not silently select a maximum and destroy other existing histories during a
migration. Determine the deployed data situation and record the rollout decision
before activating it on real libraries; no production action is authorized here.

Byte-aware acknowledged-log folding and smaller plain-text updates are worthwhile
maintenance investigations, but are separate from this restore implementation.
Do not add them to the critical path or introduce automatic resets to compensate.

When completed, update durable ADRs without changing accepted records' decisions
in place, retire the now-spent spec, and record any required history entry under
repository conventions. ADR status changes still require explicit authorization.
