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
