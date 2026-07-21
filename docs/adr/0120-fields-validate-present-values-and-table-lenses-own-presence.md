# 0120. Fields validate present values and table lenses own presence

- **Status:** Accepted
- **Date:** 2026-07-15
- **Amended by:** [ADR-0175](0175-table-traversal-is-complete-and-classified-with-paging-kept-private.md) (replaces `list()` with the complete `entries()` traversal and its `scan()` fold)
- **Relates:** [ADR-0119](0119-complete-record-maps-sync-through-schema-blind-server-ordered-patches.md), [ADR-0124](0124-workspace-documents-are-top-level-parameterized-resources.md), [ADR-0129](0129-matter-and-workspace-share-fields-not-authority-policy.md)

## Context

The canonical record map preserves schema-opaque JSON, so application releases
must be able to read old, extra, missing, and invalid keys without rewriting
them. A release may also change its lens without first proving that every stored
row conforms. The shared `@epicenter/field` vocabulary serves Matter, where a
field already means the domain of one present value rather than property
presence or persistence policy.

## Decision

`field.*` describes and validates a present JSON value. It carries no optional,
required, default, index, uniqueness, migration, or conflict behavior. A table
lens owns property presence:

```ts
defineTable({
	fields: {
		title: field.string(),
		archived: field.boolean(),
		category: nullable(field.string()),
	},
	optional: ['archived', 'category'],
});
```

Fields are required by default. A missing required field or a present value
that fails its field validator makes the row nonconforming for that typed lens.
A required field constrains successful interpretation by this release. It is
never a storage-admission rule, a server invariant, or a claim that every
canonical row contains the key. Every release must tolerate nonconforming rows.
A missing optional field is valid and reads as `undefined`. `null` is a present
value only when the lens explicitly wraps the field in `nullable(...)`.
Optionality and nullability are distinct.

This is the one presence mechanism. There is no `field.string.optional()`,
`fallbackFrom`, alias, read default, or authored field version. The lens-level
`optional` list matches Matter's existing contract shape while leaving the
shared present-value vocabulary uncontaminated.

The row id is the structural key of the canonical record map, not a payload
field. Table definitions cannot declare `id`. Normal typed creation allocates a
fresh id, and successful typed reads add it to the projected payload shape.

Typed reads validate without mutation. `get(id)` returns
`Result<Row | undefined, RowLensError>`. `list()` returns conforming rows and
nonconforming diagnostics in separate buckets. A read never inserts defaults,
clears invalid values, rewrites a row, or records a new version.

Typed creation requires required fields, permits optional fields, and allocates
the row id. Typed patching changes only supplied keys. An own optional-field
patch property with value `undefined` means unset; required fields do not admit
`undefined`. An omitted property means untouched. Before any JSON transport,
the client normalizes that object into the explicit wire-level `set` and `unset`
collections from ADR-0119. `undefined` is never canonical data. `null` remains
an ordinary set value when admitted by the field. A patch validates only the
supplied values and may modify an existing row even when the complete row does
not conform to the current lens. This lets ordinary application code repair one
key without first fabricating a valid whole row.

Table names and field names are exact permanent storage keys. Renaming starts
reading and writing a different key. A developer who wants to copy or remove old
data does so through explicit ordinary application patches. Epicenter never
infers the operation from a changed definition.

Mixed releases may write the same schema-opaque map. An older release may
create a row that lacks a field a newer release declares required. The newer
lens reports that row as nonconforming; the authority still preserves it. The
developer may add required fields or make any other lens change. Epicenter does
not classify the change, block the release, or promise that all rows will
conform afterward.

## Consequences

- Adding an optional field changes only the release-local lens. Old rows remain
  conforming and read `undefined` for that field.
- Adding a required field may make old rows nonconforming. This is permitted,
  and application code may repair any subset through ordinary patches.
- Making every field optional is refused because it would erase useful typed
  row guarantees. Successful typed reads still earn the declared required
  properties without turning those properties into storage invariants.
- Invalid and extra canonical values remain available for diagnostics and later
  explicit application repair.
- No release may assume that every canonical row conforms to its lens. Old
  releases may continue creating rows that newer releases reject.
- The public patch API remains compact while the wire stays valid JSON and
  preserves unset intent across process boundaries.
- Defaults remain release-local application expressions such as
  `row.archived ?? false`; they are never fabricated canonical values.

## Considered alternatives

- **Put optionality on each field builder.** Rejected because property presence
  is object-lens policy, not a scalar value domain.
- **Make every declared field optional.** Rejected because ordinary application
  code could no longer rely on required facts after a successful typed read.
- **Ban optional fields.** Rejected because a small presence list deletes the
  need for automatic additive backfills.
- **Ban required-field additions.** Rejected because definitions are
  release-local interpretations, not durable storage schemas. The developer may
  accept nonconforming rows and repair them explicitly.
- **Treat missing as null.** Rejected because canonical JSON can distinguish
  them and the application may legitimately model null as a value.
- **Heal on read.** Rejected because a release-local interpretation must not
  gain write authority merely by observing user data.
