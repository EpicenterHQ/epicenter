# Independent blobs and working-copy recovery: remaining implementation audit

**Date**: 2026-09-16
**Status**: Draft
**Owner**: Braden Wong
**Branch**: braden-w/app-schema-derive-export-import (design only; untracked, not committed)
**Origin**: Claude Fable 5.1 consult, 2026-09-16, with five adversarial subagent reviews and one Yjs probe. Nothing in the checkout was changed except adding this file.
**Reconsiders**: ADR-0379, ADR-0393, ADR-0394, ADR-0395, and the attachment and recovery waves in `specs/20260909T010040-current-generation-restore.md`

## Current scope, 2026-09-17

The blob design below is historical exploration. The implemented direction is
`app.blobs.local` plus explicit `app.blobs.remote` hosting, independent row
references, app-scoped local enumeration, and Stop that saves into that local
store. ADR-0349, ADR-0366, ADR-0372, and ADR-0393 record that decision. New storage
starts fresh; historical files remain untouched. No automatic transfer queue,
attachment fields, or finished-file token remains in the active design.

The product decision is now recorded in ADR-0379, ADR-0394, and ADR-0395:
materialize documents and references only; recover selected old content through
the current working copy and ordinary Push. Explicit remote hosting remains.
The original exploration below is evidence, not an executable plan.

## Remaining audit

- Inventory the structural archive, backup catalog, recovery coordinator, and
  attempt journals by production, test, and fixture callers.
- Preserve current-library initialization, offline cache opening, admission,
  retirement fences, and synchronization evidence while deciding which unused
  recovery machinery can be removed.
- Do not replace generation identities with a constant or delete explicit
  remote hosting because the earlier exploration proposed it.
- Record verified removal work in ADR-0379, then retire this audit spec.
  No backup browser, retention feature, or restore endpoint is required.

## Historical exploration: withdrawn, not implementation instructions

## One sentence

A library synchronizes its rows and the fact of each row's file; the bytes live on the device that made them, a person carries them by folder, and there is no account-side byte store, backup, restore, or generation replacement.

## The direction

The person's view, Whispering:

> Ana records an interview on the train, offline. Stop saves the row and the WAV on the laptop. At home the transcript syncs. On her phone the recording is in the list with its transcript; where the player would be it says "audio is on your MacBook". Deleting a recording removes the row everywhere and the WAV on the laptop. Once a week the desktop writes her library to the Epicenter folder, Markdown beside WAV, and Time Machine keeps the folder's history. On a new laptop the transcripts arrive at sign-in; she opens the old folder and Whispering supplies each recording's audio to the row that already has it, because the row carries the file's hash. Someone else's folder imports as new recordings.

The developer's view:

```ts
const saved = await app.tables.recordings.create({ audio: file, ...fields });
const audio = app.tables.recordings.attachment(id);
await audio.read();        // bytes, or Unavailable { on: 'another device' }
await audio.source();      // playable URL, same rule; never a network request
await audio.supply(file);  // bytes for a row this device lacks; refused unless the hash matches
app.tables.recordings.delete(id);   // the row goes everywhere; bytes go where they were
```

The attachment cell holds `{ sha256, size, contentType }` as a declared value so the fact of the file synchronizes and round-trips the folder. `export()` writes the ADR-0337 folder with a sibling per file-owning row; `import(folder)` supplies bytes to rows that already exist and creates new rows for the rest. Nothing is enabled, scheduled, or configured.

The framework owns: row sync, local byte stores with their durability barriers, native capture and finished-file creation, playback sources, the folder codec with siblings, and `supply`. The application owns: destination at creation (ADR-0401), trash if it wants one (`deletedAt`, as Honeycrisp has), and any cross-device media it needs, by its own means (see Open decisions).

## What is refused, and what each refusal deletes

| Refused promise | What goes | Why it was refused |
| --- | --- | --- |
| A saved file reaches the account | `packages/data/src/store/attachment-sync.ts`, `packages/server/src/store-sync/attachment-transfer.ts`, `packages/server/src/s3-blob-store.ts`, `packages/data/src/sync/attachment-publications.ts`, `apps/epicenter/src-tauri/src/attachment_transfer.rs`, native transfer invokes in `packages/blobs/src/webview.ts` and `packages/app/src/epicenter-host.ts`, acknowledgment receipts and `originGeneration` in the browser and Bun stores, presence and transfer states, `AttachmentSyncStatus.svelte` and the audio-cell waiting states | Every byte reviewer found the same thing: with automatic delivery the hard families are not the transfer but the states around it (obligation derivation, admission, the 404 that cannot distinguish "not uploaded yet" from "gone", eviction of unacknowledged bytes) and the reclamation of bytes the server cannot see rows for |
| The server keeps backups | the unmounted recovery family (`packages/data/src/recovery.ts`, `recovery-journal.ts`, `store/idb-journal.ts`, `artifact/archive.ts`, `artifact/archive-storage.ts`, `sync/backups.ts`, `sync/attempts.ts`, `packages/server/src/backup-storage.ts`), kept copies, coverage reporting, safety copies | Kept copies exist to protect bytes across restore; without account bytes they protect nothing the folder does not |
| The library can be replaced | `prepareActivation`/`activate`, `_restore_receipts`, `_restore_attempts`, retirement forwarding in `packages/data/src/store/store.ts` and `packages/app/src/open.ts`, the `retired` departure phase, `apps/honeycrisp/scripts/library-retirement.ts`; the generation number stays as a constant in the address | A CRDT cannot un-apply an update, so replacement needs the whole retirement lifecycle, and its designed loss is the offline laptop's completed recording (ADR-0395). With no restore there is nothing to fence |

What every direction kept and this one keeps: cache-first startup and atomic baseline install in `store/browser.ts` and `store/current-cache.ts`, the sync core, `createStoreOverPort`, the local blob stores, native capture, `renderRow` and `readArtifact`, checkout.

Deletion candidates above are from inventory, not verified deletion plans. Re-run the inventory against the live tree before removing anything; the checkout carries other sessions' concurrent edits.

## Decision trace

Each articulation below was strong enough to build, and each was killed by a specific finding. Keep this so the next session does not rebuild one.

1. **The account is the archive** (ADR-0393/0394/0395/0379 as written). Killed for the everyday case, not the catastrophic one: its recovery table wins only "bad app version overwrote thousands of rows with no export", and pays for that with kept copies, coverage, the copies-aware reclamation protocol ADR-0394 itself calls unresolved, and the discard of the offline laptop's recording.

2. **One lineage, files follow rows, recovery is copy.** Automatic upload, on-demand download, trash, folder export, import creating new rows. Killed in part: reviewers showed the deletion dividend was under 600 of the attachment family's 5,700 lines (the generation coupling and the download scheduler), that cache-first startup plumbing is not restore code, and that an unreadable lineage still needs one replace-lineage rescue.

3. **Import re-creates rows at their exported IDs.** Probe (below) showed two devices importing the same export converge to one row, and differing exports coin-flip by client order. Killed anyway: once a purge has deleted the object, recovered audio must be re-uploaded from the export regardless, so preserving IDs saved nothing and reopened the chosen-ID door the store spends its one invariant keeping shut. Recovery is new copies, as Braden first suggested.

4. **A client-side reclamation sweep with a sequence fence.** Killed: to hold it needed an authority-ack gate on finalize (today's gate is local save only, `attachment-sync.ts:337`), seq bumps on the 204 identical-content path, a server-side reclaiming state to close a list-then-delete race, and an elected sweeper. That is ADR-0394's withdrawn sweep with a sequence number in place of a grace period.

5. **A date, not a file.** Server keeps daily opaque snapshots; the app renders the library as of a date read-only and brings records back as new copies; deleted audio released on a timer. Coherent and teachable, but it is the read-only predecessor browsing ADR-0379 refused, needs a read-only opener, a server-side object copy verb, and a first-run-sized download per browse. Braden's reaction: overengineered.

6. **Refuse.** This spec. Braden's reaction: "this makes sense".

Probe evidence, `@y/y` 14.0.0-rc.24, two `gc: true` documents:

| Case | Result |
| --- | --- |
| Both devices delete R, both re-mint R with identical content | one container, full content, converged |
| Both re-mint R with different content | one wins whole, by client order, not by age |
| Import writes a field another device is editing | the import's value wins even when it equals the old value |
| Re-mint on A while B still edits its stale copy | delete wins, then the re-minted content stands |
| Delete 1,000 rows and re-mint them at the same IDs | 2 structs and 5 bytes per row after fold; the payload syncs once more |

The repo's own `packages/data/evidence/invariants.test.ts` ("re-minting the type after the deletion arrived DOES bring the row back") is the underlying fact. Under this spec nothing re-mints, so the door stays shut.

Growth, for ten recordings a day over five years (reviewer estimate, not measured on a real library): live payload 40 to 80 MB; about 19 structs per recording, roughly 350k items, 150 to 350 MB resident on every device; tombstones about 2 structs per deleted row; writer IDs under 1% of payload. The dominant costs are live data and whole-body updates (`docs/benchmarks/yjs-root-rotation/checkout.md`); generations fix neither. When a real library needs it, the answer is a second library per app for archived rows, which is the same primitive, not a new one.

## Historical open decisions

These are Braden's to make. The consult's take follows each.

1. **Is "audio is on your MacBook" Whispering, or a gap?** Asked at the end of the consult; unanswered. The whole spec rests on yes. If no, the smallest addition is one more supplier behind the same `supply` verb: the account carries bytes and a device can supply from it. Add it when an app needs it, not before.

2. **Cross-device images by inverting control.** Braden's closing thought: let the developer turn a blob into a URL and store the string in the row. This was not discussed earlier in the consult; it is the shape ADR-0091 once described. The legacy routes `POST /api/blobs`, `GET /api/blobs/:blobId` (302) and `DELETE /api/blobs/:blobId` in `packages/server/src/routes/blobs.ts` (269 lines) already are "put bytes, get a URL". Consult's take: consistent with this spec. It makes the account a plain file host an application uses by choice, with no library ownership, no sync, and no reclamation beyond the application's own DELETE. Decide whether those routes are that primitive or a legacy to delete; do not keep both a library-owned attachment and a URL field on one row.

3. **Where the file evidence lives.** `!attachment` is a reserved row attribute the folder codec skips (`packages/data/src/store/document.ts:198`), so a re-imported row cannot verify a sibling today. This spec needs the evidence as a declared value of the attachment cell. Confirm that ADR-0393's "the cell contains the MIME type" becomes "the cell contains the content evidence".

4. **Folder cadence.** The desktop writing the folder weekly was invented. Today `pull` is a button in Honeycrisp on the host build only. Decide whether the host writes it on a schedule, and say plainly that browser users have text export only: a 5 GB zip cannot be built in a tab.

5. **Unreadable account library.** With no rescue verb, the procedure is erase the account library (ADR-0287's erasure) and re-seed from a device that opens, by hand. Accept that as an operator procedure or keep the fence for a rescue. The consult accepts it for a product with today's user count.

6. **Trash in Whispering.** `apps/whispering/src/lib/operations/delete-recordings.ts` deletes outright and says "Stored audio files are not erased". Under this spec the copy is wrong twice: local bytes are erased with the row, and nothing else exists. Whether Whispering wants `deletedAt` is its call; Honeycrisp already has it.

## Withdrawn ADR consequences

- ADR-0393: keep finished-file creation, one immutable file per row, the row as address, and local-only reads. Withdraw "the account holds every one", library-owned synchronization, and the transfer UI. Add `supply` and the evidence-bearing cell.
- ADR-0394 and ADR-0395: withdraw. There is no kept copy and no restore.
- ADR-0379: withdraw the destructive operation; keep the observation that folding is maintenance and reconstruction is not. The generation number becomes an address constant.
- ADR-0366, ADR-0392, ADR-0399, ADR-0401: unchanged. Local-to-account moves are ordinary creates; a copy carries bytes only if the destination device has them.
- ADR-0337: `push` gains "a new file becomes a new row" only if import is routed through push; otherwise `import` is the verb and push stays as is.
- ADR-0091 lineage: reopened only if decision 2 keeps the blob routes as a URL primitive.

ADR status changes need Braden's explicit authorization. This spec does not make them.

## Hazards

- The checkout is dirty with other sessions' generation and platform edits (`packages/server/src/store-sync/generations.ts`, `packages/sync/src/generations-route.ts`, many ADRs). Do not discard them. `bun test packages/server/evidence/library-ownership/foundation.test.ts` was 7 pass / 2 fail before this consult and was not rerun.
- Commit 09b1965e55 and the four attachment commits after it implement direction 1's delivery. Their passing suites are evidence of what that code does, not of anything here.
- Never `git add .`; this file is untracked and unstaged.
- Existing stored data: rows with `audioBlobId` and legacy blob routes need a verified disposition before any reader is removed. No production migration is authorized here.
