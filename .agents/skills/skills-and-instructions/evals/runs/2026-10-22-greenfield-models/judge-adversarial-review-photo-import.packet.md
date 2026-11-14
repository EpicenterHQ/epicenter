# Task

Help me rethink a photo-import API from first principles. This is conceptual exploration, not implementation. Don't let the current proposal or migration cost determine the destination.

People import photos from a phone, a local folder, and an archive export. They often select overlapping sets at different times. A selection can contain 80,000 files, including large videos. Closing the screen or restarting the application must not lose completed work or the person's decisions. Some sources are removable drives; browser selections may require the person to grant access again after restart. Do not assume an operating-system path is a durable credential.

The product must preserve every distinct original byte sequence, avoid storing identical bytes repeatedly, and preserve source provenance including different filenames and capture metadata. Equal bytes can appear under different names; the same filename can refer to different bytes. A photo that cannot be decoded still needs its original preserved and a visible problem report. People want to start using successfully imported items while the rest continues. They can pause, cancel remaining work, retry failures, and later reselect a source. Cancellation must not silently delete items already imported. A failed preview is not proof that the original failed to copy.

The current proposal is:

type ImportSession = {
  id: string;
  sourceId: string;
  manifestId: string;
  status: 'selected' | 'scanning' | 'copying' | 'processing' | 'ready' | 'failed' | 'cancelled';
  entries: ImportEntry[];
};

type ImportEntry = {
  id: string;
  sourcePath: string;
  destinationPath?: string;
  copyStatus: 'pending' | 'copying' | 'copied' | 'failed';
  decodeStatus: 'pending' | 'processing' | 'done' | 'failed';
  duplicateOf?: string;
};

The implementation sketch puts SourceRegistry, ManifestStore, CopyQueue, DuplicateIndex, PreviewQueue, and ImportSessionStore behind an ImportManager. Each queue persists its progress and sends completion callbacks to the manager. A separate AssetStore owns imported files and MetadataStore owns their interpretation. No implementation exists yet; these are proposed boundaries, not requirements.

Different consumers need a progress screen, a library grid that displays usable imported items, a source-reconnection prompt, and per-file diagnostics. A background process may continue work while none of those screens is mounted. Raw source metadata should remain available even if the current parser does not understand it.

Develop the strongest coherent greenfield model and API. Show natural use and a realistic UI interaction. Follow a batch through partial success, restart with a missing source, reselecting overlapping files, a preview failure after a successful copy, and cancellation followed by retry. Define what an import's completion promises. Explain the information and responsibilities that belong together, what disappears, what new work or concepts you introduce, and which user guarantees justify them. You may challenge explicit requirements as clearly labeled proposals, but do not silently discard them.


# Responses

## Pair 1, response A

**Recommendation: replace the proposed design.** The core change is one invariant. *An item counts as imported once its bytes are durably committed under their content hash and a provenance record links the source file to that hash, both in a single transaction.* Everything else is either a user decision (which files to include, paused, cancelled) or a derived result (previews, parsed metadata, progress) that can be recomputed. This removes the reason for most of the proposed machinery.

**Files read**
```
.agents/skills/
├── adversarial-review/SKILL.md
│   └── references/{deletion-prizes.md, example-workflow.md}
└── rethink/references/{greenfield.md, radical-options.md}
REQUEST.md
```
No implementation exists, so I reviewed the proposal against the stated requirements and consumers. I did no code inspection or verification.

## Problems in the current proposal (separate from the simplification)

1. **`destinationPath` per entry plus `duplicateOf` between entries.** Storage ends up keyed by entry, and deduplication becomes a pointer from one entry to another. If the session holding the "original" entry is cancelled or pruned, its duplicates point at nothing.
2. **`sourcePath` used as identity.** It breaks when a drive remounts, when the browser asks for access again, or when someone reselects. The requirements explicitly rule out treating a path as a durable credential.
3. **`entries: ImportEntry[]` stored inside the session.** With 80,000 entries, each progress write rewrites or locks one huge record.
4. **A single session `status` field.** It can't represent "30k usable, 200 failed, 1k waiting for a drive." The values `ready` and `failed` are both false at the same time.
5. **Persisted `copying`/`processing` states.** After a restart these become stuck states that need repair logic.
6. **Queues that persist progress and then call back the manager.** That is two writes to two stores. If the manager isn't running (the background-process case), a callback is lost and the stores disagree.
7. **`decodeStatus` sitting next to `copyStatus`.** This invites treating a preview failure as an import failure, which the requirements forbid.

## The model

Each piece of information has one owner:

| Concept | Owns | Keyed by |
|---|---|---|
| **Blob** | original bytes, stored once | `sha256` |
| **SourceFile** | provenance, plus how copying it turned out | `(sourceId, locator, fingerprint)` |
| **Selection** | the person's decisions | `id`, with membership rows pointing to SourceFiles |
| **Source** | an access grant and an identity check | `id` |
| **Derivation** | preview or parsed metadata | `(hash, kind, version)` |

```ts
type Hash = `sha256:${string}`;

type Source = {
  id: SourceId;
  kind: 'phone' | 'folder' | 'archive';
  label: string;
  identity: VolumeId | DeviceId | ArchiveHash;   // checked on reconnect
  access: 'available' | 'needs-permission' | 'missing'; // live, not persisted truth
};
// The grant (FileSystemHandle, security-scoped bookmark, device token) is an
// opaque platform credential stored beside Source — never a path string.

type SourceFile = {
  id: SourceFileId;
  sourceId: SourceId;
  locator: string;                 // relative path, MTP object id, asset id
  fingerprint: { size: number; modifiedAt: number };
  name: string;
  sourceMetadata: RawRecord;       // opaque: fs attrs, sidecar JSON, album — kept verbatim
  outcome:
    | { kind: 'none' }
    | { kind: 'stored'; hash: Hash; storedAt: number }
    | { kind: 'failed'; problem: CopyProblem; attempts: number };
};

type Selection = { id: SelectionId; sourceId: SourceId; intent: 'active' | 'paused' };
type Membership = { selectionId: SelectionId; fileId: SourceFileId; included: boolean };

type Derivation = {
  hash: Hash; kind: 'preview' | 'metadata'; version: number;
  state: 'pending' | 'done' | { failed: DecodeProblem };
};
```

**The work queue is a query, not a store.** The worker looks for SourceFiles where `outcome = none` (or a retryable failure) that have an included membership in an active selection whose source is available. It works through them like this:

1. Stream the bytes from the source into a staging file, hashing as it reads (one read, which matters for phones and large videos).
2. `fsync`.
3. Move the file into `blobs/<hash>` only if no file with that name exists. If one does, discard the staged copy, because those bytes are already stored.
4. In one transaction, set `outcome = stored(hash)`.

Step 4 is the point at which the item counts as imported. Anything that crashes before it leaves only a staging file for garbage collection. Equal bytes under different names become two SourceFiles pointing to one Blob. The same name with different bytes becomes two Blobs. Deduplication is enforced by the blob store's key, not maintained in a separate index.

**API**
```ts
const sel = await importer.select(grant, locators);   // fast: writes SourceFile+Membership rows
importer.pause(sel); importer.resume(sel);
importer.cancelRemaining(sel);       // included=false for non-stored members only
importer.retry(sel, { problems?: CopyProblem['kind'][] });
await importer.reconnect(sourceId, grant);  // verifies identity before use

importer.watch.progress(sel)        // counts by derived state
importer.watch.library()            // one tile per Hash with ≥1 stored SourceFile
importer.watch.problems({ sel? })   // copy problems ∪ derivation failures ∪ waiting sources
importer.watch.sourcesNeedingAttention()
```
The screens only read. A background worker owns the writes, so it doesn't matter which screens are open. There are no callbacks: screens subscribe to queries over a single database.

**Per-item status is derived:**
- `stored` → **Imported**
- otherwise, membership not included → **Cancelled**
- otherwise, source not available → **Waiting for "SD card"**
- otherwise, `failed` → **Failed (reason)**
- otherwise → **Queued**

Preview status is shown separately and never changes these categories.

## What "complete" means

A selection is **complete** when every included member is either *stored* or *failed with a recorded reason*, and nothing is queued or waiting. Cancelled members are recorded as the person's decision. Completion promises:
- each stored original is byte-exact, hash-verified and `fsync`ed;
- its provenance, including raw source metadata, is recorded.

It does **not** promise previews, parsed metadata or decodability; those have their own visible problems. *Proposal:* say "safe to delete from source" only for items that pass a read-back hash verification, and show that as a separate badge rather than folding it into "complete."

## The requested scenarios

**1. Partial success.** The person selects 80,000 files from a folder. `select` writes the rows in seconds, and the progress screen shows `0 / 80,000`. Each blob that commits appears in the grid right away with a placeholder until its preview finishes, so the person can start working. Twelve files fail with `read-error`, and those twelve show up under problems with a Retry button.

**2. Restart with a missing source.** The app restarts at 41k stored. The worker resolves grants:
- The folder grant needs permission again, so its access is `needs-permission`.
- The SD card isn't mounted, so its access is `missing`.

Nothing is changed in storage. The progress screen shows "38,000 waiting for *Photos folder* — **Grant access**" (a browser permission prompt, which needs a click from the person). The SD card's items show "Waiting for *SD card*". After reconnecting, `reconnect` checks the volume identity. If a different drive with the same label is inserted, it's rejected. If a file's fingerprint no longer matches, that file is reported as `changed-at-source`. It isn't silently imported under the old provenance, and the person can choose to import the current version.

**3. Reselecting overlapping files.** The person reselects the folder plus a subfolder, and also imports an archive export that contains copies of the same photos.
- **Same source, same fingerprint:** the membership points to the existing SourceFile, which is already stored. It counts as done instantly with no re-read.
- **Archive copies:** these are new SourceFiles, so they must be read and hashed (equality can't be known any cheaper). They match existing blobs, so no new bytes are stored. The archive's names and sidecar metadata are added as extra provenance on the same grid tile.

**4. Preview failure after a successful copy.** A HEVC video is copied and its hash commits, so its outcome is `stored`. Then the preview derivation fails with `unsupported-profile`. The grid shows the tile with a "Can't preview" badge, and the original stays exportable. Diagnostics read: "Copied and verified sha256:…; preview failed (decoder v3)." The selection still counts as complete. When the decoder is upgraded to v4, failed derivations with an older `version` are re-queued.

**5. Cancellation, then retry.** The person cancels at 30k. Every member not yet stored gets `included=false`. The in-flight copy is aborted and its staging file is discarded. If its commit had already happened, it stays imported. All 30k stored items remain. Retry re-includes the cancelled members and resumes from them. Reselecting the folder later gives the same result through fingerprint lookup.

## Deletion prize

Removed:
- `ImportManager` orchestration and every completion callback.
- `CopyQueue` and `PreviewQueue` as stores of their own progress; both become queries.
- `DuplicateIndex`, replaced by the blob key.
- `ImportSessionStore`'s seven-state status machine, and both `status` fields as stored data.
- `destinationPath` and `duplicateOf`.
- Persisted `copying`/`processing` states and the restart repair code they need.
- Keeping manager and queue stores consistent with each other.
- The 80k-entry array.
- Any coupling between decoding and import outcome. `MetadataStore` turns into derivation rows.

## Complexity introduced, and why it's justified

- **Staging-and-commit protocol, plus garbage collection** for staging files and orphan blobs. *Needed for:* nothing completed is lost on a crash.
- **Source grant and identity verification**, with an access state that is checked live. *Needed for:* removable drives, browser re-permission, and not treating a path as a credential.
- **Fingerprint-based reconciliation.** It trusts `size+mtime` within one source. *Proposal:* add an optional "verify" mode that re-hashes.
- **Derivation versioning.** *Needed for:* a failed preview is not a failed import, and raw metadata can be re-parsed later.
- **A single writer** (one worker process), or leases if the app and the background process both write.
- **Cost to the person:** archive and cross-source duplicates are still read in full, and exports rebuild filenames from provenance, because the store is organized by hash.

## Requirements I'm challenging (proposals, not changes)

- **Drop the batch-level "import status".** Keep only `active | paused`, with completion derived. Nothing a person needs is lost.
- **Limit deduplication to exact bytes.** Similar-looking duplicates and edited variants stay separate items.
- **Treat "cancel" as excluding the remaining members**, not as an end state for the session. That's what makes retry and reselection cheap.

## Unresolved facts that decide the outcome

The coordinator should get evidence on these:
1. Whether the target platforms' persistent grants (File System Access handles, macOS bookmarks, phone APIs) produce stable locators and a usable volume or device identity. If phone locators are unstable, every reselect from a phone has to re-hash. That costs throughput but leaves the model intact.
2. Whether "move only if absent" (`link()` or `O_EXCL`) is atomic on the blob store's filesystem. If it isn't, the commit point has to move entirely into the database transaction.
3. Hashing throughput for 80k mixed files on USB and MTP. This decides whether staging should use a size-bucket prefilter.
4. Whether the background worker and the app can both run at once. If they can, leases are needed and some coordination comes back.


## Pair 1, response B

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


## Pair 2, response A

**Recommendation: replace the proposed design.** The proposal stores *progress*. The stronger model stores only *durable facts* and works out progress from them. The invariant that makes this possible: **an original is stored under the hash of its bytes, and a provenance record is committed only after those bytes are durable.** Once that holds, there's nothing left to keep in sync: no status enums, no duplicate index, no persisted queues, no completion callbacks.

Files read:
```
.agents/skills/
├── adversarial-review/SKILL.md
│   └── references/{deletion-prizes.md, example-workflow.md}
└── rethink/references/{greenfield.md, radical-options.md}
REQUEST.md
```
No implementation exists, so this is a review of a proposal. It's my own single pass. No other reviewer was involved.

---

## What the current proposal is compensating for

`ImportEntry` packs three things with different lifetimes into one mutable row:

1. **Content**, the bytes. These are permanent and identified by hash.
2. **Provenance**: "source S showed these bytes under name N with metadata M". Also permanent, and it only ever grows.
3. **Intent**: "the person chose these files, and this work is still to do". Temporary.

Because they share one row, the proposal needs `copyStatus` × `decodeStatus` × the session `status` to describe the item, and `duplicateOf` to describe how it relates to other items. Six components persist overlapping truths, so callbacks have to reconcile them. A crash between "queue persisted copied" and "manager received callback" leaves the stores disagreeing. The machinery exists to repair a split the model created.

`destinationPath` and `duplicateOf` show the same thing. If bytes are named by hash, the destination *is* the hash and a duplicate *is* a second provenance record. Neither needs a field.

## The model

```
Current                                 Proposed
ImportManager                           Worker (idempotent loop, background process)
 ├ SourceRegistry ──┐                    │ reads/writes
 ├ ManifestStore    │ callbacks          ▼
 ├ ImportSessionStore├──► manager       Ledger (one transactional DB)
 ├ CopyQueue (persist)                   ├ sources   ├ imports + selections
 ├ DuplicateIndex   │                    ├ sightings ├ problems
 └ PreviewQueue (persist)               BlobStore   (originals, keyed by hash)
AssetStore, MetadataStore               Derivatives (previews, parsed metadata;
                                                     keyed by hash+version; rebuildable)
```

```ts
type Hash = string & { readonly __brand: 'Hash' };

type Source = {
  id: SourceId;
  kind: 'phone' | 'folder' | 'archive' | 'browser';
  label: string;                 // "Braden's iPhone", "EOS_DIGITAL"
  fingerprint: string;           // volume UUID, device id, archive hash — never a path
  grant?: OpaqueGrant;           // e.g. persisted FileSystemHandle; may need re-permission
};
// Whether a source is available is runtime state, never stored:
// 'available' | 'absent' | 'needs-permission'.

type Import = {
  id: ImportId; sourceId: SourceId; parentId?: ImportId;   // set for retries
  intent: 'run' | 'paused' | 'cancelled';                  // the person's decision
  createdAt: Instant;
};
type Selected = { importId: ImportId; locator: Locator };  // one row per chosen file

type Sighting = {                 // only ever appended
  importId: ImportId; locator: Locator; hash: Hash;
  name: string; size: number; sourceTimes: SourceTimes;
  rawSourceMetadata?: Hash;       // stored as a blob exactly as the source gave it
  newToLibrary: boolean;          // false = bytes were already stored
};

type Problem = {                  // attempt records, only ever appended
  subject: { importId: ImportId; locator: Locator } | { hash: Hash };
  stage: 'access' | 'read' | 'verify' | 'decode' | 'preview';
  detail: string; version?: string; at: Instant;
};
```

**What's derived instead of stored.** A selected file is *stored* if a sighting exists for it. It has *failed* if its latest attempt is a problem. Otherwise it's *remaining*. The copy queue is a query: "selected, not stored, not failed, import `run`, source available". The preview queue is a query too: "blobs with no derivative at the current version and no problem at that version". The library grid shows sightings joined to blobs. Clearing the derivative cache costs nothing but recomputation.

**Worker step**, with no required order across files:
1. Stream the file from the source into a temp file, hashing as it copies (no extra read).
2. fsync, then rename to `blobs/<hash>`. If it already exists, discard the temp copy. That's deduplication.
3. Commit a `Sighting` in one transaction.

A crash anywhere repeats at most one file. Two imports writing the same bytes at once also converge.

**Raw metadata.** EXIF and container metadata live inside the original, so they're preserved by definition. Metadata outside the file (Takeout JSON, XMP sidecars, phone-library fields) is kept as `rawSourceMetadata` blobs. `MetadataStore` turns into a derivative: parsed fields keyed by `(hash, parserVersion)`. A new parser re-derives from the raw data.

**Who owns what:**
- **BlobStore** owns "the original is safe".
- **Ledger** owns what was seen and what the person decided.
- **Derivatives** own interpretation.
- **Worker** owns nothing that lasts.

## Natural use

```ts
const imp = importer.select(source, locators);         // persists intent first
importer.progress(imp).subscribe(render);
// → { selected, stored, alreadyInLibrary, problems, remaining,
//     blockedBy?: 'paused'|'source-absent'|'needs-permission'|'cancelled',
//     complete: boolean }
importer.pause(imp); importer.resume(imp); importer.cancel(imp);
importer.retry(imp, { failed: true, notAttempted: true }); // → new ImportId (parentId = imp)
sources.reconnect(sourceId);                           // must come from a user gesture
library.items(query);         // { hash, sightings[], preview: 'ready'|'pending'|'failed' }
diagnostics.for({ importId } | { hash });
```

UI copy: *"Importing from EOS_DIGITAL — 31,204 of 80,000 stored · 1,190 already in library · 12 couldn't be read [Details]."* Grid tiles appear as soon as their sighting commits, with a placeholder until the preview exists.

## The scenarios

**Partial success.** 80,000 files are selected, and all 80,000 selection rows commit before any copying starts, so the person's decision outlives the screen. At 31k stored, 12 files return I/O errors and get `read` problems. The 31k are already in the grid. Closing the screen changes nothing, because the worker runs in the background process.

**Restart with a missing source.** On startup the worker finds an import with intent `run` and checks its source:
- **Drive absent:** `blockedBy: 'source-absent'` and a prompt to connect EOS_DIGITAL.
- **Something mounted at the same path:** a different fingerprint doesn't match, so the import stays blocked. A path is never treated as identity.
- **Browser handle:** `queryPermission` returns `prompt`, so the import shows needs-permission. The reconnection banner calls `reconnect` from a click.
- **Plain `<input type=file>` selection** (no handle can be kept): the remaining files are shown as "Reselect these files to continue". When reselected, files are matched to the waiting rows by relative path, size and modification time. A wrong match can only attach a file to the wrong *intent*. Correct storage still depends on the hash alone.

**Reselecting an overlapping set.** Import B overlaps A. Every B file is read and hashed:
- Bytes already stored: the blob write does nothing, and a sighting is added with `newToLibrary: false`. The UI says "1,190 already in library", and the item shows both names.
- Same `IMG_0001.JPG` with different bytes: different hash, new blob. Both versions survive with separate provenance.

`duplicateOf` and DuplicateIndex simply don't exist.

**Preview fails after a successful copy.** The sighting is already committed, so the item counts as stored and is in the grid. It gets a "No preview" badge and a `preview` problem `{hash, version}` that's visible in diagnostics. An undecodable photo follows the same path: its original is preserved and the problem is visible. A decoder upgrade changes the version and puts the item back in the preview query automatically.

**Cancel, then retry.** The person cancels at 50k stored, 30k not attempted.
- Intent becomes `cancelled`, and progress shows 50k stored, 12 failed, 29,988 not imported.
- Cancellation has **no delete path in its code**. Removing imported items is a separate library action the person runs explicitly.
- "Retry failed" or "Import the rest" creates import C with `parentId: A` and selection = A's failed and/or unattempted files. A's history is never rewritten, and C has its own completion.

## What completion promises

An import is **complete** when every selected file has an outcome: *stored* (bytes durable, hash-verified, provenance committed), *failed* (problem recorded, retry available), or *not attempted because cancelled*.

Completion promises nothing about previews or parsed metadata. Those are separate, best-effort library state that can be repaired later. This deliberately narrows the proposal's `processing → ready` and is what makes "a failed preview is not a failed copy" structural rather than a rule people have to remember.

## Deletion prize

These disappear:
- **Statuses and fields:** the `ImportSession.status` state machine, `copyStatus`, `decodeStatus`, `destinationPath`, `duplicateOf`.
- **Components:** DuplicateIndex, persisted CopyQueue and PreviewQueue, and completion callbacks. ImportSessionStore, ManifestStore and SourceRegistry merge into one ledger, and ImportManager becomes a stateless worker.
- **Planned work:** code to reconcile stores after a crash, transitions for resuming mid-import, and cleanup rules for cancellation.

## What's new, and what it costs

- **Hashing every byte.** The copy already reads every byte, so the cost is CPU, not I/O. A duplicate does cost one wasted temp write.
- **Reselection re-reads everything.** Overlapping files cost a full re-read, which matters for large videos.
- **New concepts:** source fingerprints, opaque access grants, derivative versions, retry imports linked to their parent.
- **Stored source metadata.** Raw metadata blobs grow storage slightly.
- **More rows.** Provenance grows by one row per sighting. Selections of 80k rows need a real database, but you needed one anyway.

## Requirement challenges (proposals, not silent drops)

1. **Skip re-reading on reselection.** Proposal: skip when the source fingerprint, stable locator, size and modification time all match an earlier sighting. The prize is hours of re-reading video. The cost is losing the "same name, different bytes" guarantee when a source rewrites a file but keeps its modification time. I'd only offer it for sources with stable object IDs, and label it.
2. **Fold pause into cancel.** Pause could be cancel plus "import the rest", which deletes one intent value. That prize is too small. Keep pause.

## Correctness risks to keep separate

- The fsync-then-rename-then-commit order is the whole guarantee. If a sighting is ever committed before the blob is durable, the grid shows items that can be lost.
- `<input>` selections can't resume after restart, which is a platform limit. The UI has to say "reselect" rather than imply it will resume.

## Unresolved facts that decide the details

- **Phone locators.** Are they stable across sessions? PTP/MTP object handles often aren't, so the phone adapter needs a persistent ID or falls back to re-reading everything.
- **Browser support.** Persisting `FileSystemHandle` is Chromium-only. Where it isn't supported, the reconnection prompt becomes a reselection prompt.
- **Hashing speed.** Throughput on large videos from phones decides whether challenge 1 is worth it.

**Measurements for the coordinator:** a prototype that kills the process at each of the three write steps and checks that the library and progress are consistent after restart, plus a measurement of hashing throughput on 80k mixed files, including multi-GB videos.


## Pair 2, response B

# Adversarial review: photo-import API

**Independence limitation:** I was the only reviewer, not one of two. REQUEST.md showed me the proposal at the same time as the requirements, so I may have anchored on it. I built the model below from the requirements first and then compared it with the proposal. No implementation exists, so nothing here has been run.

## Recommendation

Don't model an import as a session moving through a status pipeline. Model it as a **durable ledger of facts plus the person's stated intent**, with workers that keep reconciling the two:

- **Facts:** which bytes exist, where they were seen, and what derived work succeeded or failed.
- **Intent:** what the person asked to import, and whether they paused or withdrew it.

Progress, the library grid, reconnection prompts and diagnostics all become **queries** over one transactional store. No manager has to stay mounted for any of them to work.

Two different identities do two different jobs:

- **Original:** one distinct byte sequence, keyed by its content hash. This removes duplicates.
- **Sighting:** one observation of a file at a place: source, locator, filename, raw metadata and fingerprint. This preserves provenance. Equal bytes under different names give one Original with two Sightings. The same filename with different bytes gives two Originals.

The proposal mixes these in `ImportEntry`, where `duplicateOf` and `destinationPath` sit on a per-session row. That is why it needs a DuplicateIndex, and why provenance for the second name of the same bytes has no obvious home.

## Model and API

```ts
// Durable facts (one transactional store, e.g. SQLite) + content-addressed blob directory
type Source   = { id; kind: 'device'|'folder'|'archive'; identity: DeviceId|VolumeId|HandleRef|ArchiveHash; label };
type Original = { hash: ContentHash; size: number; storedAt: Time };            // exists ⇔ bytes durable & verified
type Sighting = { id; sourceId; locator: string /* relative to source root */; name: string;
                  fingerprint: { size; modifiedAt; nativeId? }; rawMetadata: Bytes; originalHash?: ContentHash };
type Derived  = { hash; kind: 'preview'|'parsedMetadata'; version; outcome: 'ok'|'failed'; problem?: Problem };

// Intent
type Import    = { id; sourceId; selection: SelectionRule | 'explicit'; paused: boolean; createdAt };
type Candidate = { importId; sightingId;
                   disposition: 'pending'|'ingested'|'alreadyPresent'|'withdrawn'|'blocked';
                   problem?: Problem; attempts: number };
type Problem   = { code: 'sourceUnavailable'|'accessRevoked'|'unreadable'|'changedDuringCopy'|'decodeFailed'|...; detail; at };
```

```ts
const id = await imports.start(access, selection);   // persists intent, then enumerates incrementally
imports.pause(id); imports.resume(id);
imports.cancelRemaining(id);                         // pending → withdrawn; never touches Originals
imports.retry(id, { include: ['blocked', 'withdrawn'] });
sources.attach(access);                              // re-grant; resumes matching pending work

imports.progress(id)          // counts by disposition + active problem; derived, not stored
library.items(query)          // Originals with ≥1 Sighting; preview optional
sources.needingAccess()       // sources with pending candidates and no live access
imports.problems(id)          // per-file diagnostics
```

**A Source is an identity, and access is a renewable capability.** Locators are relative to the source root. The identity is a phone's device id, a removable volume's UUID, a persisted browser directory handle, or an archive's hash. An OS path is never a credential.

**Ingest is a single commit:**
1. Stream the bytes into staging, hashing as they arrive.
2. Fsync, then rename into `blobs/<hash>`. If that path already exists, discard the staged copy.
3. In one DB transaction: insert the Original if it is absent, link the Sighting, and set the candidate to `ingested`.

The only obligation that crosses stores is file system against DB. A startup sweep adopts or garbage-collects blobs that have no row. Because the rename is keyed by hash, retrying it is always safe.

**Derived work is a cache keyed by `(hash, kind, version)`.** Parsed metadata is derived from the stored raw metadata, so a newer parser can reprocess everything. Raw metadata is never discarded.

## What an import's completion promises

An import is **settled** when every candidate is `ingested`, `alreadyPresent`, `withdrawn` or `blocked` with a visible Problem. A settled import with zero blocked candidates is **complete**. Complete means:

- every selected byte sequence has a verified, durable copy;
- every sighting's name, locator and raw metadata are recorded.

Completion **does not** promise previews or parsed metadata. Those belong to the Original, not the import, and their failures show up as problems on the item. This is how "a failed preview is not proof the copy failed" becomes structural rather than a convention.

## Realistic UI

> **Importing from "SD card (EOS R6)"**: 31,204 of 80,112 imported · 2,040 already in library · ⚠ 3 need attention
> *Paused: SD card not connected. Reconnect it to continue.* [Pause] [Cancel remaining] [Show problems]

Items show up in the library grid when their Original commits, with placeholder thumbnails. The progress line is computed fresh from candidate counts. A background worker with no screen mounted writes the same rows that the screens read later.

## Consequential sequences

**1. Partial success.** At file 31,204, a video fails to read (I/O error). That candidate becomes `blocked/unreadable` with `attempts: 1`, and the others continue. The 31,203 ingested Originals are already in the grid. Nothing waits on a batch boundary, because each commit stands alone.

**2. Restart with a missing source.**
- The app restarts. Intent and candidate rows survive, and so do the person's pause and cancel decisions.
- The worker finds no live access for the source. Pending candidates stay `pending`, not failed, and `sources.needingAccess()` drives the prompt.
- **Removable drive:** a mount whose volume UUID matches resumes automatically.
- **Browser directory handle:** the prompt asks for a click to re-grant permission.
- **Browser file picker** (the list can't be restored): the prompt asks the person to reselect, and the new sightings are matched back onto pending candidates by locator plus fingerprint.
- A staging file half-written at the crash is deleted, and that candidate re-copies.

**3. Reselecting overlapping files.** A new import from the same folder enumerates 80,112 sightings:
- **Same source, locator and fingerprint as an ingested sighting:** marked `alreadyPresent` without reading the file. *(Proposal, see below.)*
- **Same bytes from the phone:** the file must be read and hashed. The hash matches an existing Original, so a new Sighting is added and no bytes are stored twice. The phone's filename and capture metadata are kept.
- **`IMG_0001.JPG` with different bytes:** gets a new Original.

**4. Preview fails after a successful copy.** The HEIC decodes badly, so `Derived{preview, failed, decodeFailed}` is recorded against the hash. The candidate stays `ingested` and the import can still be complete. The grid shows a "can't preview" badge and the original remains exportable. When a decoder upgrade bumps `version`, the preview is retried for every affected Original, across all imports.

**5. Cancel, then retry.** `cancelRemaining` withdraws the pending candidates and aborts in-flight copies, discarding their staging files. Already-ingested items stay; removing them is a separate library deletion the person must choose. A later `retry({include: ['withdrawn', 'blocked']})` reopens those candidates. Any that were ingested by another import in the meantime resolve to `alreadyPresent` when they are next processed.

## What belongs together, and what disappears

| Proposed | Becomes |
|---|---|
| `ImportSession.status` (7 states) | A derived summary of candidate dispositions. Several imports may be paused, partially blocked and partly ingested at once, which one status can't express. |
| `copyStatus` × `decodeStatus` on the entry | Copy outcome lives on Candidate, decode outcome on Derived. They have different owners and lifetimes. |
| `duplicateOf` + DuplicateIndex | The content-hash primary key. Deduplication is insert-if-absent. |
| `destinationPath` | Derived from the hash. |
| CopyQueue, PreviewQueue, ImportSessionStore, ManifestStore | Queries: "pending candidates with live access, not paused" and "Originals missing current Derived". |
| ImportManager + completion callbacks | Gone. |
| SourceRegistry | Kept, narrowed to identity plus access acquisition. |
| AssetStore / MetadataStore | Merged into the blob directory + Original/Sighting/Derived tables. |

**The deletion prize is more than fewer classes.** It removes a consistency problem the arrangement itself creates. Each persisted queue would report completions to a manager that updates another store. A crash between those two writes leaves the stores disagreeing, so reconciliation code would be needed for every queue pair. With one transactional store and idempotent hash-keyed blobs, that class of failure doesn't exist.

**New concepts and obligations:**
- The Original/Sighting split. It earns its place by delivering deduplication and provenance together.
- Source identity versus access.
- Fingerprints.
- A startup orphan sweep.
- Durable enumeration, so selections of 80,000 files survive restart.
- Derivation versioning.
- A rule for concurrent imports that see the same bytes. This is safe: renames are idempotent and the Original insert is transactional.

## Labeled proposals that bend requirements

1. **Fingerprint skip on reselection.** Treat same source, locator, size and mtime (or a native id such as a phone's asset identifier) as already imported without re-hashing. *Bargain:* reselecting 80,000 files on a removable drive costs seconds instead of a full re-read. A file edited in place without changing size or mtime would be missed. Offer an explicit "verify" option that hashes everything.
2. **The library unit is the Original, not the Sighting.** The same bytes from the phone and an archive show as one item with two provenances. If people expect to see both, the grid needs grouping instead. This is a product choice.
3. **Cancel aborts in-flight files.** The alternative is letting the current file finish. Aborting matters for large videos.
4. **Pause is intent, not a state.** Closing the app is not pausing. Work continues in the background unless the person paused.

None of these drops a requirement. Item 1 weakens "preserve every distinct byte sequence" for files modified in place undetectably, and only in that case.

## Unresolved uncertainty and next checks

These are proposed checks, not results:

- **Browser handle persistence:** confirm the target browsers keep `FileSystemDirectoryHandle` in IndexedDB and support `requestPermission` after restart. Safari support is limited. If they don't, the file-picker reselect flow becomes the main path rather than a fallback.
- **Cost of hashing during copy** on slow removable media, measured against copying alone. This decides whether an "always hash" mode is affordable as the default.
- **Archive identity:** whether hashing a multi-GB export is acceptable, or whether name plus size is enough.
- **Platform phone APIs:** whether they expose stable native ids and original bytes, not re-encoded ones. If they only give exports, "original byte sequence" needs redefining per source.

Sources: `REQUEST.md`; `.agents/skills/adversarial-review/SKILL.md` and its `references/` (deletion prizes, example workflow). No code or callers exist to trace.


