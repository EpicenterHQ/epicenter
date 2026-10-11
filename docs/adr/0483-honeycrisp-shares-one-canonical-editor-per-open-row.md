# 0483. Honeycrisp shares one canonical editor per open row

- **Status:** Superseded
- **Superseded by:** [ADR-0523](0523-applications-own-drafts-in-edit-sessions-and-leave-one-open-item.md)
- **Date:** 2026-10-01

## Context

Honeycrisp's `file-session.svelte.ts` owned every open file's buffer, saved
capture, uncertain attempts and observations, and saved a note's structured
changes as source patches. Other apps implemented the same lifetime separately.
`folder.tables.<name>.edit(stem, { signal })` places those facts behind a
framework-neutral table editor, while selection, autosave and close policy stay
with the app. Vanilla DOM, Solid and Svelte 5 views share one such editor over a
persisted browser folder in `packages/folder/evidence/edit-handle/`.

## Decision

**Honeycrisp retains one folder-owned table editor for each open structured row.**
The production entry is `folder.tables.<name>.edit(stem, { signal })`.
`src/lib/row-session.svelte.ts` wraps each open note's editor; the title,
folder and pin controls, the rich-text view and the Markdown body view change
that one document. The editor owns local changes, save attempts, observations,
subscriptions and disposal. Its methods close over the editor, so a view can
destructure them. The app owns retention, selection, autosave timing and
native close fencing. A structured change to a row with no open note, such as a
pin from the list or a folder's name, opens that table's editor, changes the
fields, saves once and disposes it.

**One path has one owner: a row editor or a raw text session, never both.**
`src/lib/file-session.svelte.ts` remains the raw session for every other text
file and for a note the row editor cannot open. A raw session saves the exact
text conditionally on its capture. "Edit as file" disposes a settled note's
row editor and hands the path to a raw session; "Open as note" reopens the row
editor only when the saved text reads cleanly and its hash matches what the raw
session holds.

**A structured save publishes the complete canonical document through `overwrite`.**
Declared keys come first in declaration order, other keys follow in code-unit
order, every key is quoted, and every value uses JSON flow spelling. Unknown keys
and nested values remain. YAML comments, quoting, header line endings and prior
key order are not preserved. The body is kept byte for byte. A file whose only
difference is formatting opens clean, so opening or listing writes nothing.
`change` names declared fields only; editing unknown metadata is raw repair.
Local invalid fields remain visible, and `save()` refuses with `InvalidDocument`
until the document validates. A value with no canonical form is refused as
`Unrepresentable`.

The editor opens only a file with a canonical form whose declared fields
conform. `NoCanonicalForm` and `InvalidSource` carry the exact text and SHA-256,
and the file stays listed and opens in a raw session for exact source repair.
Arbitrary text files use raw file access, not an invented table schema. The rich-body serializer must represent every
admitted transaction; canonical frontmatter does not relax body validation or
erase unsupported text.

**Unknown publication remains historical evidence distinct from observation.**
A successful reply acknowledges submitted text and its capture. Typing during
that save remains dirty. An unconfirmed reply stays unconfirmed in `lastSave`;
a later read whose canonical content equals the draft makes the editor clean
without identifying its publisher. `adopt(reviewed)` takes the latest read only
while its canonical text is still the reviewed one, and otherwise returns
`Stale`. No observation cancels an outstanding command or becomes a successful
reply.

**The app owns autosave and close policy.**
Autosave subscribes to the retained editor and pauses after failed or unknown
outcomes. Views do not start competing timers. A native close fences input before
settling admitted work and presenting remaining drafts or unknown changes.
Only the page's response to the shell request approves closing. Explicit discard
can release a draft while preserving the unknown operation in history.

Rename and delete remain captured file operations. A row editor is fixed to
its path, so a confirmed rename opens a new editor at the destination and
carries the document, including typing during the move, into it. An unknown
path change needs inspection before renewed destructive work; it does not
require a permanent editor lock or a generic durable file-operation journal.

## Consequences

Apps share one editor engine; Capture, Todos, Vocab and Whispering edit their
rows through it too. Honeycrisp's note saves no longer patch source. Frontmatter formatting
changes on a structured save, so the app must disclose that behavior. A save is unconditional: a write
by another program that lands first is replaced, and a removed file is
recreated. Raw repair preserves access to files the structured editor cannot
open.

## Considered alternatives

- Preserve an app-owned editor engine: duplicates publication and lifetime rules.
- Preserve arbitrary YAML formatting in structured saves: requires source-patch
  machinery alongside the canonical document model.
- Convert a matching read into confirmed publication: claims a command outcome
  that an observation cannot establish.
