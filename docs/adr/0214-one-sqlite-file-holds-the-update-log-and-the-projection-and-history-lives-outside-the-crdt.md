# 0214. One SQLite file holds the update log and the projection, and history lives outside the CRDT

- **Status:** Accepted
- **Date:** 2026-08-07
  skew clamp and a version re-stamp. That draft was `Proposed`, and its subject
  no longer exists: ADR-0212 removed the wall clock from the merge entirely, so
  there is nothing to clamp and no version to lower. Rewritten in place.
- **Amended by:** [ADR-0256](0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md)
  at workspace replacement: no user-directed rebuild or whole-document
  replacement path exists today. Local in-place replacement remains refused,
  and a stale local document is discarded rather than merged. A future Compact
  workspace action is a separate decision.
- **Relates:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md),
  [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md).
- **Revives:** [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md)
  (`Accepted`). The earlier 0212 draft withdrew its append log, saying "append
  admission and compaction stop being concepts". That withdrawal is itself
  withdrawn. 0159's design governs again, unchanged in substance.

## Context

The store is a Yjs document (ADR-0212). Something has to hold its bytes, and
something has to answer "what did this look like last month" now that `gc: true`
means the CRDT itself keeps no history: a field edited 5,000 times collapses to
two structs and 0.1 KB.

Loose files were considered and are not merely worse, they are impossible on the
runtime this record does not yet target. A browser replica already owns an OPFS
synchronous-access-handle pool, and a second live owner beside it is refused with
`NoModificationAllowedError`, measured in the throwaway OPFS document-log
experiment at git ref `c5f0fed3cf`. A `data.yjs` file has nowhere to live in a
browser.

**The browser is deferred.** This record targets Bun and Tauri only: one
`bun:sqlite` file per application. That defers `sqlite-wasm`, the OPFS pool, the
worker protocol, and the single-owner lease question. It is a real cut, because
Whispering is browser-hostable today, and it is taken so the first build has one
storage backend rather than two. The layout below is chosen to survive the
browser arriving later, which is the second reason it is one SQLite file: that
shape ports to `sqlite-wasm` over OPFS, and loose files do not port at all.

## Decision

### One file per application, holding both planes

```sql
-- so.epicenter.<app>/store.sqlite3

CREATE TABLE _updates (          -- the Yjs updateV2 append log. THE TRUTH.
  document TEXT    NOT NULL,     -- 'index' or 'notes/n1/body'
  seq      INTEGER NOT NULL CHECK (seq > 0),
  bytes    BLOB    NOT NULL,
  PRIMARY KEY (document, seq)
) WITHOUT ROWID, STRICT;

-- the lens projection tables live in this same file.
```

An append and the projection write it implies happen in **one transaction**, so
the two can never disagree and `query` always sees committed local writes. That
read-your-writes guarantee is the reason they share a file rather than merely a
directory.

<!-- doc-path-check: ignore-next-line (names a file the superseded stack carried; ADR-0227 deleted it) -->
This is not new. `packages/app/src/data/documents.ts:283-346` already does it: one
`database.transaction()` that checks liveness, inserts at `MAX(seq)+1`, and at
`COMPACTION_THRESHOLD = 64` (`documents.ts:14`) replays the chain through a fresh
`gc: true` document, deletes it, and writes one baseline row. ADR-0159 is the
decision. The symbol died with the workspace runtime plane in PR #2469; the
design did not.

### History is a base plus a stream, in a second file

Collapse is what keeps the live log small, and history is what collapse would
otherwise destroy. So collapse copies the rows it is about to delete into a
history file first, and a crash duplicates an entry rather than losing one:

```sql
-- so.epicenter.<app>/history.sqlite3
CREATE TABLE _history (
  document TEXT NOT NULL, seq INTEGER NOT NULL,
  taken_at INTEGER NOT NULL, bytes BLOB NOT NULL,
  PRIMARY KEY (document, seq)
) WITHOUT ROWID, STRICT;
```

Restoring to time `T` is: a fresh document, apply the base, apply every entry
with `taken_at <= T`. One changed field is 43 bytes on the wire, so at a hundred
edits a day this is about 4 KB a day and 1.5 MB a year. It can save on every
transaction without anyone thinking about it.

Set `PRAGMA auto_vacuum = INCREMENTAL` on the history file so pruning returns
disk.

### Restore produces a copy. It never happens in place

```txt
so.epicenter.honeycrisp/store.sqlite3        live
so.epicenter.honeycrisp/history.sqlite3      what collapse superseded
```

A restored document opens read-only, beside the live one. Copying rows out of it
into the live document is an ordinary write, so it merges like any other edit and
no other device has to participate.

**Restoring in place does not work, and its failure is silent.** Every other
device still holds the newer operations and re-sends them, so the restore quietly
undoes itself. Making it stick would require every device to replace at the same
moment, which is the operation refused below.

### A rebase is refused

Rebuilding the document from its final state, dropping history and tombstones,
was measured on a corpus of 200 rows with 100 deleted and 20 revisions each:

```txt
origin                                    192.1 KB
rebased, fresh document, no history       189.5 KB      1% smaller
```

One percent, because `gc: true` already collapsed everything a rebase would
reclaim. What it costs when one device misses it:

```txt
the laggard's offline edit         destroyed
body length                        3778 chars, against 1860 rebased      doubled
merged size                        379.9 KB, against 189.5 KB            doubled
```

Content duplicates, because the two lineages share no ancestry and neither knows
about the other. A control merge between two devices on the same lineage
converged cleanly at 1,885 characters.

**The test that sorts every mechanism here: if one device is in a drawer while
this happens, what breaks?** Nothing breaks for an append, a collapse, or a
delete, so those need no coordination. A rebase breaks everything, so it is not
an operation and is not offered.

## Consequences

- **Deleted, relative to the record this replaces:** the five-minute clock clamp,
  the re-stamp, its floor family, the refusal protocol, and the measured
  3.56% loss of re-stamped field cells. ADR-0212 removed the wall clock from the
  merge, so the entire subsystem lost its subject rather than being simplified.
- **The projection is a cache with a rebuild path.** Dropping and rebuilding it
  costs 2 ms on the real vault. A bug in the materializer is therefore
  recoverable, which a bug in an in-place upsert would not be.
- **History is per application, not per row.** Answering "what did this note say
  in June" replays that document's stream, which is cheap because a document is
  about 2.8 KB.
- **The live log grows to 64 updates before collapsing**, so the file oscillates
  rather than growing. Only the history file grows monotonically, and it is the
  one with a pruning pragma and no correctness role.
- **A second OPFS owner remains impossible**, so any future durable artifact for
  an application goes in one of these two files or through the same owner.
