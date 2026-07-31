# 0194. A mirror rebuilds on its declaration's fingerprint, not a hand-stamped version

- **Status:** Accepted
- **Date:** 2026-07-31
- **Amends:** [ADR-0192](0192-every-epicenter-mirror-satisfies-one-write-contract-and-one-credential-contract.md) at clause A, where "a schema change is a version bump that rebuilds" becomes a fingerprint the declaration derives rather than a number a person maintains; [ADR-0193](0193-durable-authorities-preserve-truth-disposable-materializations-can-always-be-rebuilt.md) at "a materialization's owner stamps a schema version", which becomes stamping the fingerprint of its declaration. Neither record's substance moves: a shape change still drops the store and re-pulls, and there is still no migration reader.
- **Relates:** [ADR-0063](0063-the-local-books-mirror-is-a-multi-writer-cache-made-safe-by-one-monotonic-write-door.md) (the writer-only door this gate sits behind), [ADR-0064](0064-the-local-books-mirror-keeps-one-realm-cdc-cursor-table-existence-is-the-per-entity-init-latch.md) (the cursor a rebuild clears and the table-existence latch that refills it), [ADR-0061](0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md) (facts from the mirror, opinions live), [ADR-0176](0176-lenses-declare-no-query-capabilities-indexed-reads-require-separate-owners.md) (an index needs an owner who can rebuild it)

## Context

Both mirror records leave the rebuild trigger as a version a person stamps by
hand. Local Books shipped exactly that: `SCHEMA_VERSION = '2'`, a literal whose
only job was to be remembered in the same commit that changed a column, a JSON
path, or the shared row shape.

Nothing checked it, and the two ways of getting it wrong are not symmetric.
Forget the bump and every existing mirror keeps tables built under the old
declaration while the code reads them under the new one: a column projecting a
path that moved, a select naming a column the table never got. That is silent,
it survives every later sync, and the store looks healthy the whole time. Bump
it needlessly and the only cost is one re-pull of data the upstream still owns.

A gate whose correctness depends on reviewer memory is the wrong gate for a
store whose entire premise is that throwing it away is cheap. The declaration
that decides the shape is already plain data sitting in the tree; it can answer
the question itself.

## Decision

**A mirror declares its shape as plain data, and the rebuild gate is that
declaration's fingerprint.**

**The declaration is the whole input and the only input.** It carries the shared
row shape and, per table, the table's name and its projected columns. For Local
Books that is `MIRROR_DECLARATION` in `apps/local-books/src/entities.ts`, built
from the entity registry rather than restated beside it, so there is no second
copy to fall out of date. The physical tables are created from the same value.

**The fingerprint is SHA-256 over `<domain>` + NUL + the canonical JSON of the
declaration**, lowercase hex. Canonical means object keys sorted by UTF-16 code
unit, arrays left in order, no whitespace (the JSON Canonicalization Scheme,
RFC 8785). The domain is an explicit type-and-version tag, so two kinds of
declaration cannot collide and bumping the tag is itself a way to force a
rebuild. `JSON.stringify` is not enough: it would leak the order properties
happened to be authored in, so moving a key would rebuild a mirror for nothing.

**Only a writer rebuilds.** On a writer open, if the fingerprint stamped in the
store differs from the running build's, the owner drops every derived table,
clears the sync cursor state, and stamps the new fingerprint. An absent stamp
counts as different, which is deliberate: it covers a fresh store, where the
rebuild does nothing, and a store built before this gate existed, where it does
it once. The stamp is written only by a rebuild, so it always describes tables
that exist.

**A reader never rebuilds and never stamps.** A read-only handle over a stale
mirror reads it stale and says so (`readBooksStatus` reports the stamp and
whether a rebuild is pending). Rebuilding is a write, it drops tables, and it is
the sync owner's job.

**What the fingerprint deliberately does not cover**, named so absence is a
decision rather than an oversight: indexes, the configured subset of tables a
given run mirrors, directory paths, the upstream principal's identity, cursors
and other sync position, credentials, the storage engine, and anything about the
process or network. An index holds no data of its own and is re-applied
idempotently on every open, so putting it in the gate would bill a query
optimization at the price of a full re-pull.

**Fingerprint equality is a statement about one thing.** It says the store's
tables were built from the same declaration this build carries. It says nothing
about whether the upstream still has the same data, whether the rows are fresh,
or whether an older release could read the file. There is no compatibility
range, no ordering between fingerprints, and no "close enough".

**The precondition is regenerability, and it is not negotiable.** Dropping the
store on a mismatch is only safe because everything in it can be pulled again
from the upstream authority (ADR-0193). A mirror that acquires one human-authored
field acquires a data-loss bug at the next declaration change, and this record
protects none of it.

**Not decided here:** whether this becomes a shared `defineMirror` /
`openMirror` package API. ADR-0192 already defers the package to a third
provider. This record fixes the mechanic so that API, when it is designed, is
designed from something proven rather than from options.

## Consequences

- A shape change can no longer ship without the rebuild it needs. The commit
  that moves a JSON path moves the fingerprint in the same edit, with nothing to
  remember.
- A change that touches no shape can no longer cost a rebuild. Adding an index,
  renaming a local, reformatting the registry, or reordering its keys leaves the
  fingerprint alone.
- The cost is granularity. The gate is one fingerprint per store, so a
  declaration change re-pulls the whole store, including tables it did not
  touch. Adding an entity to the Local Books registry now costs one full company
  pull, where the hand-stamped version let an author decline to bump. That is
  the safe direction of the asymmetry, and it is priced in time against an
  upstream that still owns the data.
- The transition needs no compatibility code. A pre-fingerprint mirror carries no
  stamp, so it rebuilds once on first open under the new engine, and that
  rebuild is where its retired `schema_version` row is deleted. Nothing reads
  the old key.
- Local Books' `_meta` gains `mirror_fingerprint` and loses `schema_version`.
  `local-books status` reports the shape's short prefix and says plainly when the
  next sync will rebuild.
- The next mirror gets the gate as a rule rather than a copied literal, and it
  fits under ADR-0192's conformance check item 2 ("a schema-version mismatch
  rebuilds; no code reads an older shape") without weakening it.
- What this forecloses: a reviewer waiving a rebuild for a change they judge
  safe, a migration reader, compatibility ranges across releases, and any claim
  that a mirror file is portable between builds.

## Considered alternatives

- **Keep the hand-stamped version.** Rejected: its failure mode is silent, and it
  is exactly the class of correctness that a derived value removes for free.
- **Hash `JSON.stringify` of the declaration.** Rejected: property insertion
  order would enter the digest, so a cosmetic edit would rebuild every store and
  reviewers would learn to distrust the gate.
- **Hash the source of the functions that build the tables
  (`Function.prototype.toString`).** Rejected: that hashes comments, formatting,
  and variable names, changes under a bundler, and still misses data-driven
  shape. It is a digest of the text, not of the decision.
- **Fingerprint each table separately and drop only the tables that changed.**
  Rejected for now, not on principle: it is genuinely cheaper (the table-existence
  latch of ADR-0064 would backfill just that entity without clearing the cursor),
  but it multiplies stored state and spreads the gate across the ingest path,
  which is where a mid-sync drop would silently lose CDC history. Revisit if the
  whole-store re-pull ever bites in practice.
- **Include indexes in the fingerprint for completeness.** Rejected: they hold
  nothing, they are re-applied idempotently at open, and including them makes
  tuning a query as expensive as changing the schema.
- **Give the owner a mode flag to choose rebuild-or-keep.** Rejected for the
  reason ADR-0193 rejected a schema-conflict callback: keeping stale derived
  state is not a real arm of the choice.
- **Design the `defineMirror` / `openMirror` API in the same pass.** Rejected:
  the gate is the part both live mirrors need now, and an API shaped before its
  mechanics are proven is how mode flags get invented.
