# Adversarial review: mirror declaration fingerprints (ADR-0194 and the Local Books implementation)

- **Date:** 2026-07-31
- **Reviewer posture:** adversarial. The accepted law is assumed wrong until the code proves it.
- **Under review:** `docs/adr/0194-mirrors-rebuild-on-declaration-fingerprints-not-hand-stamped-versions.md`, `apps/local-books/src/fingerprint.ts`, `apps/local-books/src/entities.ts:307-338`, `apps/local-books/src/db.ts:33-172`, `apps/local-books/src/books/status.ts:38-110`, `apps/local-books/test/fingerprint.test.ts`
- **Evidence base:** the user's working tree on `claude/scalar-v1-wave1` (the fingerprint work is uncommitted; line numbers are from that dirty tree). `bun test` in `apps/local-books` is green: 81 pass, 0 fail, 18 files.

## Verdict

**The mechanism is right and the granularity is wrong.** Hashing a declaration instead of hand-stamping a version is a genuine improvement, and SHA-256 over canonical sorted-key JSON is an adequate durable mechanism. But the current shape has three defects that are not stylistic:

1. **The whole-mirror fingerprint silently repeals ADR-0064.** Adding one entity to the registry now drops all seventeen tables and clears the realm cursor, forcing a full re-pull of an entire company. ADR-0064's "table existence is the per-entity init latch" exists precisely so that does not happen, and `sync.ts:200-217` still implements the cheap path that the fingerprint now bypasses. ADR-0194 lists ADR-0064 under *Relates* and defers per-table fingerprints as a performance optimization. It is not a performance optimization; it is the granularity at which the design is correct.
2. **The declaration is a sibling of the DDL, not its source.** Only `MIRROR_DECLARATION.entities` is derived from `entityDef`. The `row` block (`entities.ts:315-321`) is a hand-copied paraphrase of the `CREATE TABLE` text in `db.ts:189-198`, in different casing, with no test binding them. Change the spine in `db.ts` and no fingerprint moves. ADR-0194's own headline complaint, "correctness depends on reviewer memory," survives intact and is now *harder* to see, because the stale thing looks derived.
3. **ADR-0194 claims to abolish hand-stamped versions and cannot, for the case that most needs it.** Local Mail's `subject`, `sender`, and `body_text` are imperative TypeScript projections computed at ingest (`apps/local-mail/src/message-fields.ts`, written at `apps/local-mail/src/db.ts:227-233`). `db.ts:30-31` states the current contract explicitly: "A row shape or derivation change needs `SCHEMA_VERSION` bumped, including changes to `bodyText` or header extraction." A pure data declaration cannot observe a change to `stripHtmlTags`. Adopting ADR-0194 in Mail as written converts a caught error into a permanently silent one.

Recommendation: **do not freeze `defineMirror` yet.** Repair ADR-0194 to per-table granularity and declaration-owns-DDL, land that inside Local Books alone, and require an explicit `derivedBy` token before Mail is allowed anywhere near this. ADR-0192 already refused the shared mirror package until a third provider exists; ADR-0194's closing consequence quietly presumes the package is coming and should stop doing that.

---

## What is actually built

`fingerprint.ts` is 51 lines: a recursive canonical serializer that sorts object keys, preserves array order, rejects non-finite numbers and non-JSON types, plus `fingerprintDeclaration(domain, declaration)` that hashes `` `${domain}\0${canonical}` `` with `Bun.CryptoHasher`.

`entities.ts:313-338` builds `MIRROR_DECLARATION` = `{ format: 1, row: {...}, entities: {...} }` where `entities` is derived from `DEFAULT_ENTITIES` (i.e. `Object.keys(ENTITY_DEFS)`, `entities.ts:291`).

`db.ts:33-36` computes the module-level constant `MIRROR_FINGERPRINT` under domain `'epicenter.local-books.mirror/v1'`. `db.ts:148-172` is the gate: writers only, mismatch drops every non-`_meta` table, deletes the cursor keys and the retired `schema_version` key, then stamps.

`status.ts:104-105` reports `mirrorStale`. `commands/status.ts:40-42` prints the first twelve hex characters.

Everything below is measured against that.

---

## Findings, ranked

### F1 — Adding one entity forces a whole-company re-pull. Repeals ADR-0064. (Severity: high, confirmed)

`MIRROR_DECLARATION.entities` is keyed off `DEFAULT_ENTITIES` (`entities.ts:322-323`), so any new key in `ENTITY_DEFS` changes the fingerprint, and `db.ts:151-170` responds by dropping *every* table and clearing the cursor.

The cheap correct path already exists and is bypassed. `sync.ts:200-217`:

```
// backfilling: a freshly-added entity (no table) is backfilled in full and
if (db.isInitialized(entityDef(name))) { ... }
const backfill = await fullPullEach(deps, newNames, cursorAfter, { backfilled: true });
```

A new entity has no table, so `isInitialized` is false, and it alone is full-pulled while every other entity stays on the shared cursor. That is ADR-0064 working as designed.

Failure scenario: a maintainer adds `TimeActivity` to `ENTITY_DEFS` — which `entities.ts:12-14` explicitly advertises as free ("Adding an entity is one entry here with no migration, so there is no reason to curate below the full posting set"). Every installed mirror now drops seventeen tables and re-pulls the entire company under a 500 req/min per-realm budget with a 10-concurrent cap. The documented incentive to keep the entity set complete is now a documented incentive to never touch it.

Note the asymmetry the current design misses: a **new table** is handled perfectly by `CREATE TABLE IF NOT EXISTS` plus the existence latch and needs no rebuild at all. A **changed generated-column set on an existing table** genuinely does need a drop, because `CREATE TABLE IF NOT EXISTS` is a silent no-op against an existing table and the new column never appears. That is the real problem `SCHEMA_VERSION` was solving, and per-table fingerprints solve it exactly, with no cursor invalidation and no cross-entity blast radius.

ADR-0194's alternatives section says per-table fingerprints are "deferred; whole-mirror rebuild keeps cursor invalidation and rebuild ownership simple until measured cost justifies finer granularity." The cost is already measured and it is not latency: it is the loss of an invariant ADR-0064 established.

### F2 — The row spine is hand-copied prose about SQL that lives elsewhere. (Severity: high, confirmed)

`entities.ts:315-321`:

```ts
row: {
  id: 'TEXT PRIMARY KEY',
  raw: 'TEXT NOT NULL',
  updatedAt: 'TEXT',
  syncedAt: 'TEXT NOT NULL',
  deleted: 'INTEGER NOT NULL DEFAULT 0',
},
```

`db.ts:190-196` is the actual DDL, and its columns are `updated_at` and `synced_at`. The declaration is not derived from the DDL, does not generate the DDL, and does not even agree with it on identifier casing. Nothing in the test suite compares them.

Failure scenario: someone adds `source_hash TEXT` to the spine in `ensureEntityTable`, ships it, and every existing mirror keeps its old five-column tables because the fingerprint never moved. New code reads `source_hash` and gets `SQLITE_ERROR: no such column`, or worse, reads a stale generated projection. This is verbatim the failure ADR-0194's Context paragraph promises to eliminate: "forgetting to bump it can leave old tables behind while new code reads them as if they had the new shape."

A fingerprint over a sibling description is a lie detector wired to the wrong wire. The declaration must be the **only** input to the emitted DDL, so drift is impossible by construction rather than by review.

### F3 — Two fingerprint-era writers with different constants destroy each other's work in a loop. (Severity: high, reasoned from confirmed code)

The gate at `db.ts:148-172` is not inside a transaction: the `sqlite_master` scan, the `DROP TABLE` loop, the `DELETE FROM _meta`, and the stamp are four-plus separate implicit transactions. Independently, writers are not mutually excluded on the mirror: `app.ts:44-47` documents that the realm `lock.db` "never blocks a concurrent `local-books sync` (which is the whole point: query while sync runs)," and `app.ts:206` opens a fresh writer per sync pass.

Failure scenario, which is the ordinary development loop: `local-books app` is running from a build made before an `entities.ts` edit. The developer edits the registry and runs `bun run src/bin.ts sync`. The CLI drops all tables, stamps fingerprint B, and begins a full pull. The running `app`'s next pass opens a writer, reads fingerprint B against its compiled constant A, drops everything the CLI just pulled, and clears the cursor. The CLI's next pass does the same in reverse. Neither converges while both processes live, and in the meantime the mirror is empty.

Two mitigations, both cheap: wrap the whole gate in one `IMMEDIATE` transaction, and have the writer take the realm lock (or a dedicated rebuild lock) before it is allowed to drop. The transaction alone does not fix the live-lock; the lock does.

Note the transitional case is *safer* than this, by accident: an old pre-fingerprint binary reads `schema_version`, finds it deleted by `RETIRED_META_KEYS` (`db.ts:45`, `db.ts:162-169`), and its `storedVersion !== null` guard (removed in the new code) makes it skip the drop. So old-vs-new does not loop. New-vs-new does, and new-vs-new is the case that will actually happen.

### F4 — A rebuild reports "zero rows," not "rebuilding," to the surfaces that matter. (Severity: medium, confirmed)

`db.ts:369-391` (`pageRows`) and `db.ts:414-423` (`entityStatus`) return `{ rows: [], total: 0 }` and `rows: 0` when a table is missing. That is correct before a first sync and wrong during a rebuild, and the two are now indistinguishable. For a financial tool, "0 invoices" is a wrong answer, not a missing one.

Meanwhile the actual staleness signal reaches exactly one caller. `status.ts:105` computes `mirrorStale`; `books/query.ts:70` opens a raw `new Database(dbPath, { readonly: true })` and never consults `_meta` at all, and `books/read-models.ts:61,96,123` use the read-only handle without checking. So the two highest-traffic read surfaces — the agent's SQL door and the browse API — are exactly the ones with no staleness signal.

ADR-0194 says a reader "may report that the on-disk mirror is stale." The permissive *may* is the bug. Under whole-mirror rebuild, "stale" and "mid-rebuild, contents temporarily absent" are the same on-disk state, and a read surface that cannot tell them apart from "empty company" will confidently under-report money.

### F5 — The MCP `sync` tool can now destroy the mirror, and its description says it cannot. (Severity: medium, confirmed)

`commands/mcp.ts:179` opens a writer (`openBooksDb(ctx.dbPath)`); `mcp.ts:239` filters only `tier: 'mutation'` under `readOnly`, so `sync` (`tier: 'write'`) stays exposed in read-only mode. Its description (`mcp.ts:165`) reads: "Side-effecting but safe: it only updates the local copy."

After ADR-0194, a single `sync` tool call against a fingerprint-drifted binary deletes the entire local copy before repopulating it. The sentence is now false, and it is the sentence a foreign agent reads across ADR-0073's egress airlock. Either the description changes, or — better — the rebuild stops being a silent side effect of opening a writer.

That is the deeper point: **rebuild-on-open couples destruction to the act of acquiring a handle.** `recategorize` (`books/recategorize.ts:173`) is a single-row write-back, and it can drop a seventeen-table mirror as a side effect of opening the file. Rebuild should be an operation a caller performs, not a thing that happens to it.

### F6 — Canonical JSON silently flattens non-plain objects into `{}`. (Severity: medium, confirmed)

`fingerprint.ts:22-32`: the `object` case falls through to `Object.keys(value).sort()` for anything that is not an array. `Object.keys(new Date())`, `Object.keys(new Map())`, and `Object.keys(new Set([1,2,3]))` are all `[]`, so all three serialize to `{}` and collide with each other and with a literal empty object. The serializer is otherwise commendably strict — it rejects `undefined`, symbols, functions, bigints, and non-finite numbers loudly (`fingerprint.ts:16-20`, `33-37`) — which makes this hole conspicuous.

Today `MIRROR_DECLARATION` is a frozen literal of strings and arrays, so it cannot trigger. The moment a declaration is assembled from a builder (which `defineMirror` is), a `Set` of column names or a `Date`-valued default becomes a fingerprint that never changes. Reject anything whose prototype is not `Object.prototype` or `null`. Four lines.

### F7 — Two hand-maintained version knobs, in a design premised on abolishing them. (Severity: low, confirmed)

The domain string is `'epicenter.local-books.mirror/v1'` (`db.ts:34`) and the declaration's first key is `format: 1` (`entities.ts:314`). Both are hand-bumped, both mean "the interpretation of these bytes changed," and neither is tested. Keep exactly one. Keep the domain, because the domain is the only place that can express a change of *meaning* when the bytes are identical; delete `format`.

Related: ADR-0194 line 20 states canonicalization "prefixes the serialized value with an explicit domain **and format tag** before hashing." The code prefixes only the domain (`fingerprint.ts:45`). The ADR describes an implementation that does not exist.

### F8 — `sqlIdent` on `sqlite_master` names can permanently brick every writer open. (Severity: low, pre-existing, now far more reachable)

`db.ts:158` runs `sqlIdent(name)` over table names read back from `sqlite_master`, and `sqlIdent` throws on anything outside `/^[a-z_][a-z0-9_]*$/` (`entities.ts:53-56`). A user who opens `books.db` in the `sqlite3` CLI and creates `MyNotes` makes every subsequent writer open throw `Unsafe SQL identifier: MyNotes` — before the stamp, so it never self-heals. `local-books sync` is dead until the file is deleted by hand.

This predates ADR-0194, but the drop block now executes on far more opens (including the first open of a fresh file, since the `storedVersion !== null` guard was removed), so the latent brick is much more reachable. Quote the identifier rather than validating it, or skip names that do not conform.

### F9 — `canonicalizeDeclaration` exists only for its test, and that test asserts a tautology. (Severity: low, confirmed)

`fingerprint.ts:49-51` is exported and has zero production callers; the only consumer is `test/fingerprint.test.ts:18-20`. And the third test (`fingerprint.test.ts:35-51`) builds an object, spreads it, destructures the added key back off, and asserts the result equals the original. That is a property of object spread, not of this system. It encodes no invariant about indexes staying outside the declaration, because the code under test never sees an index either way.

The tests that are missing are the ones that matter: the domain actually separates; array order actually matters; a non-plain object is rejected; and — the load-bearing one — **the declaration agrees with the DDL the writer emits.**

### F10 — Vacated ADR numbers 0191-0193. (Severity: low, process)

`docs/adr/` on this branch runs `...0189, 0190, 0194`. The gap is deliberate: 0191, 0192, and 0193 exist on unmerged branches (`docs(adr): the Epicenter host owns the mail engine and its sync loop`, `docs(adr): one write contract and one credential contract for every mirror`, `docs(adr): separate durable authorities from disposable materializations`). Reserving 0194 to dodge a collision is pragmatic, but the repo's stated treatment is zero vacated numbers, and `scripts/check-doc-hygiene.ts:83-86` reads the directory. Confirm this branch merges after the other three, or renumber at merge.

---

## Answers to the review questions

**Is SHA-256 over canonical sorted-key JSON the right durable mechanism?**
Yes, with three amendments. SHA-256 is correct (no collision budget concerns at this scale, no reason to reach for anything faster on a once-per-open computation). Canonical sorted-key JSON is correct, and rejecting `JSON.stringify` for insertion-order sensitivity was the right call. Amend: reject non-plain objects (F6); drop `format` and keep the domain as the single version channel (F7); and make the hashed value **the declaration that generates the DDL**, not a description written alongside it (F2). The domain/version model is fine as `<org>.<app>.<artifact>/vN`; per-table, the stored key becomes `mirror_fingerprint:<table>`.

**Is the declaration the right owner, especially for Local Mail's imperative derivation?**
For Books, yes, once the declaration generates the DDL. For Mail, **no, and no data declaration ever can be.** `headerValue` and `bodyText` are arbitrary TypeScript over a MIME tree (`local-mail/src/message-fields.ts:22-31`, `62-70`); their output shape is `TEXT` no matter how the algorithm changes. Mail's current contract catches this by convention (`local-mail/src/db.ts:30-31`) and ADR-0194 removes the convention without replacing it. Mail needs an explicit token or it must not adopt this.

**Should `derivedBy` be an explicit token, a generated schema artifact, or a different projection model?**
**Explicit token, one per imperatively derived column**, e.g. `bodyText: { type: 'TEXT', derivedBy: 'strip-html@3' }`. Reject the generated-schema-artifact option: it is a build step that must be regenerated and committed, which is a hand-stamped version wearing a costume, plus a new way for the tree to be out of date.

Be honest about what this means: **ADR-0194 does not abolish hand-stamped versions.** It scopes them. `SCHEMA_VERSION = '4'` is one global integer whose blast radius is the whole mirror and whose staleness is invisible; `derivedBy: 'strip-html@3'` sits on the exact line whose function it describes, and forgetting it drops one column instead of one mailbox. That is a real and defensible win. The ADR should claim it instead of claiming the stronger thing it cannot deliver. Its Context paragraph ("A hand-maintained schema version is therefore an unnecessary correctness gate") is false as written for any mirror with an imperative projection.

**Are separate `openMirrorWriter`/`openMirrorReader` truly better than one handle or a mode discriminant?**
Yes, and this codebase already produced the evidence against the discriminant. `openBooksDb(path, { readonly = false })` (`db.ts:100-103`) defaults to **writer**, so the failure mode of forgetting an argument is "silently acquired a handle that drops tables." And the highest-volume read path did not pass the flag — it bypassed the module entirely with a raw `new Database(dbPath, { readonly: true })` (`books/query.ts:70`), which is why it has no staleness signal (F4). A mode discriminant on a capability whose two modes differ by *the power to destroy the artifact* is the wrong shape.

Caveat: two functions are necessary but not sufficient. Even `openMirrorWriter` should not rebuild as a side effect of opening (F5). The right split is three: `openMirrorReader` (never mutates, reports staleness), `openMirrorWriter` (refuses to open against a mismatched fingerprint, returning a typed `stale` result), and `rebuildMirror` (the one operation permitted to drop, holding the realm lock).

**Which fields are overfit?**

| Field | Verdict |
|---|---|
| `name` / `id` | Overfit as a *fingerprint input*. The mirror's identity is its path (`db.ts:29-30`: "The realm owns its identity through the path"). Keep it out. |
| `tables` | Load-bearing, and must be **per-table fingerprinted** (F1), not folded into one hash. |
| `schema` | Overfit as a name. It means row shape here; `row`/`columns` says what it is. Nothing else in this design is a schema. |
| `derivedBy` | Load-bearing for Mail, absent today, and the reason Mail cannot adopt yet. |
| `indexes` | Correctly excluded. The reasoning in ADR-0194 line 29-30 is sound and `db.ts:197` already applies them idempotently. |
| `cursors` | Correctly excluded as an input. But note the *consequence* is wrongly coupled: only a spine change should clear the cursor, never a per-table change (F1). |
| `engine` | Overfit. One engine exists (`bun:sqlite`) and there is no second candidate. Add it when a second appears. |
| `directory` | Overfit. Path is identity, not shape. Correctly excluded. |
| `authority identity` | Overfit as a fingerprint input, and correctly excluded — but it should be a **separate stored fact**, not merely absent. A `books.db` copied from realm A into realm B's directory is currently undetectable. That is a distinct gap from anything ADR-0194 addresses; do not solve it by contaminating the fingerprint. |

**What is the correct stale-reader behavior during a rebuild?**
A reader must **refuse with a typed state, never return an empty success**. Three states, not two: `built` (fingerprint matches), `stale` (fingerprint differs; contents are readable but shaped by older code), and `rebuilding` (no table for a declared entity whose spine is current). The machinery already exists and is unused: `EntityStatus.initialized` (`db.ts:84-86`) carries exactly this bit, and `pageRows` (`db.ts:374`) throws it away by returning `{ rows: [], total: 0 }`.

Concretely: `pageRows` and `entityStatus` should surface not-built rather than zero; `queryBooks` should read `_meta` before executing and return a typed `MirrorStaleError` rather than silently querying dropped or old-shape tables. Per-table fingerprints make this dramatically better on their own, because a rebuild then affects one table and the other sixteen keep answering correctly.

**Does the API need a shared package now?**
**No. The two apps must prove the contract first, and one of them cannot yet.** ADR-0192 already refused a mirror package until a third provider exists, and that refusal is still correct. Extracting now would freeze a declaration model that demonstrably does not cover Mail's imperative projections (F3 of the design, not the code) and would export a whole-mirror granularity that is wrong (F1).

What to do instead: land the repaired model in Books, adopt it in Mail behind an explicit `derivedBy`, let both run for a while, and only then extract whatever the two actually share. ADR-0194's closing consequence — "The eventual `defineMirror`/`openMirror` API must preserve this ownership split" — presumes an outcome that ADR-0192 declined to authorize. Soften it to a constraint on any future API rather than an announcement of one.

**Which existing ADRs are genuinely contradicted, and which merely need clarification?**

*Genuinely contradicted:*
- **ADR-0064** ("the mirror keeps one realm CDC cursor; table existence is the per-entity init latch"). Whole-mirror rebuild makes the per-entity latch unreachable for the one event it was designed for. ADR-0194 must either move to per-table granularity or state plainly that it supersedes the per-entity latch. Listing 0064 under *Relates* is not enough.
- **ADR-0063** ("multi-writer cache made safe by one monotonic write door"). The drop path is the single non-monotonic mutation in the mirror, it bypasses `ingest` entirely (`db.ts:151-170` versus `db.ts:285-338`), and it now fires on ordinary registry edits rather than on a deliberate human bump. Under two concurrent fingerprint-era writers it is actively destructive (F3). ADR-0194 needs a sentence putting rebuild under a lock and inside one transaction, or ADR-0063's "one write door" is no longer true.

*Merely needs clarification:*
- **ADR-0061** (read facts from the mirror, opinions live). Unaffected in principle; the reader surfaces need the staleness states of F4 so "read the facts" cannot silently mean "read zero facts."
- **ADR-0073** (MCP egress airlock). The `sync` tool description needs correcting (F5); the airlock model itself is fine.
- **ADR-0176** (lenses declare no query capabilities). Cited in *Relates* and genuinely orthogonal; it is about lenses, not mirrors. Fine to keep as context.
- **ADR-0190** (a build declares which Epicenter owns its data). Orthogonal. The citation is decorative and could be dropped.
- **ADR-0192** (mirror contract; two data planes never unify). Not contradicted by the mechanism, but the "eventual `defineMirror`" consequence line leans on an extraction 0192 refused. Reword.

---

## Recommended API

Two changes to the model, then the surface.

**1. The declaration generates the DDL.** One direction, no siblings.

```ts
const BOOKS_MIRROR = defineMirror({
  domain: 'epicenter.local-books.mirror',   // the only version channel
  spine: {                                   // shared by every entity table
    id:         'TEXT PRIMARY KEY',
    raw:        'TEXT NOT NULL',
    updated_at: 'TEXT',
    synced_at:  'TEXT NOT NULL',
    deleted:    'INTEGER NOT NULL DEFAULT 0',
  },
  tables: {
    invoices: {
      generated: { total_amt: { type: 'REAL', path: ['TotalAmt'] } },
    },
    // Mail's case, the one Books does not have:
    messages: {
      stored: { body_text: { type: 'TEXT', derivedBy: 'strip-html@3' } },
    },
  },
});
```

`createTableSql(BOOKS_MIRROR, 'invoices')` emits the `CREATE TABLE`. Nothing else may. F2 becomes structurally impossible rather than a review item.

**2. Fingerprints are per table, over one spine.**

- `fingerprint(domain + '/spine', spine)` → stored as `mirror_spine`. A change here is the only thing that drops everything and clears the cursor.
- `fingerprint(domain + '/table/' + name, tableDecl)` → stored as `mirror_table:<name>`. A change drops **that table only**, leaves the realm cursor alone, and lets `sync.ts:200-217`'s existing backfill re-pull it as a never-initialized entity.
- A new table adds a key and drops nothing.

That is the whole fix for F1, and it is smaller than the code it replaces.

**3. Three capabilities, not a mode flag.**

```ts
openMirrorReader(path)   // never writes; returns { state: 'built' | 'stale' | 'rebuilding', ... }
openMirrorWriter(path)   // Err({ name: 'MirrorStaleError', staleTables }) instead of dropping
rebuildMirror(path)      // the only drop; takes the realm lock; one IMMEDIATE transaction
```

`openMirrorWriter` returning an error the caller must handle is what stops `recategorize` and the MCP `sync` tool from destroying a mirror as a side effect of opening a file (F5). The CLI's response is to call `rebuildMirror` and say so on stderr.

**Do not extract a package.** Implement this as `openBooksWriter` / `openBooksReader` / `rebuildBooksMirror` inside `apps/local-books/src/db.ts`, and mirror the names in `apps/local-mail`. The shape is proven by two independent implementations agreeing, not by a premature import.

## Rejected alternatives

- **Hashing function source for `derivedBy`.** ADR-0194 rejected this and was right: `Function.prototype.toString` moves under minification, transpilation, and coverage instrumentation, so it produces spurious rebuilds. It is also unavailable after `bun build --compile` in any stable form.
- **A generated schema artifact committed to the tree.** A build step that can be forgotten, i.e. a hand-stamped version with more machinery.
- **Content-hashing the actual `sqlite_master` SQL and comparing to the emitted DDL.** Tempting, and it would catch F2 directly. Rejected because SQLite normalizes and re-emits stored DDL text in ways that vary across versions, so equality is not stable. The declaration-generates-DDL direction gets the same guarantee without depending on SQLite's formatting.
- **Keeping `SCHEMA_VERSION` alongside the fingerprint.** Two gates, two things to forget, and the fingerprint already subsumes every case the version caught except imperative derivation, which `derivedBy` covers more precisely.
- **Including the entity subset from `config.json` in the fingerprint.** Correctly excluded already. A user narrowing their mirrored set must not trigger a rebuild for everyone else, and `isKnownEntity` (`entities.ts:293`) means config can only narrow, never extend.
- **Atomic rebuild via a shadow file and rename.** Genuinely appealing for F4 and it is how Mail already behaves (`local-mail/src/db.ts:186-190` unlinks and reopens). Rejected for Books *at this granularity*: per-table fingerprints reduce the rebuild blast radius enough that the extra file-lifecycle machinery, WAL sidecar handling, and open-handle invalidation are not worth it. Revisit only if spine changes turn out to be frequent, which they should not be.

## Smallest decisive prototype

One spike in `apps/local-books`, no new package, no Mail changes:

1. Move the spine into `MIRROR_DECLARATION` as the **source** of `ensureEntityTable`'s `CREATE TABLE` text (`db.ts:189-198`), deleting the hand-copied `row` block.
2. Replace `mirror_fingerprint` with `mirror_spine` plus `mirror_table:<name>`, and scope the drop accordingly.
3. Write the two tests that decide the question:
   - *adding an entity to `ENTITY_DEFS` drops no existing table and preserves `cdc_cursor`* — this is the test that proves or refutes F1, and it fails against the current implementation;
   - *changing a generated column on one entity drops that entity's table only.*
4. Wrap the gate in one `IMMEDIATE` transaction and reject non-plain objects in `canonicalJson`.

If step 3's first test passes, the model is right and Mail can be scoped next. If it cannot be made to pass without reintroducing whole-mirror drops, the per-entity latch and the fingerprint are genuinely incompatible and ADR-0194 must say which one wins.

## Freeze checklist

Nothing here should be frozen into `defineMirror` until all of these hold.

- [ ] The declaration is the sole input to every `CREATE TABLE` the writer emits; no hand-written DDL remains. (F2)
- [ ] A new entity causes zero drops and preserves the realm cursor, with a test. (F1)
- [ ] A generated-column change drops exactly one table, with a test. (F1)
- [ ] The rebuild runs in one `IMMEDIATE` transaction and holds a lock that excludes other writers. (F3)
- [ ] Opening a writer against a mismatched fingerprint returns a typed error; only an explicit rebuild call drops. (F5)
- [ ] Readers distinguish `built` / `stale` / `rebuilding` and never return an empty success for a missing table. (F4)
- [ ] `canonicalJson` rejects any object whose prototype is not `Object.prototype` or `null`. (F6)
- [ ] Exactly one version channel; `format` deleted; ADR-0194's canonicalization sentence matches the code. (F7)
- [ ] `sqlIdent` cannot brick a writer open on a foreign table name. (F8)
- [ ] `derivedBy` exists, and Local Mail's `subject` / `sender` / `body_text` carry tokens, before Mail adopts fingerprints at all. (F3 of the verdict)
- [ ] `canonicalizeDeclaration` is either used in production or deleted; the tautological index test is replaced by domain-separation, array-order, non-plain-object, and declaration-agrees-with-DDL tests. (F9)
- [ ] ADR-0194 states its relationship to ADR-0064 and ADR-0063 explicitly, drops the claim that hand-stamped versions are unnecessary, and stops presuming the extraction ADR-0192 refused.
- [ ] ADR number 0194 confirmed against 0191-0193 at merge. (F10)

## For the implementation agents

**Change:**
- Make `MIRROR_DECLARATION` generate the DDL. Delete the hand-copied `row` block.
- Split the fingerprint per table over one spine; scope drops and cursor clearing accordingly.
- Wrap the gate in `IMMEDIATE`; take a lock before dropping.
- Split `openBooksDb` into reader/writer/rebuild. Route `books/query.ts` through the reader so it gets a staleness signal instead of a bare `new Database`.
- Reject non-plain objects in `canonicalJson`; delete `format: 1`.
- Fix the MCP `sync` description, or better, make it unable to destroy anything.

**Avoid:**
- Do not extract `@epicenter/mirror` or any shared package. ADR-0192 refused it and nothing here re-earns it.
- Do not adopt fingerprints in `apps/local-mail` until `derivedBy` exists. Adopting as-is converts a caught error into a silent one.
- Do not put indexes, cursors, paths, credentials, engine, or authority identity into the fingerprint. That part of ADR-0194 is right.
- Do not add authority identity to the fingerprint to solve the copied-mirror problem; store it as a separate `_meta` fact.
- Do not hash function source for `derivedBy`.
- Do not "fix" F4 by making readers rebuild. Reader-never-rebuilds is the single most valuable invariant in ADR-0194 and the `readonly` handle in `db.ts:104-115` already enforces it well.
