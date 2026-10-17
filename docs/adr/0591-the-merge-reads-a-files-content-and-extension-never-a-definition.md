# 0591. The merge reads a file's content and extension, never a definition

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) at the unit table's "a row, `<table>/<stem>.md`", the whole-file merge of `epicenter.json` with its union of `local`, "Sync, the one write, and the merge driver take the same rule", "Plain Git keeps its conflicts", and the rejected alternative "No merge driver": a `.md` file with readable frontmatter merges by field wherever it is, every `.json` file merges key by key, and the plain-Git merge driver is deleted. [ADR-0535](0535-an-existing-folder-opens-with-its-own-declaration.md) at "History and Sync use the handle's definition": history and Sync read no definition.
- **Unbuilt:** all of it: `merge` without a definition; frontmatter kept as a side wrote it, which tests must prove before it ships (the fallback is restoring row classification); ours' key order; the `.json` merge by key; and the deletions below.

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
(`gitMergeKind`, `packages/folder/src/merge-driver.ts:52-76`), and the CLI
configures it after a connecting sync and after `epicenter clone`.

## Decision

**`merge` takes three versions and a path:**

| File | Unit |
| --- | --- |
| a `.md` file whose present versions all have frontmatter `parseRowSource` reads | one frontmatter field; one region of body lines |
| a `.json` file, `epicenter.json` included | one key of an object, recursing into nested objects |
| other UTF-8 text | one region of lines |
| binary, or a side absent | the whole file |

- No table classifies a path and no depth rule applies: `notes/a.md`,
  `notes/2026/a.md`, and a `README.md` with frontmatter at the root merge
  alike.
- A `.json` file merges object by object, key by key. A nested object
  recurses; an array or a scalar is one unit per key; a key both sides
  changed differently goes to the writer acting. A version that does not
  parse merges whole.
- A merged Markdown file keeps its frontmatter as a side wrote it. When the
  merged fields equal ours' fields or theirs', that side's frontmatter bytes
  stand as they are, comments and quoting included. Only when the merged
  fields differ from both sides' is the frontmatter written with
  `formatRowSource`, keys in ours' order, then keys only theirs added.
- A merge that does not format, and a version whose frontmatter does not
  read, takes the frontmatter and body line merge (`rowTextWins`), as an
  invalid row does today.
- Sync and the one write call the same `merge`; history and Sync read no
  definition.

**The plain-Git merge driver is deleted.** Plain Git run on a folder shows
Git's ordinary conflicts; Epicenter's merge by unit runs in Sync. Deleted:
`packages/folder/src/merge-driver.ts` and `packages/cli/src/merge-driver.ts`
with their tests, the `epicenter merge-driver` command, and the
configuration written after a connecting sync
(`packages/cli/src/history-commands.ts:238-249`) and after `epicenter
clone` (`packages/cli/src/repository-commands.ts:182-184`). The command
link `~/.local/bin/epicenter` stays, for the credential helper.

## Consequences

- Depth no longer matters to the merge, so nested tables (a note group as a
  real directory, in the open nested-tables spec) merge by field with no new
  rule.
- A field theirs added sits last in a merged row until the app's next save
  of that row moves it: one line of churn in the next commit.
- A hand-written `.md` file with frontmatter outside any table merges by
  field. Its frontmatter is rewritten canonically, losing YAML comments,
  only when both sides changed its fields, as rows already are; history
  keeps the old version.
- A `.json` key both sides changed keeps the writer acting's value; the
  other side's value is in its commit. An edit to one key of
  `epicenter.json` does not stop a template update from changing the others.
- A person or agent running `git pull` or `git merge` on a folder resolves
  Git's ordinary conflict markers.
- Deleted: `FileKind`, `fileKindOf`, `tableAt`, the `definition` merge kind
  with `definitionWins` and `localPatterns`, `kindOf` in `git/history.ts`,
  and the merge driver.

## Considered alternatives

- **Keep the definition in the merge.** Its only effect was demoting an
  invalid side to a line merge; it tied rows to one directory level, which
  nested tables break, and made the merge driver find and prepare a file.
- **Merge `.json` by line.** A line merge joins two different insertions at
  one place (`mergeLines`, `packages/folder/src/git/merge-lines.ts:202-209`),
  so two items added to an empty array on two devices would merge into JSON
  with no comma between them.
- **Merge `.json` as a whole file, the writer acting winning.** One edit to
  `epicenter.json` would then win every later template update whole.
- **Keep the plain-Git merge driver.** It needs configuring per clone and a
  working command link, and gives plain Git a second conflict policy beside
  Git's own, for merges Sync already makes by unit.
