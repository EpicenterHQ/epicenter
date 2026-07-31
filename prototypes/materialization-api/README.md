# Adversarial materialization API prototypes

Two competing lifecycle APIs for Epicenter materializations, run against one
conformance suite, so the comparison is evidence rather than assertion.

This is a **design artifact, not a package**. It is outside the root
`workspaces` globs on purpose: nothing imports it, nothing ships it, and it must
not enter the repo's CI gates. `CLEANROOM.md` holds the alternatives written
before any implementation source was opened, committed separately so the record
stays honest.

```
bun install                 # at the repo root, once
cd prototypes/materialization-api
bun test                    # 59 pass
bun run typecheck           # clean
```

## The word, and what it may and may not touch

The mission says **materialization**. The tree says **mirror** (a disposable
projection of a remote HTTP authority, ADR-0192) and **materializer** (a local
worker projecting Epicenter data into markdown or SQLite, `docs/CONTEXT.md`).
ADR-0192 refuses to unify the two *data planes*, and that refusal is right.

But that refusal is about **who owns truth**. It says nothing about **what a
derived store is**. Both shapes are the same machine, `authority -> declaration
-> materialized store -> readers`, and both face the same six lifecycle
questions. Those are ownership questions, not data-model questions. So
"materialization" is used here as the lifecycle noun, and nothing in either
prototype gives a derived store a merge, a peer, a shared sync watermark, or a
place in canonical data.

## The precedent the tree has not applied to mirrors

**ADR-0176 already solved this ownership problem, for indexes.** A derived read
structure needs two explicitly assigned owners: a **semantic owner** that
declares one access pattern, and a **runtime owner** that materializes,
rebuilds, limits, evicts, and disposes the physical thing.

A materialization is an index with a bigger footprint and a remote source. Today
a mirror app is both owners at once, and every question the mission asks is a
consequence of that merge:

| Question | Owner under ADR-0176 | Owner in `apps/local-books` today |
| --- | --- | --- |
| declaration shape | semantic | app |
| what counts as a shape change | semantic + runtime | app |
| where the file lives | **runtime** | app (`src/paths.ts`) |
| when the store is dropped | **runtime** | app, inside `openBooksDb` |
| who may drop it | **runtime** | anyone holding a writer handle |
| whether a stale read is offered | runtime offers, semantic judges | nobody: the read path cannot ask |
| backup visibility | **runtime** | app, by picking Application Support |

## Decision matrix

`type` = the API makes the violation unrepresentable. `runtime` = it is caught
when someone does it. `none` = nothing catches it.

| # | Invariant | A `policy` | B `plan` | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Reordering declaration keys does not rebuild | type | type | `conformance.test.ts` "reordering declaration keys" |
| 2 | Adding an index does not rebuild | type | type | `conformance.test.ts` "adding an index" |
| 3 | A projection change rebuilds | runtime | runtime | `conformance.test.ts` "adding a projected column" |
| 4 | A declaration-format change never reads the old shape | runtime | **type** (comparison is refused, not attempted) | `plan.test.ts` "format change refuses to compare" |
| 5 | A reader never rebuilds | runtime (SQLite refuses the write) | **type** (no method exists) | `policy.test.ts` "every handle carries rebuild"; `plan.test.ts` "a reader holds no method" |
| 6 | A reader cannot mistake stale rows for current | **none** (a boolean field it may ignore) | **type** (`StaleRead<T>` wrapper) | `plan.test.ts` "stale rows arrive wrapped" |
| 7 | One sync owner per principal (ADR-0192 D) | **none** | **type** (`LeaseResult`) | `conformance.test.ts` "a second sync owner"; `plan.test.ts` "a second lease yields" |
| 8 | A store belonging to another principal is refused | **none** (it opens as *current*) | **type** (`kind: 'foreign'`) | `policy.test.ts` "another principal opens as current"; `plan.test.ts` "foreign, not stale" |
| 9 | Credentials cannot land inside a store directory (ADR-0192 E) | none (prose) | **type** (the app names no path) | `plan.test.ts` "a credential can never be placed inside" |
| 10 | One 0700 directory per principal (ADR-0192 G) | none (prose) | **type** | `plan.test.ts` "0700 without any app remembering" |
| 11 | A disposable store is not generic-backup visible | none | **type** (cache-class root) | `plan.test.ts` "cache-class storage, not the data root" |
| 12 | A one-table change costs a one-table re-pull | **none** (whole store) | **type** (per-part manifest) | `conformance.test.ts` "the cost of a one-table change" |
| 13 | A rebuild is inspectable before it happens | none | **type** (`RebuildPlan` value) | `plan.test.ts` "the plan is a value, computed without a disk" |
| 14 | A stale fold cannot regress a fresher row (ADR-0192 B) | runtime (shared door) | runtime (shared door) | `conformance.test.ts` "a stale fold cannot regress" |
| 15 | Missing per-record version degrades explicitly | runtime | runtime | `conformance.test.ts` "degrades to last-writer-wins" |

Rows 14 and 15 are equal because both prototypes route every write through the
same `src/store.ts` door. That is deliberate: it isolates the comparison to API
shape, and it is also the answer to ADR-0192's own diagnosis. The divergence it
was written about (Books learned a monotonic door, Mail did not) is a **write
door** problem, and neither of these API shapes fixes it. Only one door does.

## Recommendation

**Take prototype B's ownership move, in one small piece, now; take the rest of
its API only when the third provider arrives.**

The ownership move worth doing immediately is **question 4, paths belong to the
runtime**. It is small and mechanical, it is per-app so it needs no package, and
it closes ADR-0192 clause G, the credential-adjacency half of clause E, the
cross-principal collision question, and the backup question in one change (rows
9 through 11). Nothing else in this design has that ratio.

The second thing worth doing now, and it is a bug fix rather than a redesign, is
**question 5, staleness must reach the read path**. `books_sql_query` opens a
raw connection and cannot ask; the fingerprint gate is currently a writer-only
mechanism that the surface it was meant to protect never consults.

The four-verb split, the per-part manifest, the plan value, and the lease are
the *right* shape and the wrong time. ADR-0192 defers `@epicenter/mirror` to the
third provider because two samples disagree exactly where the abstraction is
hardest, and that argument holds against this API too. What this prototype
establishes is that the contract is expressible as types rather than prose, so
when the third provider arrives the choice is already evidenced.

**Prototype A is not a strawman and should be read as the honest fallback.** Its
interchangeable policies are a real improvement over the unconditional drop in
the tree today. It is rejected because three of its holes (rows 6, 7, 8) survive
every policy choice, and a policy parameter re-creates the "duplicated
decisions, unevenly applied" failure ADR-0192 was written about.

## Six answers

**1. `createApp` versus define/open separately: neither. Four verbs.**
One call makes the declaration a side effect of construction, and ADR-0194
requires it to be deterministic plain data. But `define` + `open` is only half
right, because `open` is three unrelated authorities wearing one word: *name a
path*, *judge validity*, *destroy data*. ADR-0192 clause B has to say "a
read-only connection never migrates, never drops, and never writes" only because
one function can do all three. `locate` / `inspect` / `openReader` / `lease`
turns that sentence into a type. The cost is four calls where an app wants one;
the mitigation is one convenience wrapper per consumer, never in the kernel.

**2. Fingerprint: a per-part manifest, with the whole-store digest as a fast path.**
ADR-0194's canonicalization is right and untouched: sorted keys, preserved array
order, refused unsupported values, domain and format tag. What is wrong is
throwing the canonical form away after hashing it. A hash is a diff you already
computed. Storing it costs kilobytes and buys per-table granularity (row 12), a
legible reason a person can read, and a comparison that is a pure function of
two values (row 13).

**3. Rebuild: a separate controller, reachable only through a lease. The plan is
the interesting half.** The point is not that rebuild becomes harder to call. It
is that "what will this release do to my store, and why" becomes answerable
*without doing it*, in a unit test and in a `--dry-run`. Rebuild authority stops
being a rule about which connection you used and becomes a fact about which
value you hold.

**4. Paths belong to the runtime. This is the highest-value single change.**
ADR-0192 clauses E and G are *layout* invariants that each app implements from
prose, which is exactly the "duplicated decisions, unevenly applied" failure the
ADR was written about. Let the app name a **principal** and never a **path**, and
four rules become mechanical at once (rows 9, 10, 11, and cross-principal
collision). The runtime is a plain value, not a service, so ADR-0072's
standalone dependency-light CLI still works and ADR-0192's rejection of
host-owned mirroring still stands.

**5. Readers may open stale data, and the stale handle is a different type.**
Epicenter already decided the shape of this three times on the other plane:
ADR-0003, ADR-0175, ADR-0187. Never hide nonconforming state, never silently
repair it, make the caller see it. Failing closed was considered and rejected: a
cache that refuses to answer because a release renamed a field is an outage
caused by a formatting change, and ADR-0061 makes the mirror the offline
high-volume read surface. So: yes, but wrapped, so ignoring staleness is an
explicit unwrap a reviewer sees rather than a boolean nobody read.

**6. No, and the runtime enforces it by choosing cache-class storage.**
Backing up a disposable store is waste by construction (ADR-0192 clause A), and
worse, restore is a *correctness* hazard: a restored store carries a matching
fingerprint, a stale cursor, and possibly another principal's data. Question 6
is the same question as question 4 — if the runtime owns the path it picks
`~/Library/Caches` over Application Support and the answer falls out with no
per-app exclusion call. The honest cost is that a decade of mail re-pulls after
a machine restore, and that "the upstream is the backup" is a product statement
someone should make out loud rather than a default inferred from a directory.

## Explicit refusal points

Things this design refuses, and why the refusal is the load-bearing part.

- **Refuse a structured diff that interprets an old declaration.** Comparing a
  stored declaration is one bad step from a migration reader, which ADR-0192
  clause A refuses outright. The step is *interpretation*. So `comparePlan` is a
  **shape-blind generic tree comparison** over canonical JSON: it may say the
  value at `tables.purchase.columns` differs, and it never knows what a column
  means. A `format` change disables comparison entirely and the answer is a full
  rebuild (`plan.test.ts`). Without that refusal, per-table granularity is not
  worth having.
- **Refuse to let the fingerprint carry authority identity.** ADR-0194 is right
  to exclude it: a fingerprint is a *declaration* identity. The refusal is only
  safe if something *else* carries it, and today nothing does. Prototype B
  stores it beside the manifest with its own outcome (`foreign`), which is
  neither `current` nor `stale` and specifically **not** an automatic rebuild:
  silently re-pulling over another principal's store is recoverable but wrong to
  do without saying so.
- **Refuse a policy flag at the call site.** Prototype A's three interchangeable
  policies are a real improvement over an unconditional drop, and they are still
  the wrong shape, because the invariant "only the sync owner rebuilds" becomes
  a convention every call site must remember. That is precisely the failure mode
  ADR-0192 diagnosed. B has no policy parameter at all: what a stale store means
  is a value (`RebuildPlan`) and who may act on it is a capability (`WriteLease`).
- **Refuse a runtime that is a service.** ADR-0072 makes Local Books a standalone
  dependency-light single binary, and ADR-0192 rejected host-owned mirroring on
  the merits. The runtime owner must be a *value* a process constructs, or the
  whole ownership move is unavailable to the one app that needs it most.
- **Refuse to unify the two data planes.** Nothing here gives a materialization
  a merge, a peer, a shared watermark, or a canonical address. The generalization
  is over *lifecycle*, and it stops there.
- **Refuse per-table cursors.** Per-table rebuild does **not** imply per-table
  cursors. ADR-0064's realm cursor and table-existence latch are what make a
  partial rebuild self-heal; a dropped table backfills through the latch while
  everything else stays incremental. `clearCursor` is false for an ordinary
  declaration change and true only when the comparison itself was impossible.
- **Refuse to extract a package.** ADR-0192 defers `@epicenter/mirror` to the
  third provider, and nothing here changes that arithmetic. This is a design
  argument about ownership, delivered as code so it can be run.

## What the current code wrongly suggests

Read against `apps/local-books` at the head of this branch's base plus the
uncommitted fingerprint wave in the main checkout. Every claim below was checked
in the source; none of it is inferred from the ADRs.

- **"A reader reports staleness."** ADR-0194 says a reader *may* report that the
  on-disk mirror is stale, and the shape of `openBooksDb(path, { readonly: true
  })` suggests a reader is in a position to. It is not.
  `MIRROR_FINGERPRINT` is referenced in exactly three places: `src/db.ts` (the
  writer gate), `src/books/status.ts` (one comparison), and a test. Neither
  `src/books/read-models.ts` nor `src/commands/mcp.ts` compares it, and
  `src/books/query.ts` — the `books_sql_query` surface ADR-0061 makes the
  high-volume agent read — opens a **raw** `new Database(dbPath, { readonly:
  true })` that never touches `_meta` at all. So the one surface where a wrong
  shape gets *believed*, by an agent answering a finance question, is
  structurally incapable of asking. The fingerprint moved the failure from bump
  discipline to read discipline; it did not delete it.
- **"`openBooksDb` opens a database."** It also judges validity and destroys
  data, unconditionally, with no parameter naming either. There is not even a
  policy flag: a writer open always drops on mismatch and always stamps. The
  destructive act is invisible at every call site, and there are eleven of them.
- **"The realm id identifies the store."** `src/db.ts`'s own docstring says the
  realm id "lives in the file path, not a stored column, so the db need not know
  which company it holds." That is the hole the fingerprint cannot close, and
  ADR-0194 is right that it should not try: a fingerprint is a declaration
  identity. But nothing else carries authority identity either, so a `books.db`
  restored from a backup or copied into the wrong `<realmId>/` directory opens as
  **current**, with a valid fingerprint, and answers questions about the wrong
  company. This is `policy.test.ts` "another principal opens as current",
  reproduced.
- **"Clause G is satisfied."** ADR-0192 clause G requires 0700 directories.
  `apps/local-mail/src/token-store.ts` does `mkdirSync(dir, { recursive: true,
  mode: 0o700 })` and chmods. Local Books does not: `src/db.ts:110`,
  `src/companies.ts:38`, and `src/app.ts:52` all `mkdirSync(..., { recursive:
  true })` with no mode, so the mirror directory takes the umask default. Books'
  credential file *is* 0600 and *is* correctly outside the mirror directory
  (clause E holds). ADR-0192's known-non-conformance list names only Mail's
  missing monotonic door; this one is not on it.
- **"Clause D is satisfied."** `src/app.ts` has a genuinely good exclusive lease
  (`acquireRealmLock`, a dedicated `lock.db` held with `BEGIN EXCLUSIVE` for the
  process lifetime), and its docstring explains why that beats an `O_EXCL`
  lockfile: the kernel drops an fcntl lock on `kill -9`, a lockfile is
  stale-on-crash. But that lease guards the **app**, and deliberately does not
  block `local-books sync` — the comment says so, and that is the whole point of
  the design. So the app's internal five-minute sync loop and a cron
  `local-books sync` can pull concurrently against one realm cursor. Because
  `ingest` is monotonic this is duplicate work and cursor thrash rather than
  corruption, so this is a smaller finding than it first looks. It is still
  "one sync owner per principal" not holding.
- **"Application Support is where a mirror goes."** `src/paths.ts` picks
  `~/Library/Application Support/local-books` and `$XDG_DATA_HOME`. Both are
  backed up by default. A store the ADRs describe as disposable and
  re-pullable is being swept into Time Machine, and a restored copy is the
  authority-identity hazard above. The correct root for something regenerable is
  the cache class, and picking it costs one line in the layer that should have
  owned the path anyway.
- **Two format tags for one format.** `MIRROR_FINGERPRINT` mixes a domain string
  ending `/v1` with a `format: 1` field inside the hashed declaration. One of
  them is redundant. Prototype B keeps the field, because a comparison needs to
  read the format *before* deciding whether it may compare, and a domain string
  is not a place to read it from.

Things the current code gets right and this prototype copies rather than
improves: the canonicalization rules, excluding indexes and the configured
entity subset from the declaration, stamping *after* dropping so a crash
mid-rebuild self-heals on the next open, and the read-only connection as the
enforcement floor rather than a string check.

## Open questions, logged for the adversarial reviewer

Nothing below blocks the recommendation; each has a stated default the prototype
already implements. They are recorded rather than asked because they are the
places where a reviewer disagreeing with me would change the design, and the
disagreement should land on a written position rather than on a blank.

1. **Is a materialization allowed to disappear on machine restore?** Moving to
   cache-class storage is what makes backup exclusion free, and it means a
   decade of mail re-pulls after a restore. **Default taken: yes, cache-class**
   (`plan/runtime.ts`), on the grounds that ADR-0192 clause A already says
   nothing human-meaningful lives there. The residual is that "the upstream is
   your backup" becomes a product statement someone should say out loud rather
   than a consequence of a directory choice.
2. **Should a foreign store refuse, or rebuild loudly?** Prototype B refuses,
   on the grounds that discarding another principal's data is recoverable but
   wrong to do silently. A defensible alternative is to rebuild after an
   explicit confirmation. What is not defensible is the current behaviour, which
   is to open it as current.
3. **Is per-table rebuild worth a stored declaration?** It costs kilobytes and a
   generic tree comparison; it saves a full re-pull every time one entity's
   projection changes. Whether that trade is worth taking depends on how often
   the declaration moves and how expensive a full pull is against QuickBooks and
   Gmail rate limits, which is measurable and I have not measured it.
4. **Does the four-verb split survive contact with the two real apps?**
   **Unproven, and I claim no more than that.** The conformance suite shows it
   is expressible; it does not show it reads well across 56 files of QuickBooks
   domain code, and a four-call preamble in front of every read is exactly the
   kind of tax that gets wrapped back into one function by the second consumer.
   A one-app spike is the only thing that settles it.
5. **Does any of this move before the third provider?** ADR-0192 defers
   `@epicenter/mirror` on purpose and nothing here changes that arithmetic. The
   path-ownership change (row 9 through 11) is the one piece that is worth doing
   per-app *now*, because it is small, mechanical, and closes clause G and the
   backup question at the same time.
6. **Is "lifecycle generalizes, data model does not" a real seam, or the same
   two-plane merge ADR-0192 refused, entering through a side door?** This is the
   load-bearing assumption of the whole pass and the first thing an adversarial
   reviewer should attack. My position: ADR-0192's refusal is about convergence
   semantics on single-authority data, and none of `locate` / `inspect` /
   `openReader` / `lease` touches convergence, peers, watermarks, or canonical
   addresses. The counter worth taking seriously is that a shared lifecycle
   vocabulary is how the data models get quietly aligned two refactors later,
   which is precisely how ADR-0192's own divergence story ran in reverse.

## What is not built, and would need to be

- **Orphan tables.** Prototype B drops what the plan names. A table on disk that
  appears in neither the stored manifest nor the declaration (a store touched by
  a release that no longer exists) is left alone. A real implementation needs a
  sweep, and it should be part of the plan so it is visible.
- **Lease liveness.** The lease here is an `O_EXCL` file, which is
  stale-on-crash. The tree already has the better primitive: `local-books`
  `src/app.ts` holds a dedicated `lock.db` open with `BEGIN EXCLUSIVE` for the
  process lifetime, so the kernel releases it on `kill -9`. A real
  implementation should use that, not this. The design claim being tested is
  that rebuild authority rides on a lease at all, not how the lease is taken.
- **Blob and document planes.** A materialization here is rows only.
- **Result types.** Epicenter uses `wellcrafted` `Result`; this prototype throws,
  because throwing kept the comparison legible. A real API would return
  `{ data, error }`.
