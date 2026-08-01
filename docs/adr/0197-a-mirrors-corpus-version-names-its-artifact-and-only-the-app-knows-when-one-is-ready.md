# 0197. A mirror's corpus version names its artifact, and only the app knows when one is ready

- **Status:** Accepted
- **Date:** 2026-08-01
- **Supersedes:** [ADR-0194](0194-a-mirrors-fingerprint-names-its-artifact-and-reclaiming-the-predecessor-is-explicit.md)
- **Amends:** [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) at its mechanical-enforcement clause and [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md) at one clause of its disposability consequence, carrying forward the amendments ADR-0194 made to both. Neither record's decision is otherwise touched.
- **Amended by:** [ADR-0198](0198-local-mail-stores-gmail-facts-and-durable-local-overlays-in-one-stable-file-per-account.md) by scope only: this lifecycle no longer applies to Local Mail, whose database stops being a mirror when it gains a durable local overlay tier. The decision below is unchanged and continues to govern Local Books, which is still a pure mirror; `packages/sqlite/bun-mirror` simply drops to one consumer.
- **Relates:** [ADR-0061](0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md) (Local Books reads facts from the mirror; this record decides how that file is identified and replaced), [ADR-0063](0063-the-local-books-mirror-is-a-multi-writer-cache-made-safe-by-one-monotonic-write-door.md) (the monotonic write door stays app-owned; this record puts no gate in front of it), [ADR-0064](0064-the-local-books-mirror-keeps-one-realm-cdc-cursor-table-existence-is-the-per-entity-init-latch.md) (the CDC cursor lives inside one artifact, so a new artifact starts without one, which is what makes it the readiness signal), [ADR-0196](0196-local-mails-mirror-is-a-reader-and-one-full-message-fetch-is-its-entire-budget.md) (the per-message fetch budget that prices a Local Mail rebuild)

## Context

ADR-0194 settled the shape of a disposable mirror: the artifact is named
after the code that built it, opening is non-destructive, and cleanup is
explicit. Both apps then implemented it, and the identity mechanism it chose
(a SHA-256 over a canonically serialized declaration) turned out to cost more
than it bought.

It cost a canonical serializer, a value grammar, a format tag, a cyclic-value
guard, and a golden hash pinned in two test files to catch drift between two
byte-identical copies of the module. In Local Mail it also forced a
`derivation` field onto every column declaration whose only reader was the
hash, because `bodyText` and `headerValue` compute things SQL cannot, and a
hash over the SQL shape alone would not notice when one of those promises
changed.

What it bought was one property: a shape change cannot be made without also
renaming the artifact, because a reviewer cannot forget to bump something that
is computed. That property is real, and it is narrower than it looks. The
`derivation` field is the proof: the moment the corpus depends on anything the
declaration does not literally contain, correctness is back to a human writing
down that the meaning changed. A hash cannot see an ingestion-scope change
either, and adding a QuickBooks entity or narrowing a Gmail query is exactly
the kind of change that makes an existing artifact a copy of something else.

## Decision

A mirror is a disposable local SQLite copy of data an external authority owns.
An explicit, positive, monotonically increasing integer names the current
artifact: `<name>.v<version>.db`. The version is a **corpus contract**, not an
app release version. Rebuilds create a new artifact; opening is
non-destructive and never falls back; readiness is the app's cursor, not the
filename; cleanup is explicit, scoped, and app-timed.

### Surface

One call, one object:

```ts
const mirror = mirrorAt({ name: 'mail', version: 5, directory: accountDir });

mirror.path                   // <accountDir>/mail.v5.db, whether or not it exists
mirror.artifacts()            // every version present here, and which is current
mirror.open()                 // writable handle, created if absent
mirror.openReadonly()         // read-only handle, null when absent
mirror.reclaimPredecessors()  // delete every LOWER version and its sidecars
```

`name`, `version`, and `directory` are the only inputs. There is no realm,
domain, authority identifier, filename override, or path template, and there is
no second stage: the caller passes the directory it already computed, which is
where per-tenant naming (Local Books' `realmId`, Local Mail's account email) and
its path-traversal validation stay.

The primitive lives at `@epicenter/sqlite/bun-mirror`, imported by both apps
rather than copied into each. It is a separate entry point because it depends on
Bun and the filesystem, which the portable root of `@epicenter/sqlite`
deliberately does not.

### When to bump the version

Bump it when this build would store something a previous build did not:

- the persisted SQL shape (an added, removed, or retyped column or table);
- the meaning of a persisted derivation (what `body_text` or `subject` promises);
- the ingestion scope (which QuickBooks entities are mirrored, which messages a
  full pull covers).

Do not bump it for an index, a read-time projection, a comment, or an app
release. None of those change what is on disk, and each bump costs a full
rebuild, priced for Local Mail at 20 quota units per message (ADR-0196).

Local Mail's count continues the `SCHEMA_VERSION` it replaces, which last read
`'4'`; the reader-mirror rewrite that renamed `raw` to `resource` is `5`.
Restarting at `1` would name a fresh artifact after a corpus that already exists
on someone's disk. Local Books, which never stamped a version, starts at `1`.

### How filenames are formed

`<name>.v<version>.db`, where `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$` and
`<version>` is a decimal integer with no leading zeros, plus SQLite's own `-wal`
and `-shm` sidecars. No leading zeros means one version has exactly one
filename, so numeric order and lexical order can never disagree about which
artifact is which. A filename that predates this grammar (a bare `mail.db`, a
fingerprinted name) is outside it: nothing reads it, and nothing reclaims it.

### What opening does

`open()` creates the directory if needed, creates the current artifact if it is
absent, and applies the concurrency contract both apps already share (WAL,
`busy_timeout`, `synchronous = NORMAL`, `foreign_keys = ON`). `openReadonly()`
opens the current artifact and never creates one; an absent artifact is reported
to the caller, not conjured.

Neither mode deletes, truncates, migrates, or rewrites anything, and neither
opens a different version. **There is no predecessor fallback.** A build
compiled for v5 reads v5; reading v4 would be a compatibility layer for a shape
this build no longer promises, and it would silently answer a question with data
from a corpus the caller did not ask about. A predecessor is retained, not
consulted. An app that wants to inspect one takes its path from `artifacts()`
and opens it deliberately.

Nothing is stamped inside the file, so `_meta` holds cursor state and only
cursor state, and needs no retired-key list.

### Who decides readiness

The app, from its own sync cursor, and nothing else.

This is the part a versioned filename must not be mistaken for. A new artifact
exists from the first `open()` and is empty or partial until a full pull
finishes; the newest filename is therefore never evidence of readiness. Each app
already records completion where completion actually happens, and status reports
three states from it:

- `empty`: no artifact at this version.
- `building`: an artifact exists, its cursor has never been set, so no clean
  full pull has finished and what is in it is a partial corpus.
- `ready`: a cursor written by a clean full pull.

Local Books writes `lastFullPullAt` only when every entity pulled without
failure (`syncRealm`). Local Mail writes `historyId` only in `finishFullPull`,
after every page committed. Neither definition is expressible in a storage
primitive, so the primitive has no readiness flag, no rebuild callback, and no
publication protocol. `artifacts()` is directory inventory: it opens no SQLite
handle, and it is not a readiness signal.

### What reclamation can delete

`reclaimPredecessors()` deletes every artifact of this name at a **lower**
version, plus each one's `-wal` and `-shm` sidecars, and returns what it
deleted. It is scoped three ways: never the current artifact; never a higher
version, because that one belongs to a newer build that may be running right
now; and never a path the filename grammar does not produce, so a sibling
`lock.db` or `credentials.json` is unreachable. It never removes the directory.

**Timing is app-owned, and today no app calls it automatically.** Neither app
can prove quiescence: Local Mail's sync lock deliberately does not cover the
read-only handles `status` and `query` hold, and Local Books opens read-only
handles from the CLI, the loopback API, and the MCP server, none of them under a
lock. Deleting a predecessor's `-wal` out from under a live reader is a
corruption vector, and on Windows the unlink fails outright. So reclamation
stays explicit maintenance: `status` reports the retained versions, and removing
them is a decision a human makes when nothing is reading. Wiring an automatic
call requires first giving an app a quiescence guarantee it does not have.

The split is therefore: the primitive owns the filename grammar, artifact
inventory, opening modes, and grammar-scoped deletion. Apps own the version
constant, DDL, ingestion, cursors, readiness, locking, file permissions, and
reclamation timing.

## Consequences

- Correctness of the version now depends on a reviewer, which is what ADR-0194
  set out to avoid. The trade is deliberate: the hash only ever enforced the
  subset of the contract that was literally in the declaration, and Local Mail
  had already bolted a hand-written `derivation` string onto it to cover the
  rest. One reviewed integer with a written bump rule is the honest version of
  the guarantee the hash was approximating, and it is legible on disk: `v5` says
  what `mail.9a1dd503….db` could not.
- A version bump costs a full re-pull and disk for two corpora until reclamation
  runs. Unchanged from ADR-0194, and still bounded by one call.
- The predecessor is retained because it is still the only complete local copy
  while the successor backfills, and because an old reader may still hold it
  open. Discarding a complete mailbox to begin an hours-long re-pull is not a
  defensible default, and keeping it makes a bad version bump a revert rather
  than an outage.
- Status gains a `building` state and the SPA status bars stop showing green for
  a half-backfilled artifact. Local Books' `mirrorBuilt: boolean` is replaced by
  the three-state field, because "the file exists" was never the question anyone
  meant to ask.
- One implementation exists instead of two byte-identical copies, so the golden
  hash pinned in two test suites to detect drift between them is gone with the
  thing it was watching.
- A Local Mail install from before this grammar has a `mail.db` beside the new
  `mail.v5.db`. It is outside the grammar, so status does not list it and
  reclamation cannot reach it; it is inert disk a human removes by hand. Teaching
  reclamation about pre-grammar names would mean teaching it to delete a file it
  cannot prove it wrote, which is the one thing the grammar exists to prevent.
- `packages/sqlite` is MIT and both apps are AGPL, so extracting the primitive
  relicensed roughly 200 lines of filename-grammar code from AGPL to MIT. Same
  copyright holder, no CLA, and the code is generic infrastructure with no
  product surface, so this widens permission on something that is not a moat.
  `bun run check:licenses` walks dependency edges only and could not have caught
  it either way; this note is the record that it was intentional.
- Deferred: automatic reclamation (blocked on a quiescence guarantee), per-table
  versions, a retention policy, and reprojecting rows from a predecessor into a
  successor instead of re-pulling them. Reprojection is a migration by another
  name, and every mirror value is re-pullable by construction.

## Considered alternatives

- **Keeping the declaration fingerprint (ADR-0194):** superseded, for the
  reasons in Context. It enforced only the part of the corpus contract that fit
  in a serializable literal, and the machinery to serialize that literal
  canonically was larger than the primitive it protected.
- **Falling back to the newest readable predecessor when the current artifact is
  absent:** rejected. It is a compatibility layer wearing a convenience
  disguise: the build's queries are written against a shape the predecessor does
  not promise, so the failure mode is a wrong answer rather than a missing one.
  "Not built yet" is a state the app already reports.
- **Reprojecting the predecessor's rows into the successor on bump:** rejected;
  this is a migration, and the authority is one re-pull away.
- **A readiness marker file, or a `ready` flag in the primitive:** rejected. The
  primitive cannot know what a complete corpus is, and each app already records
  it in the cursor it must maintain anyway. A second marker would be a second
  source of truth for the same fact.
- **Publishing by rename (build into a temp name, rename on completion):**
  rejected. It reintroduces the destructive step the versioned filename removed,
  it cannot be atomic across the artifact plus both sidecars, and a crash
  mid-rename leaves a state neither name describes. The cursor already records
  clean completion without moving any bytes.
- **App release version as the artifact version:** rejected; it would force a
  full re-pull on every release, and it says nothing about what is stored.
- **`reclaim(version)` taking an explicit target:** rejected. Every real caller
  wants "everything older than me", and an explicit target invites passing the
  current version or a future one. `reclaimPredecessors()` cannot express
  either.
- **A `reclaim` CLI verb in each app:** deferred, not refused. It is the natural
  home for explicit maintenance, but it is a product surface (help text, MCP
  catalog, read-only-mode semantics) rather than a lifecycle question, and the
  quiescence caveat has to be stated wherever it lands.
- **`defineMaterialization` / a two-stage `define().at()` API:** rejected. The
  second stage existed to let one declaration be reused across directories, and
  both apps immediately wrapped it in a one-call helper (`mailMirror`,
  `booksMirror`) anyway. One call is what the callers wanted.
- **A generic schema or DDL argument on the primitive:** rejected. Local Books
  generates per-entity DDL lazily because table existence is its init latch
  (ADR-0064); Local Mail runs one `CREATE TABLE IF NOT EXISTS` block at open.
  Forcing both into one schema DSL would serve neither, and the primitive has no
  use for the schema it would be holding.
