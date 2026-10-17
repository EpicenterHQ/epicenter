# 0194. A mirror's fingerprint names its artifact, and reclaiming the predecessor is explicit

- **Status:** Superseded
- **Date:** 2026-07-31
- **Superseded by:** [ADR-0197](0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md) with the same disposable-mirror shape, but an explicit corpus version in the filename instead of a declaration fingerprint, no predecessor fallback, and app-owned readiness reported as empty/building/ready. The amendments this record made to ADR-0098 and ADR-0116 are carried forward by ADR-0197.
- **Amends:** [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) at its mechanical-enforcement clause and [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md) at one clause of its disposability consequence: both described a `SCHEMA_VERSION` bump dropping and rebuilding the mirror, which this record replaces with fingerprint-named replacement and predecessor retention. Neither record's decision is otherwise touched.
- **Relates:** [ADR-0061](0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md) (Local Books reads facts from the mirror; this record decides how that file is identified and replaced), [ADR-0063](0063-the-local-books-mirror-is-a-multi-writer-cache-made-safe-by-one-monotonic-write-door.md) (the monotonic write door stays app-owned; this record puts no gate in front of it), [ADR-0064](0064-the-local-books-mirror-keeps-one-realm-cdc-cursor-table-existence-is-the-per-entity-init-latch.md) (the CDC cursor and the table-existence latch live inside one artifact, so a new artifact starts with neither), [ADR-0176](0176-lenses-declare-no-query-capabilities-indexed-reads-require-separate-owners.md) (indexed reads are a separate owner's concern, which is why indexes are not fingerprint inputs)

## Context

Local Books and Local Mail each keep a SQLite mirror of an external authority,
and each decides at open time whether the file on disk still matches the code
about to read it. Local Mail compares a hand-stamped `SCHEMA_VERSION` and, on
mismatch, unlinks `mail.db` plus its `-wal` and `-shm` sidecars and reopens
<!-- doc-path-check: ignore-next-line -->
(`apps/local-mail/src/db.ts:186`). An in-progress Local Books experiment
replaced the hand-stamped constant with a declaration fingerprint but kept the
same in-place shape: compare a `_meta` row, then drop every table it finds in
`sqlite_master` (`apps/local-books/src/db.ts:148`).

Both destroy data as a side effect of opening. Local Books opens a writable
mirror from five call sites, one of which is a single-row recategorize
write-back, so a declaration edit means whichever site opens first erases the
corpus. Local Mail's unlink runs while `status` and `query` may hold read-only
handles that the sync lock deliberately does not cover
<!-- doc-path-check: ignore-next-line -->
(`apps/local-mail/src/lock.ts`). The repository already refuses this shape
<!-- doc-path-check: ignore-next-line -->
elsewhere: `packages/sqlite/src/index.ts` defines `StorageUpgradeRequiredError`
precisely so that a generic SQLite adapter never repairs or recreates a file
implicitly.

## Decision

A mirror is a deterministic, disposable SQLite materialization of an
application-owned declaration. Its fingerprint names the current artifact.
Rebuilds create a new artifact; opening is non-destructive; cleanup is explicit,
scoped, and performed only after successful replacement.

### Surface

```ts
const mirror = defineMirror({ name: 'books', declaration: MIRROR_DECLARATION });
const site = mirror.at(companyDir);

site.fingerprint          // the declaration's fingerprint
site.artifacts()          // every artifact at this site, and which one is current
site.open()               // writable handle on the current artifact, created if absent
site.openReadonly()       // read-only handle on the current artifact, never created
site.reclaim(fingerprint) // delete one non-current artifact and its sidecars
```

`name` and `declaration` are the only inputs. There is no realm, domain,
authority identifier, filename override, or path template in the public surface.
The app picks the directory by passing it to `at()`, which is where per-tenant
naming (Local Books' `realmId`, Local Mail's account email) and its
path-traversal validation stay.

### What is fingerprinted

SHA-256 over a canonical serialization of the declaration alone: object keys
sorted, array order preserved, unsupported values rejected, and the whole thing
prefixed with a fixed format tag the primitive owns rather than an app-supplied
string. `name` is not an input. Neither are indexes, directories, tenant
identity, cursors, credentials, engines, or configured entity subsets. The
fingerprint answers exactly one question: is the stored shape the same shape as
before.

### How filenames are formed

`<name>.<fingerprint>.db`, where `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$` and
`<fingerprint>` is 64 lowercase hex characters, plus SQLite's own `-wal` and
`-shm` sidecars. Keeping `name` out of the hash keeps the hash a statement about
shape only: two mirrors with the same declaration fingerprint identically
however they are named. A rename still produces a new artifact, because the
filename changed, and still costs a full re-pull.

### What opening does

`open()` creates the directory if needed, creates the current artifact if it is
absent, and applies the concurrency contract both apps already share (WAL,
`busy_timeout`, `synchronous = NORMAL`, `foreign_keys = ON`). `openReadonly()`
opens the current artifact and never creates one; an absent artifact is reported
to the caller, not conjured.

Neither mode deletes, truncates, migrates, or rewrites anything. Because nothing
is stamped inside the file, `_meta` loses both `mirror_fingerprint` and
`schema_version`, and needs no retired-key list. A changed declaration is not an
event the opener handles; it is a different filename.

The moment the declaration changes, the predecessor stops being authoritative:
no read path consults it and `openReadonly()` will not open it. It is retained,
not consulted. An app that wants to inspect it takes its path from `artifacts()`
and opens it deliberately.

### What reclaim can delete

`reclaim(fingerprint)` deletes the artifact that fingerprint names, plus its
`-wal` and `-shm` sidecars, and nothing else. It refuses the current
fingerprint, refuses any argument that is not 64 hex characters, and never
touches a path the filename grammar does not produce. It never removes the
directory.

### Who decides completion and timing

The app, and only the app. The primitive has no completion protocol, no
readiness flag, and no automatic reclamation. Local Books already owns this
judgment: `syncRealm` advances the realm cursor only when every entity was
pulled (`apps/local-books/src/sync.ts:175`). Local Mail's paginated backfill
advances only in `finishFullPull`, after every page has committed. Neither
definition is expressible in a storage primitive, so app-owned maintenance calls
`reclaim` once the app decides its successor is usable.

The split is therefore: the primitive owns canonical declaration hashing, the
filename grammar, artifact inspection, opening modes, and grammar-scoped
deletion. Apps own DDL, ingestion, cursors, completion, locking, file
permissions, and cleanup timing.

## Consequences

- A declaration edit costs a full re-pull and disk for two corpora until reclaim
  runs. That is the price of never destroying on open, and it is bounded: one
  call ends it.
- The predecessor is retained because it is still the only complete local copy
  while the successor backfills. Gmail's backfill is paginated `messages.list`
  plus per-id `messages.get`; discarding a complete mailbox to begin an
  hours-long re-pull is not a defensible default, and keeping it makes a bad
  declaration a revert rather than an outage.
- Reader and writer asymmetry stops being a correctness requirement. Today
  `apps/local-books/src/books/status.ts:97` must remember to pass
  `{ readonly: true }` or a status read drops the mirror's tables. After this,
  the worst a mistaken writable open can do is create an empty file.
- No process can pull a file out from under another process's open handle, so
  the sync lock keeps covering exactly what it covers today and no more.
- Status surfaces change shape: "which fingerprint is stamped inside" becomes
  "which artifacts exist and which is current", read from `artifacts()`.
- File permissions stay with the app. The primitive does not know a mirror's
  sensitivity, so Local Mail keeps its 0700 directory and 0600 file discipline
  and applies it to the handle it receives.
- Books first, Mail second. Books already has the declaration to hash and a
  table-existence init latch (ADR-0064), so it exercises fingerprinting and
  non-destructive opening with the least new code. Mail is the harder second: a
  paginated full backfill, a `lock.db` sibling reclaim must not touch, 0700 and
  0600 permissions, and the hand-stamped constant this replaces. If both adopt
  the primitive without either pushing a knob into it, the surface is right.
  That is also the bar for extracting it into a package.
- Status is `Accepted` because the decision is settled and governs the next
  change to both apps. No code in the tree implements it yet, and the in-place
  fingerprint gate in `apps/local-books/src/db.ts` is a rejected experiment, not
  a first step toward this.
- Deferred: extracting the primitive into a package, per-table fingerprints, a
  retention policy or automatic reclamation, and reprojecting rows from a
  predecessor into a successor instead of re-pulling them. Reprojection is a
  migration by another name, and every mirror value is re-pullable by
  construction.

## Considered alternatives

- **In-place fingerprint gate that drops tables on mismatch:** rejected. It
  destroys on open from every call site, must enumerate and drop tables it did
  not create, and accumulates a retired-`_meta`-key list forever.
- **Hand-stamped `SCHEMA_VERSION`:** rejected; correctness depends on a reviewer
  remembering to bump a constant, and Local Mail has bumped it four times.
- **Hashing `JSON.stringify` output:** rejected; object insertion order would
  become rebuild behavior.
- **Hashing function source:** rejected; formatting and bundling changes are not
  stored-shape changes.
- **Including indexes:** rejected; an index holds no mirror facts and is applied
  idempotently on every open, so a query optimization must not force a re-pull.
- **Including `name` in the fingerprint:** rejected; it is already in the
  filename, and hashing it would make the fingerprint a statement about naming
  rather than about shape.
- **`reclaim({ dryRun: true })`:** rejected; `artifacts()` already answers what
  exists and what is current as fact rather than as prediction, and a dry-run
  flag doubles reclaim's return contract so every caller must branch on it.
- **Pruning the site directory of everything that is not current:** rejected.
  Both apps keep non-mirror files beside the mirror: `companies.json` and
  `credentials.json` for Local Books, `credentials.json`, `provider.json`, and
  `lock.db` for Local Mail. A broad prune deletes OAuth refresh tokens and the
  sync lock. The filename grammar is what makes reclaim safe, so reclaim is
  scoped to it.
- **Reclaiming automatically once the successor opens cleanly:** rejected; a
  successful open proves nothing about whether the corpus has been re-pulled.
- **Per-table fingerprints:** deferred; whole-mirror replacement keeps cursor
  invalidation and rebuild ownership simple until measured cost justifies finer
  granularity.
