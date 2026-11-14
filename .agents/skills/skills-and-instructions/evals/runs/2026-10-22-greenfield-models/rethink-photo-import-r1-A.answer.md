# Rethinking the photo-import API

## What this is for

> **People should be able to point the app at their photos and trust it. Every distinct original ends up in the library exactly once and stays there, along with everything the app learned about where it came from. Closing the app, unplugging a drive or changing their mind never costs them work. When something goes wrong, the app names the item, says what happened and offers a next step.**

The current proposal treats an import as a session that moves through statuses. I think that is the main mistake. An import of 80,000 items is never in one state, and copying, deduplication, provenance and previews have different lifetimes. The model below separates them according to what each fact is about.

## The model: five records with different lifetimes

| Record | What it records | Lifetime |
|---|---|---|
| **Content** | One distinct byte sequence, keyed by its SHA-256 hash | Permanent and immutable. It is stored once. |
| **Sighting** | "Source S, at locator L, named N, held content H when observed at time T," plus the raw external metadata exactly as found | Permanent. One piece of content can have many sightings. |
| **Import** | The person's decisions: what they selected, plus whether the import is active, paused or cancelled | Durable. Only the person changes it. |
| **Source / Access** | Source: a durable identity, such as a device serial, a volume UUID plus a marker, or an archive fingerprint. Access: whether the app can read it right now. | The identity is permanent. Access is volatile and can be obtained again. |
| **Derivation** | Previews and parsed metadata, keyed by (content, kind, parser version) | Can always be recomputed. Its failures belong to the content, not to the import. |

Deduplication is not a relation like `duplicateOf`. It is identity: equal bytes have the same key, so there is one Content with two Sightings. If the same filename refers to different bytes, the result is two Contents, each with its own Sighting, and both observations are kept. Metadata stored inside the file is preserved because the original bytes are preserved. Metadata outside the file is stored raw on the Sighting, whether or not the current parser understands it. Examples are Takeout JSON sidecars, phone favorites and filesystem times.

```ts
type Source = { id: SourceId; kind: 'device' | 'folder' | 'archive'; label: string; fingerprint: Fingerprint };
type Access = { sourceId: SourceId; state: 'available' | 'needs-permission' | 'disconnected' | 'mismatch' };

type Import = { id: ImportId; sourceId: SourceId; selection: Selection; decision: 'active' | 'paused' | 'cancelled' };

type ImportItem = {
  importId: ImportId;
  locator: Locator;                       // source-relative; never an OS path
  resolution:
    | { kind: 'pending'; attempts: number }
    | { kind: 'preserved'; content: ContentHash; sighting: SightingId; alreadyHad: boolean }
    | { kind: 'withdrawn' }               // the person cancelled it before preservation
    | { kind: 'problem'; problem: ProblemId };
};

type Sighting = { id: SightingId; content: ContentHash; sourceId: SourceId; locator: Locator;
                  name: string; observedAt: Instant; raw: RawAttachment[] };   // bytes plus media type, never discarded
type Derivation = { content: ContentHash; kind: 'preview' | 'metadata'; version: number;
                    result: { ok: true; ref: DerivedRef } | { ok: false; problem: ProblemId } };
type Problem = { id: ProblemId; subject: ItemRef | ContentHash; code: string; detail: string;
                 actions: Array<'retry' | 'reconnect' | 'skip' | 'export-original'> };
```

**One atomic step makes something "preserved":**

1. Stream the source into a temporary file in the vault, hashing as it goes.
2. Call `fsync`.
3. Rename the file to its content-addressed path, or discard it if that content already exists.
4. In **one database transaction**, upsert the Content, insert the Sighting and set the item's resolution.

Either an item is preserved and survives a crash, or it is still pending.

## How a caller uses it

```ts
const imp = await library.imports.start({ source, selection });   // returns once the decision is durable
library.imports.pause(imp.id); library.imports.resume(imp.id);
library.imports.cancel(imp.id);                                    // withdraws pending items; never deletes
library.imports.retry(imp.id, { include: ['problems', 'withdrawn'] });
await library.sources.reconnect(source.id, await pickAgain());     // checks the fingerprint, then restores Access

// Screens are queries over the same database. Nothing calls back into a manager.
library.imports.summary(imp.id).subscribe(render);   // { selected, preserved, alreadyHad, pending, withdrawn, problems, blockedOn? }
library.assets.query({ order: 'captured' });         // contents with at least one sighting; usable once preserved
library.sources.needingAttention();                  // sources with pending work and Access ≠ available
library.problems.list({ importId: imp.id });
```

A background worker claims pending items from active imports whose source is available. A separate worker claims Contents that have no derivation at the current version. Both are idempotent. Neither needs to know whether any screen is open.

## The sequences

Example data: an iPhone with 2,000 items, then a Google Takeout archive with 80,000 items that overlaps the iPhone.

**1. Partial success.** 1,400 phone items are preserved. They appear in the library grid immediately, with preview placeholders where previews aren't ready yet. Two items become problems: "File no longer on iPhone" and "Read failed at 410 MB." The progress screen says:
> *iPhone — 1,400 of 2,000 in your library · 598 left · 2 problems [Review]*

**2. Restart with the source missing.** The app quits halfway through copying a video. On startup, reconciliation deletes temporary files. A content-addressed file that has no committed row is kept as unreferenced content. The next matching sighting reuses it, and it is garbage-collected after a grace period. The phone is unplugged, so its Access is `disconnected`. The import is still `active`, but it is blocked:
> *Waiting for iPhone — connect it to continue (598 left). The 1,400 already imported are available.*

A browser folder handle reports `needs-permission`. The reconnection prompt's button calls `requestPermission`, which requires a user gesture. If the person picks a different folder, the fingerprint doesn't match. The app reports `mismatch` and offers to import the folder as a new source, rather than silently treating it as the original.

**3. Overlapping reselection.** The person imports the Takeout archive. `IMG_1234(1).HEIC` hashes to the same content as the phone's `IMG_1234.HEIC`. That item resolves as `preserved` with `alreadyHad: true`, and the app adds a Sighting carrying the raw sidecar JSON. A different `IMG_0001.JPG` with different bytes becomes new content, and the asset's diagnostics list both names. The summary says:
> *9,100 were already in your library — added their Takeout details.*

**4. Preview fails after a successful copy.** A `.CR3` file from a new camera is preserved. Preview derivation v7 fails. The problem is attached to the **Content**, not to the import. The library tile reads *"Original saved · preview unavailable."* The diagnostics show the decoder error and the raw metadata, and "Export original" works. The import counts this item as preserved. When decoder v8 ships, the derivation runs again and the problem clears.

**5. Cancel, then retry.** The person cancels the Takeout import at 50,000 of 80,000. The decision is recorded. Pending items become `withdrawn`. Any copy in progress is aborted and its temporary file discarded. Nothing preserved is touched. The screen says:
> *Cancelled — 50,000 kept · 30,000 not imported [Import remaining]*

"Import remaining" calls `retry(..., { include: ['withdrawn'] })`. Suppose the archive has since been moved. Its Access is then `disconnected`. The person picks it again, the fingerprint is verified and work continues. Problem items retry on the same path, and their attempt count increases.

## What completion promises

> **An import is finished when every selected item has a final answer:**
> - **preserved**: its exact bytes are durably in the library, verified by hash, with this source's sighting recorded;
> - **withdrawn** by the person;
> - **a listed problem** with an available action.

The promise does **not** cover previews or parsed metadata. Those are library properties with their own problem reports, so a failed preview can never be read as a failed copy. "Finished with 3 problems" is a normal state, distinct from failure. The whole import never "fails."

## What belongs together, and what disappears

- **AssetStore and DuplicateIndex merge into the vault.** The bytes and the record that they exist must change in one transaction. The hash key is the deduplication index.
- **ImportSessionStore, ManifestStore and CopyQueue merge into the import journal.** The person's decision and the resolution of each item are one record. A "queue" is just a query: pending items in active imports with available sources.
- **PreviewQueue and the interpretation side of MetadataStore merge into derivations.** They are keyed by content and version, so upgrading a parser re-runs them automatically.
- **SourceRegistry splits into identity and access.** This replaces the assumption that a path is a credential.
- **ImportManager and completion callbacks are removed.** Workers commit facts and screens read them, so no in-memory coordinator can lose state.
- **Removed fields:** `status`, `copyStatus`/`decodeStatus` on entries, `destinationPath` (derived from the hash), `duplicateOf`, `sourcePath`, `manifestId`.

**New work** and the guarantee that justifies each piece:

| New work | Guarantee it supports |
|---|---|
| Crash-safe commit order | Completed work survives a restart |
| Startup reconciliation | Nothing half-written is shown or leaked |
| Source fingerprinting | A different drive is never mistaken for the original |
| Raw attachments on sightings | Provenance survives today's parser |
| First-class Problems with actions | Every problem is visible and has a next step |

## Proposals that touch your requirements (labeled)

- **Proposal A: a fast path for re-sighting.** Reselecting overlapping sets means reading hundreds of gigabytes again. When a sighting already exists with the same (verified source, locator, size, mtime, filesystem ID), the app could record a new sighting without hashing again, and offer a "Verify" pass. **Risk:** if a file is edited in place and keeps the same size and mtime, the new version would be missed. I'd use the fast path only for sources whose fingerprint is verified, and keep full hashing as the default for archives.
- **Proposal B: an explicit "Cancel and remove what this import added."** This keeps the rule against *silent* deletion. It would remove only contents whose only sightings come from this import, after confirmation. Plain cancel never deletes.

## Working backward

1. Build the vault and its commit protocol. Prove it with kill-during-write tests.
2. Build Source/Access plus adapters for folder handles, the device and archives. Prove reconnection and mismatch handling.
3. Build the journal and workers. Run the five sequences above as end-to-end tests at 80,000-item scale.
4. Build derivations with versioning.
5. Build the screens as subscriptions.

Evidence that the design works:
- Fault injection at every commit step.
- A property test showing that a Content's bytes are preserved for every recorded sighting and that the same content is never stored twice.
- A check that the grid shows preserved items before any derivation finishes.

## Open uncertainties

- **Phone APIs** (PTP/MTP, iOS ImageCapture) may not expose locators that stay stable across sessions. Without them, reconnection after restart can only match on name and size.
- **Files picked individually in a browser** (without a directory handle) can't be reopened after a restart. The person has to pick them again, and the app would match the new picks to pending items by name, size and `lastModified`.
- **Takeout splits sidecars across several archive parts.** A sighting's raw attachments may arrive later than its media file, so attachments need to be able to accumulate over time.
- **Resuming very large copies** would require checkpointing the hash state partway through a file. Not every library supports that, so the first version may simply restart those copies.
- **Platform:** it's not stated whether this is a desktop app or a browser app, and that affects how the background worker is hosted.

No code exists in the repository to check this against. Everything above is a proposal, not a description of verified behavior.
