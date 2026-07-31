# Clean-room alternatives, written before reading any implementation

This file was written from `AGENTS.md`, `docs/CONTEXT.md`, `docs/adr/README.md`,
and ADRs 0061, 0063, 0064, 0176, 0190, 0192, 0194 only. No `apps/local-books` or
`apps/local-mail` source was read before it was committed. It is deliberately not
revised after the code inspection; the corrections live in `README.md` under
"What the current code wrongly suggests", so the record of what the documents
alone predicted stays honest.

## The word

The mission says **materialization**. The tree says **mirror** (a disposable local
projection of a remote HTTP authority: ADR-0192) and **materializer** (a local
addressless worker projecting Epicenter data into markdown or SQLite:
`docs/CONTEXT.md`). ADR-0192 refuses to unify the two *data planes*, and that
refusal is correct: convergence semantics do not belong on single-authority data.

But the plane split is an argument about **who owns truth**, not about **what a
derived store is**. Both a mirror and a materializer are the same four-part
machine:

```
authority  ->  declaration  ->  materialized store  ->  readers
```

and both answer the same six questions: where does the store live, when is it
invalid, who may destroy it, who may read it while invalid, is it backed up, and
what identity does it belong to. Those are lifecycle questions, not data-model
questions. ADR-0192's refusal does not reach them. So "materialization" is used
here as the lifecycle noun that spans mirror, materializer, and the Matter SQLite
projection (ADR-0026/0065), and the API is designed for the lifecycle, never for
the data model.

The one place the plane split *does* bind: nothing in this design may give a
materialization a merge, a peer, a sync watermark shared with the replica, or a
place in canonical data. It is disposable derived state, and its API should make
that unforgeable rather than documented.

## The precedent nobody has applied to mirrors yet

**ADR-0176 already solved this exact ownership problem, for indexes.** It says a
derived read structure needs *two* explicitly assigned owners:

1. the **semantic owner** that declares one measured access pattern; and
2. the **runtime owner** that materializes, rebuilds, limits, evicts, and
   disposes its physical representation.

A materialization is an index with a bigger footprint and a remote source. The
same two owners apply, and the whole of the mission's question list falls out of
asking who each owner is:

| Mission question | Which owner it belongs to under ADR-0176 |
| --- | --- |
| declaration shape | semantic |
| what counts as a shape change | semantic (declaration) + runtime (comparison) |
| where the file lives | **runtime** |
| when the store is dropped | **runtime** |
| who may drop it | **runtime** |
| whether a stale read is offered | runtime offers, semantic decides if it is usable |
| backup visibility | **runtime** |

Today a mirror app is both owners at once. That is the shape this prototype
attacks: not the fingerprint algorithm, the **ownership merge**.

## Six challenges, answered clean-room

### 1. `createApp` versus `define` / `open` separately

Three candidates.

- **One call.** `createBooksMirror({path, entities})` builds and opens. Reads
  well; makes the declaration unavailable as a value, so nothing can fingerprint,
  diff, print, or test it without touching a disk. Rejected on the spot: ADR-0194
  requires the declaration to be *deterministic plain data*, and a single call
  makes it a side effect of construction.
- **`define` then `open`.** The declaration is pure data; opening is effectful.
  This is the shape ADR-0194 names (`defineMirror`/`openMirror`) without freezing
  it. Correct, but underspecified in one important way: `open` still both *finds*
  the store and *fixes* it, so the destructive act hides inside the constructor.
- **`define`, `locate`, `inspect`, then either `openReader` or `lease`.** Four
  verbs, each with one job. `define` yields data. `locate` yields a path, and it
  belongs to the runtime. `inspect` yields a *state value*, and writes nothing.
  Only a `lease` can destroy anything.

**Clean-room position: the third.** The argument is not ergonomics, it is that
"open" is currently three unrelated authorities (name a path, judge validity,
destroy data) wearing one word. ADR-0192 clause B says "a read-only connection
never migrates, never drops, and never writes" — that is a sentence that only
needs to exist because the API lets one function do all three. Split the verbs
and the sentence becomes a type.

Cost, stated honestly: four calls where apps want one. Mitigation is a single
convenience wrapper *per consumer*, not in the kernel, so the wrapper is the
app's opinion and never the contract.

### 2. Fingerprint: stored string, hash, or structured diff

ADR-0194 chose a single SHA-256 of a canonically serialized declaration, stored
as one string, compared for equality, stamped only by the writer.

The canonicalization decision is right and I would not touch it: sorted keys,
preserved array order, rejected unsupported values, domain and format tag. The
rejected alternatives (`JSON.stringify`, function source) are rejected for the
right reasons.

The part worth attacking is what gets **stored**.

> A hash is a diff you already computed and threw away.

To hash the declaration you must first build the canonical serialization. Storing
that serialization instead of (or beside) its digest costs kilobytes and buys
three things a digest cannot give:

1. **Granularity.** With a per-part manifest you learn *which* table's shape
   moved, so the rebuild can drop that table rather than the mirror. ADR-0194
   defers per-table fingerprints to keep "cursor invalidation and rebuild
   ownership simple" — but cursor invalidation and table rebuild are two
   decisions, and a single whole-mirror digest is what forces them to be one.
   Under ADR-0064 the cursor is a realm high-water mark and table existence is
   the per-entity init latch; dropping one table and clearing the realm cursor is
   *already* an expressible state, and a partial full-pull already self-heals
   through that same latch. The machinery for per-table rebuild is present; only
   the fingerprint's granularity blocks it.
2. **A legible reason.** "Fingerprint mismatch, dropping 14 tables" is not
   diagnosable. "`purchase` gained field `department_ref`; dropping `purchase`,
   clearing cursor" is.
3. **Testability without a disk.** A structured comparison is a pure function of
   two declarations. You can assert "adding an index does not rebuild" without
   opening a database.

**The refusal that keeps this honest:** structurally diffing a stored old
declaration is *one bad step away from a migration reader*, which ADR-0192 clause
A refuses outright. The step is interpretation. So the comparison must be a
**shape-blind generic tree comparison over canonical JSON**: it may report that
the value at path `tables.purchase` differs, and it must never know what a
`purchase` is, what a field means, or how to read an older declaration format. If
the *format tag* differs, there is no comparison at all — the answer is full
rebuild. That keeps the property ADR-0192 wanted (no code reads an older shape)
while recovering granularity.

**Clean-room position: store the canonical declaration as a per-part manifest
(`{format, parts: {<name>: <digest>}, declaration: <canonical>}`), compare
structurally, and keep a whole-store digest as a fast path.** Prototype A keeps
the single-string form so the two can be measured against the same tests.

**A separate hole the fingerprint must not be asked to fill.** ADR-0194 correctly
excludes authority identity from fingerprint inputs — a fingerprint is a
declaration identity, not a freshness or authority indicator. But then *something
else* must carry authority identity, and the ADR does not say what. A store
restored from a backup, or a data directory copied between machines, or a person
who reauthorized against a different realm, produces a store whose fingerprint
matches perfectly and whose contents belong to someone else. Under a
fingerprint-only gate that store opens as **current**. The correct outcome is
neither "current" nor "rebuild" but a third, louder one: **refuse**. Rebuilding
would silently discard another principal's data and re-pull; that is recoverable
but wrong to do without saying so. This design carries an authority stamp beside
the fingerprint and gives it its own outcome.

### 3. Rebuild: a method, an open policy, or a separate controller

- **A method** (`mirror.rebuild()`). Any holder of any handle can destroy the
  store. The read-only SQL surface of ADR-0061 holds a handle.
- **An open policy** (`open(decl, {onStale: 'rebuild'})`). The destructive act
  becomes a flag at every call site, and the invariant "only the writer rebuilds"
  becomes a convention every call site must remember. This is the shape most
  likely to be built, and it is exactly the failure mode ADR-0192 diagnosed:
  *duplicated decisions, unevenly applied*.
- **A separate controller reachable only through an exclusive lease.**
  `inspect()` is total and non-destructive and returns a `RebuildPlan` when the
  store is stale. A plan is a value: printable, loggable, assertable,
  refusable. Executing it requires a `WriteLease`, which is exclusive per store
  (ADR-0192 clause D, "one sync owner per principal"), and a lease is the only
  thing that can produce a controller.

**Clean-room position: the controller, and the plan is the interesting half.**
The point is not that rebuild is hard to call; it is that "what would this
release do to my store" becomes answerable *without doing it*. That is the
difference between a fingerprint gate you trust because it was reviewed and one
you trust because you ran it.

Rebuild authority then stops being a rule about which connection you used and
becomes a fact about which value you hold. ADR-0192 clause B's "a read-only
connection never migrates, never drops" is enforced by the reader type not having
the methods, rather than by the reader choosing not to call them.

### 4. Do database paths belong to the app or the runtime?

**The runtime, and this is the single highest-value change in the set.**

ADR-0192 clause E ("one `0600` file at the data-dir root, *never inside a mirror
directory*, so a read-only SQL surface cannot read credentials") and clause G
("one directory per upstream principal, `0700` directories, `0600` files") are
*layout* invariants. A layout invariant that each app implements from prose is
precisely the thing ADR-0192 says produced the divergence it was written about.
Two apps, two path builders, one prose rule, and the rule is only true as long as
both authors remembered it.

If the app names a **principal** and never a **path**, then:

- clause E is mechanical: the app cannot place a credential inside a mirror
  directory because it never chooses either location;
- clause G is mechanical: one principal, one directory, by construction;
- two principals cannot collide, because the app cannot produce the same location
  for two different principals;
- and question 6 answers itself (below).

The obvious objection is ADR-0072: Local Books is a standalone, dependency-light,
single-binary CLI that must run with no Epicenter host present. So "runtime"
cannot mean "the Epicenter host process" — ADR-0192 already rejected host-owned
mirroring, and correctly. It means a **plain local value** the process constructs
once (`createLocalRuntime({ dataDir })`) and passes down. Epicenter Home, if it
ever opens a mirror (ADR-0191 shows a host may), passes its own. The runtime
owner is a value, not a service; that is what makes it compatible with both a
compiled CLI and a host process.

### 5. Should readers be able to open stale data?

Epicenter has already decided the shape of this answer three times, on the other
plane: ADR-0003 (three visible read states), ADR-0175 (traversal is complete and
classified), ADR-0187 (a bound handle *reports* staleness). The house rule is:
**never hide nonconforming state, never silently repair it, make the caller see
it in the type.**

ADR-0194 says a reader "may report that the on-disk mirror is stale." *May* is
the hole. A reader that opens a stale store and returns rows that look exactly
like fresh rows is the failure ADR-0194's own context paragraph warns about
("forgetting to bump it can leave old tables behind while new code reads them as
if they had the new shape") — the fingerprint moves that failure from *bump
discipline* to *read discipline*, but it does not delete it, because reads are
where the wrong shape actually gets believed.

**Clean-room position: yes, readers may open stale data, and the stale handle is
a different type.** Not a flag on the same handle, not a nullable warning field
that composes away: a distinct type whose query results are wrapped, so a caller
must either handle staleness or write an explicit unwrap that is visible in
review. Fail-closed was considered and rejected: a cache that refuses to answer
because a release renamed a field is an outage caused by a formatting change, and
ADR-0061 makes the mirror the offline high-volume read surface.

For **Local Books** specifically the stakes justify one extra step. A stale
mirror answering "what is my burn" with an old shape is a finance answer, and
ADR-0061 already separates facts from judgment for exactly this reason. So the
stale reader type should carry the plan, and the agent surface should be able to
say *what* is stale in its answer rather than silently degrading.

### 6. Should materializations be generic-backup visible?

**No, and the runtime enforces it by placing them in cache-class storage.**

Reasons, in order of weight:

1. **Restore is a correctness hazard, not just waste.** A restored mirror carries
   a matching fingerprint (declaration identity has not changed), a stale cursor,
   and possibly another principal's data. The fingerprint gate says *current*.
   Only the cursor's monotonic high-water discipline and the full-pull backstop
   (ADR-0064) save the freshness half, and *nothing* currently saves the identity
   half. Backing the store up multiplies the number of ways that state arises.
2. **It is pure waste by construction.** ADR-0192 clause A: nothing
   human-meaningful exists only in a mirror. Backing up gigabytes of re-pullable
   Gmail buys nothing a re-sync does not.
3. **Credential adjacency.** Clause E keeps the credential out of the mirror
   directory; keeping the mirror out of the backup sweep removes a second way for
   a data directory to end up somewhere it should not.

The honest cost: a very large mirror (a decade of mail) takes a long re-pull
after a machine restore, and a user who assumed "my backup has my mail" is
surprised. Both are acceptable — the upstream *is* the backup, that is what makes
it the authority — but the second one is a product statement someone should make
out loud rather than a default someone infers from a directory choice.

**This is the same question as #4.** If the runtime owns the path, it puts
materializations under cache-class storage (`~/Library/Caches` on macOS,
`$XDG_CACHE_HOME` on Linux) rather than Application Support, and backup exclusion
falls out with no per-app mechanism, no exclusion API call, and no rule anyone
has to remember. Two of the mission's six questions collapse into one owner
change. That collapse is the strongest single result in this pass.

## What gets built

Two competing prototypes over one shared conformance suite, so the comparison is
evidence rather than assertion.

- **Prototype A — `policy`.** Steelmans the shape ADR-0194 names: `define` +
  `open(decl, location, policy)`, a single stored SHA-256 string, interchangeable
  lifecycle policies (`rebuildOnStale` / `refuseStale` / `readStale`), and the
  app supplying the path. This is what the tree is most likely to build.
- **Prototype B — `plan`.** The adversarial alternative: runtime-owned locations,
  a structured per-part manifest, a non-destructive `inspect` returning a
  `RebuildPlan`, reader handles that do not have destructive methods, and rebuild
  reachable only through an exclusive `WriteLease`.

The suite runs against both and records, per invariant, whether it is enforced by
**type**, by **runtime check**, or **not at all**. That table is the decision
matrix.
