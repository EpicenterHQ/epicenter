# 0193. Durable authorities preserve truth; disposable materializations can always be rebuilt

- **Status:** Accepted
- **Date:** 2026-07-31
- **Amends:** [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md) by scoping its refusal of per-application databases to namespaces inside one Epicenter rather than to every store an application owns; [ADR-0176](0176-lenses-declare-no-query-capabilities-indexed-reads-require-separate-owners.md) by naming a materialization as the separate owner it requires and scoping its query refusal to reads of the shared authority; [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md) by stating that its closed namespace set withholds Epicenter ownership of a private store rather than an application's right to keep one; and [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md) at one consequence, because a build declares which Epicenter owns its authority data and says nothing about a private materialization beside it.
- **Relates:** [ADR-0026](0026-matter-vault-sqlite-is-a-projection-never-a-verdict-source.md), [ADR-0063](0063-the-local-books-mirror-is-a-multi-writer-cache-made-safe-by-one-monotonic-write-door.md), [ADR-0065](0065-matter-is-a-standalone-disk-as-truth-tool-its-sqlite-is-a-read-only-query-surface.md), [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md), [ADR-0096](0096-local-workspace-persistence-is-environment-injected.md), [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md), [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md), [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md), [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md), [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md), [ADR-0167](0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut.md), [ADR-0168](0168-lenses-are-complete-pure-json-interpretations.md), [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md), [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md), [ADR-0175](0175-table-traversal-is-complete-and-classified-with-paging-kept-private.md), [ADR-0183](0183-epicenter-mediates-the-effects-it-owns-and-names-the-rest-unmediated.md), [ADR-0186](0186-an-app-reaches-epicenter-through-one-bundled-mit-client-it-installs-itself.md)

## Context

The distinction this record names is already load-bearing in five places, in
five vocabularies. Matter calls its SQLite a projection of disk (ADR-0026,
ADR-0065). Local Books calls its SQLite a cache of QuickBooks (ADR-0063). Local
Mail calls its SQLite a mirror of Gmail and drops it on a schema-version bump
(ADR-0098, ADR-0116). ADR-0122 calls a derived index disposable runtime state.
ADR-0176 refuses an index until a runtime owner exists to rebuild and dispose
it. Each record rediscovered the same law for one app and stated it in its own
words, so nothing generalizes and the sixth app will derive it again.

Read from the other side, the One Epicenter records look absolute. ADR-0160
ends with "without creating per-application databases", ADR-0161 says a person
owns one Epicenter, and ADR-0190 says a build's data question has exactly one
answer fixed at build time. A reader who takes those literally concludes that
every byte an application stores must live in the shared Epicenter, which is
false today: `apps/local-mail/src/db.ts` and `apps/local-books/src/db.ts` are
shipped SQLite databases that are not Epicenters and never were.

Both readings cannot be right. What is missing is not another app-specific
record but the general rule, with one vocabulary, that says which laws apply to
which kind of store.

## Decision

A durable store is an **authority** or a **materialization**. The two are
governed by opposite laws, and every store answers one question to say which it
is:

> If this store is deleted while its source authority is reachable, is anything
> lost but time?

Yes means materialization. No means authority.

**An authority preserves truth and owns conflict semantics.** Losing it loses
data that exists nowhere else, so it is preserved rather than rebuilt, and its
convergence rules are part of the product. Epicenter owns exactly one authority
for the data it holds: the person's one Epicenter (ADR-0161). An application may
also depend on an external authority it does not control, such as Gmail
(ADR-0098), QuickBooks (ADR-0063), or a folder of markdown on disk (ADR-0065).

**A materialization is derived state whose only claim is speed or shape.** It
holds nothing its source authority does not already hold. Its owner may choose
any schema, any index, any query language, and any storage engine, because
nothing outside it depends on those choices. It can be deleted and rebuilt
whenever its source authority is reachable.

**A replica is not a materialization.** A local Epicenter replica holds durable
local writes the authority has not yet accepted (ADR-0171), so deleting it loses
data and it fails the question above. A replica is a participant in the
authority, governed by attachment, Restore, and Backup (ADR-0161, ADR-0170), not
by rebuild. The distinction is the pending obligation, not the file.

The rest of this record is what those two laws settle.

### Shared Epicenter data keeps its no-migration posture

The shared authority is schema-opaque portable state interpreted by partial,
overlapping, release-local Lenses that never migrate stored data (ADR-0125,
ADR-0160, ADR-0168). Nothing below reopens schema equality, a canonical
definition, a migration chain, an alias, or a compatibility classifier for it.
The rebuild rules in this record apply only to materializations and never to an
authority.

### An application may own a private database, and it is not an Epicenter

A materialization an application owns is a separate store with a separate
lifecycle. It is not addressed by namespace, not synchronized, not exported, not
part of a portable Epicenter (ADR-0167), and not part of a Backup (ADR-0170).
ADR-0160's refusal of per-application databases governs namespaces inside one
Epicenter, where a per-namespace file would recreate the lifecycle boundary One
Epicenter removed. It does not govern a store that was never an Epicenter.

The reciprocal obligation is strict: a materialization may hold only what its
source authority already holds. State that lives nowhere else is an authority
created by accident, and this record protects none of it. ADR-0098 already names
this hazard as the overlay table beside the mirror, and the drop-and-rebuild
rule below is what punishes it.

### A materialization gets no migration framework

A materialization's owner stamps a schema version. On mismatch it deletes the
store and rebuilds from the source authority. There is no migration runner, no
retained historical schema, no transform chain, no compatibility classifier, and
no schema-conflict callback, because rebuild is the honest recovery and a
callback would only offer a choice whose other arm does not exist.

A single owner may still evolve its physical tables in place when it prefers to,
exactly as ADR-0125 already permits for private runtime tables. What this record
refuses is a platform obligation to support that, and any promise to a second
party that a given schema will still be readable later.

### A materialization owns its own query surface

A materialization may expose SQL, an ORM, indexes, arbitrary predicates,
ordering, and paging over its own data. This is not a reopening of ADR-0176 or
ADR-0162; it is what ADR-0176 asked for. ADR-0176 refuses query capabilities in
a Lens because a partial, release-local interpretation of shared data owns no
installation, rebuild, or eviction lifecycle. A materialization has one owner
who owns exactly that lifecycle, which is why it may carry the query surface a
Lens may not.

The boundary is the store, not the syntax. Reads of the shared Epicenter remain
`get`, `entries`, and `scan` through a Lens (ADR-0175, ADR-0176), and relational
inspection of the shared Epicenter remains Epicenter Home's trusted capability
over the storage owner (ADR-0162). No application receives SQL, a connection, a
query builder, or a predicate over the shared authority, whatever it is
permitted to do inside its own store.

### The host never inspects a private application schema

Home's inspection reaches the shared Epicenter (ADR-0162). It does not read an
application's private materialization, and there is no host-readable schema
descriptor, cross-store join, generic application-database browser, or registry
of private stores. A materialization's shape is private by construction, which
is what makes changing it free.

### Backups are authority cuts, not machine backups

A Backup is one sealed cut of the Epicenter authority (ADR-0170) and is complete
with respect to that authority. Materializations are excluded from
correctness-critical backup by default, and their absence does not make a Backup
partial.

An owner may still offer an export of its materialization for diagnostics or for
a faster cold start. That export is never a restore path and never a
compatibility promise: importing it must be indistinguishable from rebuilding,
and an import that cannot be validated is discarded in favor of a rebuild. If an
export ever becomes the only way to recover something, that something was
authority data in the wrong store.

### Opening a materialization is per-concern injection, not a namespace

The `epicenter` handle is a closed composition boundary over capabilities
Epicenter owns and can attribute (ADR-0181, ADR-0183, ADR-0186). A private
application database is not one of them, because Epicenter neither owns its
bytes nor mediates its effects. ADR-0181 refuses `storage` and `system` as
namespaces because they name implementation categories; this record states the
stronger reason for this case, which is that the capability is not Epicenter's
to offer. Withholding a namespace withholds Epicenter's ownership, never the
application's right to keep a store.

The code that owns a materialization opens it directly in its own runtime.
Environment neutrality comes from injecting the engine at that owner's
composition root, the way ADR-0096 injects local workspace persistence and
ADR-0066 injects a runtime adapter at the deployment edge. It never comes from a
mutable service locator, a host-owned registry of application stores, or a
single `Runtime` object with co-equal legs, which ADR-0066 rejected on evidence
that still holds.

The public capability handle and internal per-concern injection are two
different axes. The handle is what an application receives; injection is how an
owner acquires a backend it already decided it needs. Neither becomes the other,
and a future application-facing open, if a real caller earns one, must still
satisfy ADR-0183's rule that a capability is unfinished until its boundary can
attribute it.

## Consequences

- Whispering is explained without a materialization at all. Its recordings and
  settings are authority data in one shared namespace, read through a Lens, and
  it owns no private store. A simple application stays simple, and adding a
  private index later changes nothing about where its truth lives.
- Local Mail is explained without special pleading. Gmail is the authority
  (ADR-0098), its Bun engine owns a private SQLite materialization
  (`apps/local-mail/src/db.ts`), a schema-version bump drops and rebuilds it, and
  its absence from a Backup costs a re-pull rather than a loss. Local Books
  (`apps/local-books/src/db.ts`) and Matter are the same shape with different
  authorities.
- One vocabulary now covers what the corpus calls a mirror, a projection, a
  cache, a derived index, and disposable runtime state. Those records stay
  accurate and need no renaming; this record is where a sixth case looks first.
- The rebuild cost is real and is now stated rather than discovered. A person who
  loses a machine loses warm caches, and Local Mail re-pulls Gmail history to
  rebuild. That is the price of refusing to back up derived bytes, and it is paid
  in time.
- An application that puts irreplaceable state in a materialization gets no
  protection and will lose it at the next rebuild. The failure is loud and early
  rather than silent, which is the point.
- Home's inspection story gains a hard edge. It explains the shared Epicenter
  completely and explains an application's private store not at all. A person who
  wants to query a mail mirror uses the tool that owns it.
- The `epicenter` handle stays small under pressure. The first real request for
  an application-facing database open now has a decided answer instead of an open
  namespace slot.
- What this forecloses: a platform-owned application database service, a generic
  migration framework for derived stores, a cross-store query engine, and any
  backup product that promises to restore a machine rather than an Epicenter.

## Considered alternatives

- **Amend each affected record separately and write no new one.** Rejected: the
  rule is cross-cutting, so it would live in ten places and be authoritative in
  none. ADR-0098 already named a homeless load-bearing invariant as the failure
  mode this avoids.
- **Add an `epicenter.database` namespace to the handle.** Rejected: no caller
  exists, every shipped materialization is opened by its own engine today, and
  Epicenter cannot attribute effects in a store it does not own (ADR-0183). A
  namespace would claim ownership to buy an opener nobody asked for.
- **Require all application data to live in the shared Epicenter.** Rejected: it
  would force an external-authority mirror into schema-opaque rows that cannot
  carry the indexes its engine needs, and it would put rebuildable Gmail and
  QuickBooks bytes into every Backup and every replica.
- **Give materializations a migration framework.** Rejected: the source authority
  is reachable by definition, so a migration is a slower, more fallible rebuild
  that must also be maintained forever.
- **Add a schema-conflict callback so an owner can choose.** Rejected: rebuild is
  the only honest arm, so the callback would be a decision point with one real
  answer and a second arm that quietly preserves stale derived state.
- **Include materializations in Backups for completeness.** Rejected: it inflates
  every artifact with bytes the authority already holds and makes Backup size
  depend on which applications happen to be installed.
- **Let the host read application schemas so Home can browse every store.**
  Rejected: it makes a private shape a public contract, which is exactly the
  freedom that pays for drop-and-rebuild.
- **Keep the per-app vocabularies and add no shared noun.** Rejected: five names
  for one concept is how the sixth app concludes the concept does not exist.
