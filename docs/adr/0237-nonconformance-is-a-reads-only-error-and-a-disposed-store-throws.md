# 0237. Nonconformance is a read's only error, and a disposed store throws

- **Status:** Accepted
- **Date:** 2026-08-12
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0229](0229-a-lens-names-the-store-it-opens-and-opening-is-one-call.md)
  at the binding error arm: a declaration that will not parse is still a returned value,
  and the storage half of that union moves out of every read signature.
- **Amended by:** [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md)
  at the storage arm: this record originally made a refused durable commit
  poison the store terminally (`StoreUnusableError('storage-failed')`); that
  half is withdrawn, and persistence failure is now an observable, retryable
  status that never invalidates the live document.
- **Amended by:** [ADR-0253](0253-schema-lenses-interpret-stored-json-on-read-and-writes-admit-storage-valid-facts.md)
  at write admission: schema mismatches are no longer write errors. Structural
  row absence and lifecycle outcomes remain explicit.
- **Relates:** [ADR-0175](0175-table-traversal-is-complete-and-classified-with-paging-kept-private.md)
  (the superseded stack's read surface already drew this line: "classification
  failure is row data, but operational failure is control flow"; this record
  carries it into the store),
  [ADR-0125 territory restated in `docs/the-store-and-what-it-replaced.md`]
  (nonconforming is a view, not damage),
  [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md)
  (a declaration validates and never transforms).

## Context

Every table read returned `Result<_, ReadRowError>` where
`ReadRowError = StoreError | NonconformingRowError`. That union put two
different worlds in one error arm: a live row the current declaration cannot fully
read, which is an expected, recoverable, caller-composable outcome; and a
store that is disposed or whose durable storage refused a commit, which no
call site can act on at all.

The mixture produced exactly the symptoms a wrong boundary produces:

- Two production call sites probed
  `error.name === 'Nonconforming' ? error.conforming : {}` to tell the
  recoverable case from the operational one (Whispering's settings, Vocab's
  settings).
- The sync client probed `stampError.name === 'Unstampable'` to separate a
  protocol refusal from a storage failure it could do nothing about.
- `packages/app/src/data/README.md` spent paragraphs warning that
  `.data?.rows ?? []` turns an operational failure into "you have never
  written one of these". A surface that needs a standing warning against its
  own ergonomics is reporting the failure in the wrong channel.
- Every consumer threaded a `loadError` state variable whose only possible
  content was an error it could do nothing with but rethrow or display
  generically.

## Decision

**A read's `Result` is about declaration conformance and nothing else. A disposed
store throws `StoreUnusableError` at the call site that touched it, because
use-after-dispose is a programmer error, not an outcome.**

Storage trouble is neither of these channels. A store that cannot reach its
durable record at OPEN returns `StoreError.StorageFailed` from the opener,
because boot is fallible I/O whose caller renders a boot failure. A store
whose durable writes fall behind MID-LIFE keeps serving reads and accepting
writes from the live document, and reports through `store.persistence`
(ADR-0238).

### The read surface

```ts
get(rowId): Result<Row | undefined, NonconformingRow>
list(): { rows: Row[]; nonconforming: NonconformingRow[] }
kv.get(): Result<Values, NonconformingValue>
ids(): string[]
```

`Ok(Row)` is a live row this declaration reads whole. `Ok(undefined)` is an address
that holds no row, a fact rather than a failure. `Err(NonconformingRow)` is a
live row this declaration cannot fully read. `list()` is not a `Result` at all,
because nothing in it can fail; the `?? []` trap is now unwritable.

### The diagnostic is plain data

```ts
type NonconformingValue = {
  raw: JsonObject;        // the stored payload, unmodified
  conforming: JsonObject; // what survived; recovery is composed from this
  issues: readonly ConformanceIssue[];
};
type NonconformingRow = NonconformingValue & { id: string };
```

No `name`, no `message`, no `address`. It is the entire error arm of the verbs
that carry it, so there is nothing to discriminate it from, and a tag would
only invite the probes this record deletes. The caller already knows the table
it asked; the row id survives as `id`, and it also rides inside `conforming`
so `data ?? { ...defaults, ...error.conforming }` is a whole row on either
branch. KV's diagnostic carries no id, because KV has none; the old shape
leaked a stray `id: 'kv'` key into recovered settings objects.

### Writes report the write

```ts
create(fields): Row
update(rowId, patch): Result<void, RowAbsentError>
kv.update(patch): void
delete(rowId): boolean
```

`create` mints the row and admits the supplied storage-valid fields. It returns
the typed write view, including declared defaults, while `get` remains the
conformance boundary.

`update` does not return the row. A patch may legally land on a row whose
other fields this declaration cannot read; that is how a nonconforming row is
repaired. It reports only `RowAbsent`, because that is a structural fact about
the addressed row. Unknown fields and values are preserved when they are valid
stored JSON, and the current lens interprets them on the next read.

`kv.update` has the same write-admission rule and returns `void`; the whole KV
value's conformance is reported by `kv.get()`.

`delete` returns whether there was a row to take.

Two mid-life failures stay in `Result`s because a caller genuinely acts on
them, and each has its own name instead of borrowing `StorageFailed`:

- `applyRemote` returns `ApplyFailed` for bytes the document cannot decode: a
  property of the bytes, the store is untouched, and the transport treats the
  position as a poison pill.
- `query` returns `QueryFailed` for a refused statement: a property of the
  SQL, which may come from a person or an agent.

### The client log follows the same rule

`cursor()`, `documentIdentity()`, `coalesce()`, `advance()`, `acknowledge()`
return plain values. `adoptDocumentIdentity` keeps its `Result`, whose one
error is `Unstampable`, the one refusal a caller concludes something from
(supersession).

### The declaration loses `project`

`ParsedTable.project()` manufactured read outcomes inside the vocabulary
package. The declaration's one read primitive is `conformance(payload)`: select
declared fields, apply declared defaults, report what failed, never transform.
Whether a payload is a row, and at what address, are the store's facts, so
the store composes `NonconformingRow` itself. The misleading word goes with
the method; nothing was ever projected into a different runtime shape.

## Consequences

- The two production `error.name === 'Nonconforming'` probes are deleted;
  settings recovery is unconditionally
  `{ ...kv.defaults, ...error.conforming }`.
- Consumer state modules delete their `loadError` plumbing; a disposed-store
  bug surfaces at the application's error boundary instead of rendering as an
  empty list or a dead badge.
- `ReadRowError` and `WriteRowError` are deleted. `StoreError` keeps the
  open-time and protocol refusals (`StorageFailed` at open, `AlreadyOpen`,
  `Unaddressable`, `Unstampable`, `RowAbsent`, `ApplyFailed`, `QueryFailed`)
  and stops appearing in any read's signature.
- What this forecloses: a read error a UI can confuse with nonconformance, a
  second read verb for "forgiving" reads, and any future verb returning
  `StoreError` for a condition the caller cannot act on.

## Considered alternatives

- **Keep everything in `Result`s (status quo).** Rejected on the evidence
  above: every consumer either rethrew, probed by name, or risked `?? []`.
  A channel nobody can use correctly is the wrong channel.
- **Tag the diagnostic (`name: 'Nonconforming'`).** Rejected: with the union
  purified there is nothing left to discriminate, and the tag is what made
  the old probes expressible.
- **`update` returns the row, `Err` on nonconforming read-back.** Rejected:
  it reports a committed write as a failure, and it forces a mixed
  tagged-plus-plain error union that needs probes to take apart.
- **Throw for write refusals too.** Rejected: field validation, unknown
  fields, and an absent update target are ordinary caller-actionable
  outcomes; the mission of the throw is use-after-dispose, not the caller's
  inputs.
- **Poison the store on a refused durable commit.** This record originally
  decided exactly that, and ADR-0238 withdraws it: the live document is the
  truth while the client is open, and a persistence failure is a visible,
  retryable debt rather than the store's death.
