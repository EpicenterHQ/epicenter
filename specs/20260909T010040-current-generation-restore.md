# One current generation, cache-first startup, and restore by reload

**Status:** In Progress

## Read this first: current direction, 2026-09-13

**App composition settled 2026-09-14:** one App exposes Local and available
account libraries. Applications choose views and explicit write destinations;
no picker, Personal default, or cross-library copy feature is required. Local
persists within the app's storage profile across account changes, while account
data and its local attachment cache remain isolated. ADR-0392, ADR-0399, and
ADR-0401 own that boundary. Backup reconstruction is not a cross-library copy.

**Restore contract settled 2026-09-14:** ordinary synchronization brings devices
together; restore replaces the library everywhere with the selected backup.
Confirmed retirement discards unsynchronized old-generation rows and attachment
work, including completed recordings whose uploads never finished. No rescue
queue or automatic merge follows. The safety copy covers captured account
state only, with audio coverage shown separately. Finishing synchronization
first means both accepted row updates and acknowledged audio uploads.

Replacement must check admission before old work resumes, reuse matching
local audio for restored rows, and preserve account objects held by backups.
Never interpret row-cache invalidation as erasing the whole attachment store.
The phone cannot verify that every offline device is synchronized. A lost
restore response or retirement notice does not establish which request won.

Build folder-backed recovery around row-owned attachments that synchronize
eagerly, with explicit local availability. Read ADR-0393 for the user story,
developer boundary, and Whispering UI; read Implementation waves below for
the active execution order. ADR-0394 and ADR-0395 own retention and restore.

Current production still has blob IDs and Whispering-owned upload policy.
The target removes that coordination, keeps local reads honest, and downloads
current attachments automatically for offline use. Completion requires the
two-device journey and failure evidence in the revised waves, plus safe
reclamation proof. Exact transfer metadata and reclamation mechanisms remain
open; neither an upload timestamp nor a grace period is a safety proof.

All older execution descriptions and checklists outside Implementation waves
are historical evidence where they disagree with that section. In particular,
the old cached-on-play policy, explicit eviction, backup-only sweep, and
deletion-first sequence no longer govern. Existing passing tests do not prove
the new attachment lifecycle.

Restore replaces the library's current generation; devices invalidate retired
IndexedDB replicas and reload, while ordinary use stays cache-first and
offline-capable.

## Bounded attachment synchronization checkpoint, 2026-09-16

Status: In Progress. This checkpoint implements waves 1 through 3 only as needed
for the saved-file delivery journey. Recovery, reclamation, account copying,
the full App scopes migration, concurrent microphones, and production migration
remain outside it. Existing planning corrections and generation edits belong
to their current workstreams; this checkpoint does not stage them.

| Checkpoint | Implemented behavior | Verification evidence | Remaining acceptance gaps | Next dependency |
| --- | --- | --- | --- | --- |
| 1. Local save | Finished-file creation, disposable capture/import, durable Saved and original inference selection implemented. Independent cumulative review and exact-request race follow-up resolved; no further App restructuring required | App 102 pass / 401 assertions; blobs and attachment 107 / 1,563; host HTTP 46 / 408. Whispering domain 20 / 77, capture 17 / 67, closure 10 / 34, inference 9 / 32, pipeline 12 / 43. Native 157 pass / 2 ignored. App, blobs, data DOM, both Whispering leaves and recursive Epicenter typechecks pass. Chromium offline capture/save/reopen/playback smoke passes; physical microphone, real WKWebView reload and owned-process interruption/reopen probes pass | Native imported-audio A/B passes in checkpoint 4; physical capture/account A/B remains incomplete. Native probes are bounded hardware evidence, not whole-product acceptance. Windows directory durability and folder-codec reconstruction are unproved; the latter belongs to excluded recovery | Implement reviewed publication protocol and library-owned transfer |
| 2. Account transfer | Authenticated publication, library worker and native one-shot transfers implemented and reviewed. Whispering uses library status and bounded controls; its upload runner, destructive copy controls and public `blobs.remote` are removed | Protocol/signing/mount: 12 Bun pass / 61 assertions; workerd publication/current-generation/retirement: 11 pass. Authenticated independently persisted browser A/B journey passes offline capture, restart, reconnect, automatic delivery, offline playback, lost responses and delayed availability. Native 169 pass / 3 ignored; streamed HTTP RSS stays near 22 to 24 MiB through 1 GiB | Native imported-audio UI A/B passes in checkpoint 4; actual object-provider enforcement remains unproved. Browser microphone is synthetic; native physical capture evidence is separate | Native Whispering UI journey and disposable real-provider verification, without expanding App architecture |
| 3. Failure/race and API review | Independent review of all three attachment commits against 09b1965e55 retained the design. Repaired filesystem observation after unconfirmed download or acknowledgment publication; presence now repeats durability barriers, including after reopen | Blobs and data attachment suites: 139 pass / 1,669 assertions. Three new filesystem fault regressions failed before repair, then passed with 21 assertions; independent follow-up approved. App 102 / 401; bridge 5 / 15; host HTTP 46 / 408; Whispering focused suites and affected typechecks pass. Foundation failures and eight main-data DOM errors reproduce at 09b1965e55 | Physical native capture A/B, actual provider and Windows durability acceptance | Advance actual native Whispering UI acceptance; preserve all unproved gaps |
| 4. Native product acceptance | Actual Whispering Local and authenticated A/B imported-audio journeys pass. Repaired WKWebView request bodies and duplicate native upload MIME. Local survives authentication without adoption; account delivery and bounded controls work through native Rust transfer | Native `--import --account` exits 0: A offline save/restart/play/reconnect; B automatic delivery before Play, pause/cancel/retry/resume, offline playback/restart without attachment requests or uploads. Matching 64,044-byte SHA-256; six native/Bun process pairs; cleanup verified. Independent review accepts evidence. Auth 141 / 587; host account/auth 51 / 327; native 169 pass / 3 ignored | Physical capture blocked: macOS lists no input device. Real-provider checksum/create-only/signature/CORS unavailable; successful inference and hardware recovery unproved | Supply physical input and extend the account source step to capture; repeat A/B against a disposable conforming provider |


Continuation review, 2026-09-16: a download can rename verified bytes and then
fail its directory flush. The worker previously accepted visible metadata on
retry or reopen and reported local completion without settling that failure.
A matching acknowledgment receipt had the same gap. Filesystem attachment
observation now synchronizes data, metadata, matching receipts, and ancestor
directories before reporting local presence or cleared upload debt. Failures
remain storage errors. The worker still owns final generation admission;
reads remain local. Repeating barriers adds filesystem work to observations.
No public API, publication protocol, or destination changed.

The focused regressions use actual filesystem synchronization faults after
rename, an HTTP download, live retry, and independent reopen. All three failed
against the prior implementation and pass after repair. Independent cumulative
review and the repair follow-up found no further blocker. Native Rust remains
169 pass / 3 ignored; publication/signing/mount remains 12 pass / 61 assertions;
workerd remains 11 pass. The authenticated browser journey passed again,
including offline capture/restart, automatic A-to-B delivery, offline playback,
lost responses, and delayed remote availability. This is still package-consumer
evidence, not native Whispering A/B or real-provider conformance.

Baseline attribution used a separate detached 09b1965e55 checkout with its own
installed dependencies. Both baseline and current foundation have 7 pass and
2 fail: initial generation fetch returns 404 and unadmitted sockets return 403
(the baseline expects 409; concurrent current tests expect 404). Both main-data
typechecks report the same eight DOM-boundary diagnostics; the current DOM
leaf passes. These unrelated files were neither repaired nor staged.


Native acceptance exposed a second defect outside the attachment worker:
`createDesktopBrokerAuth` reconstructed a request from another request's body.
WKWebView rejected even a binary generation seed with
`NotSupportedError: ReadableStream uploading is not supported`, preventing
Personal-library startup. A real native probe reproduced the difference between
a direct binary POST and the reconstructed request. The broker now snapshots
the encoded body, preserves its content headers, and fences dispatch after
signal-cancelable preparation. Independent review approved the fix, and the
rebuilt native Whispering Personal library opens. No credential, destination,
or auth-schema change was needed. Brokered bodies are materialized in memory;
native attachment bytes still use the separate streaming reqwest path.

Native account upload exposed a third defect: reqwest appended a second
`Content-Type` after applying the ticket headers. The fixture consequently
stored `audio/wav, audio/wav`; full-object verification correctly refused it.
The upload now sends only the ticket's validated MIME header. A real HTTP
regression observed both values before repair and exactly one afterward.
Independent review approved the repair; native tests remain 169 pass,
0 fail, 3 ignored. Checksum and create-only headers, streaming, and cancellation
are unchanged. The rebuilt native imported-audio A/B journey now passes.

Native evidence and exact checks are recorded in
[attachment-native-evidence.md](../packages/app/scripts/attachment-native-evidence.md).
Independent review inspected the final result and both persisted files. The
native run proves import/save, offline restart, automatic delivery before Play,
bounded controls, and offline playback using two separately persisted clients.
It does not substitute for physical capture: no input device is available here.
The object fixture does not verify real signatures or provider enforcement.
The next slice requires those environments; no production provisioning or host
security change was made. General recovery and App restructuring remain excluded.

The library owns one attachment synchronizer for its captured account, library,
and generation. Local opens no transfer worker and keeps its existing persistent
namespace across account changes. Capture and inference retain their original
destinations. Explicit remote inference remains available for local audio.

Prerequisite at task start: the checkout created null attachment rows before
capture. `store/attachment.ts` exposed completion and rolled its cell back after
a failed flush; the desktop recorder published through its recovery journal.
Replace and prove this joint local-save boundary before mounting automatic delivery. The
replacement creates an internally allocated owner from finished bytes, persists
private content-verification evidence with that owner, and leaves unknown save
outcomes intact. Native temporary output must enter library publication without
an audio-sized WebView transfer. Coordinate ownership of this prerequisite
before overlapping another implementation.

Persistence and retry boundaries:

- Durable local publication records local origin and the admitted generation.
  Persisted current rows plus that evidence reconstruct upload obligations on
  reopen. Mere file existence, a restored row, or downloaded bytes do not grant
  upload authority. Acknowledgment follows verified remote publication.
- Downloads derive from current completed owners and observed local absence.
  Presence begins unknown; storage failure is distinct from absence. Reads and
  playback perform local I/O only.
- The worker bounds concurrency, wakes on open, completion and reconnect, and
  schedules capped backoff after recoverable failures, including remote 404.
  Device-local Pause affects downloads only. Resume, Retry and prioritization
  use that same worker. Storage, authorization and quota failures remain visible.

Retirement protocol: both transfer admission and publication must check the
captured generation at the current-library authority. The historical generation
ledger is not that authority. A transfer crossing confirmed retirement cannot
publish into the replacement or recreate a deleted row. Staged or already
written immutable bytes may remain conservatively retained; they grant neither
current-row presence nor new upload authority. Ordinary account closure stops
and drains admitted work while preserving retry obligations. Confirmed retirement
abandons old-generation obligations, preserves reusable matching files, and
never triggers a blanket byte-store erase. Final transport details must prove
this fence before integration; an independently valid presigned PUT is insufficient.

Immutable retries verify actual content against retained owner evidence and any
occupied address. A 409/412, size, MIME type or ETag alone cannot establish
equality. One-shot browser and native adapters must preserve this invariant,
with native hashing and transfer streamed outside the WebView.

Publication protocol review: replace the provisional reservation with full
verification followed by atomic publication. The independent review reproduced
an unverified reservation blocking the correct content before any object
existed. No capture, import, playback, export, or inference caller needs that
claim. None should coordinate the transport's request sequence.

The retained states each enforce a different invariant:

- Local immutable content evidence and origin distinguish an authored upload
  from a download. A separate durable acknowledgment lets restart retry a lost
  publication response without manufacturing new work.
- The completed row's private content evidence tells another client exactly
  which bytes belong to that row. Local absence remains a device observation,
  not a synchronized row mutation.
- The authority retains only verified address, SHA-256, size, and MIME type.
  Row existence in that private index means published; remove `reserve()` and
  the `published` flag. Atomic compare-or-insert shares the transaction owner
  with current-generation admission. The evidence survives replacement because
  the immutable address cannot acquire different content in a later generation.
- Attempts, concurrency slots, and retry deadlines need no durable server
  reservation. The client reconstructs obligations from current completed rows
  and local origin, then retries after restart.

The request sequence remains ticket, create-only object PUT, and finalize.
Ticket issuance writes no publication state. Sign `content-type`,
`if-none-match: *`, and the base64 SHA-256 checksum header. Finalize streams and
hashes the entire object, then atomically admits and publishes. An already
verified identical publication returns success after current admission without
another full-object read. A 409/412 or ETag never supplies this proof. Bind the
authenticated storage prefix and authority together when constructing the
transport, not as independently replaceable arguments on each call.

Deletion during transfer removes the client obligation and prevents late local
publication or row resurrection. The opaque update authority does not decode
CRDT row deletion: a previously accepted remote operation can leave retained
bytes. Retirement rejects old-generation finalize even if a signed PUT already
landed. Different bytes at an immutable address cause an explicit conflict;
never acknowledge, overwrite, or serve them as the expected content. Repair or
reclamation of that address is outside this checkpoint.

Verification costs one additional object GET and one SHA-256 pass: for an
N-byte A-to-B delivery, upload, verification, and download transfer 3N bytes
before retries. Two concurrent 5 GiB verifications read 10 GiB. The provisional
transport benchmark runs the actual verifier in workerd against a backpressured
HTTP source. Two 172,800,044-byte objects took 782 ms; two 5 GiB objects took
24,253 ms. Sampled worker allocated memory peaked at 45,159,445 and 43,842,793
bytes respectively; source buffering peaked at 65,538 bytes and observed worker
chunks at 4,096 bytes. These are local runtime measurements, not production CPU
or latency guarantees, RSS measurements, or authenticated delivery acceptance.

Native finished-file hashing uses one 64 KiB buffer and has streamed size tests
through 345,600,044 bytes. Native reqwest upload and download now stream outside
the WebView. Isolated actual HTTP probes transferred 17,280,044, 172,800,044 and
1,073,741,824 bytes. After cancellation repairs, upload peak RSS was 22,368,
22,384 and 22,960 KiB; download peaks were 24,160, 24,144 and 24,336 KiB.
Both the native client and streaming loopback peer ran in the measured process.
The IPC bridge test uses mocked invocation, so this does not establish a full
native Whispering A/B journey. S3 checksum and
create-only enforcement also need actual provider evidence; signing tests alone
cannot establish provider behavior or bucket CORS configuration.

Publication implementation review kept the mechanism. It required invalid JSON
to return 400 rather than 503 and corrected the S3 overview's no-hashing claim;
both are repaired. Workerd eviction exposed a live ten-minute timeout after
successful verification. An explicitly cleared deadline now permits immediate
eviction and an identical retry without another object read. The current named
Durable Object supplies its own storage prefix; no persisted scope mapping was
added. Cloud and self-host Worker use this mount. The Bun self-host deployment
still has no store backend and is not covered by that result.

The first native byte path used Bun's existing sidecar. Actual disk-backed HTTP
measurements rejected it as bounded-memory evidence: incremental peak RSS was
75,464,704 bytes for a 17,280,044-byte file, 410,664,960 for a 172,800,044-byte
file, and 2,508,505,088 for 1 GiB. A logically chunked reader does not fix runtime
fetch buffering. Native one-shot networking is replaced by reqwest under
the same library owner; no range protocol, runtime upgrade, or application
upload runner is introduced.

Cumulative transfer review kept the library owner and required four repairs.
A live download retains its final-admission phase across recoverable failures,
without downloading the installed file again. An expired signed ticket retries
through captured-account authorization. Control 403 also remains visible and
backs off, avoiding a second error-classification surface. A twenty-minute
attempt deadline covers native byte I/O and the authority's ten-minute verifier;
timeout aborts I/O and schedules retry, unlike closure, deletion or pause.
The sole production WebView adapter already supplied native transfer, so its
unused HTTP fallback and host routes were removed. No second upload path remains
in the application. The low-level legacy copy primitive is not the attachment
protocol and is no longer exposed as `app.blobs.remote`.

Native cancellation retains only a document sequence high-water mark and two
active requests. Cancellation does not release a slot until its work finishes;
out-of-order old admission is refused rather than reviving cancelled work.
The native full suite exposed a task-owned cleanup race: dropping an async
filesystem operation could create staging after cleanup. Transfers now drain
filesystem work, flush queued writes before cancellable network reads, and
check cancellation before immutable installation. Cleanup failures remain
storage errors. The parallel regression exercises twenty-four cancellations.

Final review retained the design and found one remaining timeout branch: a byte
adapter returns a failed Result on abort instead of throwing. Deadline handling
now runs once in the attempt's `finally`, so both forms back off rather than
starting an immediate upload loop. The regression expires an active byte
transfer and confirms visible waiting state without a second upload.
The retirement follow-up also retained native slots across document epochs
until physical work drains. Exact `(epoch, sequence)` completion cannot release
a successor's slot. Its regression proves capacity remains occupied after
retirement and admits a successor only after old work finishes.

Final boundary verification aligned server and native transfer with finished-file
creation's zero-byte support. Actual HTTP empty-file publication, restart retry,
native upload and native download pass without weakening SHA-256 or MIME checks.
Final protocol/signing/mount totals are 12 Bun passes / 61 assertions; workerd
remains 11 passes. The final native suite has 169 passes / 3 ignored.

The authenticated browser journey uses real self-host session/passkey auth,
independently persisted browser contexts and the actual HTTP/WebSocket mounts.
A records offline, restarts offline, reconnects in the same runtime and uploads.
B receives before Play, disconnects, decodes and plays locally, then reopens and
plays again. Lost object-PUT and successful-finalize responses, two delayed
verification 404s and identical create-only retries pass. B issues no PUT, and
offline playback attempts no attachment network request. Evidence includes a
273-byte captured Opus file and valid 96,044-byte and 17,280,044-byte WAV imports.
The disk-backed object fixture checks checksum and create-only behavior, but
does not validate SigV4 authenticity or prove provider conformance. This is a
package-consumer journey, not full Whispering UI or whole-browser interruption.

Consumers: switch Whispering capture and imports through finished-file creation,
then playback, export and inference through local attachment reads. Replace its
legacy upload policy and manual copy controls only after their actual consumers
use the replacement. Show audio availability and a library transfer summary;
Saved continues to mean durable local row and audio, not account delivery.

Verification: use actual authenticated transport and separately persisted A/B
clients. Record offline on A, reopen if needed, reconnect and upload, receive
automatically on B without Play, disconnect B and play locally. Exercise lost
responses, delayed remote bytes without a new row event, storage failure,
account closure, deletion during transfer and retirement at each publication
boundary. Measure representative recording sizes and native streaming. Physical
microphone, whole-host interruption and native WebView recovery need actual
runtime evidence; fixtures and synthetic SIGKILL are not acceptance.

Pre-edit baseline rechecked: library-ownership foundation has 7 pass / 2 fail
(initial fetch 404; unadmitted socket expected 404, received 403). Data's main
typecheck reports eight DOM-boundary errors; its DOM leaf passes. The historical
393 Bun and 154 native passes have not been rerun for this checkpoint and do
not establish the replacement contract. Independent review must assess each
implemented boundary before dependent work and selective checkpoint commits.

Local review repairs: repeated file and ancestor-directory durability barriers
also apply to identical retries; native confirmed capture loss releases controls;
uncertain Start retains its original timestamp and inference selection. The
native exact-request resolver prevents a delayed Start after confirmed absence.
The adapter fences late Start/current replies, and Whispering excludes Retry
while Cancel resolves the original capture. Independent follow-up found no
remaining blocker. Final domain verification exposed two stale metadata stubs;
the fixtures now retain publication evidence, and all 20 domain tests pass.

## Superseding decisions, 2026-09-12

The recovery design below the "Settled product contract" heading was replaced
by three records before the restore orchestration was mounted. Read them before
anything in this spec that mentions a catalog, an archive, an attempt, a
journal, a blob id, or object storage for backups:

- [ADR-0393](../docs/adr/0393-a-blob-is-addressed-by-its-row-and-the-account-holds-every-one.md):
  a blob is the object at `<table>/<row-id>` under the library's mount, its
  cell holds the MIME type, bytes are immutable and a row keeps them for life,
  and the account holds every blob while the device caches.
- [ADR-0394](../docs/adr/0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md):
  a backup is the text of the ADR-0337 folder kept by the authority as
  `_kept` and `_kept_files` rows; a copy names bytes by naming rows; all
  reclamation awaits publication/retention proof; daily automatic copies
  keep the newest seven; six verbs on `openLibraryRecovery` and five routes
  beside `CURRENT_ROUTE`.
- [ADR-0395](../docs/adr/0395-restore-is-one-request-that-carries-its-own-safety-copy.md):
  restore is one request carrying the safety entries, the reconstructed state,
  and the expected position; the transaction keeps the safety copy; there is
  no attempt journal, pin, fence, receipt, operation id, or client journal.

ADR-0386 was deleted. The current-generation authority, retirement, cache
invalidation, reload, and the Honeycrisp browser journey stand. The dated
checkpoints below remain evidence of what was built. "Implementation waves"
and "Required proof" were rewritten on 2026-09-12 against the three records
and are the plan; every other section below this notice that describes a
catalog, an archive, an attempt, or a journal is history.

The reconstruction design is in [ADR-0379](../docs/adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md).
The current authority lives in `packages/data/src/sync/authority.ts`; its
portable transactions and generation-bound hub lifetimes are exercised under
`packages/data/evidence/current-generation/`. Production browser startup uses
the stable current authority through the Honeycrisp integration.

## Historical execution path before ADR-0393 through ADR-0395

Build one library-bound recovery owner: every restore uses a published backup ID,
and the owner manages the safety backup and durable attempt behind the call.
The five-method API below is the target. `src/recovery.ts` now implements backup,
import, list, and download as an unmounted coordinator, over durable publication
intent and a durable attempt journal. Restore, authenticated recovery transport,
and the Backups screen remain unimplemented.

Read Settled product contract, Target ownership, Recovery API and execution,
and Required proof first. Dated checkpoint sections preserve prior evidence;
they are not an alternative implementation sequence. Current-authority startup,
complete captured-head download, and Honeycrisp retirement/reload are integrated
and exercised together. Production restore orchestration and existing-history
rollout remain unresolved.
This execution path targets synchronized libraries. Preserve existing local-only
startup; local-only backup and replacement need an equivalent local recovery
owner and are separate unresolved work.

## Durable intent and retry checkpoint, 2026-09-12

Publication intent is durable and the restore attempt has a journal. Neither is
mounted: there is still no `restore()`, no transport, no package-barrel export,
and no UI.

`recovery-journal.ts` holds one intent at a time on the client, with the exact
bytes rather than a reference to them. The intent is written before the first
mutating request, so a capture that never reached object storage is still
recoverable; a retry after restart republishes those bytes instead of capturing
today's library under yesterday's intent. `recoveryJournalAddress` derives the
slot from server, account, application, data definition, and library together.
`store/idb-journal.ts` is the browser engine, in its own IndexedDB database, and
a test drives a real `openCurrentCache` install and discard against it: the
record survives the invalidation it exists to outlive. The header is written
after the payload and carries its digest and length, so a torn pair reads as
absent and is cleared rather than published.

A publication whose read-back failed is finished by a coordinator built from
nothing, over the same directory, after further writes were accepted. It
publishes the original capture at the original position, one record, and the
next backup is a fresh capture of today. A pending import is resumed only by the
same file, and refuses a manual backup by name while it is unresolved.

`sync/attempts.ts` owns the attempt under the same stable SQLite owner as the
catalog, so it survives the generation it replaces. One unresolved attempt per
library is a partial unique index over `status = 'pending'`, not a read followed
by a write. Reserving the same operation resumes; a different selection under it
conflicts; a different operation while one is unresolved is refused and names
the one that holds the slot. The safety backup id, destination position, and
prepared activation digest and object are each set once and refuse a different
value. `pinLibrary` is now shared with the catalog, so an attempt cannot be
opened against another library or application identity.

`fail` proves in one transaction that nothing committed, then writes the fence.
Activation reads that status in the same transaction as its destination
comparison and receipt write, so a request already prepared by a failed attempt
returns `fenced` and the generation does not move. An attempt that pinned no
preparation cannot activate at all: "no live activation from unverified
preparation" belongs in the same transaction as the fence, for the same reason
the fence cannot live in a route. The fence is durable: a
reopened authority refuses it too. Activation resolves its own attempt, and a
committed outcome refuses to be rewritten as a failure. `authority.receipt`
answers from the receipt table alone, so an outcome is observable with archive
storage unreachable and without the bytes that produced it.

The authority owns liveness and the journal carries bytes. Every reconciliation
asks `attempts.pending()` first, so an attempt started in another tab, on
another device, or before this device's site data was cleared still refuses a
backup, an import, and a second attempt here, naming the operation that holds
the slot. The reservation is written before the local reference, because the
reservation is the durable record and a reference written first would survive a
refused `begin` and block every later backup in the name of an attempt reserved
nowhere. One exclusion covers every mutating coordinator method rather than
publication alone, so a restore cannot overwrite the payload holding a
publication's only copy of its capture.

Reading an outcome is not what forgets it. `attempts.pending` returns a resolved
attempt with its receipt; only `acknowledge` releases the local reference, and
only for an attempt that is no longer pending. An attempt the authority never
reserved is the one case cleared on sight. An activation that committed while
the page was gone is reported on reopen, blocks a new backup until acknowledged,
and leaves both the source and the safety backup in a catalog that outlived the
generation.

One safety backup per attempt survives an interrupted publication: the capture
is journalled before it is sent, the same reservation republishes the same
bytes, and asking again returns the record rather than capturing the destination
a second time. It remains in the catalog after the attempt is finalized as
failed. Prepared activation bytes are stored immutably, read back, and pinned by
digest, so a retry activates the lineage it prepared; bytes rebuilt by a second
reconstruction differ and are refused.

Independent design review found four blockers and no objection to the ownership
split. Liveness read only the client journal, so a coordinator with no local
reference published while a restore was unresolved. `begin` wrote its reference
before reserving, so a refused reservation left a name that blocked every later
backup. Activation accepted an attempt that had pinned nothing. One exclusion
covered publication alone while every attempt method wrote the same journal
slot. All four are repaired, each with a regression test confirmed to fail
against the code as reviewed. Its nits were applied except the tolerated
unreferenced activation object.

Focused validation: 84 tests pass across codec, destination installation,
recovery, the journal, the attempt journal, the catalog, current authority/hub,
the S3 archive adapter, and generic blob routes, up from 64 at the previous
checkpoint. The whole data package passes 689 tests. Three Worker suites pass 13 tests. Server and Honeycrisp script
programs typecheck. Data's DOM leaf passes; its root passes with explicit DOM
libraries and retains the same eight browser-global diagnostics as task start.
The full Honeycrisp browser journey passes. Documentation hygiene reports the
same 44 existing findings; this checkpoint adds none.

Still unproven here: crash and power-loss durability, as against reopening a
file; hosted provider retention; and transport size limits for archives that
still embed numeric byte arrays. The prepared activation object is uploaded
before the attempt points at it, so an interruption between the two leaves an
unreferenced object for cleanup rather than a lost request.

One limitation is known and deferred rather than solved. Two coordinators over
one journal address can still race a publication's single slot; the authority
arbitrates attempts, but a publication intent has no equivalent durable holder.
Binding recovery to the page's fixed application and account lifetime, with a
lock on the journal address, is where that closes, and it is already wave 4.

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

#### Local attachment checkpoint, 2026-09-15

Continuation review, 2026-09-15: this checkout already contained the local
owner, recorder integration, and the earlier checkpoint below. Those changes
and the concurrent generation work are preserved. The attachment owner remains the
completion authority: row flush, immutable byte publication, and completion
flush are separate failure boundaries. Native staging retains the original
library, generation, row, and session until acknowledgment.

The new independent adversarial review found and verified cancellation repairs:

- Native cancellation and retirement now share `recovery::discard`, which
  removes staging and journal ownership while preserving published bytes. A
  deleted row cannot turn a lost completion acknowledgment into byte reclamation.
  The desktop adapter no longer reads the cell to choose its cleanup command;
  `AttachmentEngine.isCompleted` was removed with replacement regression coverage.
- Failed cancellation remains retryable through the desktop session and
  Whispering controls. The original handle recovers and retries. A stale handle
  cannot cancel the next capture.
- A lost cancellation response no longer prevents App close. Native release
  needs no journal and succeeds when the exact session has already gone. Live
  capture still checks window and destination before teardown.

Regression tests reproduced the original publication deletion and both retry
failures before the repairs. Follow-up review found the lost-response closure
case; its repair and tests passed a final independent review with no further
blockers. The attachment owner and native journal remain separate owners of
completion and capture recovery. No transfer, App-scope, or reclamation work was
added.

The table's attachment owner commits local completion. It first makes the
existing row durable, then saves immutable bytes at the library/table/row
address, then records and flushes the completion cell. Reads inspect local
bytes and retain platform playback disposal. A failed byte write or row flush
cannot report saved audio. Completion rechecks row existence and the captured
store lifetime after I/O; it never creates a missing row.

Recorder integration is part of this checkpoint. Browser capture supplies
bytes to that owner. Native capture retains a separate session identity and
durable staging descriptor naming its original library, generation, table,
and row. Native publication and row completion need acknowledgment so a crash
between them retains recoverable evidence. Ordinary closure and cancellation
must remain distinct from confirmed generation retirement.

The affected consumers are App recorder composition and both recorder
adapters, their capture fixtures, and Whispering's recording creation,
playback, save-file, and transcription inputs. Existing blob-ID readers stay
until replacement consumers pass; no production migration is included.
Account transfer, App scopes, copying, concurrent microphones, and restore
execution remain subsequent work. This checkpoint does not claim automatic
account delivery before the library synchronizer exists.

Task-start evidence: the library-ownership foundation suite still reports
7 pass and 2 fail (initial-generation fetch 404 and socket refusal 403 rather
than 404). Existing generation and planning changes belong to concurrent work.
Native fixtures establish storage behavior only; host termination and actual
microphone/playback acceptance require separate runtime evidence.

The local checkpoint now has `field.attachment()`, synchronous null-first row
creation, asynchronous create-with-file, and row-owned `complete`, `read`,
`stat`, and disposable `source` operations. Whispering records into its existing
row and reads that row for playback, export, and inference. Legacy rows retain
their old reader; new attachments do not enter the legacy upload runner.

Runtime evidence on 2026-09-15: Chromium captured synthetic microphone input,
played and decoded the completed attachment with network access disabled, then
closed and reopened the Local App with identical bytes. The native Rust probe
killed a child process with SIGKILL after writing staged WAV audio, reopened its
exact library/row/session journal, published and decoded the audio, retried, and
acknowledged without deleting it. This establishes process-interruption recovery,
not physical microphone recovery, native WebView playback, or power-loss safety.
Browser capture has no durable journal across page termination: same-handle
save retry is implemented, but an old null cell never automatically adopts bytes.

Independent review retained the attachment owner and native journal boundaries.
It found four required repairs: reject foreign browser destinations before
microphone acquisition; retire native staging and journals without reclaiming
published bytes; reconcile journals proven obsolete by an opened generation;
and fence shared dictation feedback against older inference. These repairs and
their focused follow-up review are part of this checkpoint, not a new App or
restore implementation wave.

All four review findings are repaired. Follow-up review required one further
guard: only a strictly newer opened generation proves an older capture journal
obsolete. An older cached generation preserves a future journal. Equal,
unknown, unavailable, and failed-to-read generations do not authorize retirement.
The added preservation test passes. Native retirement never reclaims published
bytes; restored null cells still cannot adopt them. Older inference retains its
original row and delivery, but cannot change a newer capture's shared feedback.

Final focused verification, 2026-09-15:

| Scope | Result |
| --- | --- |
| Data attachment owner, legacy attachments, field declarations, browser and desktop recorder Bun suites | 163 pass, 0 fail, 439 assertions |
| App lifecycle, App recording composition, Bun byte adapter, host server Bun suites | 117 pass, 0 fail, 703 assertions |
| Browser/WebView byte adapters and attachment address Bun suites | 49 pass, 0 fail, 293 assertions |
| Whispering recording, closure, pipeline, transcription, row domain, query retry; six isolated Bun processes | 64 pass, 0 fail, 241 assertions |
| Native `cargo test --manifest-path apps/epicenter/src-tauri/Cargo.toml --lib --quiet` | 154 pass, 0 fail, 2 ignored helper/platform tests |
| App browser/host, Whispering browser/host, host UI, data DOM, blobs typechecks | Pass; Whispering has 0 warnings |
| Native `cargo check` and `export_types` | Pass; generated command bindings updated |
| `git diff --check` | Pass |
| Library-ownership foundation recheck | 7 pass, 2 fail: same failures as task start |
| Data `tsconfig.json` typecheck | 8 DOM-boundary errors in browser/evidence imports, reproduced before continuation edits; DOM leaf passes |
| Documentation hygiene script | 57 ADR dependent-list issues; continuation changes no ADRs |

Commit preparation also exported the staged index into an isolated directory,
installed its locked dependencies, and reran all 393 focused Bun tests
(1,676 assertions) plus both App typecheck leaves successfully. That snapshot
excludes the concurrent generation changes. Its foundation suite still has
7 pass and 2 fail: initial-generation fetch 404, and socket refusal 403 versus
the committed fixture's expected 409. The live concurrent fixture expects 404
instead. Neither foundation result is an attachment regression.

Reproduce the joint owner/recorder checkpoint from the repository root:

```sh
bun test packages/data/src/store/attachment.test.ts packages/data/src/store/store-attachments.test.ts packages/data/src/field/field.test.ts packages/app/src/recording/browser.test.ts packages/app/src/recording/desktop.test.ts
bun packages/app/scripts/browser-smoke.ts
```

Remaining acceptance: run physical microphone capture, host termination, restart,
and offline playback in the native WebView. Browser page-crash capture recovery
is unimplemented. Completed browser attachments do survive App close/reopen.
Automatic account attachment synchronization is unimplemented and the UI says
new audio remains on this device. Local storage does not disable explicitly
configured remote inference; the existing Local opener still has no account AI
gateway. This checkpoint does not add the proposed multi-library App scopes.

The continuation reran the Chromium offline journey: 245 bytes of Opus audio,
0.36 seconds decoded, 22 meter ticks, successful cancellation, and identical
bytes after Local close/reopen. The native suite reran the SIGKILL recovery
probe. `system_profiler SPAudioDataType` reports only Mac Studio Speakers and
no input device, so this machine cannot provide the physical microphone proof.
No power-loss or native WebView playback claim follows from the process probe.

Next bounded implementation slice: library-owned upload and download for completed
row attachments, with generation-fenced admission, restart/retry evidence, and
offline playback on a second device. Keep account copying and reclamation out.
Before calling native capture recovery accepted, close the hardware/WebView gap
above. The broader waves below remain in progress.

Rewritten 2026-09-13 backward from ADR-0393's eager attachment synchronization
and honest local reads. The outcome is a recording made offline on device A,
uploaded after reconnect, automatically downloaded on device B, then played
offline on B. Deletion and restore follow row lifetime without losing retained
audio. This is planned work; the existing tests below are historical evidence.

Each replacement follows build, switch callers, verify, then delete the old
path. A compile pass alone is not completion. Do not enable destructive
reclamation before wave 5's evidence.

1. **Build one locally complete row attachment.**
   - [ ] Keep this checkpoint independent of a cross-library copy workflow or
     destination picker. It supplies the attachment contract consumed by the
     app-hub and concurrent-capture plans; no intermediate blob-ID recorder API.
   - [ ] Replace separate identity with stable library/table/row addressing;
     preserve identity across backups and generations. Validate imported paths.
   - [ ] Rename the declaration to `field.attachment()`, at most one per
     table, and prevent application updates to the completion cell. Settle
     its encoding without using it as evidence of current file presence.
   - [ ] Route create-with-file and native recording through the same
     row-first destination. Persist completion and pending upload recoverably.
   - [ ] Provide local bytes and disposable local playback sources, with
     explicit unavailable results and no hidden network read.
   - [ ] Prove local-save failure, interruption at each completion boundary,
     delete during capture, and restoring an old null cell after completion.
     Implement host staged-capture recovery before promising host-crash recovery.

2. **Build library-owned transfer in both directions.**
   - [ ] Design captured generation admission and publication fencing with
     the transport, before restore integration. A transfer admitted before
     retirement but completed afterward needs a defined outcome; independent
     presigned requests do not establish this by themselves.
   - [ ] Keep platform adapters as one-shot I/O. Choose and verify transport
     against supported recording sizes, authentication, browser storage, and
     native streaming requirements.
   - [ ] Recover local pending uploads on open. Derive missing downloads
     from current rows; never enqueue downloaded bytes as new uploads.
   - [ ] Run bounded transfers after new work, open, and reconnect. Give
     recoverable failures scheduled backoff wake-ups; prove a GET that first
     returns not-found later succeeds without a new row event.
   - [ ] Expose observed local presence, progress, waiting, and failure;
     distinguish initial unknown presence from absence. Add device-local
     Pause downloads, Resume, Retry, and prioritization.
   - [ ] Prove lost PUT responses, identical retries, conflicting imports,
     offline restart, storage-full failure, account closure, and deletion
     during transfer. A 409/412 is not sufficient evidence of equal content.
   - [ ] Settle verification privately; do not add a public checksum API or
     assume object-store ETags always identify content.

3. **Switch Whispering and prove the user journey.**
   - [ ] Translate recording creation, playback, transcription, and save-file
     export to the attachment handle. Keep errors visible without blocking
     unrelated row edits or local playback.
   - [ ] Replace the Storage column and transfer buttons with ADR-0393's
     audio-cell states and a library transfer summary. No upload preference,
     automatic eviction, or “backed up” label derived from upload alone.
   - [ ] Native-browser/device evidence: record offline on A, reconnect and
     upload, open B and receive audio without pressing Play, disconnect B
     and play. Interrupt B before receipt and verify unavailable-offline UI.
   - [ ] Prove Pause preserves local bytes and does not pause uploads;
     prioritization does not create a second downloader.
   - [ ] Switch all callers off `uploadedAt`, `recordingAutoUpload`,
     `backup.kick()`, upload compensation, and manual copy-management
     workflows. Run affected typechecks and tests before deleting those paths.
     Keep platform source disposal and host streaming.

4. **Build folder-backed recovery with explicit attachment coverage.**
   - [ ] Render row files and attachment siblings with the same identity;
     refuse changed bytes at an existing row address. Preserve undeclared
     tables and define how nonconforming rows retain their attachments.
   - [ ] Build kept text copies and export/import. Report missing audio;
     explicitly distinguish a saved text copy from verified audio coverage.
   - [ ] Replace the Honeycrisp archive-based activation fixture with folder
     reconstruction, then switch recovery consumers and verify before deleting
     structural archives, old catalog/attempt machinery, and unused journals.
   - [ ] Build atomic safety-copy restore under ADR-0395, preserve position
     checks and post-commit retirement, then prove restored attachments
     download automatically and old null cells cannot be refilled differently.
   - [ ] Show selected-copy and safety-copy audio coverage independently.
     Save incomplete text copies with explicit coverage; include an omission
     report in partial exports. Never infer remote audio from row sync.
   - [ ] Implement the destructive confirmation and reconnect explanation.
     Prove a completed offline recording absent from the safety copy is
     discarded on confirmed retirement, including work authored after the
     remote restore. Ordinary close/network failure must preserve that work.
   - [ ] Fence old attachment requests as well as row queues before reconnect
     admission. Reuse matching local files for restored rows; no rescue inbox,
     automatic re-import, or blanket attachment-store wipe.
   - [ ] Race two restores and lose a response: reopen actual current state
     without claiming the selected request succeeded from retirement alone.

5. **Prove retention before enabling account reclamation.**
   - [ ] Choose an authority/publication protocol that protects live rows,
     kept copies, uploads/imports in flight, and interrupted restore.
     Neither backup-only enumeration nor a grace window proves this.
   - [ ] Exercise stale snapshot H followed by a new row/upload, arbitrary
     delay between row and byte publication, restore across generations,
     deleted rows with late uploads, lost responses, and crashes during sweep.
   - [ ] Prove a retained backup prevents deletion, and unreachable bytes
     are eventually reclaimed under the documented trigger. No one-day
     deletion guarantee follows from “daily copy on open.”
   - [ ] Keep physical deletion disabled until the protocol passes.
     Conservative storage retention is an interim state, not finished cleanup.

6. **Remove obsolete paths and reconcile current documentation.**
   - [ ] Verify migration of existing rows and objects before removing deployed
     ID-based routes/readers. No production migration is authorized by this doc.
   - [ ] Remove unused blob-ID minting/copy paths and remaining application
     reconciliation after replacement evidence passes.
   - [ ] Update package READMEs, route docs, and examples to actual exports.
     Do not describe proposed methods as already implemented.
   - [ ] Re-run affected checks and the full two-device journey. Delete this
     spec only after its recovery and retention obligations are complete.

### Historical execution decisions before ADR-0393 through ADR-0395

This checklist records the superseded archive/catalog design. It is not remaining
work; the current Implementation waves above own execution and proof obligations.

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

Rewritten 2026-09-12. Cases above the rule stand from the current-generation
work; cases below it are the three records.

| Case | Required result |
| --- | --- |
| Two first devices with empty caches | One current generation, not two imports |
| Accepted write during replacement preparation | Restore refused `conflict`; nothing kept, nothing replaced |
| Two concurrent restores | The second is refused `conflict`; one safety copy |
| Ten sequential restores | Fresh lineages; ten safety copies; no merge into a prior document |
| Old socket, queued push, partial chunk, or hibernated socket | No write accepted into the current generation |
| Cached device opens offline | Existing valid cache remains usable |
| Retirement with pending writes | All pending work discarded; no automatic recovery |
| Crash around invalidation/install | Prior valid cache before invalidation, absence after it, or a complete new baseline |
| Failed download or missing local cache | Ordinary retry; no empty remote creation or reload loop |
| Different-generation working-copy manifest | Push refuses; no reinterpretation as mass edits |
| A second `field.attachment()` on one table | `compileData` refuses |
| Row created with bytes | Locally recoverable completion and upload obligation; cell encoding follows ADR-0393; no remote durability implied |
| PUT to an existing row path | Bytes unchanged; identical retry verified, different content refused |
| Capture crash before `stop` | Row exists with a null cell; host `current()` recovers and `stop()` fills it |
| Row deleted | Row gone; active local work coordinated; account object retained while current rows, backups, or protected publication need it |
| Copy deleted | Copy gone; shared objects await proven safe reclamation |
| Pass after a copy is kept | No deletion until current-row, backup, and publication protection is proved; old snapshot plus new upload cannot lose live audio |
| Crash mid-pass | Next pass completes the same work |
| Eighth automatic copy | Oldest automatic copy deleted by the pass; manual and before-restore copies untouched |
| Backup of a library with hours of audio | Text saved without embedding audio; coverage separately checked and reported; missing audio does not refuse text preservation |
| Entry above 2 MiB | Refused with its path |
| Export | Zip holds `kv.json`, every row file, and a sibling for every row whose cell is not null; a row whose object is absent has no sibling |
| Import of that zip | Siblings put create-only; entries kept as a copy; importing twice changes no bytes |
| Import with a missing sibling | Row imports with its cell; shows as missing audio; restore invents nothing |
| Folder from an older build | Undeclared tables and unknown keys kept; a body with no codec refused at that file |
| Restore | Safety copy and replacement commit together; retained available audio reused; absent audio explicitly unavailable and scheduled for download |
| Old device has completed unuploaded recording | Confirmed retirement discards old work without rescue; the safety copy never claims to contain unseen work |
| Restored row has matching local audio | Reuse it across generation replacement; do not erase attachment storage with row cache |
| Incomplete selected copy and safety copy | Independent coverage displayed; warning names unsynchronized-work loss |
| Lost restore response, then retry | Moved expected position refuses retry; reopen actual current state without inferring which request won |
| Restore while the client's replica is behind the authority | `conflict`; a second attempt renders a safety copy containing the missed edit |
| Rollback inside the restore transaction | No kept copy, no generation change, sockets usable |
| Local library | No recovery object; `pull` writes the folder with siblings; `import` reads it back |
| R2 move of pre-existing objects | Every recording row's object reachable at its row path; rerunnable; old keys unread afterwards |

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

The lifetime design is settled. The recovery API and catalog rule recorded in ADR-0386 at the time were later replaced by ADR-0394 and ADR-0395. Archive metadata
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
