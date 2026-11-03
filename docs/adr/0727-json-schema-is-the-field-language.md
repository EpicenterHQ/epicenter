# 0727. JSON Schema is the field language

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Amends:** [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) at "a field is declared once with a field builder and compiles to four outputs": no builder compiles anything; each reader interprets the contract's JSON Schema itself.
- **Unbuilt:** the written list of supported JSON Schema keywords; Epicenter's generic views reading it; `epicenter query` mapping it to columns; a document app mapping it to keys.

## Context

A contract declares each collection's fields as plain JSON Schema
([ADR-0525](0525-a-field-is-plain-json-schema.md)), written by hand: Whispering's
`contract.json` repeats one `date-time` pattern in every collection. ADR-0705
planned field builders (`text`, `select`, `multiSelect`, `date`, `url`, `ref`,
`body`) that would compile one declaration into four outputs: JSON Schema for
checking files, a Yjs shape for documents, SQL columns for queries, and UI
controls for generic views. No reader needs a second format: each can read
JSON Schema, and TypeBox already produces it.

## Decision

**The field language is a written subset of JSON Schema.** Each reader
interprets the contract's schema directly, for what it needs:

| Reader | Interprets | For example |
| --- | --- | --- |
| `epicenter check` | the schema itself | as today |
| Epicenter's generic views | a type picks a control | `enum` is a dropdown, an array of `enum` is chips, `format: date-time` is a date picker |
| `epicenter query` | a type picks a column | `string` is `TEXT`, `number` is `REAL` |
| a document app | a field is a key in the item's map | a `string` field is a string value |

**Field helpers are optional shorthand that return JSON Schema.** A helper such
as `instant()` returns the timestamp schema so no contract repeats the
pattern; a contract written by hand or with TypeBox is equally valid.

**A keyword outside the subset is allowed and ignored by readers that do not
know it.** `epicenter check` still validates it.

## Consequences

- No compiler, build step, or second format exists between a contract and its
  readers.
- Adding a reader means writing its interpretation of the subset; adding a
  keyword to the subset means each reader decides what it does with it.
- An item's body is not a field; how a document stores a body is decided
  separately.

## Considered alternatives

- **Field builders compiling to four outputs (ADR-0705).** A second format to
  keep in step with JSON Schema, for readers that can read JSON Schema.
- **`x-` keywords for UI hints inside the schema.** Readers infer controls from
  standard keywords; a hint can be added to the subset if a real need appears.
