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


## Pair 1, response B

# Photo import rethought: the library keeps originals, and an import is a request to fill it

## The organizing idea

The current proposal treats an import as a **job**. A session moves through phases, each entry carries parallel status enums, and queues report back to a manager. That model makes three things hard: overlap between selections, restart, and saying what "done" means. Each one becomes coordination work.

I propose a different centre:

> **The library is a content-addressed set of originals, each with every place it was ever seen. An import is a durable record of the person's decision to bring certain source files in. Progress is not stored state. It is the difference between what was asked for and what the library already holds.**

Everything below follows from four records with separate owners and lifetimes.

| Record | Key | Owns | Lifetime |
|---|---|---|---|
| **Original** | content hash | the exact bytes, stored once | permanent until the person deletes it |
| **Sighting** | (source, locator, hash) | provenance: filename, observed size/mtime, raw sidecar metadata, which request saw it | permanent, append-only |
| **Request** | id | the person's decision: source, selection, active/paused/withdrawn, plus one **line** per selected file | until dismissed |
| **Finding** | (hash, deriver@version) | previews and parsed metadata, ok or failed | a cache that can be rebuilt |

A **Source** has a durable identity, such as a device serial, a volume UUID plus a relative root, an archive digest, or a stored directory handle. It is kept separate from its **access**, which can be `available`, `needs-permission` or `offline`. A path is only a *locator* inside a source and never a credential.

## Natural use

```ts
const pixel = await library.sources.identify({ kind: 'device', device });
const req = await library.imports.request(pixel, { locators: picked });
// Returns only after the request and its lines are durable. The decision is safe from here on.

library.imports.observe(req.id, (v) => render(v));
// v = { source: { label, access }, intent: 'active' | 'paused' | 'withdrawn',
//       counts: { wanted, kept, alreadyHad, problems, withdrawn },
//       blockedOn?: 'source-offline' | 'needs-permission' }

req.pause(); req.resume();
req.withdrawRemaining();              // wanted → withdrawn; kept lines are never touched
req.retry({ outcome: ['problem', 'withdrawn'] });

library.items.query({ sort: 'captured' });   // the grid: every original with ≥1 sighting
library.items.get(hash).findings;            // e.g. preview@3: failed "HEVC 10-bit unsupported"
library.sources.needingAttention();          // drives the reconnection prompt
```

```ts
type LineOutcome =
  | { kind: 'wanted' }
  | { kind: 'held'; hash: Hash; new: boolean }        // new=false: bytes were already in the library
  | { kind: 'problem'; problem: ReadProblem; attempts: number }
  | { kind: 'withdrawn' };
type Line = { requestId; sourceId; locator; observed: { name; size; modifiedAt }; outcome: LineOutcome };
```

Every consumer is a query over the same records:
- The **progress screen** shows request counts.
- The **grid** shows held originals.
- The **reconnect prompt** shows sources that have wanted lines but lack access.
- **Diagnostics** show problem lines plus failed findings.

A background worker needs no mounted screen. It claims wanted lines whose source is available and whose request is active.

### The UI

> **Pixel 8 — 52,140 of 80,000 kept** · 9,310 already in library · 3 problems
> [Pause] [Stop remaining]
> *Your kept photos are already in Library.*

After a restart:

> **Waiting for "SanDisk Extreme"** — 27,860 files left. Plug it in to continue. [Stop remaining]

## The copy protocol and its invariant

For each line:
1. Stream the source file into a temp file in the store, hashing as it streams.
2. fsync the file.
3. Rename it to `originals/<hash>`. If that file already exists, discard the temp copy.
4. In **one transaction**, write the Sighting and set the line to `held`.

**Invariant: a Sighting or a held line always refers to an original that is already durable.** A crash can leave only:
- an orphan temp file, which a startup sweep removes;
- an unreferenced original, which is harmless and gets re-referenced on retry.

Duplicate handling needs no separate index. The hash is the primary key, so two locators with the same bytes, read at the same time, simply race to the same rename. Equal bytes under different names become one Original with two Sightings. The same name over different bytes becomes two Originals with separate Sightings.

Previews and metadata parsing run off held originals, keyed by `(hash, deriver@version)`. Their failures become Findings on the item. They are never reported as import failures.

## What completion promises

> **A request is settled when every line is `held`, `problem`, or `withdrawn`. `held` means the exact source bytes are durably stored and this sighting's provenance, including raw sidecar metadata, is recorded. It promises nothing about previews or parsed metadata.**

An item is usable the moment it is held. A failed preview means "kept, can't display yet". It does not mean "not imported". A parser upgrade re-runs its derivers over existing originals without involving the import at all.

## The requested sequences

**1. Partial success.** A batch of 80,000 files: 52,000 held, 3 lines hit read errors (`problem: io-error`), and the rest are still wanted. The grid already shows the 52,000. Diagnostics list the 3 by locator and filename, with the error and attempt count.

**2. Restart with a missing source.**
- Requests and lines are already durable, and nothing in flight counts as complete.
- On launch, the worker sees the SanDisk volume UUID is absent, so the request is `blockedOn: source-offline` and its lines stay `wanted`, **not failed**.
- For a browser folder, the stored directory handle reports `needs-permission`. The prompt's button calls the permission request from a user gesture, and work resumes.
- For a plain browser file picker, files can't be accessed again. The person reselects, and the new files are matched to wanted lines by (relative path, size, mtime).
- Matching only routes a file to its line. Bytes are still hashed, so a wrong match can't corrupt anything. At worst it creates an extra sighting.

*(The browser permission behaviour here is from my knowledge of the File System Access API. I did not check it in this repo.)*

**3. Overlapping reselection.**
- The person selects the same folder plus new files. This creates a new Request with its own lines.
- Lines whose bytes already exist end up `held, new: false`. They are counted as "already in library", not as copies. Each one adds a Sighting only if its provenance is new.
- If two active requests want the same (source, locator), the worker reads it once and resolves both lines.
- **Withdrawing one request doesn't stop work another request still wants.**

**4. Preview fails after a successful copy.** The line is `held`, so the import counts it as kept. The item appears in the grid with a "Can't preview" badge. Its Finding `preview@3: failed` shows in diagnostics with the reason. The original can be exported or opened externally. A later `preview@4` retries it automatically.

**5. Cancel, then retry.**
- `withdrawRemaining()` sets the wanted lines to `withdrawn` and leaves the 52,000 held items in the library.
- If the person actually wants those gone, that is a **separate, explicit library action**: "Remove 52,000 items imported only by this request?" It never happens as a side effect of cancelling.
- Later, `retry({ outcome: ['problem','withdrawn'] })` sets those lines back to `wanted`.
- Retry is idempotent because writes are keyed by hash. Anything that arrived in the meantime through another request resolves as `new: false`.

## What disappears

| Current piece | What happens to it |
|---|---|
| `ImportManager` and completion callbacks | Gone. The lines table *is* the queue, workers claim rows, and every screen queries the same rows. With one durable owner, there are no callbacks to keep consistent. |
| `CopyQueue`, `PreviewQueue`, `ManifestStore`, `ImportSessionStore` (each persisting its own progress) | Replaced by Request + lines and by Findings. |
| `DuplicateIndex`, `duplicateOf` | Replaced by the hash primary key. |
| `destinationPath` | Derived from the hash. |
| Session `status` enum | Gone. Phases like `copying` and `processing` lumped together independent work. `ready` vs `failed` couldn't express "51,997 kept, 3 problems". `scanning` becomes visible enumeration: lines appear incrementally and resume from the last enumerated cursor. |
| `copyStatus` × `decodeStatus` on one entry | Split. The first belongs to the source read. The second belongs to the bytes and is shared by every sighting of them. |
| `sourcePath` | Becomes a locator, with access held separately by the Source. |
| `MetadataStore` | Split in two. Raw facts are immutable provenance, stored on the Sighting (filename, sidecar JSON, device capture data) or inside the original's bytes (EXIF). Interpretation is a versioned Finding. Raw metadata therefore survives any parser. |

## New concepts and their cost

- **Hashing every byte read.** The copy reads the bytes anyway. The real cost appears on reselection: overlapping files are **re-read even though they aren't re-written**. This is what guarantees "every distinct byte sequence" when an edited file keeps its size and mtime.
- **Source identity separated from access.** This adds per-kind identity rules, such as phone asset ids and volume UUIDs. It is what makes "plug it in to continue" possible.
- **Deriver versioning** and a **temp-file sweep**.
- **"Already in library"** as a count the person sees, so a re-import of 80,000 files that writes nothing doesn't look broken.

## Proposed changes to explicit requirements

1. **Proposal: "cancel" means "stop remaining", and removal is a separate explicit action.** This keeps the requirement and makes its boundary visible in the UI.
2. **Proposal: let sources with strong revision identity skip re-reading.** For example, a phone photo library exposes an asset id plus a modification revision. For such sources, a known (locator, revision) could resolve without reading. Folders and archives would always hash. That trades a source-specific trust rule for much faster re-import of large overlapping video selections. **This is the decision I most want your judgment on.** I recommend hash-always for v1 and revision trust only where the platform guarantees it.
3. **Proposal: requests are history, not something you manage.** The person sees one row per source ("Pixel 8: 3,204 left"). Requests stay underneath so that each decision can be paused, withdrawn or retried on its own.

## Sources and uncertainty

I read `REQUEST.md`, the rethink skill and its `greenfield.md`, `radical-options.md` and `clean-breaks.md` references, and the dialectic skill. There is no implementation in the repo, so everything above is a proposal and none of it is confirmed behaviour.

Open questions:
- **Phone-transfer guarantees.** Whether the platform's phone APIs (MTP/PTP, PhotoKit) provide stable asset ids and revisions decides proposal 2.
- **Archive sidecars.** Whether sidecar metadata (e.g. Takeout JSON) should be its own Sighting attachment or stored as an Original.
- **Removal across requests.** What "remove items imported only by this request" should do when an item has sightings from several requests.

I have no execution evidence to ask for at this stage.


## Pair 2, response A

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


## Pair 2, response B

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


