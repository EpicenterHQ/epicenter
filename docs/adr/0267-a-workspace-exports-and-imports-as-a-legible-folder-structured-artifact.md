# 0267. A workspace exports and imports as a legible folder-structured artifact

- **Status:** Accepted
- **Date:** 2026-08-26
- **Supersedes:** [ADR-0167](0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut.md) at the artifact representation: rich documents are legible text files through their codec, not binary `document_update_v2` updates embedded in SQLite.
- **Amends:** [ADR-0256](0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md) and [ADR-0255](0255-data-definitions-use-one-data-first-public-vocabulary.md) at the deferred Compact-workspace action: the manual reset is no longer deferred, it is this export and import.
- **Amended by:** [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) at the artifact layout: `tables/<table>.json` and `documents/<table>/<row>.<ext>` collapse into one Markdown file per row with frontmatter fields, and export saves before it reads.
- **Amended by:** [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) at who produces the artifact. It is rendered continuously to `~/Epicenter` rather than assembled on demand, so "a directory, zipped for download" is withdrawn and export stops being a verb a person invokes. The artifact's shape is unchanged.
- **Amended by:** [ADR-0272](0272-restore-replaces-a-workspace-from-an-artifact-under-a-new-document-identity.md) at the unbuilt import half: it is named `restore`, it takes a destination rather than putting an artifact back where it came from, and the authority operation it needed is specified there.
- **Relates:** [ADR-0264](0264-a-table-declares-its-row-documents-derivation-and-file-codec.md) (the `file` codec this renders through), [ADR-0248](0248-a-row-owns-an-independent-yjs-document-at-a-derived-address.md) (the derived address the layout mirrors), [ADR-0257](0257-the-application-document-has-named-kv-and-table-roots.md) (the roots the layout mirrors), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) (the client owns its store)
- **Built:** the artifact, both directions as pure functions. `packages/app/src/data/artifact/` assembles the files from `data.stored()` and the `file` codecs, and reads them back into one envelope through the same codecs; `@epicenter/data/artifact` publishes both, and the round trip is tested end to end through real stores.
- **Unbuilt:** the replace-in-place half of import. Nothing yet takes the envelope and destroys a workspace with it: a device document has no door for foreign bytes at all, and an account replica adopting one would merge into its authority's document rather than replace it, which needs an authority verb that does not exist.

## Context

ADR-0256 and ADR-0255 deferred a Compact-workspace reset until measured storage pressure justified it, and ADR-0167 specified a portable export as SQLite `rows`/`values` with each document embedded as an opaque binary Yjs `document_update_v2` update. This redesign has a different motivation than storage pressure and a different value: a person wants their data as legible, editable files they can read, diff, back up, and re-upload, and prefers legibility over lossless CRDT fidelity. ADR-0264 supplied the missing piece both prior records lacked, an application-owned document codec.

## Decision

A workspace exports as a folder-structured artifact and imports by replacing the workspace in place. The artifact is a directory, zipped for download:

```txt
kv.json                                the kv root's stored values
tables/<table>.json                    one file per table, rows by id
documents/<table>/<row>.<ext>          each row document through its file codec
```

JSON rather than SQLite: the scalar rows are the truth, and a SQLite projection
is a disposable query surface rebuilt from them (ADR-0026, ADR-0213). SQLite is
about 25% smaller uncompressed, because it stores each column name once, but
that repetition is what the ZIP's DEFLATE eats, so the gap mostly closes inside
the archive, and the rows are the small half of an artifact whose bulk is
document prose. What it would cost is the premise: you cannot open a `.sqlite`
in a text editor, fix a field, and re-import it.

One file per table rather than one `tables.json`, for the same reason there is
one file per document: the path is already doing the addressing, and two
exports of the same workspace diff per table and per note instead of as one
enormous hunk. One file per document, not per root: a `file` codec serializes
the whole document to one string.

Every scalar comes from `data.stored()`, never from a table handle. A table
handle reads through the declaration and narrows to the fields it names, so a
value an older release wrote is unreachable through both of its arms: the row
still conforms, so it is not reported as nonconforming, and `conforming` never
carried it. Exporting through the lens would drop that value from healthy rows
silently, which is the one thing a backup may not do. The lens stays correct
for the SQL projection, which is a disposable index; the rule is that a
disposable derivation may narrow and a durable artifact may not.

Export fails closed. A document whose stored chain cannot be read abandons the
whole artifact rather than omitting one file, because the artifact is the input
to an import that replaces the workspace: a body quietly missing here is a body
deleted on every device.

Export serializes each row document through its application-declared `file` codec (ADR-0264) to a legible text file at its derived address (ADR-0248). Import deserializes each file back into a document, rebuilds one envelope, and replaces the workspace's documents in place under a fresh document identity, the replace-not-merge semantics of the reset path: a stale replica supersedes rather than merges. The export is intentionally lossy, carrying current visible state rather than Yjs identity or history, because import re-mints identity. It is a manual, application-owned escape hatch with an explicit loss boundary for unsynchronized work, the shape ADR-0256 required of any Compact workspace.

The export runs client-side. The client owns its store (ADR-0227), so it serializes itself into the artifact and nothing is materialized by the host. A live, host-rendered `~/Epicenter` folder is a separate decision that reopens ADR-0226/0227 and is not part of this record.

## Consequences

- A person can read, diff, back up, and re-upload their data as JSON and markdown, without the application.
- The export is legible but lossy: re-import is a clean-break reset, not a history-preserving restore. Offline edits absent from the export, and all CRDT history, are discarded by import, the explicit loss boundary ADR-0256 demanded.
- ADR-0167's binary `document_update_v2` form is superseded. The multi-file `documents/` tree is the inventory 0167 refused; it is accepted here because the artifact's purpose is human legibility, not a minimal machine cut.
- Compact workspace is no longer deferred; it is this manual export and import.
- The artifact layout mirrors the persistence roots (ADR-0257): `kv.json` is the `kv` root, `tables/<table>.json` the `tables:` roots, `documents/` the independent row documents.
- The faithful read is one verb on the data (`stored()`), not a second read on every table handle. It enumerates the roots the document holds rather than the tables the declaration names, so a table ADR-0240 left waiting in the CRDT is in the artifact too.

## Considered alternatives

- **ADR-0167's binary embedded export.** Rejected here: lossless and opaque, it cannot be read or edited by a person, which is the whole motivation, and a reset does not need CRDT identity preserved.
- **Keep Compact workspace deferred (ADR-0256).** Rejected: the motivation is portability and a legible reset, present now, not the speculative storage pressure 0256 waited on.
- **Import that merges into a non-empty workspace.** Rejected: replace-in-place under a fresh identity is the reset; a merge reintroduces the same-identity hazard the supersession gate exists to prevent.
