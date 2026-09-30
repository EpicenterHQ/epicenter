# 0463. A data folder exposes a generated root SQLite index

- **Status:** Proposed
- **Date:** 2026-09-30
- **Relates:** [ADR-0456](0456-a-markdown-row-owns-at-most-one-same-stem-attachment.md) defines attachment ownership; [ADR-0436](0436-stores-own-local-sqlite-namespaces.md) defines current private SQL namespaces.
- **Unbuilt:** the root query-index generator and complete public folder publication.

## Context

A folder of Markdown rows and same-stem attachments is readable and editable,
but querying a large collection requires parsing its files. SQLite lets ordinary
SQL tools query those rows. Moving their bytes into a separate flat blob
namespace would discard the visible ownership the files already provide.

Private application databases live in runtime-managed storage. A query file
handed to a person or published for readers describes the enclosing folder
and can be rebuilt from it.

## Decision

**A queryable data folder exposes one generated `index.sqlite3` at its root.**
The folder retains table directories, Markdown rows, optional same-stem
attachments, and root `kv.json` where present. SQLite projects the folder's
interpreted rows and settings. Generating an index is optional; no database is
required to open or recover the source files.

```text
so.epicenter.whispering/
  index.sqlite3
  kv.json
  recordings/
    r123.md
    r123.opus
    r456.md
```

The index is a read surface. Direct SQL writes do not edit Markdown, change
attachment ownership, or establish a second saved source. An old index may
describe an earlier snapshot and must not be presented as proof of the current
files. This record requires no continuous watcher or background refresh. Failed
generation preserves source and does not publish a partially replaced index.

**Attachments remain under the table and row that own them.** Folder readers
discover the same-stem sibling. A generated SQL projection may expose observed
attachment paths for readers without directory enumeration; these values are
derived from files and are never required authored frontmatter. An exposed
path is relative to the folder containing `index.sqlite3`. SQL returns it as
text; a filesystem or HTTP reader resolves and reads the bytes. The detailed
SQL schema and column names remain a separate decision.

**A complete public publication contains selected public files, their owned
attachments, and an index generated from that selected folder.** The publicizer
removes private fields and private body material before indexing. Selection and
redaction happen before generation; query filters cannot protect private values
inside a downloadable database.
It preserves table-relative paths and either includes referenced dependencies
within the published file set or reports unresolved external references. A
complete-media promise requires the dependency bytes.

Publication builds and verifies one consistent file set before making it live.
The selected copy must account for concurrent source changes. Separately copying
a live database and arbitrary media files does not establish a consistent
publication. The downloadable database is a completed snapshot that opens
without WAL or journal companions. Packaging and the exact publication switch
mechanism remain separate implementation decisions.

Private transactional databases and runtime-managed SQL caches retain their
separate lifetimes and locations. The root index and its SQLite companions
never participate in authoritative data-folder synchronization. Synchronizing
or copying source permits rebuilding the index at the destination.

## Consequences

- Files and SQL describe the same table and row organization without a second
  blob identity. A generated index remains optional and rebuildable.
- Copying only `index.sqlite3` copies queryable values and media locators, not
  attachment bytes. A complete folder copy includes owned media.
- The index duplicates potentially sensitive text and metadata. A public index
  must be built from the public file set after the visibility transformation.
- Missing or ambiguous attachments cannot be repaired by a path column. Source
  validation and complete-publication checks own those refusals.
- Hosting a SQLite download does not itself supply a browser SQL interface.
  A query service or client-side SQLite reader is a separate consumer.

## Considered alternatives

- Call the file `data.sqlite3`. The name obscures which representation owns
  saved edits. `index.sqlite3` states its rebuildable query role.
- Reuse `epicenter.sqlite3`. Earlier records used that name for an internal
  synchronization ledger rather than this external query surface.
- Move attachments into a generic `blobs/` directory on publication. This adds
  path remapping and hides their existing table and row ownership.
- Embed every attachment in SQLite. Large media no longer remains directly
  available to ordinary file and HTTP readers.
- Require authored attachment path or extension fields. The file set already
  supplies that information; the query surface can expose it when needed.
