# 0206. A row's id comes from whoever knows it, and one relation holds every fact

- **Status:** Accepted
- **Date:** 2026-08-04
- **Amended by:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md) (`Proposed`) at the presence law and the two relations. Withdrawn: "`presence` is two-valued and has one law: `absent` is a terminal tombstone" (`:51-52`), which makes an address single-use and collides with this record's own reason for existing; and `_replica_row_facts` and `_replica_row_outbox`, which become one cell relation with no queue. That a row's id comes from whoever knows it, and that one relation holds every fact, is untouched and is the premise ADR-0212 argues from.
- **Supersedes:** ADR-0178. Its two-relation split, its value-name grammar, its disjoint row and value key spaces, its two outboxes, and its `UNION ALL` sequence projection are withdrawn. Everything else it decided survives and is restated below so this record stands alone: inline coordinates with no `qualified_key`, the `_replica_` and `_authority_` prefixes, the bare-SQL-identifier table grammar, the case-insensitivity refusal, row-addressed document relations, and total format refusal.
- **Amends:** ADR-0160 at one clause, "table rows have runtime-minted globally unique IDs that callers cannot replace," which becomes the rule below. [ADR-0187](0187-a-bound-handle-reports-staleness-tables-can-name-rows-values-cannot.md) at one clause, the value half of "tables can name rows, values cannot," which no longer has a subject; its table-invalidation law is untouched.
- **Relates:** [ADR-0176](0176-lenses-declare-no-query-capabilities-indexed-reads-require-separate-owners.md), [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md), ADR-0173, [ADR-0203](0203-epicenter-owns-only-what-is-already-contended.md), [ADR-0204](0204-an-app-is-one-reverse-domain-identifier-that-names-every-place-it-exists.md) (the same rule one altitude up: a name comes from whoever has authority over it)

## Context

ADR-0178 split facts into two relations because rows and values obey different
laws. The split is real, and it is paying for almost nothing.

Across every shipped Lens in this repository exactly one value is declared,
`showReadings` in Vocab. Every other Lens declares `values: {}`. That one boolean
carries a second relation, a second outbox, a second address kind, a second name
grammar, a second presence law, a `kind` discriminant on the wire, and a
`UNION ALL` projection with a query-local `fact_kind` label wherever the two must
be read in sequence order.

The reason values exist is narrower than the split that grew around it. A value's
name is declared, so every device computes the same address without coordinating.
A row's id is minted, so no device can guess another's. Rows enumerate; values do
not. An application that wants a name it can agree on *and* a set it can list has
to pick one and work around the other.

## Decision

**A row's id comes from whoever knows it, and there is one fact relation.**

Usually nobody knows the id, so the runtime mints one. Sometimes the application
knows it and passes it. Sometimes a foreign authority knows it. It is the same
row either way, in the same relation, listed by the same traversal.

```txt
so.epicenter.voicenotes / notes    / k3f9x2h...     minted for you
so.epicenter.vocab      / settings / app            chosen by you
      who                   what        which
```

### One relation

```txt
_replica_row_facts(namespace, table_name, row_id, presence, fields, authority_sequence)
  primary key (namespace, table_name, row_id)
_replica_row_outbox(local_sequence, namespace, table_name, row_id, verb, patch)
```

The authority mirrors both under an `_authority_` prefix. `presence` is
two-valued and has one law: `absent` is a terminal tombstone. A reversible unset
is a field unset inside a patch, which the outbox verb already carries.

### A row id is a durable name

A row id is one or more bytes matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`, under the
byte ceiling the value name previously held. Every character is safe in a URL
path segment, because a row's bytes are read through a path built from its
address.

**An id is not confidential.** It travels to the authority and appears in that
path, so it must never carry content. A Gmail message id, a Google `sub`, or a
device id is fine. An email address, a filename, or a note title is not.

### Values are deleted

`defineValue`, `ValueAddress`, the `kind` discriminant, `_replica_value_facts`,
`_replica_value_outbox`, the dotted value-name grammar, its deliberate
case-sensitivity exception, and the `_epicenter_values` inspection relation are
all removed.

A value was a field that lived alone. Whole-content replacement is what a single
field already does, a declared name is now available to any row, and living alone
was the only part that cost a relation.

### `patch` does not create

Deletion must converge, so a tombstone beats a patch. An upserting patch would
resurrect a row one device deleted while another was offline. `create` is the one
verb that brings a row into being, whether or not the caller supplies the id, and
it is also the only moment the type system can demand a complete row; `patch` is
partial by nature.

Reading a named row that was never written is therefore an ordinary
read-or-seed at the one call site that needs it.

### The bound handle

With values gone, `tables` is a container with one member. `bind` answers the
tables directly, and disposal is `Symbol.asyncDispose`, which is already the
idiom in `packages/data`. Nothing else on the handle can collide with a table
name.

### Sample invocation

```ts
export const voiceNotes = defineLens({
  namespace: 'so.epicenter.voicenotes',
  tables: {
    notes: defineTable({
      fields: {
        title: field.string(),
        recordedAt: field.instant(),
        transcript: optional(field.string()),
      },
    }),
    settings: defineTable({
      fields: { autoTranscribe: field.boolean() },
    }),
  },
})

/** The one name this app chooses. Everything else is minted. */
const SETTINGS = 'app'

await using vocab = await epicenter.data.bind(voiceNotes)

// A row you named: read it, or seed it the first time.
const prefs =
  (await vocab.settings.get(SETTINGS)).data ??
  (await vocab.settings.create(SETTINGS, { autoTranscribe: true })).data

// A row the runtime named.
const { data: note } = await vocab.notes.create({
  title: 'Untitled',
  recordedAt: InstantString.now(),
})

await vocab.notes.patch(note.id, { transcript: 'hello' })
await vocab.notes.delete(note.id)

// Crossing into a capability is the one place an address is spelled in full.
const address = vocab.notes.address(note.id)
```

### Restated from ADR-0178, unchanged

Address coordinates are stored inline as their own columns; there is no
`qualified_key` and no `address_kind` column. Every private relation carries an
owner-naming prefix beginning with `_`, which a table name cannot begin with, so
no Lens can name one. A table name is one bare SQL identifier,
`^[A-Za-z][A-Za-z0-9_]*$`, because a trusted inspection host mounts a Lens as
logical relations and `SELECT * FROM notes` must need no quoting. SQL identifiers
are case-insensitive, so a Lens refuses two table names differing only in case,
and a table refuses two field names differing only in case. `document_updates`
and `document_publication` key on `(namespace, table_name, row_id)`; row
documents and blobs are not a new address kind and use the exact row address. An
opener treats any unrecognized relation as evidence of a different format and
refuses the file rather than building a second schema beside it.

Both physical formats clean-break: `REPLICA_FORMAT_VERSION` becomes 7 and
`AUTHORITY_FORMAT_VERSION` becomes 6. No migration is provided and none is
intended.

## Consequences

- **The sequence-ordered read is one table scan.** The `UNION ALL` projection and
  its `fact_kind` and `intent_kind` labels are deleted along with the second
  relation, and the exchange page and batch sealer read one relation in order.
- Settings gain per-key merge, so two devices changing two different settings
  both keep theirs, which a value could never do because a value replaced whole.
  They also gain enumeration, because they are rows.
- Settings lose per-setting invalidation. One settings row wakes every listener
  on that row, where a value woke only its own. It is one small re-read.
- A group of fields that must move together is expressed by putting the group in
  one field, because a field is the unit that replaces whole. That granularity is
  now chosen rather than imposed by which relation the fact landed in.
- An application that wants a device-independent address no longer needs a
  workaround. The pattern of storing a foreign identifier as an ordinary field
  and scanning a table to find the matching row is available to delete wherever
  it appears.
- **A chosen id is single-use for the life of the replica.** Deletion is
  terminal, so deleting a row at a name burns that name: nothing can ever create
  at it again, on any device, ever. A minted id never felt this because nobody
  wanted a specific one back. An application that names rows after foreign
  identifiers is choosing that trade knowingly, and any surface where a person
  expects to remove something and later recreate it under the same name must not
  key on that name. This is why a keyboard shortcut cannot be a row keyed by its
  chord: unbinding would make the chord permanently unbindable.
- **What this forecloses:** a second fact relation, a second declaration form
  such as `defineValue` or `defineKv`, a declared list of legal row names, prefix
  or wildcard matching on any coordinate, an upserting `patch`, and any address
  of a depth other than three.

## Considered alternatives

- **One relation with a nullable `row_id`.** Rejected on measurement rather than
  taste. Both fact relations are `WITHOUT ROWID`, where a primary-key column is
  `NOT NULL` by definition and enforced, so the nullable column is rejected at
  `CREATE TABLE`. Dropping `WITHOUT ROWID` admits it, and then NULLs are distinct
  in a unique index: the identical value fact inserts twice and the key silently
  stops being a key. That is why the first attempt reached for `row_id = ''`.
- **Keep values and add chosen row ids beside them.** Rejected: two ways to name
  one thing, which is the defect this record exists to remove.
- **Declare the legal row names in the Lens**, so a typo fails to compile.
  Rejected: different named rows want different fields, so a name list becomes a
  shape per name, which is `defineValue` with extra steps. Field declarations
  already provide the type safety at the only place it was ever missing.
- **Delete `create` and let `patch` upsert.** Genuinely attractive, because the
  fold already starts from an empty object when no fact exists, so upsert is the
  existing storage behavior and the client's refusal is a guard on top. Rejected
  because `create` is the only moment the type system can require a complete row;
  creating by patch admits rows missing their required fields, which then fail
  Lens projection on the first read.
