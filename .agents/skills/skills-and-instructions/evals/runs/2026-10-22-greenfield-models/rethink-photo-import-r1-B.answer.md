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
