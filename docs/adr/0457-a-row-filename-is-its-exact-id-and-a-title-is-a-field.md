# 0457. A row filename is its exact ID, and a title is a field

- **Status:** Proposed
- **Date:** 2026-09-30
- **Relates:** [ADR-0456](0456-a-markdown-row-owns-at-most-one-same-stem-attachment.md) defines the exact-ID row and attachment pair.
- **Unbuilt:** filename interpretation, creation policy, and coordinated identity replacement in file-authoritative application tables.

## Context

ADR-0456 places a row at `<table>/<id>.md` and its optional attachment at
`<table>/<id>.<extension>`. A readable suffix such as `r123~interview.md`
would improve directory listings, but an ID would no longer supply the exact
row path. Changing the suffix would move the row, its attachment, and path
references.

The Vault offers another example: `pages/2026-07-07-read-your-writing-out-loud.md`
already has a readable ID. Its stem is the identity, and a rename is a reference
migration. Exact-ID filenames and readable filenames are compatible.

Current Yjs-backed stores mint random row IDs and checkout Push mints IDs for
new files. This decision concerns migrated file-authoritative tables; it does
not introduce a caller-selected-ID API on current stores.

## Decision

**A row file is exactly `<table>/<id>.md`, and its optional attachment uses that
entire ID as its stem.** There is no separately parsed readable suffix. Resolve
the row directly from its table and ID, and discover its zero or one attachment
by exact stem under ADR-0456. Neither an attachment path nor its extension needs
to be repeated in authored frontmatter. A `.blob` marker adds no ownership fact.

```text
recordings/
  r123.md
  r123.opus
notes/
  attachment-ownership.md
```

**A title is an editable field and changing it does not change the ID.** Apps
can show titles in lists, search results, and file pickers while retaining exact
paths underneath. Whether an application allows a readable ID at creation is
a separate creation-policy decision. The format does not require an ID to be
random; it requires a valid, path-safe ID whose complete spelling is the stem.
A readable ID may become less descriptive as its content changes.

**An ID is immutable during its row's lifetime; an explicit rename creates a
new row and removes the old row as one coordinated replacement.** The operation
preserves the selected source content and attachment bytes at the new ID,
updates references within its declared scope, and retires the old paths. It
refuses destination collisions and an ambiguous owned attachment. Title edits
do not invoke replacement. No alias silently preserves the old identity.

```text
move recordings/r123.md to recordings/r456.md
move recordings/r123.opus to recordings/r456.opus
change admitted references from r123 to r456
```

Creating a new row and removing the old row describes the identity result.
The file boundary moves the existing row and attachment paths while preserving
attachment bytes exactly. A native adapter can rename files within one
filesystem; an adapter that must copy retains the source until destination
bytes are complete and verified. An internal immutable payload may serve the
new logical path without a second physical byte copy. The operation does not
pass its attachment through ordinary row deletion and recreate it afterward.

The operation plans all moves and source-preserving reference edits against
observed files before changing them. It checks source identity, attachment
ownership, and destination availability again when admitting the change.
Reference edits use understood Markdown links and declared row-reference
fields, not arbitrary string replacement. The file boundary detects intervening
writes and uses grouped publication or a defined interruption-recovery procedure.
An interrupted operation retains sufficient state to resume or restore the
affected paths without discarding bytes or overwriting another writer's work.
Until resolved, applications cannot present that replacement as complete.
Ordinary create and delete calls executed consecutively do not supply this
guarantee, and a Git commit does not repair an interrupted live save.

It repairs only references it can inspect and safely interpret in the declared
scope. It cannot claim to repair unopened folders, independent copies, external
URLs, or offline edits; a promised complete repair refuses unresolved source.
Sync adoption and concurrent editing must handle the resulting new and removed
paths explicitly. A rename does not establish a cross-device transaction.

**A completed app replacement records all participating source changes in one
automatic Git commit within one repository.** The row and attachment path changes
and reference edits share that snapshot. Publication and history must complete
before the app acknowledges success. An interrupted replacement retains its
evidence for recovery. Files in separate repositories cannot share one commit
or acquire atomic reference repair. Generated query indexes are invalidated or
rebuilt separately from the authored change.

Git stores the resulting snapshots and can infer a rename from a delete/add
pair. Its presentation does not determine Epicenter row identity or repair
application references. Isomorphic-git's per-path status reporting likewise
does not supply the replacement operation. See [Git's file-movement
explanation](https://git-scm.com/book/en/v2/Git-Basics-Recording-Changes-to-the-Repository#_moving_files)
and [isomorphic-git statusMatrix](https://isomorphic-git.org/docs/en/statusMatrix).

A direct filesystem rename is observed as the disappearance of the old ID and
appearance of the new ID. It does not invoke automatic reference repair, and
an attachment left at the old stem remains preserved source. The public API
name and implementation of coordinated replacement remain unbuilt.

Externally written files remain inspectable when their names violate the
convention. Invalid names do not authorize rewriting or deletion. Source and
issue reporting remain available for repair.

## Consequences

- A table and ID determine the exact Markdown path without a suffix scan. The
  attachment's format still requires sibling discovery.
- Title edits have no filename or link-repair cost. People browsing a directory
  of generated IDs need to open files or use a title-aware reader.
- Readable IDs follow the same attachment rule, but changing their words is
  an identity migration rather than an inexpensive label edit.
- An explicit replacement can be reviewed as one source change and checkpointed
  once. Git history preserves the previous paths; it does not make live writes
  or remote adoption atomic.
- The Vault remains evidence for readable IDs, not an automatic migration.
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
