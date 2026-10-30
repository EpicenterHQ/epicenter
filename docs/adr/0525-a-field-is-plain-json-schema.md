# 0525. A field is plain JSON Schema

- **Status:** Accepted
- **Date:** 2026-10-11
- **Amends:** [ADR-0491](0491-field-helpers-build-native-typebox-schemas-with-ui-metadata.md) at native callbacks in fields: `Type.Refine`, `~guard`, and codecs are refused, the frozen-copy protection for callbacks is removed, and a prepared field is a JSON copy rather than a `Memory.Clone` snapshot. Its editor hints, helpers, prepared shape, and JSON-safety check stand.
- **Relates:** [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) (`epicenter.json` holds these fields), [ADR-0526](0526-a-field-is-required-unless-declared-optional.md) (optionality)

## Context

ADR-0491 admitted any native `TSchema` as a field, including `Type.Refine`
and schemas carrying a `~guard` or a codec. A callback does not survive
JSON, so a field had two forms: the one in memory, and the one
`epicenter.json` could hold. `exportSchema` in
`2845f79987:packages/definition/src/export.ts` (329 lines) sat between them. It refused
functions, guards, symbols, accessors, and unknown formats while writing.
`readFolder` ran the same exporter over a parsed file to refuse what an
opener could not have written. `prepare` kept a second mechanism for the
callbacks it admitted: a `hasSchemaCallbacks` flag per field, and a deeply
frozen copy of every value such a field validated.

No application declared a callback field, and no application registered a
custom format. `Format.Set` appeared only in `export.test.ts`.

## Decision

**A field is a schema that JSON can hold, and `prepareSchema` refuses any
other.** `schemaProblem` in `packages/definition/src/prepare.ts` walks each
declared field and refuses:

- a function anywhere, and the keys `~guard`, `~refine`, and `~codec`;
- an object that is not a plain object or a dense array, an accessor, a
  hidden property, or a symbol key;
- a number that is not finite, and a cycle;
- a visible key starting with `~`. TypeBox keeps its own `~` keywords hidden,
  and they are dropped from the prepared field. A file has no `~` keys; see
  ADR-0526 for how optionality is written;
- a `format` other than TypeBox's stock formats, at a schema position.

**A prepared field is the declared schema's JSON, deeply frozen.**
`plainSchema` round-trips the schema through `JSON.stringify` and
`JSON.parse`. A field declared in code and the same field read from
`epicenter.json` are the same JSON and validate alike. The round trip also
turns `-0` into `0`.

**Formats are TypeBox's stock set and no other.** `PORTABLE_FORMATS` in
`prepare.ts` lists each stock format with TypeBox's own handler, such as
`date` with `Format.IsDate`. A `format` is accepted only when it names one
of them and `Format.Get(name)` still returns that handler. An application
that replaced the `date` handler with its own makes every `date` field
refuse to prepare, because a file would otherwise validate one way in that
process and another way everywhere else. The check applies only where
`format` is a keyword. A `format` key inside `default`, `enum`, `const`, or
`examples` is data.

**A body codec stays in code.** `TableBody` is beside a table's `fields`,
not inside one. App binds it to its Yjs store; Folder refuses one.

**`exportSchema` is deleted.** Nothing needs an exporter that can refuse,
because every prepared field is already JSON. `formatDeclaration` in
`packages/folder/src/declaration.ts` writes `epicenter.json` (ADR-0517), and
`hasSchemaCallbacks` and `isPreparedSchema` are gone with it.

## Consequences

- Removed: `2845f79987:packages/definition/src/export.ts` and its tests,
  `hasSchemaCallbacks`, `isPreparedSchema`, the per-field callback flag, the
  frozen copy of each validated value, and the `DefinitionExportFailed`
  publication error.
- A constraint that JSON Schema keywords cannot express cannot be a field
  constraint. It belongs to the application, after a read, or to a body
  codec.
- `readFolder` and an opener reach the same verdict on a field, because both
  call `prepareSchema`.
- Prepared field identity: a schema object reused under two names or in two
  definitions prepares to two fields.
- A new format is a change to `PORTABLE_FORMATS` first, so a reader refuses
  a file from a newer writer that uses one.
- Every read validates the caller's value in place. A field never has a
  callback that could write to it.

## Considered alternatives

- **Keep callbacks and refuse them only at export.** Leaves two forms of
  one field and an exporter whose refusals a reader has to repeat.
- **Validate `format` by name only.** Accepts a stock name whose handler an
  application replaced, so one file validates two ways.
- **Allow formats registered with `Format.Set`.** Every reader of
  `epicenter.json` would need the writer's handlers.
- **Normalize `-0` in `readFolder`.** Leaves fields declared in code
  holding a value that fields read from a file do not.
- **Validate field schemas against the JSON Schema meta-schema.** Checks the
  schema language itself; TypeBox's `Compile` already refuses what it cannot
  compile, and an unknown keyword is ignored, as JSON Schema ignores one.
