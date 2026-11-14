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
