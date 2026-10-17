# 0526. A field is required unless declared optional

- **Status:** Accepted
- **Date:** 2026-10-11
- **Amends:** [ADR-0491](0491-field-helpers-build-native-typebox-schemas-with-ui-metadata.md) at its three reads: `accepts`, `conformance`, and `inputIssues` are replaced by `check`, and a missing declared field is an issue only when the field is required. Its JSON-safety check and per-field diagnostics stand.
- **Amended:** 2026-10-17: the `patch` mode is deleted, since its caller, `table.update`, is gone ([ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md)). `check` has `read` and `input`, and whether a field admits `null` is `check({ f: schema }, { f: null }, 'input')`.
- **Relates:** [ADR-0525](0525-a-field-is-plain-json-schema.md) (fields are plain JSON Schema), [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) (`required` in `epicenter.json`), [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) (row issues), ADR-0522 (settings, since deleted: settings are a table, [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md))

## Context

Under ADR-0491 every declared field was required. `conformance(fields,
payload)` reported each absent field as an issue, and
`inputIssues(fields, values, { complete })` required every field of a
complete row. A row could not leave a field out, so a column added to a table
made every existing row nonconforming. KV had the same rule on paper, while
`KvReading.values` was already `Partial<T>` and every setting could be unset.

`epicenter.json` writes each table as a JSON Schema object (ADR-0517), and
JSON Schema already has a word for this: `required`.

## Decision

**A field is optional when it is declared with `field.optional`; every other
row field is required, and every KV field is optional.**

```txt
code                                  epicenter.json            row type
field.string()                        listed in "required"      title: string
field.optional(field.string())        not listed                title?: string
any KV field                          kv has no "required"      Partial<...>
```

- `field.optional(inner)` is `Type.Optional(inner)`. The prepared field keeps
  TypeBox's hidden `~optional`, and `isOptional(schema)` reads it.
- `required` is the only optionality marker in a file. `parseDeclaration` and
  `formatDeclaration` in `packages/folder/src/declaration.ts` convert between
  it and `field.optional`, and nothing else does. A table with no `required`
  has only optional fields. `kv` may not carry `required`.
- `RowOf` and `CreateRowOf` read optional fields as `name?:`. `KvOf` is
  `Partial`.
- `field.nullable` refuses an optional inner schema. Absent and `null` are
  different values: `field.optional(field.nullable(inner))` allows both.

**`undefined` is absence, never a stored value.** A key holding `undefined`
reads exactly as a missing key, in every mode.

**`check(fields, values, mode)` is the one read over prepared fields.** It
returns `{ conforming, issues }`: each present field that is JSON and passes
its own validator, and an issue for everything else.

| `mode` | used for | absent required field | undeclared key |
| --- | --- | --- | --- |
| `read` | a stored payload | issue | ignored |
| `input` | a whole row being written | issue | issue |
| `patch` | some fields being written | not an issue | issue |

An absent optional field is never an issue.

**Validation stays per field.** `check` runs each field's own compiled
validator, so a field that fails never takes a valid sibling with it, and
each issue names its own field.

## Consequences

- Removed: `accepts`, `conformance`, `inputIssues`, and the `{ complete }`
  option. Whether a field admits `null` is
  `check({ f: schema }, { f: null }, 'patch')`.
- Adding an optional field to a table leaves existing rows conforming.
  Adding a required one still makes each row without it an issue.
- App's `kv.nonconforming` no longer lists unset keys, only stored values a
  field refuses.
- A row's missing-field issue has no line, because nothing in the text is
  wrong; ADR-0518's issues carry that rule.

## Considered alternatives

- **One compiled `Type.Object` per table.** TypeBox's `Errors` stops after 8
  errors, and a nested `required` failure is reported against the wrong
  field.
- **Treat `null` as absence.** Loses the difference between a field nobody
  set and one a person cleared.
- **An `optional` flag beside each field in the file.** Duplicates what
  JSON Schema's `required` already says, and a tool that knows JSON Schema
  would not read it.
- **Keep every row field required.** Makes adding a column a migration of
  every row.
