# 0572. A row body is read and written with line feeds and storable text

- **Status:** Proposed
- **Date:** 2026-10-16
- **Relates:** [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) (one read and write pipeline), [ADR-0519](0519-row-frontmatter-is-yaml-every-common-reader-reads-identically.md) (every write reads its own text back), [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md), [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md)
- **Unbuilt:** `parseRow` converting body line endings to `\n`; `formatRow` writing `\n` and replacing unpaired surrogates; removing `lf`, and the `withFileNewlines` and `wellFormed` calls, from row editors in Todos, Honeycrisp, Capture, Vocab, and Whispering.

## Context

A `<textarea>` reports its value with `\n` line endings. A body read from a
file written with `\r\n` differs from the control's value, so each row editor
converts it for display and converts it back on save. Todos defines a local
`lf` and saves `notes.change(stored, withFileNewlines(wellFormed(typed), base.row.body))`
(`apps/todos/src/routes/components/TodoDetail.svelte`). `formatRow` refuses a
string with an unpaired surrogate, so every text setter also calls
`wellFormed`; Todos' title does too. Honeycrisp, Capture, Vocab, and Whispering
repeat the same calls. A missed `lf` makes the cursor jump, a missed
`withFileNewlines` rewrites a file's endings, and a missed `wellFormed` fails
the save.

## Decision

**`parseRow` returns a body with `\n` line endings, and `formatRow` writes
`\n`.** Every `\r\n` and lone `\r` in a body read from a row file becomes `\n`.
A row's merge (ADR-0551) therefore compares bodies with the same endings on
every side.

**`formatRow` replaces each unpaired surrogate in a string with U+FFFD before
it checks that its text reads back.** This applies to the body and to string
field values. It is the replacement UTF-8 encoding makes, so the stored text
is what an encoder would have produced.

A base's content (ADR-0551) stays the file's exact text, so a base still
hashes to its own `sha256`. Raw text through `files` keeps its bytes, and
`withFileNewlines` stays for `FileView` and the other raw-text editors.

## Consequences

- A file written with `\r\n` becomes `\n` on its next save from an app: one
  diff that touches every line, once.
- A lone surrogate shows on screen until its save lands, then shows as `�`,
  and the cursor may move once.
- Row editors pass the control's value as it is. `lf`, and the
  `withFileNewlines` and `wellFormed` calls in row setters, are deleted.
- A table still reads back what it writes: a body read after a write has `\n`
  endings either way.

## Considered alternatives

- **Recording each file's line ending in `StoredRow` and restoring it on
  write.** It keeps `\r\n` files intact, but adds a field to the contract for
  a convention most repositories already settle on `\n`.
- **Refusing unpaired surrogates, as now.** Every setter keeps repeating
  `wellFormed`, and a missed call is a failed save.
