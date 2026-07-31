# Clean-room mirror API

A runnable prototype of the smallest API that can define an external-authority
materialization, open it for reading or writing, declare what a rebuild costs,
gate rebuilds on a declaration fingerprint, and be driven by a host runtime.

This is a design exercise, not a package. It was written from the vocabulary in
`docs/CONTEXT.md` and ADRs 0061, 0063, 0064, 0176, 0190, and 0194, before
reading `apps/local-books` or `apps/local-mail`. The last section records where
the finished design disagrees with what those apps do today.

```
bun test examples/mirror-api/test
cd examples/mirror-api && bun run typecheck
```

53 tests, six files, no runtime dependencies.

## The whole API

```ts
// pure, importable anywhere, no filesystem
defineMirror({ name, tables, derive? })  →  { fingerprint, unfingerprintedPaths, ... }
describeMirror(declaration)              →  string

// side-effectful, one file, one intent
openMirrorWriter(declaration, { path, rebuild? })  →  MirrorWriter
openMirrorReader(declaration, { path })            →  fresh | stale | absent
```

Six exported functions in total (plus `table`, `derived`, `path` for building
declarations). The writer is `{ rebuilt, cursor, syncedAt, needsBackfill,
ingest, close }`. A fresh reader is `{ cursor, syncedAt, query, close }`. Both
are `Disposable`, so `using` gets the lifecycle right without a `try/finally`.

### The simple declaration

Every mapping is a `path()`, which is plain data, so the fingerprint gate is
total: nothing can change what a column stores without changing the fingerprint.

```ts
export const booksMirror = defineMirror({
  name: 'quickbooks',
  tables: {
    purchases: table<Purchase>({
      key: path('Id'),
      version: { from: path('MetaData', 'LastUpdatedTime'), order: 'lexical' },
      tombstone: path('status'),
      columns: {
        total:       { type: 'real', from: path('TotalAmt') },
        paymentType: { type: 'text', from: path('PaymentType') },
        accountId:   { type: 'text', from: path('AccountRef', 'value'), nullable: true },
      },
      indexes: [['accountId']],
    }),
  },
});

booksMirror.fingerprint            // 'sha256:…'
booksMirror.unfingerprintedPaths   // []  ← the gate sees everything
```

### The imperative declaration

A Gmail message carries a recursive MIME tree and a header *list*. No path
expression reaches "the Subject header" or "every attachment leaf", so the
derivation is a function, and the declaration says so out loud.

```ts
export const mailMirror = defineMirror({
  name: 'gmail',
  tables: {
    messages: table<MailMessage>({
      key: path('id'),
      version: { from: path('historyId'), order: 'numeric' },
      tombstone: path('trashed'),
      columns: {
        threadId: { type: 'text', from: path('threadId') },
        subject:  { type: 'text', from: (m) => header(m, 'Subject'), nullable: true },
      },
    }),
    attachments: derived({ of: 'messages', key: 'attachmentId', columns: { … } }),
    labels:      derived({ of: 'messages', key: 'labelId',      columns: { labelId: 'text' } }),
  },
  derive: {
    messages(message, emit) {
      for (const part of walkParts(message.payload)) {
        if (part.body?.attachmentId) emit.attachments({ … });
      }
      for (const labelId of message.labelIds) emit.labels({ labelId });
    },
  },
});

mailMirror.unfingerprintedPaths
// ['derive.messages', 'tables.messages.columns.internalDate.from',
//  'tables.messages.columns.subject.from']
```

`emit` is typed to exactly the derived tables that named `messages` as their
source, and each emitter takes exactly that table's column record. There is no
`emit('attachments', …)` string channel to get wrong.

### The host loop, in full

There is no host adapter, registry, or lifecycle object. The seam is a path and
two functions. `test/host.test.ts` is the complete integration:

```ts
function syncPass(declaration, file, authority) {
  using writer = openMirrorWriter(declaration, { path: file });
  for (const tableKey of writer.needsBackfill) {
    writer.ingest({ [tableKey]: authority.fullPull(tableKey) }, { full: [tableKey] });
  }
  const { changed, cursor } = authority.changesSince(writer.cursor);
  writer.ingest(changed, { cursor });
}
```

That is ADR-0064's shape expressed directly: backfill whatever has never had a
full pull, then one batched incremental pass advancing the one realm cursor in
the same transaction as the rows it accounts for. The mirror never touches the
network; the host never touches SQL.

## The design questions, answered

### Definition and opening are separate, and not negotiable

ADR-0194 splits authority: only a writer compares and stamps the fingerprint; a
reader never rebuilds. That asymmetry is only expressible if the declaration is
a value that exists before any file does. `defineMirror` returns plain data with
a `fingerprint` property, so a CLI can print it, a test can diff two releases,
and a reader and a writer in different processes can import the same constant
and compare.

Fusing them (`defineMirror(...)` returning a callable factory) would make the
fingerprint a property of a function, which is exactly what ADR-0194 rejected
when it refused to hash function source.

### A resource object, not capabilities and not a factory

- **Capabilities** (`const { query, ingest } = open(...)`) lose the connection.
  A mirror owns a file handle that must be closed and can be superseded; free
  functions have nowhere to put that.
- **Factory** (the declaration is callable) fuses pure data with behavior, as
  above.
- **Resource object** wins because `Symbol.dispose` makes `using` the default
  spelling, and because the reader's *status* can be part of the returned type.

### Two open functions, not one with a mode flag

`openMirrorReader` returns a union, and only the `fresh` arm has `query`:

```ts
const opened = openMirrorReader(declaration, { path });
if (opened.status !== 'fresh') return report(opened);
using reader = opened;
reader.query('SELECT …');
```

A stale reader holds no connection and has no query method. "A reader must not
serve a shape it did not open" stops being a rule someone can forget and becomes
a member that does not exist. One `open(decl, { access })` would have to type
`query` as present-but-throwing, or narrow on a flag the caller passed in rather
than on what was found on disk.

### Rebuild behavior *is* declarable, but only the recovery

The gate is not a choice (ADR-0194 settled that). What a rebuild *costs* is:

```ts
table<Note>({ retain: 'raw' })        // default
table<Note>({ retain: 'projected' })
```

`raw` keeps the authority object beside the projected columns. A declaration
change then renames the old table aside, recreates the new shape, and re-runs
the projection over payloads already on disk: rows survive, the cursor survives,
the backfill latch survives, and the authority is never contacted. A brand new
column is populated with data that was never pulled under the declaration that
created it (`test/retention.test.ts`).

`projected` stores only declared columns, so a shape change can only be answered
by pulling again: rows, cursor, and latch all clear.

This is what makes `rebuild: true` usable. The one hole in the fingerprint gate
is a projection whose *meaning* changed while its *shape* did not, and the fix
for that is a forced rebuild. On a raw-retaining mirror that costs CPU. Without
retention it would cost a full re-download of the mailbox, which is why nobody
would ever run it.

Reprojection degrades safely: a table that cannot be rebuilt locally drops its
own latch and gets a full pull, while the realm cursor and every other table
survive. That is the same mechanism ADR-0064 already uses when a new table joins
the declaration, reused rather than reinvented.

### The fingerprint covers shape, and says where it does not

Fingerprinted: table names, column names, types, nullability, key and version
extractors, version ordering, retention, ownership edges, and the set of tables
with an imperative derivation.

Not fingerprinted: the mirror's `name` (a label stores no bytes), `indexes`
(reconciled idempotently every open, so changing a query plan never costs a
re-pull), and the bodies of functions.

That last exclusion is a real hole, and hiding it would be worse than having it.
So the declaration reports it as data:

```ts
mirror.unfingerprintedPaths  // [] means the gate is total
```

A host can act on that: refuse to ship a release whose mirror has a non-empty
blind set without an explicit review, or force `rebuild: true` in development.
The library takes no position; it just refuses to pretend the gate is total when
it is not.

## Invariants the tests hold

Concurrency and stale state are the parts that cannot be argued, only run.

1. **A stale write cannot regress a newer row.** One monotonic write door: the
   update lands only when the incoming version is at least as new, so a losing
   write is `changes === 0`, reported as `rejectedStale`.
2. **A stale live write cannot resurrect a tombstone.** Deletion keeps the key
   and version and nulls the payload. A hard delete would discard the version
   that makes the rejection possible, so tombstones are load-bearing here, not
   bookkeeping.
3. **A stale source cannot resurrect derived rows a newer version dropped.**
   A derived set is a function of one exact source version, so advancing a
   source replaces its whole derived set rather than merging into it. A rejected
   parent emits nothing.
4. **Two writers on one file converge on the newest version, in any order**, and
   a contended writer waits rather than failing (`WAL` + `busy_timeout` +
   `IMMEDIATE`, applied to every connection).
5. **A superseded writer refuses to write, and writes nothing.** Every ingest
   transaction re-reads the fingerprint before touching a row, so a writer whose
   file was rebuilt by another release throws instead of writing into a shape it
   does not own.
6. **A reader that was fresh at open refuses to serve a rebuilt shape.** WAL
   hands out a snapshot per statement, not per connection, so freshness at open
   is not a claim that survives on its own. `query` re-checks.
7. **A rebuild drops every relation, not only the declared ones.** A table the
   previous declaration created and this one removed would otherwise be an
   orphan no later fingerprint check could see. The mirror owns its file
   exclusively; this is what that ownership buys.
8. **An index survives a rebuild that reprojected its table.** Indexes follow
   their table through a rename and keep their names, so a reprojection that
   left them alone would make `CREATE INDEX IF NOT EXISTS` a silent no-op and
   then take the index with the holding table. This one was found by writing
   the test, not by reading the code.

## Rejected alternatives

**One `openMirror(decl, { access })`.** Rejected: the reader/writer split is
authority, not permission. A single entry point either types the writer surface
as optional on every reader, or narrows on an argument instead of on what the
file turned out to contain.

**A `writer.rebuild()` method.** Rejected: a writer's prepared statements and
shape assumption are fixed for its life, and a mid-life rebuild invalidates
both. Rebuilding is something you open *into*, so it is an open option.

**Typed read accessors beside SQL.** Rejected as a duplicate verb. ADR-0061
already settled that the mirror's read surface is open read-only SQL, enforced
by the connection. A parallel `reader.all('purchases')` would carry weaker
guarantees than the SQL it wraps and would make the declaration look like a
query contract, which ADR-0176 spent a whole decision refusing for Lenses.

**Last-writer-wins when the authority supplies no version.** Rejected: an
authority with no per-object version cannot back a monotonic mirror, and a
silent fallback hides that at ingest time. `version` is a required part of a
source table declaration, so the problem surfaces when the declaration is
written.

**Hard deletes instead of tombstones.** Rejected: a hard delete discards the
version, and a retried fold-back from before the delete would then resurrect the
row. Invariant 2 is only enforceable because the tombstone keeps a version.

**Per-table fingerprints.** Rejected, following ADR-0194's deferral: whole-mirror
rebuild keeps cursor invalidation and rebuild ownership in one place. Retention
already removes most of the cost that finer granularity would have bought.

**Table existence as the per-table backfill latch (ADR-0064).** Rejected *for
this design specifically*. That latch works in Local Books because entity tables
are created lazily on first pull. Once the fingerprint gates DDL, every declared
table is created when the mirror opens, so existence stops implying anything
about data. The latch has to be data: one `backfilled:<table>` key in the single
metadata relation, cleared by a rebuild that could not reproject that table.

**A host adapter interface.** Rejected: every candidate method was something the
host already owns (path, schedule, credentials, network) or something the mirror
already exposes (cursor, backfill set, rebuilt flag). The seam is a string and
two functions, and `test/host.test.ts` is the proof that nothing is missing.

**Rebuild-time callbacks (`onRebuild`).** Rejected in favor of state. The host
reads `rebuilt` and `needsBackfill` and does the right thing; an event would let
a host miss the rebuild by not subscribing.

## Where the clean-room design disagrees with the code today

Read after the design was fixed, and offered as findings, not as patches.

**1. Local Books keeps `raw` for every row and still re-pulls on a fingerprint
mismatch.** `db.ts` stores `raw TEXT NOT NULL` and projects columns as VIRTUAL
generated columns over `json_extract`. Every fact needed to rebuild the mirror's
shape is already on disk, and the gate nonetheless drops the tables and clears
the cursor, forcing a networked `sync --full`. Rename-aside plus `INSERT …
SELECT raw` would make every shape change local. This is the largest single
finding, and it is what turned into `retain` here.

**2. A Local Books read-only handle never compares the fingerprint.**
`openBooksDb(path, { readonly: true })` deliberately skips the gate so a reader
cannot drop tables, which is right, but it also never *reads* the stored
fingerprint. So a reader from release N happily serves rows a release N−1 mirror
wrote, in whatever shape those tables have. ADR-0194 says a reader "may report
that the on-disk mirror is stale"; today it cannot tell. Here that is the whole
reason `openMirrorReader` returns a union.

**3. Nothing re-checks the fingerprint after open.** Both apps stamp or compare
once at open. Two processes on one file across a release boundary is exactly the
topology ADR-0063 says to design for, and a rebuild underneath a live writer is
not covered by the monotonic door. Invariants 5 and 6 exist because of this.

**4. Generated columns are a genuinely better idea than write-time extraction on
one axis, and cannot express Local Mail's case at all.** A VIRTUAL generated
column costs no storage and needs no write path, and a missing field is
`json_extract`'s null for free. But the projection language is SQLite's JSON
path, which cannot walk a MIME tree or search a header list, which is precisely
why Local Mail declares its tables by hand instead of reusing the registry. The
comment in `local-mail/src/schema.ts` reads that split as "QuickBooks is
uniform and configurable, Gmail is a small fixed set". The clean-room reading is
different: the split is declarative-path versus imperative-derive, and one API
can carry both, because `derive` is TypeScript rather than SQL. That is the case
`mirrors/mail.ts` exists to demonstrate.

**5. `ENTITY_DEFS` columns are an opt-in ergonomic layer, so the declaration is
not a complete description of the queryable surface.** An entity may ship
`columns: []` and stay queryable through `json_extract`. That is a real
convenience and this prototype gives it up: a column exists only if declared.
The trade is deliberate, because the declaration is also the fingerprint input,
and a partial declaration means the gate protects a partial shape.

## Known limits

- `MirrorDeclaration<TableMap>` is the erased form, and generic host plumbing
  has to use it. Typed `ingest` batches are for the code that owns the
  declaration. That seam is visible in `test/host.test.ts` and is not solved.
- Reprojection re-runs projections in-process in 500-row batches. It is bounded
  in memory but not in time; a large mirror pays a real pause at open.
- `Bun.CryptoHasher` makes fingerprinting Bun-only. A shipped package would want
  a portable hash so a browser or Worker could compute the same value.
- Multi-writer behavior is exercised with two connections in one process. Real
  cross-process contention under load is not measured here.
