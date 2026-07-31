# mirror-api (prototype)

A greenfield prototype of the public API for external-authority mirrors, built
against the two mirrors that exist: `apps/local-books` (QuickBooks CDC) and
`apps/local-mail` (Gmail history). Neither app is migrated, and nothing here is
imported by anything. It lives in `examples/` on purpose: see
[Why this is not a package](#why-this-is-not-a-package-yet).

Run it: `bun test` and `bun run typecheck` from this directory.

## The API

Two halves, and the split between them is the whole design.

### The declaration is inert

```ts
const booksMirror = defineMirror({
	domain: 'epicenter.local-books.mirror',
	tables: {
		invoices: {
			columns: {
				doc_number: { type: 'TEXT', from: ['DocNumber'] },
				total_amt: { type: 'REAL', from: ['TotalAmt'] },
				customer_ref: { type: 'TEXT', from: ['CustomerRef', 'value'] },
			},
			orderBy: { column: 'updated_at', from: ['MetaData', 'LastUpdatedTime'] },
			softDelete: true,
			indexes: { idx_invoices_updated_at: ['updated_at'] },
		},
	},
});
```

`defineMirror` performs no I/O, reads no environment, and touches no clock. It
validates identifiers and paths, then computes `mirror.canonical`: a
deterministic serialization of everything that changes the stored shape. That
string is the rebuild gate.

Every table gets `id TEXT PRIMARY KEY`, `raw TEXT NOT NULL`, and
`synced_at TEXT NOT NULL` without declaring them, because every mirror row is
the same thing: one regenerable record from an external authority, and when we
last saw it. Everything else is declared:

| Field | What it does | In the gate? |
| --- | --- | --- |
| `columns` | `json_extract` projections of `raw`; `stored: true` materializes | yes |
| `supplied` | app-computed columns SQLite cannot express, with a `revision` token | yes |
| `orderBy` | names the authority's ordering value; its presence makes writes monotonic | yes |
| `softDelete` | adds `deleted` and the `softDelete` verb | yes |
| `indexes` | column lists, applied idempotently with the table | **no** |

Not in the declaration, by construction: realm or account identity, credentials,
paths, directories, engines, cursors, pull scheduling, rate limits, read models.

### The writer may rebuild

```ts
const writer = openMirrorWriter(booksMirror, { database });

writer.opened; // 'created' | 'reused' | 'rebuilt'

writer.write({ syncedAt }, ({ table, advance }) => {
	const invoices = table('invoices');
	for (const record of live) invoices.upsert({ id: record.Id, record });
	for (const record of gone) invoices.softDelete({ id: record.Id, record });
	advance({ cursor: nextCursor, lastSyncedAt: syncedAt });
});
```

Opening compares the stored declaration to `mirror.canonical`. A mismatch drops
every derived table, clears the pull cursor, and stamps the new declaration; the
app's own `_meta` keys survive. Everything inside one `write` commits together,
cursor included, so a crash rolls back to the previous cursor and the next pass
re-pulls a window it already applies idempotently.

`table(name)` creates the table on first use **in a pass**, not at open, because
both mirrors use table existence as the per-table "has this had its first full
pull?" latch. Creating everything at open would silently destroy that.

Table verbs: `upsert`, `softDelete` (declared only), `remove`, `sweep(before)`
returning the count, and `patch(id, fold)` for an authoritative partial update.

### The reader never rebuilds

```ts
const reader = openMirrorReader(booksMirror, { database }); // opened read-only

reader.stale; // the mirror on disk was written by a different declaration
reader.storedDeclaration; // diff it against mirror.canonical to say which column moved
```

A reader is not a writer with the dangerous parts switched off. It compiles no
statement against today's columns at open, so it survives being pointed at a
mirror an older declaration wrote; a missing table is an empty answer, not an
error. In exchange it gets the one thing a writer cannot have: `stale`. A writer
is never stale, because by the time it exists it has already matched or rebuilt.

Both handles share `state()`, `exists()`, `count()`, and `all(sql, params)`.
`all` is the app's read models and query verbs; the mirror does not try to own
them.

### Sync stays outside

Nothing here calls an authority. Choosing FULL versus INCREMENTAL, paging,
backing off a rate limit, refreshing a token, and deciding what a cursor means
all stay in the app, which passes the results to `write`. The mirror stores the
cursor for exactly one reason: a rebuild has to invalidate it, and an
invalidation that lives somewhere else is an invalidation someone forgets.

### Instances and injected resources

`openMirrorWriter(mirror, { database })` takes an already-open
`SqliteDatabase` from `@epicenter/sqlite`. One authority instance is one call.
Two realms are two calls sharing one declaration, and neither the declaration
nor this module ever learns which realm it is looking at. Path layout,
directory modes, file permissions, WAL pragmas, and the read-only decision stay
with the app that owns the disk (`local-mail`'s `mailDbPath` segment guard and
`0600` files have real security content and are not this API's to absorb).

## Decisions worth arguing with

### `packages/sqlite` suffices, and was not forced

`SqliteDatabase` is `run` / `all` / `transaction`, and every mirror operation
fits. The one apparent gap closed cleanly: `run` returns `void`, so `sweep`
cannot read `.changes` -- but `SELECT changes()` inside the same transaction
gets the count through the existing contract. No new driver surface, and the
prototype never imports `bun:sqlite` outside its tests.

Adopting the boundary forces one honest refusal. `local-mail` rebuilds by
deleting the db, wal, and shm files; a driver contract has no file identity, so
rebuild here is drop-tables (`local-books`' approach), which works identically
in Bun, a browser, and a Durable Object. The cost is that disk space is not
reclaimed without a `VACUUM`.

### Indexes are excluded structurally, not by a blacklist

`rebuildShape()` builds the gate input by reading `columns`, `supplied`,
`orderBy`, and `softDelete`. It never reads `indexes`. There is no exclusion
list to keep current, and no way to add an index-shaped field that accidentally
becomes a rebuild input. A test asserts the gate does not move when an index is
added.

### `supplied` columns need a hand-stamped `revision`, and that is unavoidable

Gmail's `subject`, `sender`, and `body_text` are computed in TypeScript: a
lookup inside `payload.headers[]` and a base64url MIME walk. SQLite expresses
neither, and all three are searched, so read-time derivation would cost the
search. Their stored shape therefore lives in a function, and:

- hashing the function source makes reformatting a rebuild (ADR-0194 rejects it)
- refusing imperative columns costs Local Mail its search
- deriving at read time works only for values nothing queries

So the declaration carries an opaque author token per supplied column. This is
the one hand-stamped input in the system, and ADR-0194's objection to
hand-stamped versions ("correctness depends on reviewer memory") applies to it
in full. It is narrowed as far as it goes: the token sits on the same line as
the column whose derivation it describes, so the edit and the stamp are the same
edit. **ADR-0194 should say this out loud rather than implying nothing is
hand-stamped.**

The pressure this creates is the right one: prefer a projection, prefer read-time
derivation, and store an imperative value only when a query needs it on disk.
Local Mail already reasons this way for `unsafeBodyHtml`.

### `orderBy` replaces a monotonic-vs-last-writer-wins flag

Local Books needs monotonic writes (a write-through fold must not regress a row
a newer sync already ingested); Local Mail has no authority ordering value at
all. That is a mode flag waiting to happen. Instead the table declares *where
the ordering value comes from*, and monotonicity falls out of its presence. Data,
not a mode, and a table with nothing to order on gets last-writer-wins, which is
the honest behavior.

Soft versus physical delete is the same move: `softDelete` is a column, so the
verb exists only where the shape supports it, and the gate moves when it changes.

### The gate is the canonical string, not its SHA-256

This is the one place the prototype departs from ADR-0194 as written, and it is
a fork for you, not a decision I get to make.

ADR-0194 specifies a domain-separated SHA-256. The gate is only ever compared
for equality, so the canonical string does that job directly, and:

- it stays pure and synchronous with no crypto at all, so the same code runs in
  Bun, a browser, and a Durable Object (`Bun.CryptoHasher` is sync but Bun-only;
  `crypto.subtle` is portable but async, which would infect `defineMirror`)
- a stale mirror can be **diffed**: `storedDeclaration` against
  `mirror.canonical` names the column that moved, instead of reporting that two
  hashes differ
- the cost is a few KB in one `_meta` row, and a noisier `SELECT * FROM _meta`

If you prefer the ADR as written, it is one line at the writer and one at the
reader: hash `mirror.canonical` before storing, and lose the diff.

### Refused

- **`mode: 'read' | 'write'`.** The handles are different capabilities, so they
  are different functions with different surfaces.
- **Expression and partial indexes.** `indexes` takes column lists, which both
  apps' indexes are, and which validates completely.
- **App read models.** `pageRows`, `getMessageDetail`, and the triage filters are
  product surface. They get `all()`.
- **A `close()`.** The caller opened the database and owns closing it.
- **Per-table fingerprints.** Whole-mirror rebuild keeps cursor invalidation and
  rebuild ownership simple; ADR-0194 already defers this.

## Known gaps

- **`softDelete` on a table with `supplied` columns** requires supplying them on
  the delete stub, which an authority's delete payload will not carry. No
  producer today (Local Books soft-deletes and supplies nothing), so it is
  unresolved rather than solved. The likely answer is that a soft delete writes
  only bookkeeping on conflict and refuses to insert a row it has never seen.
- **`table(name)` is typed by the declaration's key union, not the literal key**,
  so `softDelete` on a table that did not declare it throws at runtime rather
  than failing to compile. Local Books builds its tables through
  `Object.fromEntries`, which loses literal keys anyway.
- **A writer over a read-only connection opens successfully** when the
  declaration already matches, because every statement on that path is a read or
  a no-op `CREATE TABLE IF NOT EXISTS`. SQLite refuses at the first real write.
  The capability split is the first line of defense; the engine is the second.
- **`orderBy` columns are always `TEXT`**, which suits an ISO timestamp and any
  lexicographically increasing token, and would need a type for a numeric one.

## Why this is not a package (yet)

Two consumers, both in `apps/`, both AGPL, and the strongest argument against
extraction is that the two mirrors disagree about deletes, ordering, derivation,
rebuild mechanics, and read models. This prototype shows those disagreements
fitting in one declaration, which is evidence, not a verdict: it is written from
reading both apps, not from migrating either, so it has not yet paid the price
of a real cutover.

`examples/` is a workspace package, so `@epicenter/sqlite` resolves and the
tests are real, while nothing depends on it and no package boundary is claimed.
Promote it to `packages/mirror` when a migration proves the shape, or delete it
and keep the ideas.
