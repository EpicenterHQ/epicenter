# 0194. Mirrors rebuild on declaration fingerprints, not hand-stamped versions

- **Status:** Accepted
- **Date:** 2026-07-31
- **Relates:** [ADR-0061](0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md), [ADR-0063](0063-the-local-books-mirror-is-a-multi-writer-cache-made-safe-by-one-monotonic-write-door.md), [ADR-0064](0064-the-local-books-mirror-keeps-one-realm-cdc-cursor-table-existence-is-the-per-entity-init-latch.md), [ADR-0176](0176-lenses-declare-no-query-capabilities-indexed-reads-require-separate-owners.md), [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md)

## Context

An external-authority mirror contains only facts that can be pulled again, so
its stored shape does not need migrations. A hand-maintained schema version is
therefore an unnecessary correctness gate: forgetting to bump it can leave old
tables behind while new code reads them as if they had the new shape.

## Decision

A mirror's rebuild gate is the SHA-256 fingerprint of its rebuild-relevant
declaration. The declaration is deterministic plain data describing the stored
row shape and projections. Canonical serialization sorts object keys, preserves
array order, rejects unsupported values, and prefixes the serialized value with
an explicit domain and format tag before hashing.

Only the writer compares and stamps the fingerprint. A missing or different
fingerprint drops the derived tables, clears sync cursor state, removes retired
version metadata, and stamps the current fingerprint. A reader never rebuilds or
stamps; it may report that the on-disk mirror is stale.

Indexes, paths, authority identity, configured runtime subsets, cursors,
credentials, engines, and network behavior are not fingerprint inputs. Indexes
are re-applied idempotently because changing a query optimization must not force
a full re-pull.

This is safe only because every mirror value is regenerable from its external
authority. User-owned facts belong in Epicenter source-of-truth data, not in the
mirror.

## Consequences

- Shape and projection changes automatically force a clean rebuild.
- Reformatting or reordering declaration objects does not force a rebuild.
- A mirror may be rebuilt wholesale; there is no migration reader or compatibility range.
- The fingerprint is a declaration identity, not a freshness indicator or authority identity.
- The eventual `defineMirror`/`openMirror` API must preserve this ownership split, but this record does not freeze that package surface.

## Considered alternatives

- **Hand-stamped schema versions:** rejected because correctness depends on reviewer memory.
- **Hashing `JSON.stringify`:** rejected because object insertion order becomes rebuild behavior.
- **Hashing function source:** rejected because formatting and bundling changes are not stored-shape changes.
- **Including indexes:** rejected because indexes contain no mirror facts and are idempotently applied.
- **Per-table fingerprints:** deferred; whole-mirror rebuild keeps cursor invalidation and rebuild ownership simple until measured cost justifies finer granularity.
