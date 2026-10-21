# 0666. One source draft per path saves against its observed source

- **Status:** Proposed
- **Date:** 2026-10-21
- **Implementation:** `FileEdit` holds one exact source draft, source-only pending input, guarded source comparison and a whole-source conflict recovery action in both storage engines. The decision remains Proposed.

## Context

One `FileEdit` owns accepted input for a path. Forms call `change({ fields?,
body? })`; source views call `replaceText(text)`. The current owner retains
document-shaped and text-shaped pending input, field and body witnesses, and
handoff rules between them. It merges those intents with outside writers at
save time. This preserves many independent changes, but creates cases where
accepted input is absent from `getText()` and where the last local command
does not determine the local source. A named assignment equal to the displayed
value is especially difficult to distinguish from an intentional revert.

The product can instead let an outside edit pause a dirty save. The local
source remains available for comparison and recovery. This changes the
conflict frequency and requires a usable whole-source recovery interaction.

## Decision

**The path owner holds one exact source draft.** `change()` applies its named
field assignments and body replacement to the currently displayed source
when called. `replaceText(text)` replaces that source. Both commands either
produce a new source immediately or refuse without changing it. They are not
stored as different kinds of pending operations. Later local commands see the
source produced by earlier ones, in call order. Reading, view switching, and
subscription delivery do not change local input.

An assignment to the value already shown is a no-op. A body replacement or
source replacement that produces identical source is also a no-op. Before a
save begins, returning to the observed source clears the pending draft.
Once a save has submitted a source, its receipt acknowledges only that exact
submitted version; typing during the save remains visible and pending. A
later save uses the landed source as its comparison base.

**Every edit view reads the same source.** `getText()` returns the draft while
one is held, otherwise the latest known stored text. `getMarkdown()` is a pure
interpretation of that exact text through the view's bound schema. It never
inventories accepted fields outside the source. An invalid source retains its
exact text and diagnostics. A field change without interpretable fields, or a
body change without a known boundary, refuses synchronously. `replaceText()`
remains available for repair. With no opening frontmatter fence, the whole file is a
body with empty fields.

**Pending input is the unsaved source, independent of the view's schema.**
`getPending()` answers `undefined` when no source is held, otherwise the exact
draft text, path, saving state, and last save failure. Its text equals
`getText()` for that version. It has no document/text discriminator, field
patch, body patch, or framing policy. The core `FileEdit` keeps the explicit
`getPending()` read method. `createFileEdit(folder.tables.notes.edit(id))`
exposes the same value as a tracked Svelte `.pending` getter; its `.text` and
`.markdown` getters remain tracked projections. The adapter owns no draft.

**Saving compares whole source at the guarded storage attempt.** A save
submits the exact draft and the exact stored source it was based on. If the
current source still equals that base, storage writes the draft. If current
already equals the submitted draft, the attempt is satisfied without a write.
Otherwise the attempt reports a conflict and retains the draft, including
when the outside change is to an independent field or paragraph. The
comparison runs again on a guarded retry in both storage engines. A watcher
or read can update the known stored version, but it does not replace a dirty
draft or silently change its save base.

A conflict is resolved at whole-file scope. The user can keep the current
stored source, submit the held source as an explicit replacement, or edit a
resolution using both sources. The chosen resolution is guarded against the
current source shown to the user; another outside write before it lands
requires another comparison. The conflict UI can show base, held, and current
source. Field controls may help compose a resolution, but they do not require
a second field-level conflict protocol.

## Consequences

- Remove public `DocumentPending` and `TextPending`, internal document/text
  input variants, per-field and body merge witnesses, handoff logic, and
  required/optional framing carried in pending input. Submitted source and
  draft revision still need distinct identities so typing during a save is
  never cleared by an older receipt.
- An outside writer changing any byte can pause autosave. The exposure lasts
  for the whole dirty period, including debounce and continued typing; a
  subscription does not shorten it while the draft stays pinned. The
  application must expose the held source and a usable resolution path,
  including after close or a storage failure. An outside deletion or binary
  replacement is also a conflict, not an implicit request to recreate the file.
- A field assignment equal to the currently displayed value cannot claim
  precedence over a later outside assignment by itself. The outside change
  instead creates a whole-source conflict while another local change is held.
- Keep the existing content merge for Git sync and storage operations whose
  callers explicitly request it. Folder edit saves use source comparison;
  this decision does not silently change every repository writer.

## Considered alternatives

- **Keep named pending commands and automatic merge.** Independent outside
  changes usually save without interruption, but the owner must preserve
  command intent, witnesses, and handoffs that are not visible in source.
- **One source draft with automatic content merge.** This is smaller than
  named commands but can override a field whose local assignment was a no-op
  or infer intent from a textual diff that was never a user command.
- **Replace stored source unconditionally.** It removes the conflict path but
  can erase an outside writer's work without making that loss visible.
