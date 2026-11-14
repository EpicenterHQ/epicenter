# Rethinking photo import: preserved bytes, recorded sightings, and the person's intent

## The idea

The current proposal treats an import as a session that moves through statuses. I think that is the wrong unit. A batch of 80,000 files never has one true status, because parts of it are copied, waiting, failed and cancelled at the same moment. Copying and decoding are different kinds of fact, and a duplicate is not a property of a file.

> **An import is a durable statement of what the person wants. The library is a durable record of which bytes it holds and where each copy was seen. Progress is whatever you get when you compare the two.**

That gives three kinds of record that are authoritative, plus one kind that can always be recomputed:

| Record | Meaning | Owner | Can it be lost? |
|---|---|---|---|
| **Content** | One stored copy of a byte sequence, keyed by its hash | Content store | Never through import or cancellation |
| **Sighting** | "Source S, at location L, named N, with raw metadata M, held bytes H, seen at T" | Library ledger, append-only | No |
| **Intent** | "Bring in these items from S", plus pause and withdraw decisions | Import ledger | No. It is recorded before any work starts |
| **Interpretation** | Preview, parsed metadata, decode problems for content H under parser version V | Interpreter | Yes. It can be rebuilt from Content |

An **asset**, meaning an item in the library, is content that has at least one sighting. Duplicates are handled by the structure itself. Equal bytes under different names become one content record with two sightings. The same filename holding different bytes produces two hashes, so two content records. Provenance lives on the sighting, so nothing about it is lost.

**Sources are identities, not paths.** A `Source` has a stable id and a fingerprint: a volume UUID, a device identifier, the archive's size plus a hash of its first and last parts, or a person's confirmation. **Access** is separate. It is a short-lived capability that may currently be granted, may need a new grant, or may be absent. A location (`locator`) is relative to the source. An operating-system path never acts as a credential.

## What callers write

```ts
const phone = await sources.adopt(deviceHandle);       // Source { id, kind, label }
const request = await imports.request({
  source: phone.id,
  items: picked.map((p) => p.locator),
  label: 'Phone — Oct 22',
});                                                    // durable before it returns

imports.pause(request.id);
imports.resume(request.id);
imports.withdraw(request.id);                          // cancel remaining; never removes assets
imports.retry(request.id, { problems: 'all' });
```

Screens subscribe to projections. They never drive the work:

```ts
type RequestProgress = {
  selected: number;
  preserved: number;          // durable, usable now
  alreadyInLibrary: number;   // subset of preserved: the bytes were already held
  waiting: { queued: number; paused: number; sourceUnavailable: number };
  problems: number;           // visible and retryable
  withdrawn: number;
  bytes: { read: number; total?: number };
  state: 'working' | 'waiting-for-person' | 'complete' | 'settled-with-problems' | 'withdrawn';
};

type ItemOutcome =
  | { kind: 'preserved'; contentId: Hash; sightingId: Id }
  | { kind: 'waiting'; reason: 'queued' | 'paused' | 'source-unavailable' }
  | { kind: 'problem'; problem: Problem }    // read error, vanished file, short read…
  | { kind: 'withdrawn' };
```

Each consumer reads a different projection:

- **Library grid:** `library.assets({ since })`. It knows nothing about imports, so an asset appears the moment its sighting commits. If the preview isn't ready it shows a placeholder, and if the preview failed it shows a "can't preview" tile.
- **Reconnection prompt:** `sources.needingAccess()`, meaning sources that have outstanding intent but no access.
- **Diagnostics:** `imports.items(requestId, { outcome: 'problem' })` covers copy problems. `library.interpretation(contentId)` covers decode problems. They are kept apart on purpose.
- **Background process:** one **reconciler** keeps finding intent items that have no matching sighting and does the work for them. When no screen is mounted, nothing changes.

## How the reconciler preserves one item

1. Take a short **lease** on (request, item), recorded in the ledger.
2. Stream the bytes from the source into a staging file, hashing as they arrive.
3. Flush the staging file to disk. If content H already exists, discard the staging file. Otherwise rename it atomically to `content/H`.
4. In one transaction, record a sighting with source, locator, name, size, capture timestamps and **raw source metadata as opaque bytes**. That includes phone-side capture records and sidecar JSON from archives.
5. Release the lease and queue interpretation of H if none exists for the current parser version.

A crash at any step is safe. An expired lease just means the item is redone, and every step can be repeated safely. Content with no sighting is collected after a grace period. **The moment of preservation is the sighting commit**, so "preserved" always means the bytes are on disk and their provenance is recorded.

## What completion promises

> **"Complete" means every selected item has its bytes, as read from the source, durably stored, with a sighting recording where it came from. Nothing is still waiting.**

Completion promises nothing about previews, parsed metadata or decodability. It also doesn't promise that the source still matches what it held later. If some items have problems or were withdrawn, the request is **settled-with-problems** or **withdrawn**, never "complete". Preview readiness is reported separately, per asset.

## One batch, followed through

**Partial success.** The person picks 80,000 phone items. After 20 minutes, 31,200 are preserved. Of those, 4,100 were already in the library from last month's archive import, so each gained a sighting and wrote no new bytes. 12 have read errors. The grid already shows the 31,200. The progress screen reads:

> **Phone — Oct 22**
> 31,200 of 80,000 in your library · 4,100 were already there
> 12 couldn't be read — Review
> [Pause] [Stop remaining]

**Restart with a missing source.** The person quits and unplugs the phone. On launch, the ledger still holds the intent. The reconciler finds no access for `phone.id`, so 48,788 items are **waiting: source-unavailable**, not failed. The progress screen shows "Waiting for *Braden's phone*". The reconnection prompt appears because a source has outstanding intent.

For a browser folder grant, the stored handle requires `requestPermission` from a user gesture, so the prompt offers **[Allow access again]**. If the person picks a folder instead, `sources.adopt` checks the fingerprint by sampling locators and sizes. If they don't match, the app asks: "This looks different from *Archive 2023*. Treat it as the same source?" It never silently re-points the source.

**Reselecting overlapping files.** Next week the person selects 50,000 phone items, 30,000 of them overlapping. That creates a new request. Overlapping items get hashed again, match existing content, and their sightings already exist (same source, location and hash), so they're done without any writes. The progress screen says "30,000 already in your library". Two files called `IMG_0042.HEIC` hold different bytes (the phone reused the name), so they become two assets, each with its own sighting. A video that matches an archive file under a different name gets a second sighting on the same asset. Its detail view lists both origins.

**Preview fails after a successful copy.** Content H is preserved, and decoding fails because a RAW variant isn't supported. The asset stays in the grid with a "can't preview" tile. You can still open the original, download it, or see its provenance. Diagnostics show "Decoder: unsupported RAW (parser v3)" on the asset, not on the import. **The import still counts this item as preserved.** When parser v4 ships, interpretation runs again on its own. Raw metadata was never thrown away, so it gets parsed then too.

**Cancel, then retry.** With 9,000 items left, the person presses **Stop remaining**. That records `withdraw` on the intent. Leases in flight either commit or are dropped; nothing half-done becomes visible. **Every preserved asset stays.** The dialog says: "61,000 items stay in your library. 9,000 won't be added." A separate, explicit action, **Remove items added by this import…**, exists in the library for people who want that. Later, **Retry** reopens the withdrawn and problem items. The reconciler skips everything that already has a sighting and picks up the rest, waiting for source access again if it needs to.

## What goes away, and what's new

**Goes away:**
- `ImportSession.status` and the paired `copyStatus` / `decodeStatus`. They become projections, plus interpretation records attached to content rather than to an import.
- `duplicateOf`, because the content address replaces it, and `DuplicateIndex`, because it is the content store's key.
- `destinationPath` (the hash is the address) and `sourcePath` (replaced by source id plus locator).
- Per-queue persisted progress, completion callbacks, and `ImportManager` as a coordinator. Truth lives in one ledger with one writer, and the reconciler only holds leases.
- `ManifestStore`, which becomes the intent record.

**Stays, with a sharper role:** `AssetStore` becomes Content plus Sightings. `MetadataStore` becomes Interpretation, which can always be rebuilt. `SourceRegistry` becomes Source identity plus Access.

**New, and the guarantee each one buys:**
- **Sighting:** different filenames and capture metadata are preserved for the same bytes.
- **Source fingerprint and verification:** a re-granted folder or a remounted drive is recognised safely, and without trusting paths.
- **Recorded intent and leases:** restarts and closing the screen lose neither finished work nor decisions.
- **Interpretation keyed by parser version:** a failed preview never implies the original failed, and raw metadata gets parsed once a parser understands it.
- **Problem records with retry:** problems are visible and can always be retried.
- **Orphan collection:** the cost of a crash-safe copy.
- **Explicit "remove items added by this import":** cancelling never deletes, but people can still undo deliberately.

## Proposals that challenge your stated requirements

1. **Skipping re-reads, labelled because it conflicts with "preserve every distinct byte sequence".** For a reselected source, items whose (locator, size, modification time) match an existing sighting could be skipped without reading. That would save hours on large videos. The risk is that bytes changed under identical metadata would be missed. **I recommend reading and hashing by default.** Reading is much cheaper than writing. The skip could be offered as an explicit "quick re-scan".
2. **One-off browser file selections can't be re-acquired after a restart.** Their remaining intent can only be satisfied by reselecting. Reselected files would be matched to waiting items by name, size and modification time, then confirmed by hash. This narrows what "continue after restart" can mean for that kind of source, and the UI should say so: "Select these files again to continue."

## Open questions to settle with prototypes

These are design claims, not tested behavior.

- **Phone access:** does the transport (PTP/MTP, or a platform photos API) expose stable item ids, or only names? That determines what a phone locator is and how strong its fingerprint can be.
- **Browser grants:** keeping and re-granting access with the File System Access API differs between Chromium, Safari and Firefox. Test each target browser.
- **Hashing speed:** check hashing throughput for large videos on removable USB drives.
- **Atomic renames:** confirm atomic rename and flush behavior on each filesystem the library might live on.
- **Raw metadata scope:** decide whether "raw source metadata" includes metadata embedded in the file. That is already preserved inside the content. Only source-side metadata needs storing on the sighting.
