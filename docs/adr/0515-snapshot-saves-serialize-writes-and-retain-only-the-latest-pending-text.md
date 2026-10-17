# 0515. Snapshot saves serialize writes and retain only the latest pending text

- **Status:** Superseded
- **Superseded by:** [ADR-0528](0528-applications-edit-files-through-the-query-cache.md)
- **Date:** 2026-10-11
- **Relates:** [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) (what a session reads and writes), [ADR-0519](0519-row-frontmatter-is-yaml-every-common-reader-reads-identically.md) (the text each save writes), [ADR-0464](0464-file-table-updates-conditionally-replace-the-captured-whole-file.md) (conditional replacement without retry)
- **Unbuilt:** an automatic commit for a save a host reported `Unconfirmed` that a read then proved landed, and acceptance on a real storage host with a person editing.

## Context

The retained row editor (`table.edit`) owned a row's input, followed the
file's change hints, reloaded while clean, and handed drafts to a text editor
through `files.readDraft`. Applications wrapped it again to add fences,
release, and recovery, so a component that only wanted to save what a person
typed carried three owners of the same input.

A component already owns its draft. What it lacks is a way to submit saves
without a later save racing an earlier one, without a save result overwriting
newer typing, and without silently overwriting a change made elsewhere, such
as a Git pull that lands while the row is open.

## Decision

**The application owns the draft; the folder coordinates the saves it
explicitly requests.**

```ts
const saves = folder.tables.todos.autosave(stored, { onState });
saves.request(row); // formatted before it returns
await saves.settled(); // waits; starts nothing
```

An editing session starts from a capture: a `StoredRow`, an `InvalidRow`, or
any `{ path, sha256 }` of that row file. `files.autosave(capture)` is the
same session over raw content, for repairing a row as text.

- `request(value)` prepares an immutable snapshot synchronously, so a later
  edit cannot change an earlier request. One write runs at a time; requests
  made while it runs replace one pending snapshot, so intermediate drafts may
  never be written. `request` returns nothing: a coalesced request has no
  receipt of its own.
- Each write is guarded by the capture the previous write confirmed, starting
  from the session's capture. A change made elsewhere, or a deleted file, is
  `Conflict`; the other change stays, and nothing is recreated. The
  application decides what the person sees: reload theirs, or keep theirs by
  starting a new session from a fresh read and requesting the draft again.
- A table session writes only valid rows. A draft that fails the schema or
  cannot be written is that request's `InvalidValues` at once, drops the
  pending snapshot, and is never written; an older write that finishes later
  cannot report `saved` over it.
- `onState` reports the latest request: `saving`, `saved`, or the `error` that
  stopped it. Every state carries `file`, the capture the session last
  confirmed, so a rename or delete from the same view is guarded by the
  session's own save.
- Nothing retries; requesting again is the retry. Construction reads, writes,
  and reports nothing. Nothing is saved when a session ends unless it was
  requested, and a save result never assigns the draft.
- A host that loses its reply reports `Unconfirmed`. The session reads the
  file once: bytes that hash to what it sent are its own save, confirmed after
  all, so it never mistakes its own landed save for someone else's change.

There is no observation in a session. An application reads again when a view
opens, after its own actions, and when the person returns
([ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md)).

## Consequences

Applications lose their editor wrappers, release and fence logic, and the
draft handoff to Files; a form is a `$state` row and one `request` per edit.
The folder loses `editor.ts`, the Svelte adapter, `files.readDraft`, and the
hint-following reload machinery.

An open row does not show changes made elsewhere until it is read again. A
save after such a change is `Conflict` rather than an overwrite, so the
person sees the clash instead of losing the other change; the cost is a
conflict prompt in every editing view.

A session is bound to its path. After a rename, the application starts a new
session from the renamed capture.

## Considered alternatives

- **Unguarded existing-only replacement.** Simpler, and the first version
  shipped this way: a complete draft overwrote whatever the file held. A Git
  pull landing while a row was open was lost from the working copy with no
  signal, so the guard won.
- **Save schema-invalid drafts.** Lets a half-typed form persist, but every
  such row then reads back as `InvalidRow`, with no structured row to reopen
  in the form. Every table write reads back as a row instead.
- **A retained library editor that follows the file while clean.** Gives
  live updates, but makes the library a second owner of input with reload,
  adoption, and release rules every caller inherits.
- **Format later, from a queued mutable row.** A later edit could change an
  earlier request.
- **Save from a reactive effect.** Needs policies for the first render,
  reloads, and dependency tracking; explicit requests have none.
- **Retain every snapshot in a promise chain.** Writes obsolete drafts.
- **Parallel writes, or debounce alone.** Neither orders a running write
  against later input.

## Verification

<!-- doc-path-check: ignore-next-line -->
`packages/folder/src/autosave.test.ts` covers construction and waiting,
latest-pending coalescing, the guard chain, synchronous preparation,
preparation-failure precedence over an older write, the confirmed capture on
every state, terminal and reentrant observers, writer defects, schema-invalid
drafts never written, a change made elsewhere and a deleted row as
`Conflict`, and an `Unconfirmed` save that did and did not land.
