# Historical restore handoff and live-mechanism evidence

> **Historical handoff; do not execute its steps.** It records the withdrawn
> automatic-transfer and full-restore proposal. The current target is ordinary
> row-valued blob references, disposable local capture, document-only
> materialization, and recovery through the current working copy under
> ADR-0393/0394/0395. Keep the physical-capture and live-generation evidence
> below when auditing current callers.

> **Superseded on 2026-09-12 before this checkpoint was started.** The design
> this handoff continues was replaced by
> [ADR-0393](../docs/adr/0393-rows-refer-to-blobs-without-owning-their-lifetime.md),
> [ADR-0394](../docs/adr/0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md),
> and [ADR-0395](../docs/adr/0395-restore-is-one-request-that-carries-its-own-safety-copy.md),
> and ADR-0386 was deleted. Do not add `restore()` to `createLibraryRecovery`,
> do not mount the `attempts` namespace, and do not build transport for the
> catalog or the attempt journal. The text below is preserved as evidence of
> what exists and how it was verified, not as an implementation plan.

Continue in `/Users/braden/conductor/workspaces/epicenter/yamoussoukro`.
Read `AGENTS.md`,
[ADR-0379](../docs/adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md),
and the [execution spec](20260909T010040-current-generation-restore.md).
Start with Active execution path and Durable intent and retry checkpoint.
Earlier dated checkpoints are evidence, not an alternative plan.

Do not implement the former activation checkpoint, `restore()`, authenticated
recovery transport, catalog, or restore-attempt journal from this handoff.
Publication and physical-capture checks below remain historical evidence for the
separate live-mechanism audit.

## What now exists

`packages/data/src/recovery.ts` contains `createLibraryRecovery`, bound to one
application/data identity, stable authority, attachment reader, archive store,
and a durable journal. Its public operations are `backup()`, `import(file)`,
`list()`, and `download(backupId)`. There is no `restore()`, authenticated
recovery transport, package-barrel export, or Backups screen. The coordinator is
unmounted.

`recovery-journal.ts` holds one client-side intent at a time, with the exact
bytes rather than a reference to them, written before the first mutating
request. `recoveryJournalAddress` derives the slot from server, account,
application, data definition, and library together.
`store/idb-journal.ts` is the browser engine in its own IndexedDB database; a
test drives a real `openCurrentCache` install and discard against it. The header
follows the payload and carries its digest and length, so a torn pair reads as
absent and is cleared. `recovery-journal.test-support.ts` is the filesystem
storage the Bun tests build a new coordinator over.

A publication whose read-back failed is finished by a coordinator built from
nothing, after further writes were accepted: the original capture at the
original position, one record. A pending import is resumed only by the same
file. Either refuses the other by name while it is unresolved.

`sync/attempts.ts` owns the restore attempt under the same stable SQLite owner
as the catalog. One unresolved attempt per library is a partial unique index
over `status = 'pending'`. The safety backup id, destination position, and
prepared activation digest and object are set once and refuse a different value.
`pinLibrary`, extracted from `backups.ts`, means an attempt cannot be opened
against another library or application identity.

`fail` proves in one transaction that nothing committed, then writes the fence.
`prepareActivation().activate()` reads attempt status in the same transaction as
its destination comparison and receipt write, returns `fenced` for a finalized
failure, refuses an attempt that pinned no preparation or that pinned different
bytes or a different position, and resolves its own attempt on success. An
operation with no attempt row still activates raw, which is what the existing
test-only fixtures use. `authority.receipt(operation)` answers from the receipt
table alone, so an outcome is readable with archive storage unreachable.

The authority owns liveness. Every reconciliation asks `journalled.pending()`
first, so an attempt started elsewhere refuses a backup, an import, and a second
attempt here by name. `begin` reserves before writing its local reference. One
exclusion covers every mutating coordinator method. Two coordinators over one
journal address can still race a publication's slot: bind recovery to the page's
application and account lifetime and take a lock on the journal address when you
mount it.

The coordinator's `attempts` namespace is the unmounted durable owner:
`begin`, `safetyBackup`, `pin`, `activationBytes`, `fail`, `pending`,
`acknowledge`, `outcome`, `list`. Reading an outcome does not forget it; only
`acknowledge` releases the local reference, and only for an attempt that is no
longer pending. One safety backup per attempt survives an interrupted
publication and a finalized failure.

`packages/server/src/backup-storage.ts` composes the existing S3 signer. Objects
live at `<stable authority name>/backups/<id>`, outside generic
`<library prefix>/blobs/<id>` upload/delete routes. Its capability has no
delete. Provider and account deletion policies, storage limits, retention, and
cleanup remain separate work; the prepared activation object shares that
namespace and an interruption before it is pinned leaves it unreferenced.

## Caller audit that remains

The former activation, catalog, transport, safety-copy, and Backups-screen
proposal is withdrawn. Do not mount `restore()`, an attempts namespace, archive
installation, or full-restore UI from this handoff.

Use the preserved evidence below to audit live callers of generation admission,
cache invalidation, retirement fences, local publication, and exact-session
native cleanup. Verify that those mechanisms do not imply automatic blob sync,
row ownership, native crash recovery, or server restore. Recovery of readable
content belongs to the current working copy and ordinary Pull/Push previews.

## Evidence and boundaries

The checkpoint passes 84 focused tests across codec, destination installation,
recovery, the journal, the attempt journal, the catalog, current authority/hub,
the S3 archive adapter, and generic blob routes. Three Worker suites pass 13
tests. Server and Honeycrisp script programs typecheck. Data's DOM leaf passes;
its root passes with explicit DOM globals and retains the same eight
browser-global diagnostics as task start. The full Honeycrisp browser journey
passes. The whole data package passes 689 tests; `packages/server`'s own suite
has one failure present before this work. Documentation hygiene has 44 existing
findings; this checkpoint adds none. Existing non-null assertion warnings remain
in tests.

Independent design review found four blockers, all repaired here, each with a
regression test confirmed to fail against the code as reviewed. Run a review
against the mounted path too: the ones it caught were all places where an
invariant lived in a caller that did not exist yet.

Run from the repository root:

```sh
bun test packages/data/src/artifact/archive.test.ts packages/data/src/artifact/archive-storage.test.ts packages/data/src/recovery.test.ts packages/data/src/recovery-journal.test.ts packages/data/src/sync/attempts.test.ts packages/data/src/sync/backups.test.ts packages/data/evidence/current-generation packages/server/src/backup-storage.test.ts packages/server/src/routes/blobs.test.ts packages/server/src/s3-blob-store.test.ts
bun x tsc --noEmit -p packages/data/tsconfig.json --lib esnext,dom,dom.iterable
bun x tsc --noEmit -p packages/data/tsconfig.dom.json
bun run --filter @epicenter/server typecheck
bun run --filter @epicenter/honeycrisp typecheck:scripts
bun run --filter @epicenter/server test:workers workers/current-retirement.test.ts workers/initial-generation.test.ts workers/e2e.test.ts
bun apps/honeycrisp/scripts/library.browser.ts
```

Filesystem reopen is not power-loss proof, and neither is IndexedDB reopen. The
S3 test uses a local HTTP object fixture and the real signer/adapter; it proves
namespace and conditional-write behavior, not hosted provider enforcement or
indefinite retention. Archive JSON still embeds numeric byte arrays, and
conservative BlobId recognition can refuse ordinary text mentioning unavailable
objects. Transport size limits remain open.

Preserve unrelated work in this active checkout. This checkpoint began at
`b577421734`; inspect the subsequent focused commit before editing. Earlier
journey commits are `1cf91d8379`, `8cea9aa6c6`, `10f4c3456d`, and `d81743d016`.
No deployment or existing-data migration was requested. Historical independently
writable libraries still need a rollout decision; do not adopt the maximum
generation or delete real libraries to make the new path pass.

Keep the settled live contract: one writable current generation, folding,
cache invalidation, retirement fencing, and full document reload after confirmed
retirement. No generation picker, stranded-outbox recovery, predecessor
browsing, automatic resets, native crash recovery, or immutable backup-history
product is implied. Local readable-content recovery remains a current-working-
copy operation. Retire this handoff only after the caller audit is complete;
do not keep it In Progress for a deferred restore product. Consult Claude only
when requested.
