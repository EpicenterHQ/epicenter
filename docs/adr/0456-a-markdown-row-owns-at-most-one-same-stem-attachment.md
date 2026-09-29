# 0456. A Markdown row owns at most one same-stem attachment

- **Status:** Accepted
- **Date:** 2026-09-29
- **Unbuilt:** flat Markdown and attachment pairs as authoritative files in browser and native applications.

## Context

The file-first direction places a document's Markdown and owned media in the same saved file set, but does not say which file owns which bytes. Whispering has one original audio file per recording. A visible filename relationship would let an application and a coding agent find that audio without an `audioBlobId`, an attachment registry, or a directory named `index.md` for every recording.

Documents with several images create a real cost for this simpler relationship. A rule that lets one row own an arbitrary number of files needs another way to name and enumerate them. This record chooses the smaller ownership unit.

## Decision

**A Markdown row owns zero or one sibling attachment with the same file stem.** Within a table directory, `<id>.md` is the row. If it has an attachment, that file is `<id>.<extension>` beside it, where the extension is one nonempty ASCII alphanumeric segment other than `md`, ignoring case. Split at the final dot: `r1.take.opus` belongs to `r1.take.md`, not `r1.md`.

```text
so.epicenter.whispering/
  recordings/
    r123.md
    r123.opus

so.epicenter.mail/
  savedQueries/
    q789.md
```

The data folder and table names above illustrate the rule; this record does not select a default root or require every row to have an attachment. The path supplies the row's identity and its attachment relationship. An app need not copy an attachment ID or filename into frontmatter to find it. Descriptive metadata may still record a title or original filename.

**An application creates and deletes the row and its one owned attachment together.** A link to another row's file does not transfer ownership. A document needing several assets links to other rows that own those assets. A Markdown file used as content is another row, not an opaque `.md` attachment beside this row.

Externally written files remain source even if they violate the convention. If a row has several same-stem attachment candidates, the app reports ambiguity and refuses an app deletion until that ambiguity is resolved. It does not choose one or delete the others. An attachment without its Markdown row is preserved; a missing row does not authorize automatic cleanup. An app refuses a new path that would collide on the destination filesystem rather than silently renaming or merging files.

This decision does not prescribe the browser's physical byte storage, save publication order, Git or LFS transport, sync, or export packaging. Those mechanisms must preserve these logical paths and include actual attachment bytes in a complete current-state copy.

## Consequences

- A recording's audio is discoverable from the recording path. The app no longer needs a separate application-facing blob ID or attachment inventory for that relationship.
- One row cannot own two audio formats, two images, or an attachment named `*.md`. Apps that need several assets create and link separate owning rows.
- Preserving a supplied attachment basename may require storing it as descriptive metadata. The stored sibling basename follows the row ID.
- Direct filesystem edits can leave missing or extra files. The app reports them without rewriting or sweeping source.

## Considered alternatives

- Give each row a directory containing `index.md` and any number of attachments. This preserves original names and direct multi-file ownership, but adds a directory and a choice of attachment names for every row.
- Keep attachments in an independent blob namespace referenced from frontmatter. This restores a second application-facing identity and makes ordinary file copies depend on that namespace.
