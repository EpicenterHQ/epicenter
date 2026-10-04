# Local Photos: a Takeout-native import ledger, not a Google Photos sync client

- **Status:** In Progress
- **Date:** 2026-07-09
- **Kind:** Greenfield app design memo (destined to split into one or two ADRs on acceptance)
- **Proposed home:** `apps/local-photos/` (AGPL, standalone Bun CLI, `local-mail`/`local-books` shell reused)
- **Proposed ADRs:** [ADR-0114](../docs/adr/0114-local-photos-is-an-import-ledger-not-a-google-photos-sync-client.md), [ADR-0115](../docs/adr/0115-local-photos-deletes-only-from-local-tombstones-not-source-absence.md)

## Product sentence

Local Photos owns a private, content-addressed photo and video archive on your own
machine, with full provenance of where every asset came from; Google Photos is one
import source among several, never the system of record.

That sentence is the whole design. Everything below is what it forces and what it
refuses.

## The forced inversion (why this is not a sync client)

`local-books` and `local-mail` are the house pattern for "mirror a Google/Intuit
account into local SQLite." Both are **disposable CDC mirrors**: the upstream owns
truth, a monotonic cursor (`historyId`, QuickBooks `/cdc`) drives incremental pulls,
the DB is dropped and rebuilt on any `SCHEMA_VERSION` bump because it is a cache
(`local-mail/src/db.ts:175`), a CDC delete becomes a soft-delete tombstone because
the upstream stopped carrying the object, and every human action round-trips through
the provider (ADR-0098, ADR-0061).

Google Photos after March 31, 2025 satisfies **none** of those preconditions. This is
verified, not assumed:

| Precondition the mirror pattern needs | Google Photos reality (mid-2026) |
|---|---|
| Full-library read API | Gone. Library API is app-created-media only; `photoslibrary.readonly` returns `403 PERMISSION_DENIED`. You can only read what your own app uploaded. |
| A changefeed / cursor | None. There is no `history.list` equivalent for the library. |
| A write surface for arbitrary items | None. `appendonly` writes only new app-created media. |
| Deletes carried as tombstones | None. Incremental Takeout (shipped ~June 2026) is **additive only**: "items uploaded, backed up, created, or edited since your last successful backup." No source represents deletions or album removals. |
| A disposable local copy (rebuildable from upstream) | Impossible. If we drop the DB there is no API to rebuild it from. **The local copy is the system of record.** |

So Local Photos cannot be a mirror. It is the inverse: **the local archive is
authoritative and precious, fed by append-only, immutable import batches.** The
drop-and-rebuild-on-schema-bump trick that `local-mail`/`local-books` rely on is
**forbidden** here; migrations must preserve data.

## The asymmetric win

Refuse the promise "sync Google Photos." Preserving that promise forces an entire
implementation family; refusing it deletes all of it:

- Browser automation of the Photos web UI (the fragile, attended backbone of half the
  prior art: `docker-gphotos-sync`, `vikas5914`, the download half of `gpb`; all break
  on login/passkey/DOM changes and cannot run unattended).
- The now-dead Library-API OAuth path, its restricted-scope CASA verification, and the
  archived tools built on it (`gphotos-sync`, archived 2024-10-04).
- CDC cursor / changefeed emulation (there is no feed to emulate).
- Deletion-sync and album-membership reconciliation (no tombstones exist to reconcile).
- Write-through / round-trip machinery (Google is not the system of record here).
- The entire "keep it live, minimize latency" game.

What survives is small and durable: unzip a Takeout, hash every media file into a
content-addressed blob store, match sidecars, and record each run as one immutable
evidence batch. Takeout is the **official, stable** rail Google keeps investing in
(it just gained scheduled incrementals); the API is the surface Google keeps
narrowing. We bet on the rail that is getting better.

**Named asymmetric win:** trade live-sync fidelity and exact-parity with Google
Photos' library state for the deletion of the browser-automation subsystem, the
Library-API subsystem, and the CDC/tombstone reconciliation subsystem. One product
refusal, three subsystems gone.

## Compatibility contracts

**None owed.** Greenfield, no users, no wire compatibility to Google Photos, no API to
emulate. The only external shapes we *read* (best-effort, defensively) are:

- Google Takeout Photos archive layout (album folders, year buckets, `-edited`
  duplicates, split zip parts).
- The per-photo JSON sidecar (`<name>.supplemental-metadata.json` since late 2024,
  truncated to ~46 chars in practice; older `<name>.jpg.json`). Google publishes no
  schema for this, so the parser treats every field as advisory.
- EXIF/XMP embedded metadata.

These are inputs to parse, not contracts we uphold. When Google changes the sidecar
name again, we add a matcher heuristic; nothing downstream breaks because raw evidence
is preserved separately from normalized state (see below).

## Value owners

Each owner is a single table or on-disk structure with one job. The novel ones versus
`local-mail`/`local-books` are the **blob store** (binary media, not JSON) and the
**provenance claim** (multi-source metadata that is never overwritten).

1. **Blob store** (`blobs/<ab>/<sha256>` on disk + `blobs` table). Content-addressed,
   immutable binary media. Identity is the sha256 of the bytes. Deduplication is free:
   the same photo in a full Takeout and three incrementals is one blob. This is the
   actual archive; the DB is an index over it.
2. **Import manifest** (`imports`). One row per import run: the immutable evidence
   batch. Source kind, source locator, timestamps, counts, warnings, status.
   Append-only; a finished import is never mutated.
3. **Import item** (`import_items`). One row per file observed in an import: the raw
   evidence layer. Verbatim archive path, matched sidecar path, the verbatim sidecar
   JSON, and the blob hash it resolved to. Kept forever, never normalized over. This is
   what lets us re-run the resolver, debug a mismatch, or survive a sidecar-format
   change.
4. **Provenance claim** (`claims`). What one source *said* about one asset ("Takeout
   batch #3's sidecar says taken 2019-06-01, album Japan, geo X"). Many claims per
   asset. Never overwritten. This is the structural home of "a source disappearing
   means a stale claim, not a delete."
5. **Normalized asset** (`assets`). The deduplicated logical photo/video, keyed by blob
   hash. Carries the *resolved* best-guess metadata (taken-at, geo, dimensions,
   live-photo pairing). Fully derivable from claims by a pure resolver; recomputable
   with no re-import.
6. **Album / grouping** (`albums`, `album_members`). Albums as observed in Takeout.
   Membership is itself a per-import claim: absence in a later export is *not* removal.
7. **Local tombstone** (`tombstones`). A *local* decision to delete an asset from the
   archive. The only thing that ever hides an asset. Optional blob purge after a
   retention window. Never triggered by source disappearance.
8. **Source status** (derived from `imports`, no dedicated table). Per configured
   source: last import at, last manifest, and staleness. "Unobserved since X" is a
   reported state, never a delete trigger.

**The one invariant that separates this from the mirror pattern:** `local-books`
soft-deletes on a CDC delete because the upstream is authoritative and the local blob
is the last copy. Local Photos does the *reverse*: it never deletes on source absence,
because Takeout absence carries no meaning (it is not a changefeed) and Local Photos is
itself the last copy. Deletion has exactly one source: an explicit local tombstone.

## SQLite schema sketch

Blobs live on disk; the DB indexes them. Unlike the mirror apps, there is **no cursor**
(no changefeed) and **no drop-and-rebuild** (the DB is precious). Migrations are
additive and preserving.

```sql
-- Immutable binary media, content-addressed.
CREATE TABLE blobs (
  hash       TEXT PRIMARY KEY,        -- sha256 of the bytes
  bytes      INTEGER NOT NULL,
  mime       TEXT,                    -- sniffed at ingest
  stored_at  TEXT NOT NULL,
  purged     INTEGER NOT NULL DEFAULT 0  -- blob file removed, metadata retained
);

-- One row per import run: the evidence batch.
CREATE TABLE imports (
  id             TEXT PRIMARY KEY,     -- opaque import id (UUID in the first checkpoint)
  fingerprint    TEXT NOT NULL UNIQUE, -- paths + content hashes; exact re-imports collapse
  source_kind    TEXT NOT NULL,        -- google_takeout_full | google_takeout_incremental
                                       -- | google_picker_session | local_folder_scan | device_import
  source_locator TEXT,                 -- zip path / picker session id / scanned dir
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  status         TEXT NOT NULL,        -- running | complete | partial | failed
  files_seen     INTEGER,
  blobs_new      INTEGER,
  sidecars_seen  INTEGER,
  warnings       TEXT                  -- JSON array of structured warnings
);

-- One row per file observed in an import: raw evidence, never normalized over.
CREATE TABLE import_items (
  id           INTEGER PRIMARY KEY,
  import_id    TEXT NOT NULL REFERENCES imports(id),
  blob_hash    TEXT REFERENCES blobs(hash),  -- null if the file was unreadable
  content_hash TEXT NOT NULL,           -- every observed file, including JSON/unknown
  archive_path TEXT NOT NULL,          -- verbatim path inside the Takeout
  original_name TEXT,
  sidecar_path TEXT,                   -- matched sidecar, if any
  kind         TEXT,                   -- media | sidecar | album_metadata | unknown
  raw_sidecar  TEXT                    -- verbatim sidecar JSON (evidence)
);

-- The normalized logical asset, keyed by content identity.
CREATE TABLE assets (
  hash          TEXT PRIMARY KEY REFERENCES blobs(hash),
  kind          TEXT,                  -- image | video | motion_photo
  taken_at      TEXT,                  -- RESOLVED from claims
  geo_lat REAL, geo_lng REAL,          -- resolved
  width INTEGER, height INTEGER,
  live_pair_hash TEXT,                 -- companion still/motion blob
  first_seen_import TEXT REFERENCES imports(id),
  last_seen_import  TEXT REFERENCES imports(id),
  resolved_at   TEXT
);

-- Provenance: what a source SAID about an asset. Append-only, never overwritten.
CREATE TABLE claims (
  id          INTEGER PRIMARY KEY,
  asset_hash  TEXT NOT NULL REFERENCES assets(hash),
  import_id   TEXT NOT NULL REFERENCES imports(id),
  source_kind TEXT NOT NULL,
  origin      TEXT,                    -- exif | takeout_json | filename | picker_metadata
  taken_at    TEXT, geo_lat REAL, geo_lng REAL,
  claimed_name TEXT,
  raw         TEXT                     -- verbatim claim JSON
);

CREATE TABLE albums (
  id          TEXT PRIMARY KEY,        -- derived from title + source
  title       TEXT,
  source_kind TEXT,
  first_seen_import TEXT REFERENCES imports(id),
  last_seen_import  TEXT REFERENCES imports(id)
);

-- Membership is a per-import CLAIM; absence in a later import is not removal.
CREATE TABLE album_members (
  album_id   TEXT REFERENCES albums(id),
  asset_hash TEXT REFERENCES assets(hash),
  import_id  TEXT REFERENCES imports(id),
  PRIMARY KEY (album_id, asset_hash, import_id)
);

-- The ONLY thing that ever hides an asset. Local decisions only.
CREATE TABLE tombstones (
  asset_hash  TEXT PRIMARY KEY REFERENCES assets(hash),
  reason      TEXT,
  created_at  TEXT,
  blob_purged INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version; NO cursor
```

Invariants:

- `blobs`, `imports`, `import_items`, `claims`, `album_members` are append-only after
  their run finishes (imports flip `running -> complete/failed` and nothing else).
- `assets.*` derived fields are a pure function of `claims`; recomputing them requires
  no re-import. The resolver, not the importer, owns "which claim wins."
- Re-importing the same Takeout is idempotent: same bytes to same hashes, duplicate
  claims collapse, no asset is duplicated.
- Read models filter out tombstoned assets. Source staleness is a `SELECT`, not a
  mutation.

## CLI shape

Borrows the `local-books` shell wholesale (loopback `app`, `status`, `query`, `mcp`,
the read-only gate, the `0600`/`0700` file discipline, the `src/<domain>/*` verb-core
seam that CLI + MCP + HTTP all reuse). It drops everything sync-shaped (no `connect`,
no OAuth, no `--watch` cursor loop) because there is no live account to connect to.

```
local-photos import <path>            # ingest a Takeout zip/dir as an immutable evidence batch
                    [--incremental]   # tag the batch source_kind; default inferred from archive
local-photos scan <dir>               # (V2) import a local folder as a source
local-photos status                   # sources, last import per source, counts, staleness
local-photos query "<sql>"            # read-only SQL over assets/claims/albums/imports
local-photos resolve                  # recompute normalized assets from claims (no re-import)
local-photos rm <assetHash...>        # write a LOCAL tombstone (optional --purge-blobs)
local-photos app [--no-open] [--port] # (V3) loopback gallery SPA + same-origin /api
local-photos mcp                      # (V3) stdio MCP: query/status/resolve tools to an agent
```

Key differences from the mirror apps, made explicit in `--help`: `import` is the only
ingress and it is additive; there is no command that deletes an asset from a remote;
`rm` is a local decision; source absence never removes anything.

## Waves

### V1 execution checkpoint

- [x] Add the private Bun CLI package, preserving SQLite migration gate, and
  `0700`/`0600` archive permissions.
- [x] Import an extracted Takeout directory as one immutable, content-fingerprinted
  manifest; exact re-imports reuse the first manifest.
- [x] Stream SHA-256 hashing and write media to the two-character-sharded blob store.
- [x] Preserve one evidence row per observed file, match common old and supplemental
  sidecar names, and keep unmatched sidecars with structured warnings.
- [x] Record filename and Takeout JSON claims, resolve timestamps and coordinates,
  and expose `status`, bounded read-only `query`, and `resolve` commands.
- [x] Prove deduplication, exact re-import idempotence, read-only SQL, and the
  source-absence-is-not-delete invariant in integration tests.
- [ ] Ingest multipart zip archives without buffering a complete archive or video.
- [ ] Parse album metadata and membership claims.
- [ ] Add EXIF claims, edited-variant relationships, and live-photo handling at the
  wave boundaries below.
- [ ] Record running/failed manifests and commit per archive part so a crash only
  loses the in-flight part.

The first checkpoint deliberately accepts an extracted directory rather than a zip.
That proves the ownership model without choosing a large-archive extraction strategy
prematurely. The database records only completed imports in this checkpoint; resumable
and failed-run manifests belong with multipart archive ingestion. Album JSON is
preserved as `album_metadata` evidence, but the checkpoint does not create album tables
until the membership parser earns their final shape.

**V1 (smallest useful, the whole thesis in one command): Takeout in, queryable archive
out.** `import` + `status` + `query` + `resolve`. Walk a Takeout tree, hash media into
the blob store, match sidecars (the hard part; see risks), write one manifest, its
items, claims, and resolved assets. Idempotent re-import. Albums parsed into
`album_members` as claims. This proves: content-addressed dedup, the immutable-batch
model, and claim-based metadata resolution. Nothing else is needed to own an archive.

**V2: many sources feed one archive.** `scan <dir>` (local folder), Picker import
inbox (`import --picker`, a user-driven one-shot session honoring the 60-minute
baseUrl + auth-header fetch), better album modeling, and resolver refinement
(EXIF-vs-sidecar conflict rules, live-photo pairing). All new sources are just more
`source_kind` values feeding the same manifest model; no new backbone.

**V3: Local Photos becomes the first owner of new originals.** Device/mobile capture
lands originals in Local Photos *first*, with Google Photos as an optional downstream
*export* edge (upload via `appendonly`, the one thing the crippled API still allows for
app-created media). This completes the inversion: Google Photos becomes a mirror of
Local Photos, not the reverse. Plus the loopback `app` gallery and `mcp` surface.

## Refused promises (explicit)

- No live/continuous sync with Google Photos. (The API cannot back it; the web-UI
  automation is brittle and attended.)
- No remote deletion propagation. Takeout carries no tombstones, so we cannot and will
  not remove or unlink an asset because it stopped appearing.
- No browser automation as the product backbone. If ever added, it is one optional
  source behind the same manifest model, never the spine.
- No generic provider-CDC abstraction. We build it when a real provider hands us a
  cursor *and* tombstones. None does today; abstracting over one instance is
  speculative.
- No destructive import cleanup. Raw evidence (`import_items.raw_sidecar`, verbatim
  paths) is preserved separately from normalized `assets`. The importer never edits the
  bytes it ingests.
- No claim of exact Google Photos parity (Memories, sharing state, exact ordering, face
  groups). We own our archive's truth, not a reconstruction of Google's product state.
- No dependence on scheduled incremental Takeout being reliable. If an incremental
  arrives, it is just another append-only batch. If it does not, a fresh full Takeout
  re-imports idempotently and dedups by hash. The design degrades to "periodic full
  re-import" with zero code change.

## Open risks and verification plan

1. **Sidecar-to-media matching under filename truncation (THE risk).** Names are
   clipped to ~46 chars, yielding `.supplemental-metadata.json`,
   `.supplemental-metadat.json`, `.supplementa.json`, plus `IMG(1).jpg` vs
   `IMG.jpg(1).json` disambiguation. This is the #1 documented failure across every
   Takeout tool. *Plan:* build a heuristic matcher (longest-common-prefix + duplicate
   disambiguation), and because `import_items` keeps every unmatched file and raw
   sidecar, a matcher improvement is a `resolve` re-run, not a re-import. Validate
   against a real Takeout export and against the documented `immich-go` / GPTH matching
   rules (read the *heuristics*, write our own code; those tools are GPL/AGPL and this
   app is AGPL, but copying source across a package license boundary is still a
   relicensing act, so we reference behavior, not code).
2. **EXIF stripped/rewritten by Google; truth lives in the sidecar.** *Plan:* the
   resolver treats `takeout_json.photoTakenTime` as authoritative over embedded EXIF;
   both are kept as separate claims so the choice is auditable and reversible.
3. **Live-photo / motion-photo pairing** (`.MP`/`.MOV` companion to `.HEIC`/`.JPG`)
   is largely unsolved in prior art. *Plan:* deferred to V2 resolver; V1 ingests both
   blobs and leaves `live_pair_hash` null rather than guessing wrong.
4. **`-edited` duplicate inflation.** *Plan:* both blobs are stored (immutable
   evidence); the resolver marks the edited variant as derived so counts stay honest.
5. **Incremental Takeout has no deletion signal (confirmed by absence across four
   sources, not a Google statement).** *Plan:* already the design's core assumption;
   no action needed beyond never treating absence as delete. Re-verify if Google
   documents scheduled-export semantics officially.
6. **Blob-store scale** (100k+ files). *Plan:* 2-char sharded dirs, stream-hash on
   import (never buffer whole files), commit per archive-part so a crash loses only the
   in-flight part (mirrors `local-mail`'s per-page commit at `db.ts:483`).

## Smallest first skeleton (if the spec is accepted)

`apps/local-photos/` with the `local-books` file skeleton (`bin.ts`, `cli.ts`,
`config.ts`, `db.ts`, `paths.ts`), a `src/import/takeout.ts` walker, a
`src/import/sidecar-match.ts` matcher, a `src/blobs/store.ts` content-addressed writer,
and a `src/photos/{query,status,resolve}.ts` verb-core trio. One command lights up the
thesis end to end:

```
local-photos import ~/Downloads/takeout-photos.zip
local-photos query "SELECT taken_at, claimed_name FROM assets a
                    JOIN claims c ON c.asset_hash = a.hash
                    ORDER BY taken_at DESC LIMIT 20"
```

Everything else (Picker, scan, app, mcp, export-to-Google) is additive on top of the
manifest model and can wait for a live producer.

## Suggested ADR split on acceptance

- ADR: "Local Photos is an import ledger, not a sync client" (the inversion + the
  system-of-record flip + the no-drop-and-rebuild rule).
- ADR: "Source absence is never a delete; deletion has one local source" (the tombstone
  invariant and the additive-only Takeout consequence).

(ADR frontier is 0113; next free numbers apply.)
