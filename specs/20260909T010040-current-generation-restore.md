# Remove unused backup orchestration; retain live library safeguards

**Status:** In Progress
**Updated:** 2026-09-17

Remove unused backup orchestration without changing working-copy recovery or
live library safeguards.

## Current state and target

The product decisions are settled:
[ADR-0379](../docs/adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md),
[ADR-0393](../docs/adr/0393-rows-refer-to-blobs-without-owning-their-lifetime.md),
[ADR-0394](../docs/adr/0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md),
and [ADR-0395](../docs/adr/0395-restore-is-one-request-that-carries-its-own-safety-copy.md).
This plan tracks remaining implementation work, not a backup-product proposal.

Current code contains a mounted current-library authority, a working-copy path,
an unmounted backup coordinator, and structural archives used by a retirement
fixture. Restore-attempt schema creation also runs in the mounted authority.
These are different dependencies, not one removable directory.

The target keeps independent local blobs and explicit remote hosting.
Materialization contains Markdown, settings, and the checkout manifest, with
blob IDs and URLs as ordinary values. No blob payload is copied or fetched.
Recovery applies selected old content through ordinary Push against a current
manifest. There is no backup catalog, retention service, destructive restore
endpoint, or new recovery UI in this work.

Done means the unused backup family has no callers or exposed authority methods,
the retirement fixture no longer needs structural archives, and startup,
offline-cache, admission, retirement, and checkout evidence still passes.
Documentation must distinguish implemented paths from product contracts.
This documentation pass records the audit; it does not perform runtime deletion.

## Caller audit, 2026-09-17

Paths below are repository-relative. Recheck callers before editing because
other work is active in this checkout.

| Component | Observed use | Disposition |
| --- | --- | --- |
| `packages/data/src/recovery.ts` | Coordinator instantiated only in its tests; no package export or mounted transport | Remove with coordinator-only tests |
| `packages/data/src/recovery-journal.ts`, `store/idb-journal.ts`, and `recovery-journal.test-support.ts` | Backup/restore intent storage; coordinator types and tests, no app mounting | Remove with journal-only tests |
| `packages/data/src/sync/backups.ts` | Catalog exposed through authority methods; consumed by the coordinator, attempts, and tests | Remove catalog methods and private helpers with their callers |
| `packages/data/src/sync/attempts.ts` | Authority construction applies its schema; activation reads and updates attempts | Remove only through a coordinated authority edit, not an isolated file deletion |
| `packages/server/src/backup-storage.ts` | Backup-specific S3 wrapper, instantiated only by its test | Remove wrapper and its test; retain shared S3 hosting implementation |
| `packages/data/src/artifact/archive.ts` | Structural v3 JSON archive; coordinator, tests, and Honeycrisp retirement script | Replace fixture dependency before removing |
| `packages/data/src/artifact/archive-storage.ts` | Local-byte installation and verification for archive/recovery tests and coordinator | Remove after coordinator and fixture dependencies are gone |
| `packages/data/src/artifact/import.ts` | Whole-document Markdown reader exported as `readArtifact`; package and app test callers found | Separate caller decision; not ordinary Push and not the structural archive |
| `packages/data/src/artifact/checkout.ts` and its rendering/format dependencies | Live Honeycrisp folder workflow and host filesystem implementation | Retain |

The sync barrel exports `CurrentAuthority` and `openCurrentAuthority`, so
backup and attempt methods are indirectly exposed even without direct module
exports. `openCurrentAuthority` creates `_restore_receipts` and applies the
attempt schema. The absence of a recovery endpoint does not make this code
unreachable.

Conversely, `capture()` supplies the current authority baseline during ordinary
initialization/download. Its name does not make it a backup-only method.
`prepareActivation()` has test/evidence and fixture callers; preserve the
retirement scenario while separating it from backup attempts. Determine whether
activation receipts are necessary to retain its retry guarantees before removing
them. This plan does not authorize dropping persisted user databases or tables.

## Working-copy behavior and remaining gaps

Pull writes app data into the working folder. Push reads intentional folder
changes relative to the current manifest, previews them, rechecks before applying,
and reports partial success. A missing tracked Markdown file deletes its row on
approved Push. Trash is an ordinary application field. Neither deletes blobs.

To recover selected older content, Pull the current state first, retain the
current manifest, copy selected old content into that folder, and preview Push.
Missing rows receive fresh identities. There is no automatic reference remapping.
Invalid content stays available to edit and retry; no new restore wizard is
required. Do not install an old manifest as the current baseline.

The host-backed Honeycrisp path already uses
`apps/honeycrisp/src/lib/platform/folder.epicenter-host.ts`,
`PullToFolder.svelte`, `SendFolderEdits.svelte`, and
`apps/epicenter/src/checkout.ts`. Its browser-only folder leaf is unavailable.
Do not describe this as an enabled workflow in every app or platform.

Whispering's `recordings-markdown-export.ts` creates a one-way ZIP from current
recording rows. It includes neither a checkout manifest nor settings or audio.
It is not a ZIP of an existing working folder and is not a round-trip recovery
implementation. Keep that distinction in documentation; any expansion to
working-copy support is separate application work, not a reason to retain
structural archives.

The chosen saved-folder contract copies the actual working folder, including
unpushed edits. It promises neither exact CRDT history nor recoverable audio.
A retained remote URL may stop resolving; a retained local ID may have no bytes
on another device. Those are independent lifetimes, not import failures to repair
by silently fetching or deleting objects.

## Ordered implementation work

1. Record fresh caller counts and baseline results for the tests below. Preserve
   unrelated worktree edits. Separate dedicated backup tests from mixed authority
   and retirement coverage.
2. Replace the retirement script's archive round-trip with independently created
   valid replacement state. Preserve the fresh-lineage scenario, activation retry,
   stale-device fence, cache invalidation, and reload assertions. Reusing the old
   lineage's captured bytes is not an equivalent fixture.
3. Remove backup coordination, journals, catalog and backup-specific S3 wrapper,
   their authority methods, and dedicated tests. Remove attempt reads/writes and
   schema setup coherently from the authority. Keep the authority's baseline
   capture and ordinary synchronization operations.
4. Once no callers remain, remove structural archive/installation code and tests
   that only prove the refused format. Audit `readArtifact` separately: its
   Markdown format and public export are not the structural JSON archive.
5. Re-run preserved evidence, search for removed exports and imports, and update
   README/ADR implementation notes to describe what actually remains. Delete this
   spec once implementation is complete.

Do not mount recovery transport, replace generation identities with a constant,
remove explicit remote hosting, or delete persisted data to make cleanup pass.
The historical generation ledger still refuses implicit migration over existing
data. Changing that refusal needs its own migration decision.

## Evidence and preserved tests

Retain and run:

- `packages/data/src/artifact/checkout.test.ts`: baseline, preview/recheck,
  deletion, validation, partial success, and recovered-row behavior.
- `packages/data/src/store/current-open.test.ts` and
  `packages/data/src/store/store-retirement.test.ts`: cache-first opening and
  retirement fences.
- `packages/data/evidence/current-generation/authority.test.ts` and
  `hub.test.ts`: authority and generation admission.
- `packages/server/workers/current-retirement.test.ts`: deployed-runtime
  retirement evidence.
- `apps/honeycrisp/scripts/library-retirement.ts` with its fixture worker:
  cross-device retirement, invalidation, and ordinary reload.
- `packages/server/evidence/library-ownership/foundation.test.ts`: startup and
  ownership integration. Record actual baseline failures rather than deleting
  them with backup tests.

Use the package scripts for worker and browser/native fixtures; they are not all
plain Bun unit tests. No old pass count proves a changed implementation correct.

Preserve recording guarantees during adjacent work: successful Stop saves the
local blob before row creation; failed row creation leaves an enumerable blob.
The session retains its original destination and inference lifetime. Local
playback precedes an explicitly stored remote URL fallback. None of these
requires a transfer queue or backup journal.

Historical checkpoints, probes, acceptance limitations, and adversarial findings
remain in Git at `db70c7833b`. For example:

```sh
git show db70c7833b:specs/20260909T010040-current-generation-restore.md
git show db70c7833b:specs/20260909T010040-current-generation-restore.handoff.md
git show db70c7833b:specs/20260916T023255-refuse-media-sync-and-backups.md
```

Those records include superseded automatic-transfer experiments and bounded
physical-capture evidence. They do not direct further implementation or prove
Windows durability, power-loss recovery, real-provider enforcement, or current
replacement behavior.
