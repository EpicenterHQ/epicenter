# Rethinking the photo-import API

## The organizing idea

> **An import is a decision the person made about a source. That decision is stored in a durable ledger. The library is a set of content-addressed originals, and each original remembers every place it was seen. Progress, duplicates and "done" are worked out from those facts. None of them is stored as a status.**

The current proposal's `ImportEntry` combines five things that live for different lengths of time:

- what the person chose;
- a file on a source;
- a byte sequence;
- whether it duplicates something;
- its preview.

`ImportSession.status` is a single linear enum, so it can't describe "paused, drive missing, 61k usable, 14 need attention." Separately, queues that save their own progress and also send callbacks to a manager create two records of the truth. After a crash those records can disagree.

## Model

```text
Source ── stable identity (volume UUID, device id, archive digest, label)
  └─ Grant ── temporary access (path, FileSystemHandle, phone session); can expire
Import ── what the person decided: source + selection + intent (run | pause | cancel)
  └─ Sighting ── locator, filename, size, mtime, sidecars, raw source metadata
       └─ outcome: pending | stored → Original | problem | withdrawn
Original ── sha256 → bytes, with embedded metadata kept exactly as found
  ├─ Renditions ── previews, parsed metadata (derived, can be regenerated)
  └─ Problems ── undecodable, preview failed, …
```

What belongs together, and why:

- **Original:** the bytes and their hash. It never changes. Files in the store are named by their hash, so the store also serves as the duplicate index.
- **Sighting:** everything that can differ between copies of the same bytes: filename, path, timestamps, Takeout sidecar JSON, phone album membership.
  - Equal bytes under two names become one Original with two Sightings.
  - The same name with different bytes becomes two Originals.
  - Raw source metadata is stored exactly as found, whether or not a parser understands it.
- **Import:** only what the person decided. Its one stored state is `intent`.
- **Rendition:** interpretation of an Original. It is kept separate so that parser upgrades can re-run it and a failure never touches the original.

A **library item is an Original with at least one Sighting.** It can be used as soon as its Original is committed.

## API

```ts
const library = await openLibrary(libraryDir);

// The platform supplies the grant: a picker, a mounted path, a phone session.
const source = await library.sources.attach(grant); // recognizes a known source or registers a new one

const imp = await library.imports.start({
  source,
  selection: { kind: 'tree', root: 'DCIM' }, // or { kind: 'locators', list }
});

library.imports.pause(imp.id);
library.imports.resume(imp.id);
library.imports.cancel(imp.id);                        // withdraws pending sightings only
library.imports.retry(imp.id, { include: ['problems', 'withdrawn'] });

// Every consumer is a live query over the ledger. There is no manager and no callbacks.
library.watch.import(imp.id, renderProgress);
library.watch.items({ order: 'captured' }, grid.update);
library.watch.sourcesNeedingAccess(showReconnectPrompt);
library.watch.problems({ importId: imp.id }, showDiagnostics);
```

```ts
type ImportView = {
  source: { label: string; access: 'connected' | 'needs-permission' | 'absent' };
  intent: 'run' | 'pause' | 'cancel';
  found: number; scanning: boolean;
  stored: number;      // new originals
  alreadyHad: number;  // bytes already in the library; provenance added
  waiting: number;     // queued, or blocked on access
  problems: number;
  withdrawn: number;
  bytes: { done: number; total: number | null };
  settled: boolean;
};
```

The background process runs the scan, copy and render workers.

- Each worker claims pending work from the ledger under a lease and writes its results in a transaction.
- Screens subscribe to queries, so they can mount and unmount freely.

**How a copy commits:**

1. Stream the file from the grant into a staging area, hashing in the same pass. Large videos are read only once.
2. `fsync` the staged file.
3. If the hash already exists, discard the staged file. Otherwise rename it into `originals/ab/cdef…`.
4. In one transaction, insert the Original if it is new, then link the Sighting to it.

A crash before step 4 leaves a staging file, which is swept up on the next start, and the sighting stays pending. A crash after step 4 loses nothing.

## UI interaction

Progress screen:

> **Pixel 8** — 52,310 of 80,000 · 4,102 already in library · 14 need attention
> [Pause] [Stop remaining] [Review problems]

The grid fills with stored items while the import continues. Items without a preview show a generic tile.

A diagnostics row:

> IMG_2231.HEIC — **Original saved ✓** · Preview: unsupported HEIF variant · [Retry preview] [Show file]

## The requested sequences

**1. Partial success.**
- Scanning streams sightings into the ledger, and copying starts before the scan finishes. At 30k stored, the grid shows 30k items.
- Three files hit I/O errors. Each sighting gets a retryable `source-read-failed` problem.
- Two files are stored but can't be decoded. Their originals exist, and each carries a rendition problem.
- `settled` stays false until every sighting reaches a final outcome.

**2. Restart with a missing source.**
- The ledger says the import's intent is `run`. The copier finds the drive absent, or the browser handle needing permission.
- Those sightings stay **pending, not failed**, and `access` becomes `absent` or `needs-permission`.
- The prompt reads: "Drive 'SANDISK' — 41,000 files waiting. Connect it or choose its folder."
- When the person reattaches, `sources.attach` checks identity:
  - on a mounted drive, by volume ID;
  - for a browser folder, by spot-checking that known locators exist with the same sizes.
- If the check fails, the folder is treated as a new source rather than silently misattributed. Work resumes from the pending sightings, and stored items are untouched.
- Files picked one by one in a browser can't be re-granted. Those sightings say "reselect these files," and reselection matches them by locator.

**3. Overlapping reselection.**
- Selecting DCIM again creates a new Import with new Sightings.
- A file whose bytes are already stored has its Sighting linked and counts as `alreadyHad`.
- A photo renamed on the phone adds a provenance entry to the existing item.
- A reused filename with new bytes becomes a new Original.
- The person sees one item per distinct byte sequence, with every name it was seen under.

**4. Preview failure after a successful copy.**
- The Original is committed, so the item is usable and appears with a generic tile.
- The problem is recorded on the Original's rendition, not on the import. The import counts the file as `stored`.
- "Retry preview" re-runs only the rendition. A later parser upgrade re-runs it automatically.

**5. Cancel, then retry.**
- `cancel` sets intent to `cancel` and marks the pending sightings `withdrawn`.
- An in-flight copy either commits completely or is discarded, because commits are atomic. Nothing already stored is deleted.
- `retry(…, { include: ['withdrawn'] })` makes those sightings pending again and sets intent back to `run`.
- Reselecting the source instead also works: everything already stored counts as `alreadyHad`.

## What completion promises

> **Settled:** every sighting the import selected has a final outcome:
> - stored, or already held, as a verified original with its provenance linked;
> - withdrawn by the person;
> - or carrying a recorded problem that needs them.
>
> **Previews and parsed metadata are not part of the promise.** "Done" means settled with zero problems.

"Stored" means the bytes were fsynced at a path named by their hash and the hash was checked. It also means the Sighting link committed. A restart can't undo any of this.

## What disappears

- **`ImportManager` and completion callbacks.** Workers record facts, and every view is derived from them.
- **Saved progress for each queue.** The pending set is a query, so `CopyQueue` and `PreviewQueue` become stateless workers.
- **`DuplicateIndex`.** Content addressing takes its place.
- **`ManifestStore`.** Sightings are the manifest.
- **`status`, `copyStatus`, `decodeStatus`, `duplicateOf`, `destinationPath`.** Each is either derived or no longer meaningful, since the destination is just the hash.
- **The three stores.** `ImportSessionStore`, `AssetStore` and `MetadataStore` become one ledger and one content store. `MetadataStore` splits:
  - raw metadata is kept permanently with the Original or Sighting;
  - interpretation becomes a rendition.

## What's new, and the user guarantee behind each

- **Source identity separate from Grant.** Paths aren't credentials and drives move, yet waiting work must survive both.
- **Sightings.** Provenance and deduplication stay correct without losing any filename.
- **Leases, a staging area, and a sweep on startup.** Restarts lose no finished work and leave no half-written originals.
- **Identity checks on reattach.** Choosing the wrong folder can't silently pollute provenance.
- **A separate lane for rendition problems.** A failed preview can never be mistaken for a failed copy.

Most of the complexity moves into one place: the commit transaction and the lease logic. That code needs careful crash testing.

## Proposals that challenge your requirements

**A. Quick match when reselecting.** I propose skipping the reread when the source identity, locator, size and mtime all match a Sighting that is already stored. This avoids hashing tens of gigabytes again.
- **Cost:** a file rewritten with the same size and mtime would be missed. That breaks "preserve every distinct byte sequence."
- **Recommendation:** trust the match by default for phones and folders, and offer an explicit "Verify everything" option that rehashes.
- If the guarantee has to hold strictly, reselection always rereads the bytes.

**B. An explicit undo.** Cancelling never deletes anything, as you required. I'd add a separate operation the person has to confirm: "Remove items only this import added," meaning items whose only Sightings belong to that import.

**C. Possibly organize the UI around sources rather than imports.** People may think "my phone" rather than "Tuesday's import." Imports would stay as the record of decisions while the main screen shows each source's state. I haven't settled this; real use would decide it.

## Open questions and evidence to request

- Platform limits I haven't confirmed:
  - whether browser `FileSystemDirectoryHandle`s can be persisted and given permission again on your target browsers;
  - how stable phone and MTP device identifiers are;
  - whether volume UUIDs are available on each OS.

  A small prototype for each would decide how strong the reattach check can be.
- Hashing and copy throughput for 80k files, including multi-GB videos, on your target hardware. This decides whether proposal A is necessary.
- Whether a library item should be exactly one per Original. I think it should, but albums or edits could challenge that.

**Sources:** `REQUEST.md`, `.agents/skills/rethink/SKILL.md` and its `greenfield`, `radical-options` and `clean-breaks` references, and `.agents/skills/dialectic/SKILL.md`. No implementation exists yet, so this is a design proposal; none of the behavior described has been verified.
