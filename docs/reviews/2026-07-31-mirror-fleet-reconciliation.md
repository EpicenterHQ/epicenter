# Fleet reconciliation: external-authority mirror declarations

- **Date:** 2026-07-31
- **Inputs:** the originating tree on `claude/scalar-v1-wave1` (uncommitted fingerprint work), `.claude/worktrees/mirror-api-prototype` @ `b788865fcf`, `.claude/worktrees/local-mail-mirror-fingerprint` @ `19e8582a4e`, `.claude/worktrees/mirror-fingerprint-adversarial-review` @ `fd00e4fb15`
- **Posture:** integration. Every claim below was re-verified against the code; three were executed.
- **Baseline:** `bun test` in `apps/local-books` is green, 81 pass / 0 fail / 18 files.

## Verdict in one paragraph

The accepted law survives intact and should be frozen. The API must not be. The
fleet produced one correct mechanism (a declaration whose canonical
serialization is the rebuild gate), one correct structural refusal (indexes
excluded by construction rather than by blacklist), one correct capability split
(reader and writer are different functions, not a mode flag), and one shared
defect that all three artifacts carry: **rebuild happens as a side effect of
acquiring a writer handle.** That defect, not granularity, is the headline. It
turns five ordinary writer opens in Books and three lock-free writer opens in
Mail into potential mirror destruction, one of them reachable by a foreign agent
across the MCP egress airlock. Fix rebuild-as-an-operation first, per-table
granularity second, and the concurrency, blast-radius, and stale-reader problems
mostly dissolve as consequences. Land it in Local Books alone. Take the Mail
worktree's first commit and reject its second.

I part with the adversarial review on ranking (it leads with granularity; the
destruction seam is worse and is what makes locking tractable) and on one
mechanism call (store the canonical string, not its SHA-256). Everything else in
that memo is correct and unusually well evidenced.

---

## Evidence table

Executed means I ran it. Read means I read the code path end to end.

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| E1 | A declaration change drops **every** table and clears the realm cursor | review F1 | **Confirmed, executed** | Stamped a drifted fingerprint on a two-table mirror and reopened a writer: `tables = _meta,customers,invoices` became `tables = _meta`; `cdcCursor` `2026-01-02T00:00:00Z` became `null`; `isInitialized(Invoice)` true became false. |
| E2 | The cheap per-entity path exists and is bypassed | review F1 | **Confirmed, read** | `src/sync.ts:199-217` partitions on `db.isInitialized(entityDef(name))`, full-pulls only the uninitialized names, and rides the rest on one CDC call. E1 resets that partition to "everything is new". |
| E3 | Adding an entity is advertised as free | review F1 | **Confirmed, read** | `src/entities.ts:12-14`: "Adding an entity is one entry here with no migration, so there is no reason to curate below the full posting set." E1 makes that sentence false. |
| E4 | The declaration is a sibling of the DDL, not its source | review F2 | **Confirmed, read** | `src/entities.ts:315-321` declares `updatedAt` / `syncedAt`; `src/db.ts:189-198` emits `updated_at` / `synced_at`. Different casing, no derivation, no test binding them. Only `.entities` is derived from `entityDef`. |
| E5 | Books writer opens are not mutually excluded | review F3 | **Confirmed, read** | `src/app.ts:42-47` states the realm `lock.db` "never blocks a concurrent `local-books sync` (which is the whole point)". Five production writer opens: `app.ts:206`, `commands/sync.ts:78`, `commands/mcp.ts:179`, `books/recategorize.ts:173`, `commands/demo.ts:136`. |
| E6 | The rebuild gate is not transactional | review F3 | **Confirmed, read** | `src/db.ts:148-172`: a `sqlite_master` scan, a `DROP TABLE` loop, a `DELETE FROM _meta`, and the stamp are separate implicit transactions. |
| E7 | Readers cannot distinguish "empty" from "mid-rebuild" | review F4 | **Confirmed, read** | `db.ts:369-391` and `db.ts:414-423` return `{rows: [], total: 0}` / `rows: 0` for a missing table. `books/query.ts:69` opens a bare `new Database(dbPath, {readonly: true})` and never reads `_meta`. `books/read-models.ts:61,96,123` take the read-only handle and never check. Only `books/status.ts:104-105` computes `mirrorStale`. |
| E8 | The MCP `sync` tool can destroy the mirror and says it cannot | review F5 | **Confirmed, read** | `commands/mcp.ts:179` opens a writer; `mcp.ts:239` filters `tier !== 'mutation'`, and `sync` is `tier: 'write'`, so it survives read-only mode. Its description (`mcp.ts:165`) reads "Side-effecting but safe: it only updates the local copy." |
| E9 | `canonicalJson` flattens non-plain objects to `{}` | review F6 | **Confirmed, executed** | `canonicalizeDeclaration` returns `{"cols":{}}` for `Set`, `Date`, `Map`, and `{}` alike. Latent today (the declaration is a literal), fatal under any builder. |
| E10 | Two version channels, neither tested | review F7 | **Confirmed, read** | `db.ts:34` domain `'epicenter.local-books.mirror/v1'` plus `entities.ts:314` `format: 1`. ADR-0194 line 20 promises a "domain **and format tag**" prefix; `fingerprint.ts:45` prefixes the domain only. |
| E11 | `sqlIdent` over `sqlite_master` permanently bricks writer opens | review F8 | **Confirmed, executed** | Created `MyNotes` in a mirror, drifted the stamp, reopened: `BRICKED: Unsafe SQL identifier: MyNotes`, and again on the second attempt. No self-heal; the stamp never lands. |
| E12 | `canonicalizeDeclaration` has zero production callers; the index test is a tautology | review F9 | **Confirmed, read** | Only consumer is `test/fingerprint.test.ts:18-20`. `fingerprint.test.ts:35-51` spreads an object, destructures the added key back off, and asserts equality: a property of object spread, not of this system. |
| E13 | ADR numbers 0191-0193 are vacant on this branch | review F10 | **Confirmed, read** | `docs/adr/` runs `...0189, 0190, 0194`. The three exist on unmerged branches. |
| E14 | **Mail's gate commit rests on a false safety claim** | new | **Confirmed, read** | `19e8582a4e`'s message: "Every writer path already holds the per-account sync lock before opening." It does not. `apps/local-mail/src/mcp.ts:194` (`modify_labels`, `tier: 'mutation'`) opens a writable session with no lock; `apps/local-mail/src/cli.ts:389` (the label verbs) likewise; `apps/local-mail/src/app.ts:203` opens the session **before** `acquireSyncLock` at line 218 and keeps the engine when `lock === null`. `apps/local-mail/src/lock.ts:6-9` says so outright: "Only the sync path takes this lock; reads and triage writes go Gmail-first with a best-effort local fold, so neither needs it." |
| E15 | **Mail's rebuild is strictly more destructive than Books'** | new | **Confirmed, read** | `apps/local-mail/src/db.ts:194-197` closes the handle and `unlinkDbFiles(path)` (db, wal, shm), then reopens. Combined with E14: an unlocked `modify_labels` call from a foreign agent against a drifted binary deletes the mailbox mirror. A concurrent holder keeps writing into the unlinked inode. |
| E16 | **The mail gate removes the guard that made the old version safe** | new | **Confirmed, read** | The old code was `if (storedVersion !== null && storedVersion !== SCHEMA_VERSION)`. The new code is `if (storedFingerprint !== MIRROR_FINGERPRINT)`. The commit message treats dropping the null guard as a feature; it is what makes every unstamped or foreign file an unlink. |
| E17 | **The prototype preserves the per-table latch in a pass and destroys it at open** | new | **Confirmed, read** | `examples/mirror-api/src/writer.ts:178-186` creates a table on first use in a pass, and the README (lines 77-79) explains why: "both mirrors use table existence as the per-table 'has this had its first full pull?' latch. Creating everything at open would silently destroy that." Then `writer.ts:149-176` drops every derived table at open, and the README (line 208) refuses per-table fingerprints. The prototype argues against itself. |
| E18 | The prototype's gate **is** transactional | new | **Confirmed, read** | `writer.ts:149` wraps the whole gate in `database.transaction`. It fixes the torn half of E6 and none of the live-lock half; there is no lock anywhere in the prototype. |
| E19 | Mail already generates DDL from its declaration, and it works | new | **Confirmed, read** | `apps/local-mail/src/mirror-schema.ts` emits `CREATE_TABLES_SQL` from `MESSAGE_COLUMNS` / `LABEL_COLUMNS`; the commit reports the generated table set is physically identical to the hand-written one. This is exactly the artifact Books lacks (E4). |
| E20 | Mail puts the derivation token in the better place | new | **Confirmed, read** | `apps/local-mail/src/message-fields.ts:40-47` owns `STORED_PROJECTIONS`, next to `headerValue` and `bodyText`; `mirror-schema.ts` imports it. The prototype puts `revision` in the declaration, one file away from the function it describes. Mail's placement wins: the edit and the stamp are the same edit. |

### Findings I downgrade

**E1 is expensive, not incorrect, on its own.** The review calls whole-mirror
granularity "the granularity at which the design is correct." That overstates
it. After the drop, `sync.ts` sees a null cursor, forces FULL, and re-pulls the
company correctly. The defect is cost plus incentive: `entities.ts:12-14`
promises a free entity addition and now charges a whole-company re-pull under a
500 req/min budget, so the documented reason to keep the posting set complete
becomes a reason never to touch it. It becomes a correctness problem only in
composition with E7 (during the re-pull every read surface confidently reports
zero) and with a full pull that fails partway (populated tables, no cursor). I
reach the same conclusion as the review by a shorter route, and the honest
framing matters because it explains why per-table is second priority, not first.

**E5's live-lock needs version skew; the torn rebuild does not.** The review's
scenario (two fingerprint-era writers destroying each other in a loop) requires
two binaries compiled from different declarations, which is the dev loop and the
upgrade-while-running case, not steady state. But E6 plus E5 give a same-version
hazard with no skew at all: on the first upgrade, two concurrent writers can both
detect the mismatch and both drop, one of them mid-full-pull. Both matter; only
one needs skew.

**E11 is real but requires a user to poke the file by hand.** Low severity. It is
worth naming only because the corrected design deletes it for free (see below),
which is the best kind of fix.

---

## Corrected target architecture

Four changes to the law as implemented. The first is the one that matters.

### 1. Rebuild is an operation, not a consequence of opening

Today the power to destroy the mirror is attached to the act of acquiring a
writer handle. Books has five such acquisitions (E5) and Mail has three
lock-free ones (E14); one on each side is a tool a foreign agent calls across
the ADR-0073 airlock (E8, E14). `recategorize` writing one row must not be able
to drop seventeen tables, and `modify_labels` adding a Gmail label must not be
able to unlink a mailbox.

Three capabilities, not two and not a flag:

```ts
openBooksReader(path)    // never writes; reports built | stale | rebuilding
openBooksWriter(path)    // Err(MirrorStaleError) instead of dropping
rebuildBooksMirror(path) // the only drop; holds the realm lock; one IMMEDIATE transaction
```

The mode-flag refusal is well earned, and this codebase produced the evidence
itself: `openBooksDb(path, { readonly = false })` defaults to the destructive
capability, so forgetting an argument silently acquires the power to drop tables,
and the highest-traffic read path avoided the module entirely rather than pass
the flag (E7). A discriminant whose two arms differ by the power to destroy the
artifact is the wrong shape.

**Who may rebuild.** Only a process holding the realm lock as an exclusive owner
for the whole rebuild. Books already has that lock (`app.ts` takes `lock.db` with
`BEGIN EXCLUSIVE` for its process lifetime and refuses to start if it cannot);
it simply has no other caller today. Give `rebuildBooksMirror` that caller. The
consequences fall out cleanly:

- `local-books sync` acquires the lock, rebuilds if stale, says so on stderr, then full-pulls. Sync's job is to repopulate, so rebuilding is in scope.
- While `local-books app` is running, `sync` cannot take the lock, so it refuses with "another process owns this mirror; stop it and re-run". The version-skew live-lock is now impossible: exactly one process is ever permitted to rebuild.
- `recategorize`, the MCP `sync` and `modify` tools, and `app`'s loop get `Err(MirrorStaleError)` and surface it. None of them drops anything, ever.

This is the answer to "rebuild on open, refuse stale, or explicit rebuild": all
three, assigned by caller. Writers refuse. One verb rebuilds. Nothing rebuilds
implicitly.

### 2. The declaration generates the DDL. There is no sibling

E4 is the exact failure ADR-0194's Context paragraph promises to eliminate, made
harder to see because the stale thing looks derived. `MIRROR_DECLARATION` becomes
the sole input to every `CREATE TABLE` the writer emits, spine included, and the
hand-copied `row` block is deleted. Mail has already done this and reports the
generated tables are physically identical to the hand-written ones (E19), so the
technique is proven, not speculative.

### 3. Fingerprints are per table, over one spine

The spine (the five columns every entity table shares) gets one gate; each table
gets its own. The rules:

- **spine changed** -> drop everything, clear the cursor. The only whole-mirror event.
- **one table's declaration changed** -> drop that table only. Cursor untouched.
- **a table added** -> drop nothing. `CREATE TABLE IF NOT EXISTS` plus the existence latch already handle it.

The decisive evidence that this composes rather than complicates: a per-table
drop lands that entity in precisely the state `sync.ts:199-217` already handles.
`isInitialized` returns false, the entity is full-pulled on its own, everything
else rides the shared CDC cursor. The corrected design does not add a path; it
stops bypassing one that exists (E2).

Two bonuses worth naming. First, the drop now names the tables it removes from
the declaration instead of sweeping `sqlite_master`, which deletes E11 outright:
no foreign table name ever reaches `sqlIdent`. Second, E7 shrinks by a lot on its
own, because a rebuild affects one table while the other sixteen keep answering
correctly.

So: **per-table granularity is required by the latch, not a deferred
optimization, and the design should not supersede the latch.** ADR-0064's latch
is live, load-bearing, and cheaper than anything that replaces it.

### 4. The gate is the canonical string, not its SHA-256

This is the prototype's open fork and my lowest-conviction call, so here is the
reasoning plainly. The gate is only ever compared for equality, and the string
does that job directly. Storing it buys three things: a stale mirror can be
**diffed** to name the column that moved (which is exactly what E7's readers need
in order to say something useful rather than "two hashes differ"); the code stays
pure and synchronous with no crypto, so it runs unchanged in Bun, a browser, and
a Durable Object; and `Bun.CryptoHasher` leaves the dependency graph. The cost is
a few KB across seventeen `_meta` rows and a noisier `SELECT * FROM _meta`. Take
the diff.

Reversing this is one line at the writer and one at the reader, so it is not
worth a second round of debate either way.

**Also settled here:** delete `format: 1` (E10). The domain is the single version
channel, because it is the only place that can express a change of meaning when
the bytes are identical. Amend ADR-0194's canonicalization sentence to match.

### What the declaration holds

The prototype's field set is right and survives almost whole. Keeping:

| Field | Verdict |
|---|---|
| `domain` | Keep. The sole version channel. Names the declaration, never the authority instance. |
| `columns` (`type`, `from` path, `stored`) | Keep. Projections over `raw` are the default kind of column. |
| `supplied` + derivation token | Keep, with Mail's placement (E20): the token lives beside the function, and the declaration imports it. |
| `orderBy` (`column`, `from`) | Keep, and this is the prototype's best idea. Books needs monotonic writes; Mail has no authority ordering value. That was a mode flag waiting to happen, and the prototype turned it into data: monotonicity falls out of the field's presence, and a table with nothing to order on gets last-writer-wins, which is the honest behavior. |
| `softDelete` | Keep. Same move: a column, so the verb exists only where the shape supports it. |
| `indexes` | Keep excluded, and keep the prototype's **structural** exclusion (`rebuildShape` never reads the field) over a blacklist. There is no exclusion list to keep current and no way to add an index-shaped field that accidentally becomes a rebuild input. |
| `format` | **Delete.** Duplicate version channel (E10). |
| paths, realm/account identity, credentials, cursors, engine, read models | Stay out. ADR-0194 is right about all of these. |

One gap neither artifact closes, and it is not this design's to close: a
`books.db` copied from realm A into realm B's directory is undetectable. Store
authority identity as a separate `_meta` fact. Do not contaminate the gate with
it.

### What ADR-0194 must stop claiming

Its Context paragraph ("A hand-maintained schema version is therefore an
unnecessary correctness gate") is false for any mirror with an imperative
projection, and Mail is exactly that mirror: `subject`, `sender`, and `body_text`
are a header lookup and a base64url MIME walk whose output type is `TEXT` no
matter how the algorithm changes. No data declaration can observe a change to
`stripHtmlTags`.

The honest claim is stronger than the false one and the ADR should make it:
**fingerprinting does not abolish hand-stamped versions, it scopes them.**
`SCHEMA_VERSION = '4'` is one global integer whose blast radius is the whole
mirror and whose staleness is invisible. `STORED_PROJECTIONS.bodyText` sits on
the line above the function it describes, and forgetting it costs one column
instead of one mailbox. That is a real win. Claim it.

---

## Integration order

One wave, Local Books only, on `claude/scalar-v1-wave1`. No new package, no Mail
changes, no ADR beyond amending 0194.

**Step 1: the declaration owns the shape.**
`src/entities.ts` loses the hand-copied `row` block and `format: 1`; the spine
moves into `MIRROR_DECLARATION` as the source of the `CREATE TABLE` text that
`db.ts:189-198` emits. `src/fingerprint.ts` becomes canonical-string only
(`canonicalDeclaration(domain, declaration): string`), rejects any object whose
prototype is not `Object.prototype` or `null` (E9), and loses
`fingerprintDeclaration` and the orphaned `canonicalizeDeclaration` (E12).

**Step 2: split the gate.**
`_meta.mirror_fingerprint` becomes `mirror_spine` plus `mirror_table:<name>`.
Scope the drop per section 3. The `sqlite_master` sweep goes away with it.

**Step 3: split the capability.**
`openBooksDb` becomes `openBooksReader` / `openBooksWriter` /
`rebuildBooksMirror`. Route the five writer opens (E5): `commands/sync.ts` takes
the realm lock and may rebuild; `app.ts`, `commands/mcp.ts`, `books/recategorize.ts`
handle `MirrorStaleError`; `commands/demo.ts` builds fresh and may rebuild.
`rebuildBooksMirror` runs in one `IMMEDIATE` transaction under the lock (E6).

**Step 4: give readers a signal.**
`books/query.ts:69` stops opening a bare `new Database` and goes through
`openBooksReader`, returning a typed stale error rather than silently querying
dropped or old-shape tables. `pageRows` and `entityStatus` report not-built
rather than zero (E7); `EntityStatus.initialized` already carries the bit and
`db.ts:374` throws it away.

**Step 5: correct the airlock.**
`commands/mcp.ts:165`'s "Side-effecting but safe" is true again once `sync`
cannot destroy (E8), but the description should say what it now does on a stale
mirror. Confirm `tier` assignment while there.

**Step 6: amend ADR-0194.** See the checklist below.

Mail comes after, as its own wave, once steps 1-4 have run in Books for a while.
Nothing about Mail belongs in this wave.

### ADR-0194 edits

- Replace the deferred per-table alternative with per-table plus spine as the decision (E1, E2).
- State the ADR-0064 relationship explicitly: the per-entity existence latch is **preserved**, and a per-table drop hands the entity to the existing backfill path. Listing 0064 under *Relates* is not enough.
- State the ADR-0063 relationship: rebuild is the one non-monotonic mutation in the mirror, it bypasses the single write door, and it is therefore an explicit locked operation, never a side effect of acquiring a handle.
- Drop the claim that hand-stamped versions are unnecessary; scope them to per-column derivation tokens and claim the narrower win.
- Fix the canonicalization sentence: the gate is the domain-prefixed canonical string, and there is no format tag.
- Soften the `defineMirror`/`openMirror` consequence to a constraint on any future API. ADR-0192 refused that extraction and nothing here re-earns it.
- Renumber at merge, or confirm this branch merges after 0191-0193 (E13).

---

## Rejected fleet artifacts

**Reject: `19e8582a4e`, the Mail gate commit.** It cannot be integrated as-is or
after cosmetic edits. Its central safety claim is false (E14), it removes the
null guard that made the old gate safe against unstamped files (E16), and its
destructive act is an unlink rather than a drop (E15). The composition is the
worst single hazard in the fleet: a foreign agent calling `modify_labels` against
a drifted binary deletes a mailbox mirror, with no lock held and a concurrent
process potentially writing into the unlinked inode. Discard the commit. Correct
the message's lock claim wherever it is reused.

**Accept: `74d30066cd`, the Mail declaration commit.** Keep all of it:
`mirror-schema.ts` generating the DDL from the declaration (E19, the artifact
Books lacks), `STORED_PROJECTIONS` in `message-fields.ts` (E20, the better
placement of the derivation token), and `mirror-schema.test.ts`. It wires nothing
up, which is exactly right. Its duplication of `fingerprint.ts` into Mail is also
right and its stated reason is right: two standalone Bun CLIs with no dependency
edge, kept identical so the eventual extraction is a delete.

**Reject: the prototype's whole-mirror drop-on-open and its refusal of per-table
fingerprints.** The prototype argues against itself here (E17): it carefully
preserves the per-table initialization latch inside a write pass, explaining in
its own README why creating tables at open would destroy it, and then destroys it
wholesale at open with a `DROP TABLE` sweep. Overturn the refusal on line 208 of
its README.

**Keep from the prototype:** the reader/writer capability split and the argument
against a mode discriminant; `orderBy` replacing a monotonic flag; `softDelete`
as a column; structural index exclusion; the transactional gate (E18); the
`examples/` placement and the "not a package yet" reasoning. Add the third
capability it is missing.

**Reject: promotion to `packages/mirror` or `@epicenter/mirror`.** ADR-0192
refused a shared mirror package until a third provider exists, and that refusal
still holds. Two consumers, both AGPL apps, and one of them cannot adopt the
current shape at all. Extracting now would freeze whole-mirror granularity that
is wrong and a declaration model that does not yet cover Mail's imperative
projections. Implement as `openBooksWriter` / `openBooksReader` /
`rebuildBooksMirror` inside `apps/local-books/src/db.ts` and mirror the names in
`apps/local-mail`. The shape is proven by two independent implementations
agreeing, not by an import.

**Reject: SHA-256 as the stored gate** (section 4), **`format: 1`** (E10), and
**`canonicalizeDeclaration` as an exported orphan** (E12).

**Reject, restating the prototype and review agreeing:** hashing function source
for derivation tokens (formatting and bundling move it, and it does not survive
`bun build --compile`); a generated schema artifact committed to the tree (a
build step that can be forgotten, which is a hand-stamped version wearing a
costume); content-hashing `sqlite_master` SQL (SQLite re-emits stored DDL text
differently across versions); keeping `SCHEMA_VERSION` alongside the gate; and
atomic rebuild via shadow file and rename for Books (per-table granularity
shrinks the blast radius enough that WAL sidecar handling and open-handle
invalidation are not worth it).

---

## Tests that prove the invariants

The current `test/fingerprint.test.ts` proves the hasher and nothing about the
system. Two of its three tests survive; the third is a tautology about object
spread (E12) and should be deleted, not repaired. These replace it.

**The four that decide the design.** The first fails against the current
implementation, which is the point.

1. **Adding an entity drops no existing table and preserves the cursor.** Build a mirror with two entities, ingest rows, advance `cdc_cursor`, then reopen against a declaration with a third entity. Assert both original tables still hold their rows and `cdc_cursor` is unchanged. This is the test that proves or refutes E1; if it cannot be made to pass without whole-mirror drops, the latch and the gate are genuinely incompatible and ADR-0194 must say which one wins.
2. **Changing one entity's generated column drops exactly that table.** Same setup; change a column on one entity only. Assert that table is gone, every other table is intact, and the cursor survives.
3. **Changing the spine drops everything and clears the cursor.** The one whole-mirror event, asserted as such so it cannot creep.
4. **The declaration agrees with the DDL the writer emits.** Read column names, types, and generated-column expressions back from `sqlite_master` / `PRAGMA table_info` for every declared table and compare against the declaration. This is the F2 killer: it makes the E4 drift a test failure rather than a review item, and it is the test whose absence let `updatedAt` and `updated_at` coexist.

**The capability invariants.**

5. **A writer against a changed declaration returns stale and drops nothing.** Assert the tables and `_meta` are byte-identical after the failed open.
6. **A reader never mutates.** Open a reader against a drifted mirror; assert `_meta`, the stamp, and every table are unchanged, and that it reports `stale` rather than throwing.
7. **A reader distinguishes not-built from empty.** A declared table with no rows and a declared table with no table must not produce the same answer from `pageRows` / `entityStatus`.
8. **Only the rebuild verb drops.** Drive `recategorize` and the MCP `sync` tool against a drifted mirror and assert both surface an error with zero tables dropped.
9. **Rebuild is exclusive.** With the realm lock held, assert `rebuildBooksMirror` refuses rather than proceeding. This is the test that retires the E5 live-lock.

**The serializer invariants.**

10. **Non-plain objects are rejected.** `Set`, `Map`, and `Date` must throw, not serialize to `{}` (E9).
11. **The domain separates.** The same declaration under two domains produces two different gates. Currently untested (E10).
12. **Array order is load-bearing.** Reordering a `path` changes the gate; reordering object keys does not. The second half exists today and is worth keeping.

**Regression guard.** `bun test` in `apps/local-books` must stay at or above the
81-pass baseline, and `test/db.test.ts` already covers the monotonic write door
that the rebuild path must not disturb.

---

## Freeze verdict

**Freeze the law. Do not freeze the API.**

Freeze now, as an amended ADR-0194:

- A mirror's rebuild gate is the canonical serialization of its rebuild-relevant declaration, domain-separated, key-sorted, array-order-preserving.
- The declaration is the sole input to the emitted DDL. No sibling description.
- Writers compare and stamp. Readers never rebuild and never stamp. Readers may report staleness and must not report a rebuilt-away table as an empty success.
- Rebuild is an explicit operation held under an exclusive lock in one transaction, never a side effect of acquiring a handle.
- Granularity is per table over one spine. The per-entity existence latch is preserved.
- Indexes, paths, cursors, credentials, engine, authority identity, and configured runtime subsets are not inputs, and the exclusion is structural.
- Derivation tokens are the one hand-stamped input; they live beside the function they describe. Fingerprinting scopes hand-stamping, it does not abolish it.

Do not freeze `defineMirror` / `openMirror`. Three reasons, in descending order:
the corrected model has never been run (every artifact in the fleet implements
the uncorrected one); Mail cannot adopt the current shape at all and the one
worktree that tried produced the fleet's worst hazard (E14, E15); and ADR-0192
already refused the extraction, so freezing an API now would settle by momentum a
question that was deliberately left open.

The right next artifact is not an API. It is test 1 above, passing in Local
Books.
