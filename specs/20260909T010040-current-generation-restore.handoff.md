# Continue with durable publication and restore retries

Continue in `/Users/braden/conductor/workspaces/epicenter/yamoussoukro`.
Read `AGENTS.md`, [ADR-0386](../docs/adr/0386-recovery-restores-only-verified-backups-and-owns-retry-identity.md),
[ADR-0379](../docs/adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md),
and the [execution spec](20260909T010040-current-generation-restore.md).
Start with Active execution path and Verified publication checkpoint. Earlier
dated checkpoints are evidence, not an alternative plan.

Implement the next bounded checkpoint: durable intent and exact-request retries.
Publication and the persistent catalog now work. The next owner must preserve
pending backup/import and restore attempts across page/process restart, resolve
committed outcomes before object reads, and never reconstruct fresh activation
bytes merely to retry. Finish with focused passing checks, independent design
review, a reviewable commit, and updated execution evidence.

## What now exists

`packages/data/src/recovery.ts` contains `createLibraryRecovery`, bound to one
application/data identity, stable authority, attachment reader, and archive store.
Its working operations are `backup()`, `import(file)`, `list()`, and
`download(backupId)`. There is no `restore()`, authenticated recovery transport,
package-barrel export, or Backups screen. The coordinator is unmounted.

`artifact/archive.ts` writes version 2 with separate `appId` and `dataId` and
source generation/head. Version 1 lacks identity and is explicitly refused.
Repository consumers were converted; there is no compatibility reader. The codec
retains unknown roots/values, settings, rich formatting, and referenced attachment
bytes/MIME types. Import validates the file but stores its exact bytes, including
whitespace. Capture time is not invented.

`CurrentAuthority.backups` composes `sync/backups.ts` over its private SQLite
handle. `_backup_library` pins the full stable library and application/data IDs.
`_backups` holds private pending reservations and published records outside the
replaceable generation log. A reservation binds ID, reason, whole-file digest,
length, and provenance. Publication writes immutable bytes, reads them back,
compares exact bytes and MIME, then atomically sets the authority's addition time.
Pending records cannot be listed or downloaded. Generation replacement preserves
the catalog. Matching replay returns the same record; changed requests conflict.

The coordinator owns semantic archive verification. The authority owns opaque
stored-object integrity and scope. Its private metadata-bearing publish request
is trusted infrastructure, not a ready-made public HTTP handler. Preserve that
distinction when mounting transport; do not run reconstruction in a Worker through
an injected callback and call that an opaque authority.

`packages/server/src/backup-storage.ts` composes the existing S3 signer. Objects
live at `<stable authority name>/backups/<id>`, outside generic
`<library prefix>/blobs/<id>` upload/delete routes. Its capability has no delete.
Archives embed attachment bytes, so ordinary attachment deletion cannot destroy
an existing recovery point. Provider/account deletion policies and storage limits
remain separate work. No cleanup or retention UI was added.

Caller-managed `saveArchive` was absorbed into publication.
`artifact/archive-storage.ts` now owns destination attachment installation with
immutable read-back and conflict refusal. Its earlier uncommitted work and tests
were reviewed and incorporated into this checkpoint.

## The next invariant

A failed public publication retains its ID and exact bytes only in the current
coordinator lifetime. Calling `backup()` again retries that capture despite later
accepted writes. Retrying import requires the same file. Another operation is
refused while that publication remains pending. A later deliberate backup/import
after success can create a new record.

Portable tests reopen SQLite and replay an externally retained private request.
That proves authority idempotency, not durable public-action recovery. Persist
publication intent and exact capture/file bytes before the first mutating request.
A reservation ID alone cannot recover a capture whose object was never uploaded.
Reconcile pending publication before starting another action after restart. Keep
the journal outside replica invalidation and scope it to the full
account/server/application/library identity.

For restore, reserve one unresolved attempt per library. Retain selected backup
ID/digest, one destination safety backup, the exact destination generation/head,
exact prepared activation bytes, private operation identity, and outcome.
`before-restore` already uses the common authority publication operation, but no
restore coordinator creates or associates that safety backup yet.

Query committed receipts before archive or prepared-object reads. Existing raw
`prepareActivation` requires bytes to recover a receipt; add a private receipt
query. Unknown outcomes stay pending. A definitive preparation failure must
atomically fence delayed activation before releasing the active slot. Activation
checks attempt state in the same transaction as its destination condition and
receipt. Completed backups remain available after failure.

Do not reconstruct again on activation retry: every reconstruction authors fresh
Yjs operation identities. A later deliberate restore of the same backup is a new
attempt. Source generation/head are provenance, never permission to overwrite
today's destination. Accepted intervening writes cause a conflict.

Authenticated recovery transport, the page-bound coordinator, Backups UI, and the
extended browser proof follow this durable-owner checkpoint. The existing
Honeycrisp journey already proves offline reopen and confirmed retirement:
fence writes, invalidate the replica, close producers, and reload the replacement.
It does not yet exercise production recovery or a durable pending-attempt journal.

## Evidence and boundaries

The checkpoint passes 64 focused tests across codec, installation, coordinator,
catalog, current authority/hub, S3 archive adapter, and generic blob routes.
Three Worker suites pass 13 tests. Server and Honeycrisp script programs typecheck.
Data's DOM leaf passes; its root passes with explicit DOM globals. The normal
data root retains the same eight browser-global diagnostics as task start.
The full Honeycrisp browser journey passes with the v2 fixture. Independent
review found no blocker; its test-isolation and stale-comment repairs were applied.
The isolated staged source also passed the 64-test suite and data/Server checks.
Documentation hygiene has 44 existing findings; this checkpoint adds none.

Run from the repository root:

```sh
bun test packages/data/src/artifact/archive.test.ts packages/data/src/artifact/archive-storage.test.ts packages/data/src/recovery.test.ts packages/data/src/sync/backups.test.ts packages/data/evidence/current-generation packages/server/src/backup-storage.test.ts packages/server/src/routes/blobs.test.ts packages/server/src/s3-blob-store.test.ts
bun x tsc --noEmit -p packages/data/tsconfig.json --lib esnext,dom,dom.iterable
bun x tsc --noEmit -p packages/data/tsconfig.dom.json
bun run --filter @epicenter/server typecheck
bun run --filter @epicenter/honeycrisp typecheck:scripts
bun run --filter @epicenter/server test:workers workers/current-retirement.test.ts workers/initial-generation.test.ts workers/e2e.test.ts
bun apps/honeycrisp/scripts/library.browser.ts
```

Filesystem reopen is not power-loss proof. The S3 test uses a local HTTP object
fixture and the real signer/adapter; it proves namespace and conditional-write
behavior, not hosted provider enforcement or indefinite retention. Archive JSON
still embeds numeric byte arrays, and conservative BlobId recognition can refuse
ordinary text mentioning unavailable objects. Transport size limits remain open.

Preserve unrelated work in this active checkout. This checkpoint began at
`1cf91d8379`; inspect the subsequent focused commit before editing. Earlier
journey commits are `8cea9aa6c6`, `10f4c3456d`, and `d81743d016`.
No deployment or existing-data migration was requested. Historical independently
writable libraries still need a rollout decision; do not adopt the maximum
generation or delete real libraries to make the new path pass.

Keep the settled contract: one writable current generation, automatic folding,
immutable backup history, and full document reload after retirement. No generation
picker, stranded-outbox recovery, predecessor browsing, or automatic resets.
Local-only recovery remains separate. Keep the spec In Progress until the full
recovery outcome is integrated and verified. Consult Claude only when requested.
