# 0536. A folder table may close with additionalProperties false

- **Status:** Accepted
- **Date:** 2026-10-14
- **Relates:** [ADR-0525](0525-a-field-is-plain-json-schema.md) (a field is plain JSON Schema), [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) (one read pipeline), [ADR-0520](0520-the-cli-acts-on-a-data-folder-by-its-path.md) (`check` and `query`)

## Context

A row read from a file ignores frontmatter keys its table does not declare and
keeps them on save. That suits applications: a key another tool wrote
survives. A folder people and agents write by hand needs the opposite for some
tables. A misspelled `subtitel:` reads as a valid row with no subtitle, and
nothing reports it. The Vault's own reader reported such keys, which was one
reason the Vault could not read through Epicenter alone.

## Decision

**A folder table may declare `additionalProperties: false`, JSON Schema's own
keyword for a closed object.** In `defineTable` it sits beside `fields`; in
`epicenter.json` it sits beside `properties` and `required`, and `false` is
its only value. A row of a closed table with an undeclared key does not
conform: the read reports `<key> is not declared` at the key's line, the same
issue a write of that key already reports. `check` names it, and `query`
leaves the file out.

**Only a folder keeps a closed table.** `prepareSchema`, which folders use,
accepts one. `prepareData`, which datasets use, refuses one: a dataset is
shared across releases, and an older release must read the keys a newer one
added.

## Consequences

- Open stays the default, so every existing folder and application reads as
  before.
- Closing a table is a declaration change. A folder that closes a table with
  stray keys in its files sees those rows stop conforming until the keys are
  declared or removed.
- Validation stays per field. A whole-row TypeBox `Type.Object` validator
  would report the same undeclared key, but one failing field would then hide
  the others.

## Considered alternatives

- **A warning that does not fail the row.** A second severity in `check`
  and a rule for what `query` does with a warned row, for a case the
  declaration can state exactly.
- **Any schema as `additionalProperties`, or `patternProperties`.** A row's
  keys are field names; nothing needs a pattern of them yet.
- **Closing datasets too.** Breaks reading across releases.
