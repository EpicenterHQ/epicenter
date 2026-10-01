# Implement one live app handle for local and account data

**Date:** 2026-09-07
**Status:** In Progress
**Owner:** The implementing Codex agent owns execution, verification, and integration.

## Current opening boundary: 2026-09-18

[ADR-0407](../docs/adr/0407-app-owns-the-declaration-and-data-engine.md) completes
the declaration/opening split: `defineApp` is platform-free, `openApp` owns the
App lifetime, and `openData` borrows caller-owned SQLite. Public runtime/AI
overrides and historical generation helpers are removed; old bytes and server
HTTP 409 protection remain. Earlier opening examples and generation-helper
checkpoints below are historical evidence, not remaining API work. Broader
acceptance and product outcomes in this plan remain separate.

## Next application checkpoint: fixed page ownership

The user accepted one primary library per application page. Changing libraries
closes that page and starts a fresh document; transient UI need not survive.
Execute [the focused page-lifetime plan](20260908T194801-fixed-library-page-lifetime.md)
next. Its decision is recorded in
[ADR-0369](../docs/adr/0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md).
Earlier instructions to replace an application session inside a surviving page
are withdrawn. Storage-level distinct-library coexistence and explicitly owned
imports/transfers remain; they do not retarget the primary UI handle.

The checkpoints below record completed storage work and remaining broader
obligations. Whole-library erasure remains unavailable until all producers and
durable resources participate in its close/erase contract.

## Active execution: one library owner, 2026-09-08

This section replaces earlier planned shared-reader claims and per-document SQL
reference counting. The user accepted one active owner per application and
captured AccountIdentity or null. A library is that ownership key and all its
data generations, blobs, and named SQL files; it adds no public wrapper.

Baseline: cdf3383ca1 includes portable recording bound to the opened document.
Earlier checkpoints 0d034d48a4 and c4fca89d42 recorded erasure requirements and
fixed shared browser worker ownership. Unrelated dirty auth, inference, Local
Mail, native shutdown, and documentation work is preserved. These earlier
untracked planning documents remain preserved throughout execution.

Preserve synchronous construction, one ready Result, document-owned admission
and drain, captured account identity, local/account coexistence, named SQL-only
use, secrets, and sequential historical generations. Refuse a second independent
owner of the same library, including sibling definitions. Components borrow the
same owner. Do not implement shared-library reference counts or lifetime IDs in
media URLs merely to make copied URLs permanently unusable after reopen.

Working checkpoints:

1. Explicit SQL lifetime: acquire once, open named connections, invalidate old
   connection IDs on delete/close, serialize deletion, acknowledge physical
   release. Browser and native owners share invariant implementation. Standalone
   Device closes its SQL lifetime without deleting secrets. Verify real browser
   and native persistence, retained handles, delayed work, and account isolation.
2. Library exclusion: acquire before generation discovery; document close holds
   ownership through capture, transfers, SQL, and durable backing release. Route
   lower-level generation and standalone storage entrypoints through the same
   exclusion before deleting displaced per-generation/allocation coordination.
   Verify sibling-definition refusal and preserved local/account coexistence.
3. Whole-library removal: under exclusive ownership, enumerate durable data,
   blobs, and unopened SQL names/sidecars across definitions. Host gates new blob
   requests and tracks actual file-response completion. Keep exclusion through
   uncancellable IndexedDB deletion and report partial failure. Verify native
   recorder reload/recovery before claiming it safe. UI removal stays disabled
   until the complete backend contract passes integration checks.
4. Review and documentation: independently review each substantive checkpoint,
   reshape remaining work, record the accepted single-owner mechanism in ADR-0367,
   run affected tests and full-workspace typechecking, and commit only task-owned
   changes. The broader local/account spec is not spent until its separate
   import/transfer and application acceptance obligations are complete.

The next checkpoint is implementation and verification, not another general
architecture discussion. External process exclusion and crash recovery must be
proven at the actual owner; a page-only flag is insufficient.

### SQL lifetime checkpoint

Implemented explicit SQL acquisition and physical release across browser and
native owners. SQL-only Device has close; Local Mail calls it after draining its
page operations, including a failed schema open. Native SQL moved from HTTP to
one authenticated WebSocket per lifetime so reload disconnect drains and releases
the old host reservation. Secrets remain independent HTTP operations.

Application acquisition claims its library before generation discovery and SQL
acquisition. Duplicate sibling definitions are refused until physical release.
This is not yet common exclusion for all storage entrypoints: direct generation
APIs and standalone browser SQL acquisition still need the same origin-wide
claim. Keep their existing guards until that integration is complete. The following common-exclusion checkpoint includes SQL-only consumers and
direct data openers together.

Independent cumulative review accepted SQL lifetime/connection IDs and native
socket cleanup, and rejected adding reference counts or another public owner.
It found that failed capture cleanup released the library claim. The repair keeps
backing and exclusion after failed recovery, cancellation, or playback cleanup;
close rejects and other libraries remain usable. Retaining resources until context
shutdown on that exceptional path avoids a second release protocol. Native host
construction already has a single-instance plugin and one Bun SQL owner; no new
filesystem lock was added without a demonstrated second process owner.

Honeycrisp and Vocab had always-present wrappers around an undefined removal
callback. Direct callback forwarding now keeps the removal action absent instead
of allowing a no-op success. Whole-library erasure remains unimplemented.

Committed as 8223c96542. Isolated commit verification: 344 affected tests, full-workspace
TypeScript checks, real Chromium and WebKit OPFS probes, and a native Bun socket
reload/persistence test passed. This includes failed recovery/cancellation coverage. The separate recorder
work is committed in cdf3383ca1 and 36eb41657a and remains preserved. Unrelated
Local Mail token work landed as 3c551b59fd during execution.

### Common library exclusion checkpoint

Committed as febfefb267. Final isolated commit verification: 359 tests, 1,415
assertions, and full-workspace typechecking passed. Independent review verified
all four cleanup failure cases after repair. Chromium and WebKit passed SQL
exclusion/persistence and direct-data persistence probes; the preceding native
WebSocket reload probe passed. Doc hygiene reports 33 unrelated findings: 31
reproduce at cdf3383ca1, and two concern preserved untracked ADRs 0359/0363.

The existing createAppSqlite now acquires the origin-wide library claim before
backend acquisition, so app documents and standalone Device share one gate.
Direct openDatabase, resolveGeneration, createGeneration, and eraseGenerations
use the same claim. Private generation helpers run under the caller's ownership.
The previous per-generation and allocation claim module is removed. Error
factories remain shared so AlreadyOpen, LocksUnsupported, and ClaimFailed keep
their existing boot meaning. The test-only Web Locks shim moved with the primitive.

Durable disposal now precedes SQL close; a failed durable release retains SQL
and the common claim. IndexedDB deletion waits for actual settlement even when
blocked, retaining exclusion through an uncancellable request. Tests cover SQL-only
versus every direct generation API, refusal before network/enumeration, reverse
exclusion, local/account coexistence, blocked deletion, and failed durable release.
Browser probes prove a competing tab is refused before starting a worker.

The second independent review reproduced acquisition cleanup release faults in
all four app/direct-open/create/resolve paths. Repairs now release only after a
settled Result, retain ownership after unexpected cleanup throws, and close an
IndexedDB connection before returning a typed load failure. Five fault regressions
cover that distinction; ordinary network failure recovery remains covered.

Remaining erasure work stays substantive: independently constructed blob producers,
complete durable inventory across definitions and unopened SQL files, host media
response drain, and native recorder admission/recovery. These are needed before
whole-library removal or its UI callback can be implemented. Common document/SQL
exclusion alone does not establish that all native producers have stopped.

## One sentence

One live app handle opens, operates on, and closes one local or account dataset.

## Outcome and authority

Implement [ADR-0355](../docs/adr/0355-local-and-account-sessions-share-the-application-data-api.md)
from its final call sites backward. The user explicitly chose a clean break:
no legacy data migrations, fallback readers, compatibility aliases, or old APIs
kept to make intermediate builds pass. Temporary repository breakage is allowed.
The finished implementation must pass applicable tests, typechecks, and browser
smokes. Removing compatibility does not authorize deleting unrelated work or
wiping existing on-disk user stores. Use disposable storage for verification.

First milestone: open a local declared-table database without credentials,
write data, close, restart, and read it through the final app handle. Local and
account handles coexist. Final product proof: a fresh Whispering installation
records, restarts, and plays without sign-in; its account library uses the same
API and supports explicit import and remote audio transfer.

This spec is an execution guide, not an assertion that the proposed APIs exist.
The ADR owns durable decisions. Code and package READMEs own current signatures.
A fresh-chat prompt lives beside this file with the `.handoff.md` suffix.

## Execution baseline, 2026-09-08

The direct-session auth rewrite landed in `0c329cbb54` (server foundation),
`23bade0df4` (client integration), and `b589fddf75` (evidence and closeout).
Read `packages/auth/README.md` and
[ADR-0354](../docs/adr/0354-hosted-applications-authenticate-with-better-auth-session-bearers.md)
for current authentication. Its execution spec was retired.

`createSessionAuth` persists `{ token, principalId }`. Account exposes
`principalId`, `baseURL`, `fetch`, `openWebSocket`, and `getProfile`.
`DesktopAuthBootSnapshot` exposes `{ state, connection }`, without credentials.
Authenticated `authorityId` remains checkpoint 1 of this spec. Extend the
direct-session contracts and self-hosted identity path together; preserve
captured transport retirement, same-person reauthentication, and offline boot.
The earlier suggestion to delegate this addition to the auth task was withdrawn.

No local/account implementation landed during the coordination pause. All six
checkpoints remain open. Recheck active task ownership before editing shared
files, and sequence overlapping work. Auth smoke evidence does not prove local
restart durability, scoped OPFS ownership, or native recording paths. Real
provider and packaged Tauri login were unverified at the auth handoff; consult
its durable evidence for updates and report any remaining external limits.

## Final call sites

### Captured identity transport checkpoint, 2026-09-08

Committed as `f40b9091c6`, following test-fixture prerequisite `f14c8112e0`.
The isolated final staged tree passes the full-workspace typecheck and 422 tests
with 2,800 assertions; three existing Skills tests remain skipped. The live
workspace typecheck also passes. Documentation hygiene reports 33 issues and
remains separate from this passing implementation checkpoint.

After foundation `f09dc34d4b`, the identity lane removes `StorageScope`,
`WebviewBlobScope`, and the three separately bound WebView blob adapters.
`AccountIdentity` in `@epicenter/principal` names authority and principal;
explicit `null` names the local library. Account and DatabaseAccount reuse that
identity without moving credentials into the shared leaf. SQL requests require
the account field and reject the former tagged shape.

`createWebviewBlobs` captures one validated address for local storage, playback,
and remote operations. Local routes use
`/api/apps/:appId/local/blobs/:blobId`; account routes use
`/api/apps/:appId/accounts/:authorityId/:principalId/blobs/:blobId`.
COPY appends `/copy` to the destination and accepts `{ sourceId }`. Old routes
and query selectors have no compatibility branch. The document still owns
admission, operation drain, and close; runtime owners retain physical files.

Verification: 127 integrated tests pass with 780 assertions, including actual
host routes and sidecar startup. The broader app/data-store/device/blob suite
passes 343 tests with 2,256 assertions. App, data, device, blobs, principal, auth,
host, and both Whispering and Honeycrisp typecheck targets pass. Two stale
account fixtures in dashboard and Skills now carry authority identity;
dashboard tests pass, while Skills' three existing skipped tests remain skipped.

Runtime evidence: the disposable-profile ownership probe passed again in WebKit
and Chromium, including SQL and owning-attachment persistence across browser
process restart, independent copying, playback, retained-method refusal, shared
close completion, and URL revocation. This does not prove packaged native capture
or cross-device transfer. No external blocker was established for those smokes.

Independent final GPT-6 review found mutable-input retargeting before readiness
and through standalone SQL. App and direct data constructors now capture explicit
identity and transport fields synchronously; standalone SQL constructors capture
authority and principal. Regressions cover mutation before and during deferred
acquisition and after obtaining a SQL handle. The reviewer reproduced the repairs
and closed the checkpoint with 35 focused tests and 149 assertions passing.
Whole-library removal remains a separate acceptance gap; this checkpoint does
not complete ADR-0355. Earlier untracked planning documents are not included in
the selective identity commit while their broader authorship remains unclaimed.

### Active ownership collapse, 2026-09-08

The user accepted two further changes after independent GPT-6 consultations:
one document-owned operation guard/drain for SQL and blobs, and fresh-ID copies
for every owning attachment. Existing blob IDs become local copy inputs, never
adoption or ownership-transfer receipts. Duplicate imports may create independent
copies; no persistent single-use registry or legacy migration is required.

Execution is split into non-overlapping lanes:

- [x] Data/device lifecycle: construct app SQL methods in the document factory;
  remove app readiness mirrors and close callbacks. Preserve standalone SQL.
- [x] Blob storage, in parallel: add same-store immutable copy on browser, Bun,
  and WebView. Host requests carry IDs, not recording bytes.
- [x] After independent lifecycle review, owning creation mints each destination
  and drains copy plus compensation. Remove adoption receipts and the used-ID
  registry after verifying the replacement path.
- [ ] Complete native/Whispering integration review and its route tests. The
  recording operation owns temporary capture cleanup; generic creation never
  removes a source. Cleanup after document closure is currently best-effort and
  can leave an unreferenced capture; it cannot replace the pipeline failure.
- [x] Close the cumulative independent core review. The reviewer independently
  passed 109 tests and cleared the document-owned guard, drain, and attachment
  compensation. Keep standalone SQL validation separate from document lifetime.
- [ ] Complete remaining integration checks in the native/Whispering lane.

Final data-lane handoff: 416 tests pass with 2,302 assertions and no failures.
Core production edits are stable. The final reviewer reproduced unauthenticated
access to the native COPY endpoint; the native owner must add the session gate
and route tests proving unauthorized requests never reach storage, authenticated
copying, source preservation, scope isolation, and 404/409 mapping. The data lane
explicitly releases `apps/epicenter/src/server.test.ts` to that integration lane.
The Whispering owner must remove the recording error's unsupported claim that
audio remains available and obtain passing integration reruns.

Whole-library removal remains an ADR-0355 implementation gap. No factory erase
operation landed here; `eraseGenerations` only removes one account definition's
data generations, not its blobs and named SQL files. Leave the unavailable UI
action disabled rather than present partial erasure as whole-library removal.
The user owns Whispering/UI erasure and integration checks. This core checkpoint
does not establish complete implementation of ADR-0355.

Each substantive lane receives an independent GPT-6 checkpoint before dependent
work. Verification must cover retained SQL methods, late open, mixed SQL/blob
drains, copying across reopen, independent deletion, and failure compensation.
Runtime evidence remains separate from unit tests and any unrun native smokes.
The original six-checkpoint spec remains active beyond these two improvements.

Checkpoint evidence: the independent lifecycle reviewer passed 43 tests and
cleared the ownership boundary. Main passed 58 focused lifecycle tests, then
331 broader data/app/device tests. The attachment suite now has 14 passing tests,
including concurrent copies, reopening, independent deletion, and close during
copy compensation. Five package typechecks (app, data, device, blobs, client)
pass. Whispering browser and epicenter-host typechecks both pass.

The copy reviewer found MIME normalization in Bun's lazy file wrapper. Copy now
passes the recorded metadata directly to staged publication; 23 Bun tests and
typecheck pass independently after repair. No extra JavaScript byte buffer or
new power-loss guarantee was introduced.

Runtime evidence: `/tmp/epicenter-ownership-proof.cGgGEx/run.ts` passed in WebKit
and Chromium after receipt deletion. Each engine used a disposable persistent
profile, wrote an owning attachment and named SQL row, restarted its browser
process, read both, copied the attachment to a new ID, deleted the original, and
played the surviving copy. It also proved shared close completion, refusal of
five retained SQL operations, and playback URL revocation. Profiles were removed;
the probe source remains. Native capture and account-transfer smokes are not
established by this evidence, and no external blocker was established for them.

Adjacent review finding routed to acquisition ownership: failed initial reading
in `openIdbBacking` can leak its opened connection. The reviewer reproduced it
at the pre-wave baseline too. Do not claim this wave fixes all acquisition paths.
The repository documentation hygiene check reports 32 issues, including the
existing Proposed ADR-0359 dependency; this is not a passing final hygiene check.

### Active construction wave

The destination is settled; implementation follows the document-owned readiness
and closure mechanism recorded in
[ADR-0359](../docs/adr/0359-the-document-factory-owns-readiness-and-closure.md).
Construct the actual document/table/KV capabilities before acquisition, hydrate
that same document, then construct the persistence controller from real loaded
storage. Do not introduce a forwarding facade, Proxy, generic lifetime manager,
or two-phase persistence controller.

- [x] Move operation guards and one close completion into the document factory.
- [x] Move asynchronous hydration there and make browser acquisition return storage
   resources rather than another store.
- [x] Compose the app from actual capabilities, delete the forwarding path, migrate
   callers, and verify retained-handle behavior with an independent GPT-6 review.
- [x] Construct blob operations under the document's guard and close completion;
   remove the prototype composition and duplicate closure state. Drain admitted
   operations and release playback sources, including late acquisitions.

These steps do not complete authenticated identity, the final blob transfer API,
SQL composition, owning fields, or the app consumer checkpoints below.

Blob lifecycle verification: 310 tests passed across app, data store/sync, server
browser dial, and Whispering app tests. Seven focused blob tests cover retained
verbs, deferred and rejected operations, reentrant close, and source disposal.
App/data typechecks pass. Independent GPT-6 review identified uncancellable
transfers and consumer compensation across close as limits requiring explicit
handling; close drains admitted transfers and does not promise a timeout.

Runtime evidence: a disposable-profile probe passed in WebKit and Chromium. It
opened locally without credentials, persisted one row and blob, closed the app,
restarted the browser process, read both back, checked playback bytes, and
verified source-URL revocation and retained-method refusal on close. The probe
sources are at `/tmp/epicenter-app-lifecycle.tyxrTR/`; run with
`bun /tmp/epicenter-app-lifecycle.tyxrTR/run.ts` on this checkout. This is not native
capture, cross-device transfer, or account-scoped SQL evidence. No external
blocker was established for those unverified smokes.

A provisional owning-field table prototype wrapper was withdrawn after an
overlapping edit was detected. The engine-native creation wave now supplies local
bytes at document construction and implements attachment creation in the actual
table method. `CreateRowOf` is the only input lens; owning fields take `Blob` or
nullable bytes and read as `BlobId`. Schema markers distinguish ownership from an
ordinary branded string. Plain-table creation stays synchronous. Raw-ID owning
patches, blob declarations in KV, and attachment creation inside synchronous
transactions are refused.

Creation and its in-process compensation share the document's operation drain.
Cleanup reads accepted references from the document rather than maintaining a
publication flag. It preserves the original failure and logs cleanup failures
with blob IDs. It does not promise crash-orphan recovery, attachment replacement,
deletion cleanup, or atomicity across row and byte stores. Those obligations remain
open; native recorder integration follows the accepted table contract.

Owning-create checkpoint: 410 tests and 1,642 assertions pass across the targeted
suite, now including definition/field tests and ten attachment tests. A concurrent
SQLite app test is deliberately excluded from that count. App/data typechecks
pass. The disposable WebKit and Chromium probe now creates through an actual
`field.blob()` table and passes browser-process restart and playback checks.

Independent GPT-6 review cleared the attachment checkpoint after finding and
verifying a reversed-nullable-union type mismatch. The transport tests now use
strict Result assertions; their permissive wrapper and 58 raw-create wrappers
were removed. Internal `createBlobs` remains a constructor over separately supplied
source and remote capabilities; table creation needs only the captured local byte store,
including through the direct SQLite constructor used by domain tests.

An overlapping SQLite edit changed app/index, app tests, and browser composition
during review. It is preserved but excluded from the attachment review verdict;
the coordinating task did not claim its authorship. Shared-file continuation must
sequence that writer and review its readiness/close behavior. No native, SQL, or
account-transfer smoke is claimed by attachment evidence. The repository-wide
documentation hygiene check reports 29 issues, including Proposed ADR-0359;
acceptance remains with the coordinating task and is not full ADR-0355 completion.

The factory is inert. `definition` is declared before opening and knows no
account. A reverse-DNS `appId` is supplied once to the factory.

```ts
const epicenter = createEpicenter({
  appId: 'so.epicenter.whispering',
  definition,
});

export const app = epicenter.openLocal();
// A separately selected account dataset:
const accountApp = epicenter.openAccount(account);

app.account; // null, or readonly { authorityId, principalId }; no credentials
app.ready;   // Promise<Result<void, OpenError>>, settles once
app.tables.recordings;
app.kv;      // Existing declared KV capability, retained directly.
app.blobs;
app.sqlite;
await app.close();
```

Prefer full access paths, such as `app.tables.recordings.create(...)`. Do not
introduce `session.app`, `opened.data`, `scope`, `isLocal`, `supportsRemote`, a
second public readiness state, or a facade forwarding each method. Internal
lifecycle state is allowed where it actually coordinates acquisition/release.
`app.account` is captured identity, never a getter over global auth selection.
Remote blob configuration comes from the opened App's actual blob capability,
not a second Account-derived flag. The agreed target is `app.blobs.remote` as a
fixed capability or null; presence does not promise reachability or authorization.
The [core reads and capabilities plan](20260908T204224-explicit-core-reads-and-blob-capabilities.md)
owns that contract migration and removal of Whispering's `remoteAvailable`.
Preserve current KV,
content, observation, and persistence behavior where callers need it; the short
conversation inventory was not authorization to remove those capabilities.

The preferred client-only app composition exports a singleton and gates once.
UI component imports are omitted here:

```svelte
<!-- Parent.svelte: the owner must also arrange app.close() at lifetime end -->
<script>
  import { app } from './app';
</script>

{#await app.ready}
  <Loading />
{:then result}
  {#if result.error}
    <OpenFailure error={result.error} />
  {:else}
    <Recordings />
  {/if}
{/await}
```

```svelte
<!-- Recordings.svelte -->
<script>
  import { app } from './app';
</script>

<button onclick={() => app.tables.recordings.create(recordingInput)}>
  Save recording
</button>
```

The button is illustrative; production handles its Result. Ordinary child
instance scripts run after the successful gate. Module initializers do not.
The same object may instead be passed to `<Recordings {app} />` or set in a
provider's initialization for descendants to retrieve through context. Support
both without making either a second library implementation. Keep one owner for
closure. Remove consumers before or with closing; a settled `ready` promise
cannot report subsequent closure. Account-selected handles may require a keyed
owner rather than one mutable globally selected singleton.

## Current evidence and translations

Re-read these at execution start against the direct-session baseline above.

| Current owner | What changes |
| --- | --- |
| `packages/app/src/index.ts` | `open(account)` returns a separate session; factory-wide `live`/`retire()` replaces the prior session. Replace with one app handle and address-specific coordination. |
| `packages/app/src/client-owned-data.ts` | Account generation resolution, opening, sync attachment, and teardown are coupled. Local opening must perform no authority request or sync dial. |
| `packages/data/src/store/browser.ts` | Generation/address lookup currently requires account data. Add the local persistence path and stable address grammar. |
| `packages/data/src/store/log.ts`, `persist.ts`, `persistence.ts` | Verify local writes can persist and compact without waiting for a nonexistent remote acknowledgment. |
| `packages/auth/src/auth-contract.ts` | Account identity currently needs an authority-identity decision; preserve captured transport retirement semantics. |
| `packages/blobs/src/browser.ts`, `bun.ts`, `webview.ts` | Preserve immutable storage and platform transfer behavior while replacing old addresses and claiming code. |
| `packages/client/src/index.ts` | Existing explicit blob remotes compose with stores. Keep bytes off the WebView in native streaming paths. |
| `packages/device/src/index.ts`, `protocol.ts`, `browser-sqlite.worker.ts` | SQL is device-only today; extend owner identity through protocol and worker, preserve standalone SQL use. |
| `apps/epicenter/src/device.ts`, `server.ts` | Native SQL paths and request validation must agree with the new address codec. |
| `apps/epicenter/src-tauri/src/recorder/blob.rs` | Native capture writes bytes independently of the Bun routes; propagate selected storage ownership through capture and subsequent reads. |
| `apps/whispering/src/lib/epicenter.svelte.ts`, `whispering/recordings.ts`, `whispering/recording-audio.ts` | Update real composition and recording ownership, not just package exports. |
| `apps/whispering/src/routes/(app)/_components/RecordingsSession.svelte` | Replace the account-only gate and split session/data access with the final app readiness gate. |

Three translations anchor the implementation in real callers:

```ts
// Before: packages/app/src/index.ts public session member
readonly opened: Promise<Result<ReplicaData<TDefinition>, DataOpenError>>;
// Target: readiness lives on the app that also exposes tables/blobs/sqlite.
readonly ready: Promise<Result<void, OpenError>>;
```

```ts
// Before: apps/whispering/src/routes/(app)/_components/RecordingsSession.svelte
let session = $state.raw(epicenter.open(account));
// Target local first-run module, imported by its owning gate:
export const app = epicenter.openLocal();
// Account selection opens its own distinct handle, not a promotion of app.
```

```ts
// Before: apps/epicenter/src/device.ts
const directory = join(appDataDir(root, appId), 'sqlite');
const path = join(directory, `${name}.sqlite`);
// Target logical suffix chosen by the captured identity:
// <app-id>/local/sqlite/<name>.sqlite
// <app-id>/accounts/<authority-id>/<principal-id>/sqlite/<name>.sqlite
// Use the shared codec; do not repeat path construction in each owner.
```

## Storage and ownership to implement

```text
epicenter/<app-id>/
  local/
    data/<definition-id>/<generation-id>/
    blobs/
    sqlite/<name>.sqlite
  accounts/<authority-id>/<principal-id>/
    data/<definition-id>/<generation-id>/
    blobs/
    sqlite/<name>.sqlite
```

Filesystem roots contain these directories. IndexedDB names mirror the logical
addresses for generation and blob databases. Browser SQLite uses OPFS and its
VFS may use opaque physical pool files. Do not add a literal directory-mirroring
requirement that the selected VFS cannot satisfy. Files and blob keys stay
platform-owned leaves. There is no `vN` root and no old-layout lookup.

One runtime opens an address once. A duplicate returns a typed failure through
its own `ready`, preserving the first handle. Independent factory instances
must not accidentally defeat this rule. No handle interning or reference-counted
public API. Multiple tabs/processes remain a storage-coordination concern; a
clear refusal on contention is acceptable where the backend cannot share safely.
Never simulate success over conflicting writers.

## Work backward through executable checkpoints

At each checkpoint, record changed owners, validation evidence, review findings,
and the next step here. Use Draft until execution begins, then In Progress.
Do not turn checkpoints into a second permanent task database.

### 1. Settle identity and address ownership

- [ ] Trace account identity from auth to generation resolver, remote transfers,
  SQL protocol, and erasure. Choose the smallest authenticated stable authority
  identity mechanism that supports hosted and self-hosted instances. A server URL
  is a locator, not automatically identity. Record the concrete new mechanism in
  a focused ADR before relying on it; do not invent a global server registry.
- [x] Implement local/account generation address separation in the browser opener.
- [ ] Implement one address codec. Exercise local/account separation, two
  authorities with the same principal, definition/generation separation, safe
  segments, SQLite name validation, and blob placement outside generations.
- [ ] Remove previous address builders and unscoped legacy claiming/import paths.
  No data migration or compatibility test suite is owed.
- [ ] Run the independent GPT-6 checkpoint review described below.

> **Execution note:** Optional `authorityId` plumbing exists in auth constructors
> and account generation addresses, but real boot callers do not bind it.
> Authenticated authority identity is not implemented. The app currently throws
> before acquiring those account opens; the identity assertion is removed. The shared
> codec, blob/SQL propagation, and legacy path removal remain open.

### 2. Prove the one-handle lifecycle against delayed acquisition

- [ ] Return one live app synchronously from either opener. Test immediate
  account identity, successful and failed `ready`, and access before readiness.
- [ ] Test close before acquisition, close during acquisition, late acquisition
  cleanup, repeated close, operations through a retained namespace after close,
  duplicate opens, and reopening after full closure. Closing during opening
  settles readiness with a typed failure and cannot publish success afterward.
- [ ] Prove local/account coexistence and rejection of same-address duplication
  without retiring the first handle. Avoid a permanent fake runtime: use a small
  harness around the real lifecycle boundary, then retain meaningful regressions.
- [ ] Demonstrate singleton import and props/context using the same app type.
  No separate resolved-app facade. Run the GPT-6 checkpoint review.

### 3. Make local persistence real

- [ ] Persist an initial local generation without auth, HTTP, or a sync driver.
  Reopen the same local generation after process/browser restart.
- [ ] Preserve account cache-first opening: cached data can become ready offline;
  a first uncached account open may require generation resolution. Do not gate
  readiness on full synchronization or a successful socket connection.
- [ ] Prove local edits survive flush, compaction, close, and reopen without
  indefinitely accumulating an upload obligation. Audit the existing log/fold
  semantics rather than merely omitting attachStoreSync.
- [ ] Verify local closing leaves account operations working and vice versa.
  Run the GPT-6 checkpoint review.

> **Execution note:** A fake-IndexedDB regression proves a local row survives
> close and reopen within one process. It does not prove process or browser
> restart durability. Local appends use `NO_AUTHORITY`, so they do not create
> upload debt. Local stores now have no registered replication engine; the unused
> `replicates` flag and fabricated replica metadata are removed from apps. Browser/native runtime
> smokes are unverified; no external blocker has been established.

### Review checkpoint, 2026-09-08

The forwarding app facade and `open-replica.ts` are removed. The real document
factory owns readiness, guarded operations, sync/hide registration, and closure.
Browser acquisition returns backing resources rather than another store. Local
apps no longer carry fabricated replica metadata. Exact-generation low-level
openers remain for real callers; they are not a second application API.

Independent review found and corrected closure inside a transaction, closure
during sync attachment, callbacks continuing after closure, and corrupt
synchronous hydration leaking its backing. Deferred acquisition, corrupt replay,
retained operations, repeated closure, and cleanup failure have focused tests.
Concurrent first-open generation allocation and whole-library claims remain
separate work; changing document construction did not solve them.

The claim now returns its own release function instead of using an address-keyed
release map. Its Promise resolver supplies idempotence directly. The unused
`eraseReplicaOf` function was removed and account acquisition moved from
`client-owned-data.ts` to `open-replica.ts`. Whole-library removal remains open.

Whispering's settings persistence, notifications, and domain disposal tests were
restored against `openAccount` and `ready`; deleting the old session API did not
justify deleting those behaviors. Three restored tests and Whispering's browser
and host typechecks pass. App/data typechecks and 35 focused app/browser tests
passed after the claim cleanup. Broader account regression coverage still needs
restoration against the final ownership model.

The implemented document factory constructs real capabilities before hydration.
It constructs persistence after acquiring the real port and loaded snapshot;
there is no two-phase controller. Raw Yjs content is borrowed
and cannot be revoked by that guard, so editor consumers must stop before close.
Nullable account identity remains the only public local/account distinction.

The overlapping blob/schema task paused app/data writes for this construction
wave and authorized withdrawing its provisional `app.blobs` composition from
`packages/app/src/index.ts`. Its blob primitives and schema changes were left
untouched. Subsequent composition must join the actual resource owner, not
mutate the frozen returned handle or add another readiness/closure facade.

Independent reviews also proposed a whole-library exclusive claim, authenticated
server-issued authority identity persisted with credentials, and fixed initial
generation boot through an atomic ensure operation. The latter would sacrifice
generation rollover and requires a caller audit and an ADR amendment before
implementation. These are proposals, not completed checkpoints.

The first product slice should prove signed-out recording, durable save, reopen,
and playback with real app-owned blobs. A plain blob-ID field can support that
intermediate proof; it does not complete the owning-field checkpoint. Removing
automatic transcription was proposed by a reviewer and was not accepted: no
evidence establishes that core behavior must be sacrificed for this collapse.

### 4. Compose blobs and named SQL under the captured identity

- [ ] Implement the app blob verbs over portable primitives. Expose the actual
  configured remote capability or null through `app.blobs.remote`, preserving
  App operation admission and close/drain. Remove Whispering's duplicate
  `remoteConfigured` argument and `remoteAvailable` surface with their consumers.
  Coordinate with the linked core reads and capabilities plan. Verify remote Result failures remain
  precise, download is same-ID, and local reads do not fall back to the network.
- [ ] Propagate SQL identity through browser worker and native request boundary.
  `app.sqlite.open('recordings')` returns the existing run/all/batch shape;
  validate plain strings at open/delete and the native trust boundary.
- [ ] Preserve SQL-only construction without opening a declared-table replica.
  Choose its minimal composition from real Local Mail/Local Books callers;
  do not force a dummy definition or account. Preserve device secret lifetime.
- [ ] Verify browser OPFS contention behavior and native close/delete sidecars.
  Account SQL remains local, outside data generations, with no implicit sync.
  A shared OPFS worker/pool can outlive one app: close that app's SQL handles
  without destroying another app's active databases.
- [ ] Run the GPT-6 checkpoint review; challenge wrappers and duplicated identity.

> **Execution note:** `@epicenter/app` now constructs a scoped `app.blobs`
> capability before freezing the app handle. `BlobId` is the only read address;
> `add(Blob)` is separate from `get/stat/open(BlobId)`, local reads never fall
> back to remote, and account namespaces include the captured authority when
> present. The app close gate refuses retained blob operations after closure;
> the combined GPT-6 review still requires in-flight remote drain and true
> resource ownership before this checkpoint is complete. SQL composition remains
> open.

### 5. Implement owning blob fields and prove Whispering end to end

- [ ] Extend field declaration/validation/row types and projection/artifact
  handling for `field.blob()`. Input bytes become an immutable ID in rows.
  Existing low-level synchronous row writes must not bypass attachment ownership.
  Decide and document whether scalar-only writes stay synchronous; test ordinary
  table callers and type inference rather than imposing async creation silently.
- [ ] Define creation compensation, replacement/deletion ordering, orphan recovery,
  transfer/deletion races, and remote receipt storage before claiming reliability.
  Separate an acknowledged upload from verified current remote presence. Reuse
  existing recording workflows where they still own a real policy.
- [ ] Make Whispering's local recording path available before sign-in. Prove
  capture, local commit, row creation, restart, and playback on a fresh origin.
- [ ] Open an account library independently. Implement explicit application-owned
  copy/import with source preservation and retry-safe mappings; do not confuse
  this product operation with the refused legacy storage migrations.
- [ ] Prove individual and selected-recording uploads and second-device download.
  Verify sign-out retires transport without changing a handle's account identity.
- [ ] Preserve the existing account-local removal use case with an app-level owner;
  do not add speculative reset/cache-clearing/remote-account-deletion APIs.
- [ ] Run the GPT-6 checkpoint review against real recording call sites.

> **Execution note:** `field.blob()` is recognized as a distinct schema kind,
> `RowOf` carries `BlobId`, and `AttachmentCreateRowOf` carries `Blob`. The
> compile-time proof passes. Whispering now consumes `app.blobs` directly for
> local reads, writes, playback, and remote copy, and the unscoped claim path
> plus its UI and tests are deleted. The persisted Whispering field is still
> named `audioBlobId` and the low-level row create remains synchronous, so the
> owning-field and end-to-end checkpoints remain open.

### 6. Integrate consumers and remove the displaced shape

- [ ] Update Honeycrisp, Vocab, and every other live consumer found through imports.
  Preserve account callback and overlay lifetimes; do not eagerly open data from
  a module shared with routes that must not acquire it. Prefer singleton imports
  where one client dataset has an actual module lifetime, not indiscriminately.
- [ ] Delete obsolete session/facade/capability-state code, account-only boot rules,
  old-layout tests, exports, and documentation claims. Update applicable guidance
  so AGENTS.md no longer instructs every app to gate use on sign-in. Use its
  instruction-design skill for that change. Keep historical articles explanatory.
- [ ] Verify final builds and relevant runtime smokes. Temporary breakage is no
  excuse for leaving a broken consumer or a compatibility alias in the result.
- [ ] Run a final independent GPT-6 caller/invariant review. Integrate valid
  findings, rerun affected checks, and record final evidence.

## GPT-6 reviews are execution checkpoints

After each meaningful slice above, spawn a separate GPT-6 agent for a bounded,
read-only review while the execution owner does useful independent work. Use the
available GPT-6 model through the collaboration tool; do not invoke Claude.
A failure or newly spreading wrapper family is also a review trigger. Reviews
are not a requirement to stop every few edited files or re-approve settled names.

Give the reviewer the current diff, relevant callers, ADR, test evidence, and
this question:

> Does one live app still own one dataset's opening, operations, and closure?
> Identify duplicate facts, forwarding facades, repeated account/address binding,
> readiness wrappers, and policies that should have one owner. For each proposed
> collapse, show the before/after call site, the invariant it preserves, code that
> disappears, and any behavior lost. Distinguish a real finding from a preference.

The implementing agent judges and integrates feedback. Reviewers do not edit the
living checkout. Do not accept comments merely because another agent made them.
Use caller evidence and targeted tests. Keep distinctions that vary independently:
account identity/auth availability, row/blob identity, and acknowledgment/presence.

A coherent internal collapse is authorized without asking the user. If evidence
suggests changing the settled product promise or public semantics, articulate the
conflict and seek judgment rather than silently rewriting it. Record new durable
mechanisms in focused ADRs; do not reopen the entire design at each checkpoint.

## Verification and completion

Start by inspecting dirty state and current package scripts. Preserve the
direct-session baseline and any subsequent work; re-read before editing.
Baseline only affected checks. Use Bun, and verify external library behavior with
installed types/source or official documentation when it controls correctness.

Useful starting commands, adjusted when files move:

```sh
bun test packages/app/src
bun test packages/data/src/store
bun test packages/blobs/src
bun test packages/device/src
bun test apps/whispering/src/lib/whispering
bun run --filter @epicenter/app typecheck
bun run --filter @epicenter/data typecheck
bun run --filter @epicenter/blobs typecheck
bun run --filter @epicenter/device typecheck
bun run --filter @epicenter/blobs smoke:webkit
bun dev:whispering
bun scripts/check-doc-hygiene.ts
```

Read and run each changed app's declared typecheck/build scripts, including
browser and epicenter-host variants. Broaden to the repository's normal final
checks after integration. Do not run production deployment/admin commands.
Do not count snippet compilation, fake-indexeddb, or an in-memory lifecycle
harness as proof of browser restart durability, OPFS behavior, or native streaming.

Done means the final call sites exist, meaningful lifecycle/persistence/transfer
regressions pass, the product flows above work, displaced paths are gone, and
current READMEs/examples match code. Report any genuinely external verification
block separately with exact evidence; do not quietly call untested paths done.
Remove this spent spec and its handoff when work is complete, retaining durable
ADRs and the repository's normal spec-history entry. Remove or replace ADR-0355's
link to this temporary spec in that same change. No deployment is included.
