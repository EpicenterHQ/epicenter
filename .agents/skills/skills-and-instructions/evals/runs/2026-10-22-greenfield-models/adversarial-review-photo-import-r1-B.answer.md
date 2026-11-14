# Adversarial review: photo-import API

**Limits on this review.** There was one seat, and I did it myself. REQUEST.md shows the proposal next to the requirements, so I saw it before forming my own account. No implementation exists, so none of this rests on code. It rests on the stated requirements and on what I know of the platforms.

## Recommendation: imports as a durable request checked against content-addressed facts

The proposal centres on an `ImportSession`: a state machine whose status, and the status of each entry, is advanced by queue callbacks. I recommend a different organising idea. **The person's request is durable intent. What the system has done is recorded as immutable facts. Progress and status are queries, not stored state.**

There are four kinds of information, and each has a different lifetime:

| Concept | What it is | Lifetime |
|---|---|---|
| **Blob** | Original bytes, keyed by `sha256`. Storing it is idempotent. | Kept until an explicit library deletion |
| **Sighting** | "Source S, at locator L, named N, with raw source metadata M, had bytes H" | Append-only provenance |
| **Request / RequestItem** | What the person selected, plus their decisions (pause, cancel, retry, exclude) and each item's outcome | Durable, recorded before any copying starts |
| **Derivation** | Preview, poster frame or parsed metadata for a blob, tied to a deriver version | Cache that can be rebuilt, with its own failures |

Under this model, deduplication is simply how storage is keyed. Provenance is the sighting table. "Copy succeeded" and "preview failed" are facts about different subjects, so they can't be confused.

```ts
type BlobId = `sha256:${string}`;
type Source = {
  id: SourceId; kind: 'phone' | 'folder' | 'archive';
  identity: SourceIdentity;  // volume UUID, device+asset-library id, archive hash — never a path
  label: string;
};
type SourceAccess = 'available' | 'needs-grant' | 'disconnected' | 'gone'; // computed at runtime, not stored

type ImportRequest = { id; sourceId; createdAt; enumeration: 'running' | 'complete';
                       pausedAt?: Time; cancelledAt?: Time };
type RequestItem = { id; requestId; locator: string; name: string; expectedSize: number;
                     outcome: Outcome; attempts: Attempt[] };
type Outcome =
  | { kind: 'pending' }
  | { kind: 'imported'; sightingId; blobId; alreadyInLibrary: boolean }
  | { kind: 'problem'; problemId }      // unreadable, vanished, changed-during-read
  | { kind: 'cancelled'; at: Time };

type Sighting = { id; blobId; sourceId; locator; name; size; sourceModified?: Time;
                  raw: { format: string; payload: Uint8Array }; // sidecar JSON, PhotoKit attributes, fs xattrs — uninterpreted
                  requestItemId?; at };
type Derivation = { blobId; kind: 'thumbnail' | 'poster' | 'metadata'; version: number;
                    state: 'pending' | 'done' | 'failed'; problemId? };
type Problem = { id; subject: RequestItemId | BlobId; kind; detail; at; resolvedAt? };
```

"Blocked" and "copying" are not stored. Blocked is computed from `pending` plus the source's access or a paused request. Copying is a worker's **lease** on an item, and the lease expires if the process dies.

### Operations

```ts
const req = await imports.select(sourceRef, selection); // persists intent, then enumerates in durable batches
imports.pause(req); imports.resume(req); imports.cancel(req);
imports.retry(req, { outcomes: ['problem', 'cancelled'] });
await sources.grant(sourceId, handleOrDevice);          // re-attaches access after checking identity
derivations.retry(blobId, 'thumbnail');

observe(imports.progress(req));     // counts grouped by outcome × access
observe(library.items(query));      // blobs with ≥1 sighting; preview may be missing
observe(sources.needingAccess());   // sources that have pending items but no access
observe(problems.for(subject));
```

**How a worker commits one item:**
1. Lease the item and read it from the source.
2. Stream the bytes into a temporary file while hashing, then fsync.
3. Check the source's size and mtime again. If they changed during the read, discard and retry later; after N attempts, record a problem.
4. Rename the file into the blob's place, unless that blob already exists, in which case discard the copy.
5. In one transaction: insert the blob if absent, insert the sighting, and set the outcome — **but only if the outcome is still `pending`**.

The database may never point at bytes that aren't stored. A stored blob that no row points at, left by a crash, is harmless. A startup sweep can adopt it after checking the hash, or delete it.

### Realistic UI

The progress screen reads:

> **Vacation SSD** — 41,210 of 80,112 · 3,201 already in library · 14 problems
> ⏸ Waiting: drive disconnected **[Reconnect]**   **[Pause] [Cancel remaining]**

The library grid fills in as each item commits. A tile without a derivation shows a placeholder. A tile whose derivation failed shows "Original saved · preview unavailable". Both progress and the grid are queries over the store, so they work the same whether the work runs in the foreground or in a background process.

## What "complete" promises

A request is **settled** when enumeration has finished and every item has a final outcome: `imported`, `problem` or `cancelled`.

**`imported` promises:**
- the exact bytes read from the source are stored durably and their hash is verified;
- a sighting records where they came from, under what name, with the raw source metadata.

**It does not promise:**
- previews or parsed metadata;
- that the source still matches what was read;
- a separate library item per filename.

The UI says "Finished — 14 problems", never just "Done". Settled does not mean everything succeeded.

## Consequential sequences

**1. Partial success, then closing the app.**
- 80,000 items are recorded in batches before copying starts. Workers lease items, and each commit is its own transaction.
- The person closes the app halfway through a 4 GB video. The lease expires, the temporary file is swept away, and that item goes back to pending.
- The 41,000 committed items stay in the library. Their decisions (excluded folders, pause) survive because they are rows, not memory.
- There is no session status to repair at startup.

**2. Restart with a missing source.**
- On startup, the pending items are still pending, and access is recomputed for each source.
  - The SSD is absent, so it shows as `disconnected`.
  - The browser folder handle stored in IndexedDB reports `queryPermission → 'prompt'`, so it shows as `needs-grant`. `requestPermission` needs a user gesture, so the reconnection prompt shows a button.
- Other sources keep going.
- When the person reconnects, `grant` checks identity:
  - a volume by its UUID;
  - a stored handle by `isSameEntry`;
  - a freshly picked folder by sampling locators, sizes and hashes of already-imported sightings, then asking: "Is this the same 'Vacation' folder?"
- **Honest consequence:** a plain `<input type=file>` selection has no handle that survives a restart. The decisions survive, but the remaining work needs the person to select again. That isn't a guarantee lost; it's a fact about the platform, and the prompt should say so.

**3. Selecting overlapping files again.**
- A later superset selection creates a new request. Each item is read and hashed.
  - If the blob exists, nothing is written. A new sighting is added only if the source, locator, name or raw metadata differ; otherwise the outcome is `alreadyInLibrary`.
  - The same filename with different bytes gets a new blob and a second item. Nothing collides, because storage is keyed by hash.
  - Equal bytes under a new name give one item with two provenance rows.
- Pending items from the earlier blocked request are resolved by any later sighting with the same source identity and locator.
- Progress shows "2,300 new · 41,000 already in library".

**4. Preview fails after a successful copy.**
- The outcome is `imported`. Only the thumbnail derivation fails, and its problem is attached to the blob.
- The item is usable: you can see it, export the original and see its provenance.
- Diagnostics show the chain: read ok → hash H → stored → thumbnail v3 failed (unsupported codec).
- Raising the deriver version re-derives automatically. Import counts are untouched. An undecodable photo follows exactly the same path.

**5. Cancel, then retry.**
- `cancel` sets every `pending` item to `cancelled` in one transaction.
- A worker racing to commit loses, because its write requires the outcome to still be `pending`. If its blob already landed, it is unreferenced and swept later.
- Imported items are never touched. Removing them is a separate, explicit library operation.
- `retry(req, {outcomes:['cancelled','problem']})` sets those items back to pending and appends an attempt to their history. If the source changed in the meantime, the new sighting records what was actually read.

## What disappears

- **`ImportSession.status`.** One status can't describe "79,990 imported, 10 problems, paused on one drive".
- **Persisted per-queue progress, and the callbacks to `ImportManager`.** Those are three copies of progress that would have to agree. Workers become stateless lease-takers over one store, and the manager shrinks to a scheduler.
- **`DuplicateIndex` and `duplicateOf`.** The blob key is the index. Calling one copy "the original" means nothing when bytes are equal.
- **`destinationPath`.** The location is a function of the hash.
- **`copyStatus: 'copying'`.** It becomes a lease.
- **`decodeStatus`.** It moves to Derivation, so a decode failure can't poison the import outcome.
- **`ManifestStore`.** It merges into RequestItem.
- **`MetadataStore`.** It splits: raw metadata becomes a fact in Sighting, and the parsed interpretation becomes a Derivation. This is what keeps unparsed metadata available.

## New work this model introduces, and why each piece earns its place

- **Hashing every byte** — needed for byte-exact deduplication.
- **Staging plus atomic rename and an orphan sweep** — needed so a restart never loses or corrupts completed work.
- **Leases** — needed so a background process and the foreground app don't double-copy.
- **Source identity checks** — needed because a path is not a credential.
- **Derivation versioning** — needed so an import isn't judged by the parser.
- **A Problem record** — needed for visible diagnostics.

**Cost:** a reselection re-reads every byte. It doesn't rewrite them.

## Requirements challenged (proposals, not decisions)

- **P1 — faster reselection.** Skip reading when source identity, locator, size and mtime all match a previous sighting. This breaks "preserve every distinct byte sequence" whenever a file was edited in place with the same size and mtime. I'd keep it off by default, or offer it as an explicit "trust unchanged files" choice.
- **P2 — a library item means one byte sequence, not one file.** Equal bytes show as one item listing several names. If the product needs a tile per filename, items become sighting-based, and grouping logic comes back.
- **P3 — no resuming partway through a file.** A large video restarts from zero after a crash. Saving hash state partway through a file is an optimisation to add only if measurements justify it.

## What could change this recommendation

These are the next checks to run; none has been done.

1. **Can each phone source deliver the true original bytes?** PhotoKit and MTP may hand over transcoded HEIC→JPEG or separate Live Photo parts. This decides what "original" means, and whether a Sighting needs to group several resources.
2. **Can browser handles be persisted and permission re-requested** across restarts in the browsers you target?
3. **How fast is hashing plus writing** for 80,000 files with videos on the slowest supported hardware? This decides whether P1 or P3 is worth it.
4. **What does library deletion mean when one blob has several sightings?** That is outside import, but it decides when a blob can be removed.
