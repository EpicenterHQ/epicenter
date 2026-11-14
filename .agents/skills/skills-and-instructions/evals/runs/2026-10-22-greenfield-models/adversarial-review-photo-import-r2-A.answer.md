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
