# 0457. A table and file stem address a row, and a title is a field

- **Status:** Proposed
- **Date:** 2026-09-30
- **Relates:** [ADR-0480](0480-file-tables-own-only-their-markdown-row-files.md) proposes single-file rows; [ADR-0477](0477-file-folder-operations-tolerate-repairable-layout-disorder.md) bounds native layout guarantees.
- **Implementation:** literal stem addressing under the shared path rule of [ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md), stem-addressed byte-preserving `rename(stem, nextStem, options)`, and the one read pipeline of ADR-0518 in `@epicenter/folder`, consumed by Todos, Whispering, Honeycrisp, Capture, and Vocab.
- **Unbuilt:** nothing in `@epicenter/folder`. Reference repair stays a separate application capability, as below.

## Context

ADR-0456 places a row at `<table>/<stem>.md` and its optional attachment at
`<table>/<stem>.<extension>`. A readable suffix such as `r123~interview.md`
would improve directory listings, but a separate ID would no longer supply the exact
row path. Changing the suffix would move the row, its attachment, and path
references.

The Vault offers another example: `pages/2026-07-07-read-your-writing-out-loud.md`
already has a readable stem. Renaming changes its address and can require
reference repair. Readable stems need no independent row identifier.

Current Yjs-backed stores mint random row IDs and checkout Push mints IDs for
new files. This decision concerns migrated file-authoritative tables; it does
not introduce a caller-selected-ID API on current stores.

## Decision

**A row file is exactly `<table>/<stem>.md`.** There is no separately parsed
readable suffix. Resolve the row directly from its table and stem. The proposed
single-file row contract in ADR-0480 removes inferred sibling ownership;
applications express media references through fields or links.

```text
recordings/
  r123.md
audio/
  take123.opus
notes/
  meeting.md
```

**Table lookup uses the complete file stem without `.md`; raw file access uses
the literal folder-relative path.** A file stem is the filename without its
final extension: `interview.take.md` has stem `interview.take`. The `stem` in a
table entry is that derived stem, not a separately stored identifier or lookup
registry. The table supplies its directory and the fixed `.md` extension.

Use `stem` for the table address, `filename` for the name including its
extension, and `path` for the location including its directories:

| Term                 | Example                        |
| -------------------- | ------------------------------ |
| Stem                 | `interview.take`               |
| Filename             | `interview.take.md`            |
| Folder-relative path | `recordings/interview.take.md` |

```ts
// File-backed folder handle; see @epicenter/folder.
await folder.tables.recordings.get("interview");
await folder.files.read("recordings/interview.md");
```

`get` does not strip a supplied extension or accept a path as an alias. A stem
spelled `interview.md` addresses `interview.md.md`, not `interview.md`. Links and
raw file operations retain exact paths including extensions. Table selection
and reference fields scoped to a table use stems. [ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md)
places both views under the same folder handle.

**A title is an editable field and changing it does not change the stem.** Apps
can show titles in lists, search results, and file pickers while retaining exact
paths underneath. Whether an application allows a readable stem at creation is
a separate creation-policy decision. The format uses a literal filename segment
admitted by the scoped file boundary and representable on its backing filesystem. It may be readable or generated.
Creation and rename follow the folder's one path rule
([ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)),
which refuses a name that does not mean only itself on every disk, such as
`a: b` or `con`; there is no rule beyond it.
A readable stem may become less descriptive as its content changes.

**A row's current address is its table and stem; rename changes that address.**
`table.rename(stem, nextStem, options)` moves only the Markdown file, preserving
its bytes. With `{ expectedSha256 }` it checks the reviewed bytes; with `{}` it
moves whatever the row holds (ADR-0464). It checks an absent destination, and a
collision refuses the operation. Renaming to the current stem moves nothing
and answers the row as it is. Title edits do not invoke rename. No alias
silently preserves the old address.

```text
move recordings/r123.md to recordings/r456.md
audio/take123.opus stays at its existing path
```

The file boundary moves the existing row without re-encoding it. An adapter
that must copy retains the source until destination bytes are complete and
verified. An internal immutable payload may serve the new logical path without
a second physical byte copy. Rename does not call row deletion and recreate it.

The operation performs destination layout checks once before publication;
publication checks the source baseline and destination vacancy. Native writers
outside the owner can race these checks. Partial publication is reported when
observable, with no rollback or mandatory recovery journal.

Rename does not rewrite inbound links, change media paths, or repair application
reference fields. A product may offer separately scoped repair over files it
understands, with explicit outcomes. Moving a Markdown document across
directories can change the meaning of its relative body links. No complete
reference-repair promise follows from a file move.

**After an app rename finishes its filesystem steps, it requests history through
the same folder policy as other app saves.** The captured snapshot can include the
row move and other writers' saved changes. Commit failure does not undo a
completed file rename. Automatic subjects
describe captured path changes under ADR-0469, with no special rename message.
Files in separate repositories cannot share one commit
or acquire atomic publication. Generated query indexes are invalidated or
rebuilt separately from the authored change.

Git stores the resulting snapshots and can infer a rename from a delete/add
pair. Its presentation does not determine the current row address or repair
application references. Isomorphic-git's per-path status reporting likewise
does not supply the replacement operation. See [Git's file-movement
explanation](https://git-scm.com/book/en/v2/Git-Basics-Recording-Changes-to-the-Repository#_moving_files)
and [isomorphic-git statusMatrix](https://isomorphic-git.org/docs/en/statusMatrix).

A direct filesystem rename is observed as the disappearance of the old stem and
appearance of the new stem. It does not invoke automatic reference repair.
The earlier experimental API also moved inferred attachments; the current
Folder operation moves only the row file. Broader reference repair remains
a separate application capability.

Every representable literal stem is a row address, including an empty stem
for `.md`, leading dots and trailing spaces. Folder scope and row membership
checks remain; names produce no content issues or application reference gate.
ADR-0518 reads a row's text, not its name, so a stem is never a row issue.
Transfer may refuse paths the destination cannot represent; it does not
retroactively invalidate the source name.

## Consequences

- A table and stem determine the exact Markdown path without a suffix or sibling
  scan.
- Title edits have no filename or link-repair cost. People browsing a directory
  of generated stems need to open files or use a title-aware reader.
- Changing a readable stem is a path rename that can leave stale references.
- An explicit rename can be reviewed as one source change and checkpointed
  once. Git history preserves the previous paths; it does not make live writes
  or remote adoption atomic.
- The Vault remains evidence for readable stems, not an automatic migration.
  Media layout is an application convention, not part of the row address.

## Considered alternatives

- Add `<id>~<label>.md`. An ID no longer determines the path, and a label rename
  requires path moves and can leave stale links.
- Rename files whenever titles change. Ordinary metadata edits would rekey
  rows and require reference migration.
- Implement rename by calling ordinary row deletion before creating the new
  row. It discards the direct move's baseline and adds another publication step.
- Use Git's inferred rename as the application's replacement signal. Content
  similarity cannot establish intent, ownership, or which references to update.
- Require opaque generated IDs as part of the file format. This couples path
  interpretation to application creation policy without improving discovery.
- Give each row an owned asset directory: requires per-asset ownership and
  enumeration beyond the single-file row contract.
