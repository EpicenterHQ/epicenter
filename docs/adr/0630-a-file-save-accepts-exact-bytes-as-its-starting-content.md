# 0630. A file save accepts exact bytes as its starting content

- **Status:** Proposed
- **Date:** 2026-10-19
- **Amends:** [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) at `Files.write` and `Files.delete` taking `from: string | null`, at `from: null` as a deliberate overwrite, and at the failures of a non-text row deletion.
- **Relates:** [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) (writes remain text only).
- **Unbuilt:** reconciliation of this proposal's text-only changed-content restriction with the implemented byte-write contract. Exact-byte starting content is implemented in browser, Bun, and Tauri; see the current [Folder contract](../../packages/folder/README.md#saving).

## Context

`files.read` returns a Blob, which can contain ordinary Git's binary data or
text with a leading byte-order mark. Decoding it with `Blob.text()` strips
that mark. A string alone therefore cannot always carry the exact source
the caller read. Deletion would treat an unchanged file as a concurrent edit.
A binary row's empty `text` cannot witness its original bytes either.

## Decision

**`Files.write` and `Files.delete` take `from: string | Uint8Array | null`.**
The changed content of `write` remains text. A caller can use
`new Uint8Array(await file.content.arrayBuffer())` as the exact base,
including when deleting a binary file ordinary Git supplied.

The library copies a mutable byte base once at operation entry and uses that
copy through retries. It compares original bytes before text decoding.
`Table.delete` given a row with a not-text issue returns `NotText`; the app
can use `files` with the file's exact bytes instead.

`from: null` witnesses absence. Concurrent creations still follow the normal
field and text-region merge, including insertion union. It is not an
unconditional whole-file replacement. To replace existing text, pass the
source that was read as `from` and the replacement as `text`.

## Consequences

Binary writes remain absent. Reads still return one Blob without a second
text representation. Byte-order marks and non-UTF-8 content can participate
in an exact deletion witness without a stored per-edit base or new history.
