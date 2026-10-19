# 0591. The merge reads a file's content and extension, never a definition

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) at the unit table's "a row, `<table>/<stem>.md`", the whole-file merge of `epicenter.json` with its union of `local`, "Sync, the one write, and the merge driver take the same rule", "Plain Git keeps its conflicts", and the rejected alternative "No merge driver": a `.md` file with readable frontmatter merges by field wherever it is, every `.json` file merges key by key, and the plain-Git merge driver is deleted. [ADR-0535](0535-an-existing-folder-opens-with-its-own-declaration.md) at "History and Sync use the handle's definition": history and Sync read no definition.
- **Amended by:** [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) at "`epicenter.json` included": a `table.json` is text and merges as any text file does; [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) at "one region of body lines", "other UTF-8 text | one region of lines", the line merge `rowTextWins`, "a `.json` file, `epicenter.json` included | one key of an object", and "binary, or a side absent | the whole file" for a side absent: all text, `.json` included, merges by diff3 region, and an edit beats a delete it never saw.
- **Unbuilt:** deleting `localPatterns`, which stays in `packages/folder/src/declaration.ts` while publication and history still read `local`, until ADR-0592 removes it.

## Context

`fileKindOf` and `tableAt` (`packages/folder/src/merge-file.ts:56`, `:67`)
classify a path as a row only when it is `<declared table>/<id>.md`, one
level deep, and `epicenter.json` as the `definition` kind, which merges
whole but unions `local` (`definitionWins`, `:191`). `rowWins` reads each
side with `parseRow(table)` (`:315`) and writes the result with
`writeRow(table)` (`:321`); a side that fails the table's schema sends the
file to a line merge (`rowTextWins`, `:386`). `writeRow` orders keys by
`Object.keys(table.fields)` through `formatRowSource`
(`packages/folder/src/row-text.ts:147-150`).

The validity gate protects nothing a field merge could break: `check`
validates one field at a time with no rule across fields
(`packages/definition/src/prepare.ts:316-342`), and every merged value
comes from ours or theirs, so a field merge of two valid rows is always
valid. The gate only demoted an invalid side to a coarser merge. The field
merge itself needs no table: `mergeRows`
(`packages/folder/src/row-merge.ts:92`) takes rows and returns fields, and
orders keys base, then ours, then theirs (`:106-110`).

Sync takes its classifier from the opened handle (`kindOf`,
`packages/folder/src/git/history.ts:687`). A plain-Git merge driver walks
up from the path to the nearest `epicenter.json` and prepares it
<!-- doc-path-check: ignore-next-line -->
(`gitMergeKind`, `packages/folder/src/merge-driver.ts:52-76`), and the CLI
configures it after a connecting sync and after `epicenter clone`.

## Decision

**merge takes a path and three content versions, without consulting a schema.**
Its named roles are base, current, and change, with ADR-0622 defining the
winner when both sides replace the same unit.

| File | Merge unit |
| --- | --- |
| Markdown with readable frontmatter | One complete frontmatter field value, then one diff3 region of body lines |
| Other UTF-8 text, JSON included | One diff3 region |
| Binary content or an absent side | The whole file under the existing merge rules |

A JSON schema file merges as ordinary text. It has no special object-key
merge and no influence over how other files merge. Two insertions at one
location both survive under ADR-0622's insertion rule.

When a Markdown merge keeps one side's fields, that side's frontmatter
bytes can remain intact. Combining fields uses the source-preserving
formatter's key order. A malformed frontmatter version remains text for
repair; it is not a reason to consult a table schema.

**Local saves and synchronization use the same content merge.**
The inputs differ as specified by ADR-0622. Paths identify file kinds; no
owning app, table marker, or declaration classifies them.

**Epicenter registers no plain-Git merge driver.**
Epicenter's save and sync operations use its merge. Plain git retains its
own conflict behavior. A file containing unresolved conflict markers needs
repair before an Epicenter disk sync can commit it. The CLI's credential
helper is independent of merge-driver installation.

## Consequences

- A missing or stale schema does not change merge results.
- JSON does not receive a separate structural merge implementation.
- Invalid schema JSON remains visible as source and can be repaired.
