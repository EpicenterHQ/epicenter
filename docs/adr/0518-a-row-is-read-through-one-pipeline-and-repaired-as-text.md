# 0518. A row is read through one pipeline and repaired as text

- **Status:** Accepted
- **Date:** 2026-10-11
- **Relates:** [ADR-0515](0515-snapshot-saves-serialize-writes-and-retain-only-the-latest-pending-text.md) (editing sessions), [ADR-0519](0519-row-frontmatter-is-yaml-every-common-reader-reads-identically.md) (the row text format), [ADR-0464](0464-file-table-updates-conditionally-replace-the-captured-whole-file.md) (conditional replacement without retry)

## Context

A table read returned a snapshot with a partial field projection: every
declared field that validated, beside the issues of the rest, while unknown
keys stayed only in the text. The retained editor read the same file through
a second, canonical parser, and `table.update` patched source through a third
path. The interpretations disagreed: a row could list as valid and fail to
open, `create` could write text that the editor refused, and a list view
could show a title for a row nobody could save.

## Decision

**Every row file is read through one pipeline and written through one
writer, and a row that is not valid is repaired as text.**

```ts
type Row<T> = { fields: T; body: string };
type StoredRow<T> = { path: string; sha256: string; row: Row<T> };

table.get(stem): Result<StoredRow<T> | undefined, RowReadError>;
table.list(): Result<readonly { stem; result: Result<StoredRow<T>, RowReadError> }[]>;
parseRow(definition.tables.x, text): Result<Row<T>, RowIssues>;
formatRow(definition.tables.x, row): Result<string, RowIssue>;
```

- `get`, `list`, `create`, `replace`, and autosave all run `parseRow` and
  `formatRow`; nothing else parses or writes row text, so what a table writes
  it reads back as the same row.
- A valid read is a `StoredRow`: the path and hash of the bytes read, and the
  complete row, unknown keys included, owned and mutable by the caller.
- Readable text that is not a valid row is one error, `InvalidRow`, carrying
  the exact text, its hash, and `issues`. Malformed frontmatter, a value with
  no exact JSON form, and a schema failure share it, because the caller does
  the same thing for each: open a text editor. There is no partial row.
- Issues are compiler-style: `{ message, line?, field? }`, never empty, with a
  1-based line over the whole file, absent only for a missing required field.
  A missing optional field is not an issue (ADR-0526).
- `create` is the one unconditional write. `replace`, `rename`, and `delete`
  take a capture `{ path, sha256 }`, so every other write names the bytes it
  replaces and is `Conflict` when they are gone. A stored row, an `InvalidRow`,
  a listed row, or an autosave state's `file` is a capture as it is.
- A read is a snapshot. There is no observation API: an application reads
  again when a view opens, after its own actions, and when the person
  returns. `onFilesChanged` remains the low-level hint for an application
  that wants to reread sooner.

## Consequences

Removed: `TableSnapshot`, `TableReading`, `inspectRow`, `serializeRow`,
`table.update` and its comment-preserving patcher, the second Markdown
parser, the `{ expectedSha256 }` options object and its runtime checks, and
the table's directory listing before `create` and `rename`, which storage
already enforces at publication.

A list view shows a row with one bad field as needing repair, with no title,
until someone repairs it. A list toggle replaces the complete row, so comments
and source formatting in that row's frontmatter are normalized by the first
save.

## Considered alternatives

- **Partial projection for listing.** Keeps titles of broken rows visible,
  but keeps two interpretations of one file alive.
- **Valid, invalid, and unrepresentable statuses with structured repair of
  schema-invalid rows.** Rebuilds a third document state and an adoption path
  for values that do not conform.
- **Distinct error names for parse and schema failures.** The caller acts the
  same on both; a later `stage` field could separate them without breaking
  anyone, while merging names later would.
- **Issues keyed by field, or enumerated codes.** No caller groups by field
  once repair is textual, and codes would make wording and internal limits a
  contract.
- **Per-namespace `observe`, or a folder `follow(read, listener)` helper.**
  Freshness is the application's choice of when to read; a query cache or one
  `onFilesChanged` listener covers live updates if a product needs them.
- **`stem` plus `{ expectedSha256 }` on guarded writes.** Needed runtime
  defenses against a guard lost on its way; a capture argument makes a
  missing guard a type error.
- **Keep `table.update` for comment-preserving patches.** It kept the second
  parser alive, and autosave already normalizes a row on its first save.

## Verification

`packages/folder/src/row-text.test.ts` and `table.test.ts` cover every failure
category with its line, never-empty issues, unknown keys kept, mutable and
independent values, the listing pipeline, canonical writes reading back,
synchronous capture, refusal before storage, and stale and missing captures as `Conflict`.
