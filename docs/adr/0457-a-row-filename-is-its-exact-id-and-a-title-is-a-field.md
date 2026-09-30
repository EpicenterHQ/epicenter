# 0457. A table and file stem address a row, and a title is a field

- **Status:** Proposed
- **Date:** 2026-09-30
- **Relates:** [ADR-0456](0456-a-markdown-row-owns-at-most-one-same-stem-attachment.md) defines the same-stem row and attachment pair.
- **Unbuilt:** filename interpretation, creation policy, and scoped rename in file-authoritative application tables.

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

**A row file is exactly `<table>/<stem>.md`, and its optional attachment uses that
complete stem.** There is no separately parsed readable suffix. Resolve
the row directly from its table and stem, and discover its zero or one attachment
by exact stem under ADR-0456. Neither an attachment path nor its extension needs
to be repeated in authored frontmatter. A `.blob` marker adds no ownership fact.

```text
recordings/
  r123.md
  r123.opus
notes/
  attachment-ownership.md
```

**Table lookup uses the complete file stem without `.md`; raw file access uses
the literal folder-relative path.** A file stem is the filename without its
final extension: `interview.take.md` has stem `interview.take`. The `stem` in a
table entry is that derived stem, not a separately stored identifier or lookup
registry. The table supplies its directory and the fixed `.md` extension.

Use `stem` for the table address, `filename` for the name including its
extension, and `path` for the location including its directories:

| Term | Example |
| --- | --- |
| Stem | `interview.take` |
| Filename | `interview.take.md` |
| Folder-relative path | `recordings/interview.take.md` |

```ts
// File-backed folder handle; implementation remains unbuilt.
await folder.tables.recordings.get('interview');
await folder.files.read('recordings/interview.md');
```

`get` does not strip a supplied extension or accept a path as an alias. A stem
spelled `interview.md` addresses `interview.md.md`, not `interview.md`. Links and
raw file operations retain exact paths including extensions. Table selection
and reference fields scoped to a table use stems. [ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md)
places both views under the same folder handle.

**A title is an editable field and changing it does not change the stem.** Apps
can show titles in lists, search results, and file pickers while retaining exact
paths underneath. Whether an application allows a readable stem at creation is
a separate creation-policy decision. The format requires a valid, path-safe
stem, which may be readable or generated.
A readable stem may become less descriptive as its content changes.

**A row's current address is its table and stem; rename changes that address.**
The operation moves the row and its owned attachment through ordered filesystem
steps and preserves the selected source content and attachment bytes. It
updates references within its declared scope and retires the old paths. It
refuses destination collisions and an ambiguous owned attachment. Title edits
do not invoke replacement. No alias silently preserves the old address.

```text
move recordings/r123.md to recordings/r456.md
move recordings/r123.opus to recordings/r456.opus
change admitted references from r123 to r456
```

The file boundary moves the existing row and attachment paths while preserving
attachment bytes exactly. A native adapter can rename files within one
filesystem; an adapter that must copy retains the source until destination
bytes are complete and verified. An internal immutable payload may serve the
new logical path without a second physical byte copy. The operation does not
pass its attachment through ordinary row deletion and recreate it afterward.

The operation plans all moves and source-preserving reference edits against
observed files before changing them. It checks the observed source, attachment
ownership, and destination availability again when admitting the change.
Reference edits use understood Markdown links and declared row-reference
fields, not arbitrary string replacement. The file boundary can check observed versions, but concurrent native writers
can race its checks. Partial publication is reported when observable; no atomic
multi-file transaction, application-wide lock, or mandatory recovery journal is
promised. A Git commit can capture a partial state and does not finish missing
moves or reference edits.

It repairs only references it can inspect and safely interpret in the declared
scope. It cannot claim to repair unopened folders, independent copies, external
URLs, or offline edits; a promised complete repair refuses unresolved source.
Sync adoption and concurrent editing must handle the resulting new and removed
paths explicitly. A rename does not establish a cross-device transaction.

**After an app rename finishes its filesystem steps, it requests history through
the same folder policy as other app saves.** The captured snapshot can include the
row and attachment moves, reference edits, and other writers' saved changes.
Commit failure does not undo a completed file rename. Unchanged audio keeps the
same LFS object ID; only the pointer's tree path changes. Automatic subjects
describe captured path changes under ADR-0469, with no special rename message.
Files in separate repositories cannot share one commit
or acquire atomic reference repair. Generated query indexes are invalidated or
rebuilt separately from the authored change.

Git stores the resulting snapshots and can infer a rename from a delete/add
pair. Its presentation does not determine the current row address or repair
application references. Isomorphic-git's per-path status reporting likewise
does not supply the replacement operation. See [Git's file-movement
explanation](https://git-scm.com/book/en/v2/Git-Basics-Recording-Changes-to-the-Repository#_moving_files)
and [isomorphic-git statusMatrix](https://isomorphic-git.org/docs/en/statusMatrix).

A direct filesystem rename is observed as the disappearance of the old stem and
appearance of the new stem. It does not invoke automatic reference repair, and
an attachment left at the old stem remains preserved source. The public API
name and implementation of rename remain unbuilt.

Externally written files remain inspectable when their names violate the
convention. Invalid names do not authorize rewriting or deletion. Source and
issue reporting remain available for repair.

## Consequences

- A table and stem determine the exact Markdown path without a suffix scan. The
  attachment's format still requires sibling discovery.
- Title edits have no filename or link-repair cost. People browsing a directory
  of generated stems need to open files or use a title-aware reader.
- Readable stems follow the same attachment rule, but changing their words is
  a path rename with reference repair.
- An explicit rename can be reviewed as one source change and checkpointed
  once. Git history preserves the previous paths; it does not make live writes
  or remote adoption atomic.
- The Vault remains evidence for readable stems, not an automatic migration.
  Its shadow folders can own several assets; Epicenter's one-attachment rule
  instead requires separate owning rows for multiple assets.

## Considered alternatives

- Add `<id>~<label>.md`. An ID no longer determines the path, and a label rename
  requires coordinated attachment moves and link repair.
- Rename files whenever titles change. Ordinary metadata edits would rekey
  rows and require reference migration.
- Implement rename by calling ordinary row deletion before creating the new
  row. Deletion owns attachment cleanup and can discard the bytes being moved.
- Use Git's inferred rename as the application's replacement signal. Content
  similarity cannot establish intent, ownership, or which references to update.
- Require opaque generated IDs as part of the file format. This couples path
  interpretation to application creation policy without improving discovery.
- Give each row a shadow directory containing several attachments, as the Vault
  does. This supports page-local asset collections, but changes the selected
  ownership cardinality and requires per-asset names and enumeration.
