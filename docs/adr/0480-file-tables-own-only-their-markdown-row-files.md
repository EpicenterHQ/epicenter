# 0480. File tables own only their Markdown row files

- **Status:** Accepted
- **Date:** 2026-10-01
- **Supersedes:** [ADR-0456](0456-a-markdown-row-owns-at-most-one-same-stem-attachment.md).

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

ADR-0456 assigns zero or one same-stem sibling attachment to each Markdown row.
`9d13dd25854e:packages/folder/src/table.ts` discovers those files, reports attachment
ambiguity, and composes row creation, rename, and deletion with media operations.
Whispering reconstructs the same relationship again when recovering a partial
recording publication.

Ordinary Markdown can link several files or share a file with another document.
A filename or reference does not prove exclusive ownership. Generic table
operations need not enumerate media or decide its lifetime.

## Decision

**A table entry interprets exactly one Markdown row file.**
Table creation writes that file; update and source replacement edit that file;
rename moves that file; deletion removes that file. Sibling files do not become
attachments, invalidate an otherwise valid row, or block creation solely because
they share its stem. Literal destination and filesystem-collision checks remain.

**Media is ordinary file content addressed through the files API.**
Applications may place it anywhere within the opened folder and reference it
through Markdown links or declared fields. There is no required `blobs/` or
`assets/` directory, flat identifier namespace, attachment registry, or media
immutability policy. An application may preserve original recordings by using
exclusive creation and new paths for converted content.

```text
folder/
  recordings/interview.md
  audio/interview.webm
  notes/meeting.md
  images/whiteboard.png
```

These directories illustrate one application's convention. A standard body
link in `recordings/interview.md` can be
`[Listen](../audio/interview.webm)`. Applications define the resolution of their
own frontmatter fields; a field may use a document-relative link or an explicitly
folder-relative API path. Public file operations always use literal paths
relative to the opened folder, never the physical account data root.

**References do not authorize media deletion, renaming, or cleanup.**
Copying a row can share its referenced media. Row deletion retains referenced
files. A product can offer an explicit operation on known selected paths, using
their captured baselines and reporting each operation and its uncertainty.
Independent operations do not create a generic batch or `Partial` result. The
folder performs no reference scan, orphan sweep, link rewriting, or inferred
cascade deletion.

Plain Git records media bytes like other file bytes. Selective LFS support would
change history representation and transfer below file reads and saves; it would
not restore row attachment ownership. LFS is not implemented by this decision.

## Consequences

- `Entry.attachment`, attachment issues, `CreateInput.attachment`, sibling
  candidate discovery, and attachment ownership checks are gone from the
  generic table API.
- Applications supply their media links and compose related saves over the same
  file boundary. Pending recording bytes and publication reconciliation remain
  application workflow state.
- Files may remain after a row is deleted, and moving files may break links.
  Products can expose repair or selected-file deletion without imposing those
  behaviors on every table.
- Existing audio-bearing history is preserved. Changing the table model does
  not authorize rewriting history or discarding media.

## Considered alternatives

- Infer ownership from a same-stem filename: limits cardinality and duplicates
  application recovery logic while failing for shared links.
- Require an immutable blob namespace: introduces another identity and lifecycle
  contract for bytes already addressable as ordinary files.
- Scan references before cleanup: the folder cannot enumerate all link forms,
  external documents, or historical referrers and infer ownership from them.
