# 0688. One Folder-owned text document per path

- **Status:** Superseded
- **Date:** 2026-10-24
- **Superseded by:** [ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md).
- **Relates:** [A lens belongs to its reader](0632-a-lens-belongs-to-its-reader.md) and [a folder owns local files](0636-an-app-opens-local-files-through-one-folder-handle.md).
- **Supersedes:** [ADR-0676](0676-structured-edits-share-the-acquired-working-document.md) at the public document API and owner implementation. [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md)'s per-path order and last-write-wins publication remain.

## Context

The earlier owner kept a source, schema-specific views, a command lane, read
ordering, publication counters, and draft runs for each path. A document save
could accept and interpret input, return parsed captured content, and preserve
exact acknowledgment identity. Those guarantees made routine typing and
background saving difficult to explain. Applications predominantly edit
Markdown text; binary files are generally added or removed through raw file
operations. The user accepted last-write-wins publication against outside
changes and a weaker document-save result.

## Decision

A Folder keeps one `TextDocument` per literal path until it closes. File and
table access to that path return the same runtime object. The document owns
current editable text, the last confirmed storage text, a pending local draft,
and one I/O slot. Table schemas interpret text through a pure table reader;
they do not create runtime views or validate publication.

`replace(text)` and `patch({ fields?, body? })` accept text synchronously.
`save()` takes no input, captures the visible text at its call, and returns the
Result of that one publication, without parsed content. Autosave coalesces to
the latest pending draft while the path is busy. Raw writes and deletes remain
exact operations in the same path slot. Different paths can run concurrently.
Document reads use the path slot too, so no publication or read epoch is needed.
Direct operations pause an existing draft's autosave; success supersedes that
draft, while failure leaves it for retry. Later edits stay visible.
A patch accepted over a visible pending raw write includes that write's
content, and its later autosave can publish the composition even if the raw
call fails.

A document snapshot contains text and load/save state only. It is shallowly
frozen and cached for UI subscription identity. A clean document follows
readable storage observations; an unreadable or missing observation retains
its last readable text with a load error. Editing that text schedules autosave
and can overwrite the missing or non-text file; `save()` restores it explicitly.
An inactive clean document retains its last observed text across change hints,
so a programmatic patch refreshes before composing. Local dirty text stays
visible. A later save may unconditionally overwrite outside changes.
`discard()` removes only local
unadmitted input and does not cancel an admitted operation. Each accepted edit
has a distinct identity, so returning to an earlier string does not let an
older write acknowledge the newer edit. Continuous edits share the identity
of their last publication failure until discard; a retry of the exact current
edit temporarily hides it. Close refuses new work, drops pending autosave, and
lets admitted writes settle with their own Results, including failures if
storage is released before they run.

## Consequences

A caller explicitly parses text when it needs fields, body, or diagnostics.
A successful save promises that its captured write succeeded, not that it is
still the latest visible or disk value. Outside edits can be overwritten.
Folder lifetime retention costs one map entry for every acquired document;
raw-only path entries leave the map when idle. There is no reference counting.
Document reads and writes on the same path cannot overlap, but unrelated paths
can proceed independently. Raw file reads remain direct storage reads.

## Considered alternatives

`edit()` or an edit session implies a temporary or exclusive workflow, which
contradicts a shared folder-lifetime value. A schema-specific `document()`
would duplicate state and demand synchronization across views. A folder-global
writer would unnecessarily serialize different paths. Independent writes of
one path can land out of call order, so the per-path I/O slot remains.
