# One current generation, cache-first startup, and restore by reload

**Status:** In Progress

Restore replaces the library's current generation; devices invalidate retired
IndexedDB replicas and reload, while ordinary use stays cache-first and
offline-capable.

The reconstruction design is in [ADR-0379](../docs/adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md).
The agreed recovery API and backup history are recorded in
[ADR-0386](../docs/adr/0386-recovery-restores-only-verified-backups-and-owns-retry-identity.md).
The current authority now lives in `packages/data/src/sync/authority.ts`.
Its portable transactions and generation-bound hub lifetimes are exercised under
`packages/data/evidence/current-generation/`. The replaced native Bun harness has
been deleted. Production browser startup now uses the stable current authority through the Honeycrisp integration. Done means the
authority rejects all retired writes, browser invalidation survives interruptions,
restore preserves its promised archive contents, and affected applications reload
through normal bootstrap without a generation picker.

## Active execution path

Build one library-bound recovery owner: every restore uses a published backup ID,
and the owner manages the safety backup and durable attempt behind the call.
The five-method API below is the target. `src/recovery.ts` now implements backup,
import, list, and download as an unmounted coordinator. Restore, authenticated
recovery transport, and durable client intent remain unimplemented.

Read Settled product contract, Target ownership, Recovery API and execution,
and Required proof first. Dated checkpoint sections preserve prior evidence;
they are not an alternative implementation sequence. Current-authority startup,
complete captured-head download, and Honeycrisp retirement/reload are integrated
and exercised together. Production restore orchestration and existing-history
rollout remain unresolved.
This execution path targets synchronized libraries. Preserve existing local-only
startup; local-only backup and replacement need an equivalent local recovery
owner and are separate unresolved work.

## Verified publication checkpoint, 2026-09-09

`createLibraryRecovery` binds application/data identity, the stable authority,
attachment reads, and immutable archive storage. Manual capture and exact file
import converge on its private publication path. Archive v2 requires `appId` and
`dataId`; v1 is refused because it lacks identity. The codec still preserves
unknown values, rich content, and referenced attachment bytes. It never rewrites
an imported file. Source generation/head remain provenance, with no fabricated
capture time or assertion that imported contents existed in the destination.

`CurrentAuthority.backups` owns `_backup_library` and `_backups` under the same
SQLite transaction owner as the current generation. Reopening that catalog with
another library or application/data identity refuses. A private publication
request reserves its ID, whole-file digest, length, source metadata, and reason.
It writes immutable bytes, reads them back, compares bytes and MIME type, then
atomically records `addedAt`. Pending rows cannot be listed or downloaded.
Matching concurrent/reopened requests resolve one record; changed requests
conflict. Generation replacement leaves the catalog intact.

Semantic verification runs in the application-side coordinator. The authority
proves stored-object integrity and scope, and imports no Yjs codec. Its private
metadata-bearing request is trusted infrastructure, not a production HTTP API.
The transport checkpoint must preserve this trust boundary. Download checks the
published whole-file digest and the coordinator revalidates archive semantics.

`createS3ArchiveStore` reuses the existing presigned S3 adapter and addresses
`<stable authority name>/backups/<id>`. Generic attachment DELETE targets
`<library prefix>/blobs/<id>`, so it cannot reach these self-contained archives.
The adapter has no deletion method. No bucket scans, expiry, cleanup, or retention
UI were added. Provider retention and account deletion remain separate policies.
`saveArchive` was absorbed into publication; `installArchive` retains destination
attachment write/read-back verification for the next restore checkpoint.

The coordinator holds a failed publication's exact request for retry in its live
lifetime. Portable tests also replay a retained private request after SQLite
reopen. Neither proves public-action retry after page/process restart: the next
journal must durably retain publication intent and exact bytes, including manual
captures before object upload. A reserved ID alone cannot recover those bytes.
The `before-restore` reason uses the same authority publication operation; actual
safety-backup orchestration remains unimplemented.

Focused validation: 64 tests pass across archive, destination installation,
recovery, catalog, current authority/hub, S3 archive adapter, and generic blob
routes. The authority tests first failed with the publication API absent.
Data's root TypeScript program retains the same eight browser-global diagnostics
as the saved task-start run. No production endpoint, deployment, or UI was added.
Server and Honeycrisp's script programs typecheck. Data's DOM leaf passes and its
root program passes with explicit DOM libraries. The three current-generation
Worker suites pass 13 tests. The complete Honeycrisp browser journey passes with
the v2 archive fixture.

Independent design review accepted the ownership split and found no blocker.
Its suggested test repair made the wrong-bytes fixture explicitly match MIME
and length, isolating byte equality; the remaining installation helper's header
now describes its actual responsibility. Bun had normalized the fixture's earlier
MIME shorthand, but the explicit spelling removes that dependency from the proof.
The review kept durable public intent as the next checkpoint and rejected moving
full pending archives into SQL solely for this unmounted lifetime.

An isolated copy of the staged tree also passed all 64 focused tests, the data
root with explicit DOM libraries, the data DOM leaf, and Server typechecks.
Formatting and scoped whitespace checks pass; existing non-null assertion
warnings remain in tests. Documentation hygiene reports 44 findings both before
and after this checkpoint. The changed findings concern concurrent AI/runtime
ADRs; this checkpoint adds no hygiene finding and leaves their work untouched.

## Two-device journey checkpoint, 2026-09-09

The real Honeycrisp browser harness now proves the requested sequence:
edit offline, replace elsewhere, reconnect, reject old edits, invalidate, and
reload the replacement. Two independent Chromium profiles use the actual
self-hosted authentication, App, editor, IndexedDB backing, and Worker socket
handlers. A fixture-only service binding activates through the same authority
instance that owns the live hub. No destructive production endpoint was added.

The offline edit survives an ordinary page reload and stays pending until the
device learns retirement. The connected peer learns retirement immediately.
The stale reconnect sends no frames. During a paused native invalidation,
the old App rejects writes, the editor unmounts, its delayed title callback does
nothing, and the library claim remains held. Successful cleanup reloads once.
An aborted invalidation keeps the claim and permits retry through the existing
button. A failed subsequent download leaves the cache absent and shows normal
bootstrap retry without a reload loop.

Two implementation gaps were repaired:

- `@epicenter/sync/current-download` frames an opaque snapshot and its complete
  accepted tail at one captured head. The browser verifies coverage and Yjs
  dependencies before atomically installing a complete baseline. The native
  journey displays a post-replacement tail edit while all new-generation socket
  frames are withheld, so catch-up cannot hide an incomplete HTTP download.
- `App.signal` exposes the existing document lifetime. Honeycrisp's title
  producer cancels its timer and subscription synchronously on abort; ordinary
  editor close still flushes once. Both new regression cases fail against the
  saved original producer implementation.

Verification commands from the repository root:

```sh
bun apps/honeycrisp/scripts/library.browser.ts
bun run --filter @epicenter/honeycrisp typecheck:scripts
bun test packages/sync/src/current-download.test.ts packages/data/src/store/current-open.test.ts packages/app/src/app.test.ts packages/app/src/recording.test.ts apps/honeycrisp/src/lib/app.test.ts
bun run --filter @epicenter/server test:workers workers/current-retirement.test.ts workers/initial-generation.test.ts workers/e2e.test.ts
bun run --filter @epicenter/sync typecheck
bun run --filter @epicenter/server typecheck
bun run --filter @epicenter/app typecheck
bun run --filter @epicenter/honeycrisp typecheck
bun x tsc --noEmit -p packages/data/tsconfig.dom.json
```

The browser journey passes. The wire, browser-open, App, and App-recording suite
passes 62 tests; the three Honeycrisp editor tests also pass. The three Worker
suites pass 13 tests. Sync, Server, App, both Honeycrisp targets, and the data DOM
leaf typecheck. Data's root program retains eight browser-global diagnostics,
reproduced identically using the saved task-start source. Independent reviews
accepted the production ownership and the browser proof.
The test Worker also typechecks with the self-hosted Worker program. Documentation
hygiene reports 43 proposal/dependency findings both before and after this slice;
ADR-0379 now names ADR-0386 in its existing dependency finding. ADR statuses were
not changed. Formatting checks pass with the existing test non-null-assertion
warning; the task-owned diff has no whitespace errors.

This fixture verifies retirement and adoption. Its first reconstruction uses a
saved/read-back-verified text-note archive, and receipt retry reuses the exact
request in the live test process. It does not establish a production backup
catalog, a fresh safety backup for every activation, attachment retention, or
durable restore-attempt reconciliation after process restart. The real browser
journey covers Chromium; separate existing cache tests cover WebKit storage.

Obsolete responses have a narrower guarantee today. Admission rejects a download
whose generation was replaced while it was in flight. Closing an App during
acquisition retains its claim and refuses subsequent hydration/readiness, but
the late response may still install a cache before cleanup finishes. A stronger
no-install-after-boot-abort guarantee remains separate work.

## Design review and next checkpoint, 2026-09-09

An independent design pass retained the opaque download envelope, browser-owned
Yjs validation, existing App lifetime, and editor-owned title producer. It found
no correctness blocker. The process launcher, retirement scenario, and disposable
Worker remain separate because they run distinct lifetimes and runtime programs.
Both browser scripts are now TypeScript. Honeycrisp's normal typecheck includes
the Bun/DOM runner and a separate fixture program under the self-hosted Worker.
The converted browser journey passes. The launcher probes its disposable service
binding before enrollment because Wrangler can reload during service discovery.

Focused commits record the complete download (`8cea9aa6c6`), producer cancellation
(`10f4c3456d`), and typed browser proof (`d81743d016`). An isolated copy of the
staged source passed 62 wire/open/App/recording tests, the three Honeycrisp editor
tests, 13 Worker tests, Sync/Server/App/Honeycrisp typechecks, both script programs,
and the complete browser journey. The first isolated browser attempt exposed the
service-discovery race; the read-only readiness repair passed the repeat run.
The final full-worktree documentation scan reports 45 findings. Compared with
the earlier 43-finding report, it adds ADR-0365 and ADR-0376, neither edited by
this task. The earlier checkpoint counts remain dated evidence.

The next bounded checkpoint is verified backup publication and the persistent
library catalog. Manual and imported backups must share immutable storage,
read-back verification, and publication. Preserve imported bytes exactly. Prove
interrupted publication leaves no published record, downloads return the exact
saved bytes, another library cannot resolve the ID, and generic deletion cannot
remove retained backups. Keep the structural codec; absorb the storage
checkpoint's caller-managed save identity into the recovery owner.

Do not expose a five-method recovery object with unfinished guarantees. Add the
working publication operations first. Durable restore-attempt reservation,
receipt-first reconciliation, activation transport, and the Backups screen follow
as their own checkpoints. The complete outcome below remains the destination.

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
- Manual backups, uploaded backups, and automatic pre-restore backups enter
  one verified catalog outside the replaceable generation. Download and restore
  accept only published backup IDs. Recovery owns operation identity privately.
- Ordinary folding stays automatic. Archives are immutable recovery artifacts.
  No automatic fresh-document or nested-container replacement for maintenance.

## Evidence and current entrypoints

Read actual signatures before editing; the working tree is active and these
paths can change independently of this spec.

```txt
packages/server/src/store-sync/
  generations.ts       historical ledger retained for migration refusal
  authority.ts         stable current authority and generation-bound sockets
  mount.ts             atomic current startup; scoped generation-bound sockets
packages/data/src/
  store/browser.ts     stable replica IDB, optional header, canonical bootstrap
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
packages/sync/src/current-download.ts complete opaque HTTP capture
apps/honeycrisp/scripts/library-retirement.ts real browser retirement journey
```

At the original task start, the mount and browser still selected independently
writable generations. The current App path now uses a stable authority address
and optional-header cache. Ordinary close drains pending writes; confirmed
retirement has a separate discard path. Historical personal libraries refuse
implicit adoption pending an explicit rollout decision.

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

## Recovery API and execution

The target application surface is:

```ts
const recovery = createLibraryRecovery(resources);

recovery.backup();
recovery.import(file);
recovery.list();
recovery.download(backupId);
recovery.restore(backupId);
```

This is proposed call syntax. Result handling is omitted here. `backup` and
`import` return the published backup record; `list` returns this library's
published records; `download` returns a way to obtain the original immutable
file; `restore` returns its resolved outcome. Bind the application definition,
authenticated library authority, attachment storage, archive storage, and private
request persistence when constructing recovery. Do not add empty methods to the
public barrel before their guarantees exist. Concrete factory resource types and
transport return types follow the first working integration.

### Owners and durable records

```txt
Backups screen
  -> library-bound recovery coordinator (application-side codec)
     -> stable library authority: catalog, restore records, generation activation
     -> object storage: archive files, retained prepared requests, attachments
     -> local pending reference: recover the same intent after page restart

Current authority activation
  -> old generation retirement -> App departure -> normal startup on new page
```

The catalog and restore records survive generation replacement. Place their
metadata under the stable library authority's serialization boundary. R2 is the
hosted object provider through the existing S3 adapter; it does not define public
IDs or application semantics. Existing principal-scoped blob routes are not a
library-scoped backup catalog.

A published backup record needs an opaque backup ID, its library scope, immutable
object reference and digest, byte length, authority-recorded addition time, and
reason (`manual`, `imported`, or `before-restore`). Source application/data
identity, format version, and available capture provenance must accompany it.
Use the addition time for imported entries; do not infer capture time from a
filename. A capture position describes the source, not permission to overwrite
the destination. Keep these records outside the Yjs document and replaceable log.

A restore attempt needs an internal operation ID, selected backup ID and digest,
its exact destination condition, one safety backup ID, exact prepared request
object and digest, and its outcome/receipt. Reserve one unresolved attempt per
library atomically. Concurrent attempts cannot each claim the same slot. The
application retains a small durable pending reference before its first mutating
request, scoped to the full library identity and outside the retired replica's
invalidation path. The authority stores the attempt and its progress; immutable
object storage holds large prepared bytes. Neither a closure nor a recomputed
archive is durable request storage.

On reopening, reconcile the pending attempt before enabling a new restore or
fetching its source archive again. A committed receipt must remain readable from
the journal/authority even when archive object storage is unavailable. The current
raw authority resolves receipts through `prepareActivation` with replacement
bytes; add a private authenticated receipt query rather than requiring the
original source or large prepared object merely to observe a committed outcome.
Calling `restore` with its pending backup resumes that attempt; another backup
reports that a restore is already pending. Once an outcome has been reconciled,
a later deliberate call can allocate a new attempt even for the same backup.
The UI's retry action continues the pending request. No caller supplies an ID
and no public prepare/commit API is needed. Prove completion-observation and
pending-reference cleanup across restart before declaring this contract done.

Define a durable failed-without-activation outcome for definitive preparation
failures, including conflicting immutable destination attachment bytes. The
authority must atomically confirm no committed activation, fence that attempt
against delayed activation, and release the active slot. Activation checks this
attempt state in the same transaction as its generation/head comparison and
receipt write; a route-level check followed by another transaction is insufficient.
Retain all completed backup records. Unknown outcomes remain pending until the
authority resolves them; never interpret a network failure as proof of no commit.
This failure finalization belongs to the private coordinator, not a sixth public
method. Prove another backup can restore after a definitive failure.

The authority remains opaque to Yjs. The recovery coordinator performs semantic
archive validation and reconstruction. Authority publication binds the authorized
library and exact stored object identity; restore revalidates the selected bytes
rather than treating a catalog row as a substitute for validation. Admission,
accepted log writes, and final activation still share one transaction owner.

### One backup publication path

```txt
backup(): capture authoritative snapshot + tail + referenced attachments
import(file): retain the selected file's exact bytes
pre-restore backup: capture the destination position that activation will compare
                       |
                       v
          validate -> immutable write -> read-back verification
                       |
                       v
          publish library catalog record -> return backup ID
```

Preserve imported bytes; do not reconstruct and recapture the file.
The coordinator's private publication path converges on authority-owned immutable
verification. `captureArchive` and `prepareArchive` remain codec operations.

Object storage and authority SQL do not share a transaction. First verify the
immutable object, then publish its record. Interrupted or rejected publication
must expose no usable backup. A retry reconciles its reserved identity rather
than duplicating rows. Unreferenced uploads can remain pending cleanup; cleanup
must not race publication or delete an object referenced by a catalog row or
restore attempt. The existing generic blob DELETE route must not bypass this
protection; choose recovery-owned object addressing or enforce references at that
route. Do not implement bucket scanning as the catalog.

`download(id)` and `restore(id)` resolve only a published record authorized for
this library. The exact verified digest connects import, download, and restore.
An expired download URL is retriable; it does not remove the backup. If storage
is unavailable or corrupted, refuse the action rather than silently substitute
another object. Publication alone does not establish indefinite storage retention.

### Complete restore sequence

1. Look up the private pending reference and reconcile any existing attempt
   first. Return its committed receipt without downloading or reconstructing its
   source again. If it is still preparing, continue that attempt; a different
   selected backup cannot start while its outcome is unresolved.
2. For a new attempt, resolve the selected published backup, confirm application
   compatibility, and validate its bytes. The UI has already named the destination
   and obtained deliberate restore confirmation. Start the durable attempt, pin
   its selected source, and reserve its safety backup identity. Capture the destination's generation and
   exact head, including its tail, and preserve that capture for interrupted
   preparation before publishing the safety backup.
3. Save and verify the destination backup through the common publication path.
   Associate the resulting record with this attempt. Its label is Before restore
   attempt, since capture does not prove activation succeeded.
4. Reconstruct the selected archive into a fresh lineage. Install and verify its
   attachments in the destination storage needed by synchronized devices, not
   only a transient device cache. Persist the exact activation bytes and
   destination condition under the attempt before dispatching activation.
5. Activate conditionally through the stable authority. Retries reuse the same
   request and receipt. A destination conflict is terminal for this attempt;
   never silently recapture newer work under the same intent.
6. Resolve the attempt's outcome and retain its backup records. Retirement closes
   old App producers and invalidates its cache before full document reload.
   Pending operation reconciliation must survive that very reload.

Definitive preparation failure finalizes the failed attempt through the authority
and fences late activation before releasing the slot. An unresolved activation
response retains the pending attempt until receipt reconciliation succeeds.

If import succeeds but the person cancels restoration, its backup remains in the
catalog. Failed activation also retains the completed safety backup. Keep one
safety backup per attempt across response loss and restarts. A different attempt
is allowed to create another backup even when restoring the same source.

### Implementation waves

1. **Catalog and file contract, independent of deployed server replacement.**
   - [x] Add failing portable tests for publication, interruption, library scope,
     and history surviving generation changes before defining catalog mutations.
   - [x] Extend the unshipped archive format with application/data identity and
     explicit provenance. Decide version refusal from actual fixtures; do not
     guess missing identity or silently add a compatibility reader.
   - [x] Implement private catalog/publication over portable authority SQL and
     immutable object storage. Reuse exact byte/MIME checks from
     `archive-storage.ts`; preserve uploaded files unchanged.
   - [x] Exercise manual capture and imported files through the same publication
     owner. Verify invalid files, missing objects, and interrupted finalization
     never become usable records; retries publish one record.
   - [x] Review the resulting owner before starting dependent orchestration.
2. **Durable restore owner behind the five methods.**
   - [ ] Persist pending publication intent and exact capture/file bytes outside
     retired replica storage. Reconcile before creating another backup/import
     after restart. Preserve the current live-lifetime retry behavior.
   - [ ] Build the private attempt journal and active-attempt reservation. Test
     restart before first response, before/after request persistence, before/after
     activation, and before/after local pending-reference reconciliation.
     Prove receipt recovery without archive storage, terminal preparation failure
     with slot release, and rejection of the failed attempt's late activation.
   - [ ] Compose destination capture, one safety backup, installed attachments,
     retained activation request, and receipt recovery. No live activation from
     unverified preparation and no fresh reconstruction on retry.
   - [ ] Extend recovery tests to reopen the public owner and resume using only
     the backup ID. Publication tests already use backup/import/download and
     preserve exact bytes. Private catalog replay still supplies a retained
     request; replace that evidence gap with durable public reconciliation.
   - [ ] Compose the remaining `installArchive` operation into restore. Retain
     attachment conflict/read-back proof and the codec/opaque-authority boundary.
3. **Production authority and browser integration.**
   - [x] Integrate one current authority with the shared browser bootstrap path.
   - [ ] Mount catalog and private restore transport against one stable library
     authority, with account/library authorization on every operation. Use
     configured object storage and prove retention across generation cleanup.
   - [x] Replace list/max discovery with atomic current download and stable
     optional-header cache; preserve offline opening and local-only startup.
   - [x] Prove Durable Object eviction/hibernation and old-socket rejection.
   - [ ] Exercise hosted R2 adapter behavior and the self-hosted S3 boundary without
     deploying to production or deleting existing libraries.
4. **Backups screen and complete native-browser proof.**
   - [ ] Add Create backup and Upload backup to the Backups screen. Upload selects
     its published row and offers Restore this backup without a list detour.
   - [ ] Restore confirmation names the destination and unsynchronized-work loss.
     Import cancellation, preparation errors, conflicts, and unknown outcomes
     retain the appropriate backups and pending attempt for recovery.
   - [ ] Bind the recovery owner to the page's fixed App/account lifetime. Fence
     late callbacks after departure; never publish into another account's library.
   - [x] Prove Honeycrisp editor cleanup, full reload, offline cached startup,
     failed invalidation, failed download, and complete replacement readiness
     in a native browser through test-only activation.
   - [ ] Extend the native proof to production recovery, recorder cleanup,
     restart reconciliation, and obsolete boot response interruption. Preserve
     different-generation working-copy refusal.
5. **Prove and retire replaced paths.**
   - [ ] Run affected suites and typechecks, attributing unrelated failures to a
     recorded baseline. Review cumulative implementation and remaining risks.
   - [ ] Stop importing old generation discovery and public history-selection
     paths, verify, then delete them under the grounded existing-history rollout
     decision. No automatic choice of a maximum historical library for deletion.
   - [ ] Update durable records under ADR conventions and delete this spec and its
     handoff only when the full accepted outcome is implemented and verified.

### Execution decisions still requiring evidence

- Application compatibility and archive provenance: v2 requires application/data
  identity and preserves source generation/head. It supplies no capture date.
  The codec's conservative recognition of BlobIds in
  ordinary text can refuse capture; product acceptance of that limitation is
  still outstanding.
- Durability and size: filesystem reopen tests do not prove crash/power-loss
  durability, and full JSON archives containing numeric byte arrays have not
  been sized for Worker execution. Measure limits at the application and
  transport boundaries; keep reconstruction application-side. Prove the selected
  storage provider's write and retention guarantees before enabling activation.
- Lifetime and authorization: resolve full shared/personal library identity from
  current code, not stale principal assumptions. Define pending-reference storage
  that remains available after App retirement without preserving retired edits.
- Retention: protect published backups and active attempts first. Scheduling,
  previews, automatic expiry, and user-driven deletion are separate features.
  Do not silently delete user backups to satisfy a storage budget.
- Production replacement still requires the recovery owner and verified catalog.
  Existing-history rollout remains a separate decision before deployment.

## Recovery planning review, 2026-09-09

The independent design review kept the five-method API and the split between
application-side codec, durable recovery coordinator, and opaque authority.
It accepted the publication-first wave ordering. Two findings were incorporated:
definitive preparation failure now fences late activation and releases the active
slot; interrupted attempts resolve receipts before source-file reads. The plan
also scopes this path to synchronized libraries and includes generic blob deletion
in retention proof. These are planning repairs, not newly passing runtime tests.

Documentation validation checks local links, code fences, whitespace, and ADR
index registration. The task-start hygiene baseline contains 40 unrelated ADR
dependency/status findings. This documentation pass changes no runtime code or
ADR status.

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
| Manual backup, uploaded file, and pre-restore backup | Same verified publication path and persistent catalog |
| Interrupted upload or publication | No usable catalog record; retry publishes once |
| Download then import | Exact original bytes retained and served by the new backup ID |
| Invalid application/format or unauthorized backup ID | Refused before library replacement |
| Restore canceled after import or activation conflicts | Imported and completed safety backups remain downloadable |
| Restore completes and generation changes | Backup history survives outside the replaced document |
| Restore response lost, then page/owner restarts | Public backup-ID call resumes the retained request and original receipt |
| Concurrent or repeated restore while outcome unknown | One pending attempt; no duplicate safety backup or activation |
| Same backup deliberately restored after resolved completion | New internal attempt and fresh lineage |
| Cleanup overlaps upload, publication, or active restore | No required archive, capture, attachment, or request object is removed |
| Committed restore loses its response, then archive storage fails | Journal/authority receipt resolves without source download or reconstruction |
| Permanent preparation failure, restart, then another backup chosen | Failed attempt releases its slot and another restore can proceed |
| Delayed activation arrives after failure finalization | Authority rejects it in the same serialization boundary |
| Generic blob deletion targets a retained recovery object | Retention cannot be bypassed through the existing DELETE route |

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

## Archive storage continuation, 2026-09-09

`packages/data/src/artifact/archive-storage.ts` now composes the structural
archive with the existing immutable `BlobStore` contract. It remains unmounted.
`saveArchive` captures the supplied destination state, writes it under a
caller-retained archive id, reads it back, compares every byte and its MIME type,
and verifies reconstruction. A retry accepts an existing object only when it
matches exactly. A different capture cannot overwrite that archive id.

`installArchive` validates the source archive before writing any destination
blob. It installs each referenced id and verifies bytes and MIME type on
read-back before returning fresh-lineage activation material. An interrupted
installation can retry already written objects. A conflicting existing blob
refuses installation without overwrite. Neither operation activates, deletes,
or changes the authority.

The storage owner supplies durability and retention. Tests use actual temporary
Bun filesystem stores and reopen their handles. They prove persisted read-back,
not process interruption or power-loss durability. The Bun adapter publishes by
rename without an explicit fsync barrier. This slice does not establish the
complete pre-activation durability gate. Production composition must retain both
the backup and installed blobs through activation and cleanup; the address-only
blob capability itself has no retention pin.

Validation:

- Eight new archive-storage tests pass, with 27 assertions. They cover reopened
  storage, unchanged backup retry, conflicting capture, failed write/read-back,
  a different valid archive returned by storage, interrupted blob installation,
  conflicting bytes/MIME types, and invalid archive refusal before any write.
- The combined sync, authority, archive, persistence, store retirement, and
  departure suite passes 216 tests with 1,271 assertions.
- Focused strict TypeScript validation of the new module and tests passes.
  The data package still reports eight browser-global diagnostics. A temporary
  equivalent config excluding both new files reproduces those same diagnostics.
- Before these documentation updates, doc hygiene reports 40 existing ADR
  dependency/status issues. This continuation changes no ADR status.

Independent design review accepted the shared read-back invariant and found no
correctness blocker in this slice. It independently ran 49 archive/storage and
current-authority/hub tests with 316 assertions. Its remaining findings match
the durability, retention, and request-identity obligations below. The retry
warning is now also on `installArchive` itself.

Reproduce the focused continuation checks from the repository root:

```sh
bun test packages/data/src/artifact/archive-storage.test.ts packages/data/src/artifact/archive.test.ts packages/data/evidence/current-generation
bun x tsc --noEmit --strict --skipLibCheck --module preserve --moduleResolution bundler --target esnext --lib esnext --types bun --noUncheckedIndexedAccess packages/data/src/artifact/archive-storage.ts packages/data/src/artifact/archive-storage.test.ts
```

Next work must preserve the distinction between source provenance and destination
coverage. An old archive's generation/head cannot authorize replacing today's
library. Capture and save today's destination first, then condition activation
on that captured destination position. Each `installArchive` call reconstructs
new Yjs operation identities. Re-running it after a lost activation response
would produce a different byte digest and fail the authority's request-bound
receipt check. The recovery owner must persist the operation, exact replacement bytes, and
destination condition before sending activation. Public callers supply only a
backup ID. The orchestration and its interruption proof remain unimplemented.

## Shared startup integration and remaining proof

The user assigned the overlapping startup boundary to the Honeycrisp
library-ownership continuation and selected one current authority with full
page reopening. Follow `20260909T004225-library-ownership-execution.md` for its
active implementation and exact evidence. The paused initializer proposal in
ADR-0385 has been reconciled with this contract: no list/max adoption or separate
initial-generation owner participates in startup.

That continuation integrated `packages/server/src/store-sync/`, the shared route
constants, and browser acquisition. It mounted the existing current-authority
transaction, binds hibernated sockets to their admitted generation, and uses the
optional-header cache for App startup. Historical numbered libraries remain
untouched and their rollout remains a separate decision. Its earlier browser and
Worker results are recorded in the ownership execution spec. The Two-device
journey checkpoint above adds complete current downloads and real editor
retirement/reload proof. Production restore remains unmounted.

Remaining restore work:

1. Compose verified archive storage and blob installation with a retained backup
   and durable activation request. Prove durability, retention, request-bound
   receipt recovery, and the deliberate restore operation.
2. Extend browser and Worker proof to production recovery, restart reconciliation,
   attachment retention, recorder cleanup, and obsolete/interrupted downloads.
   Preserve the existing failed-invalidation and hibernation evidence and
   working-copy mismatch refusal.
3. Keep restore generation retirement distinct from Account retirement and
   ordinary library switching. Only confirmed generation retirement authorizes
   discarding a replica's pending edits.

No restore endpoint, deployment, destructive migration, or real-library deletion
is authorized by the Honeycrisp slice. This spec remains In Progress.

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

The lifetime design is settled. The recovery API and catalog rule are settled in ADR-0386. Archive metadata
and versioning, private endpoint names, receipt retention, temporary replacement
storage limits, and rollout of existing independently writable generations still
need implementation evidence.
Do not silently select a maximum and destroy other existing histories during a
migration. Determine the deployed data situation and record the rollout decision
before activating it on real libraries; no production action is authorized here.

Byte-aware acknowledged-log folding and smaller plain-text updates are worthwhile
maintenance investigations, but are separate from this restore implementation.
Do not add them to the critical path or introduce automatic resets to compensate.

When completed, update durable ADRs without changing accepted records' decisions
in place, retire the now-spent spec, and record any required history entry under
repository conventions. ADR status changes still require explicit authorization.
