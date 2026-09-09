# Continue the current-generation recovery implementation

Continue in `/Users/braden/conductor/workspaces/epicenter/yamoussoukro`.
Read `AGENTS.md`, [ADR-0379](../docs/adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md),
[ADR-0386](../docs/adr/0386-recovery-restores-only-verified-backups-and-owns-retry-identity.md),
and the [execution spec](20260909T010040-current-generation-restore.md).
Start with Active execution path and Two-device journey checkpoint. Dated
checkpoints preserve earlier evidence; they do not override the active path.

Implement the next bounded checkpoint: verified backup publication and a
persistent library catalog. Manual and imported backups must share immutable
storage, read-back verification, and publication under the stable library
authority. Preserve imported bytes exactly. Finish with focused tests, independent
design review, updated execution evidence, and a reviewable commit.

The larger destination is one library-bound recovery owner with `backup()`,
`import(file)`, `list()`, `download(backupId)`, and `restore(backupId)`. These methods
do not exist yet. Add operations as their guarantees become real. Every restore
will select a published backup; recovery will own the destination safety backup,
private attempt identity, exact activation bytes, and restart reconciliation.
Callers never manufacture a restore ID.

## What now works

One stable library authority is mounted in the shared server. It owns the current
numeric generation, transaction-local log SQL, request-bound activation receipts,
and one current hub. The same transaction boundary checks generation admission
and accepted writes. Socket attachments preserve their admitted generation
through hibernation. Old sockets and partial submissions cannot write into a
replacement, even after retired bytes are gone.

Browser App startup uses one stable IndexedDB address with an optional generation
header. A valid cache opens offline. An absent header triggers a current download.
The `@epicenter/sync/current-download` envelope carries the frozen snapshot and
complete accepted tail through one head. The browser checks framing and unresolved
Yjs dependencies, folds the captured state, and installs its header and baseline
atomically. The authority treats the update bytes as opaque.

Confirmed retirement stops the sender, synchronously fences old persistence, and
invalidates the header and updates together. App departure stops producers,
awaits invalidation, closes resources, and reloads. `App.signal` exposes the
existing document lifetime; it means unusable, not cleanup completed. Honeycrisp's
title producer cancels its timer on abort while ordinary editor close still
flushes once. Failed invalidation retains the library claim and allows retry.

The real two-device journey passes in
`apps/honeycrisp/scripts/library.browser.ts`, with the scenario in
`library-retirement.ts` and a disposable Worker fixture in `library.worker.ts`.
The fixture inherits production HTTP/socket handling and activates through the
actual owning authority. Its private service binding adds no production route.

The browser proves an offline edit survives reopening, then confirmed retirement
discards it and reloads the replacement. It also proves immediate retirement of
an idle connected peer, zero old outbox uploads on stale reconnection, real editor
cleanup with a delayed callback, claim retention during paused/failed native
invalidation, UI retry, and absent-cache bootstrap retry after a failed download.
Replacement contents and an accepted post-replacement edit appear while all
new-generation socket frames are withheld.

## Evidence boundaries

The fixture establishes retirement and adoption, not the completed recovery
operation. Its text-note archive is saved and read back before fresh reconstruction.
It does not publish a fresh safety backup for every activation or exercise
attachments. Its receipt retry retains the same request in the live process;
it does not prove a durable pending-attempt journal across process restart.
Native application proof is Chromium. Existing cache-only evidence separately
covers 27 checks each in Chromium and WebKit.

If replacement occurs during a download, connection admission rejects the now-old
generation before uploading. If App closure occurs during acquisition, the claim
remains held and readiness/hydration are refused, but the response may still
install a cache before cleanup. Do not claim a stronger no-install-after-abort
guarantee without implementing and testing it.

The structural codec is `packages/data/src/artifact/archive.ts`.
It preserves visible roots, nested types, formatting, unknown values, settings,
and referenced blob bytes/MIME types, then verifies a fresh lineage.
`archive-storage.ts` verifies immutable backup read-back and destination blob
installation. They remain checkpoints without production recovery callers.
Filesystem reopen tests do not establish power-loss durability or retention.
Version 1 lacks application/data identity and recognizes BlobIds conservatively,
including ordinary text; missing referenced bytes refuse capture.

## Next implementation

Begin with wave 1 below. Its acceptance proof must cover interrupted publication,
exact imported download, cross-library refusal, and protection from generic
deletion. Stop at that working checkpoint; waves 2 through 4 explain what follows.

1. Define archive identity/provenance and one verified publication path for
   manual, imported, and pre-restore backups. Preserve uploaded bytes. Publish
   catalog metadata under the stable library authority only after object
   read-back verification. Protect retained objects from generic deletion.
2. Build durable attempt reservation and reconciliation. Retain one safety backup,
   destination generation/head condition, exact prepared bytes, and receipt.
   Query committed receipts before reading archive storage. Finalize definitive
   preparation failure atomically with a fence against delayed activation before
   releasing the active slot. Unknown outcomes remain pending.
3. Mount authenticated recovery transport through that same authority owner and
   configured object storage. Bind the coordinator to the page's fixed library.
   An old archive's source position is provenance, never permission to replace
   today's destination. Accepted intervening writes cause a conflict.
4. Add the Backups screen and extend the browser proof to the real recovery
   operation, restart reconciliation, attachments, recorder cleanup, and
   obsolete/interrupted bootstrap. Preserve working-copy generation mismatch
   refusal.

Each reconstruction creates new Yjs operation identities. Retrying activation
must reuse retained bytes and the original destination condition, not reconstruct
again. A later deliberate restore of the same backup is a new attempt.

Keep the settled product contract: one writable current generation, automatic
folding for maintenance, immutable archives for recovery, and full document reload
after retirement. No generation picker, stranded-outbox recovery, writable
predecessor browsing, automatic resets, or old-page replacement download.

## Verification and workspace

The latest wire/browser-open/App/recording suite passed 62 tests. Three Honeycrisp
editor tests passed, including two regressions that fail against their saved
original implementation. Current-retirement, initial-generation, and e2e Worker
suites passed 13 tests. The converted TypeScript browser journey passes.
Honeycrisp's normal typecheck also checks its scripts and the separate Worker fixture. Sync, Server, App, both
Honeycrisp targets, and the data DOM leaf typecheck. Data's root program has eight
browser-global diagnostics reproduced identically against task-start source.
Commands and the independent review verdicts are in the execution spec.

The worktree has extensive concurrent changes. Compare task-owned files to the
recorded baseline; do not reset or absorb other work. This journey adds complete
current downloads, App.signal/title cancellation, the browser fixture/proof, and
the corresponding documentation. Earlier authority, cache, archive, and application
composition work has its own history. The user authorized focused commits for
this journey and requested this continuation. The implementation commits are `8cea9aa6c6`, `10f4c3456d`, and `d81743d016`.
The staged source also passed isolated tests, typechecks, and the full browser
journey. Check the latest commits before editing. `archive-storage.ts` and its
tests are earlier uncommitted checkpoint work: review their state before absorbing them into publication. No deployment
was requested.

Existing independently writable historical libraries require a separate rollout
decision. The mounted Personal path refuses implicit adoption. Do not choose a
maximum history or delete real libraries to make the new path pass. The test
configuration uses temporary storage and never touches existing device data.

Continue through working checkpoints and independent review. Consult Claude only
when explicitly requested. Keep the spec In Progress until the full recovery
outcome is implemented and verified; then update durable decisions and retire the
spent planning documents under repository conventions.
