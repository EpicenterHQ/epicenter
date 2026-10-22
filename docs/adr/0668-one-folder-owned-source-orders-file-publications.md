# 0668. One Folder-owned source orders file publications

- **Status:** Accepted
- **Date:** 2026-10-22
- **Supersedes:** [ADR-0666](0666-one-source-draft-per-path-saves-against-its-observed-source.md), guarded editor saves, and [ADR-0667](0667-a-file-edits-ready-buffer-contains-its-unsaved-state.md), the nested editor state contract.
- **Amends:** [ADR-0656](0656-a-folder-owns-typed-input-from-open-to-close.md) at retained source, save feedback, and acknowledgement, and [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) at local file publication. Git synchronization keeps its merge behavior.
- **Implementation:** Commit `bd78bfb52b` implements the retained-source model. The decision retains that API and last-write-wins behavior, with passive aggregate save indicators and caller-owned input feedback.
- **Historical proposals:** [ADR-0662](0662-one-path-edit-exposes-text-and-structured-changes-through-one-interface.md) records the earlier common editor API; [ADR-0666](0666-one-source-draft-per-path-saves-against-its-observed-source.md) records the guarded-source save model it replaced.

## Context

The guarded-source model retained exact input but required an observed storage
base, conflict witnesses, resolution commands, and a second lifecycle nested
inside readable text. Direct writes still used a different merge contract.
An app had to distinguish those paths while coordinating controls, publication,
and storage observations for the same file.

The replacement keeps the useful owner: one retained source per path for the
Folder's lifetime. Schema-specific editors interpret that source. Local
commands publish through one ordered path lane, with a deliberately smaller
promise about concurrent writers.

## Decision

**The Folder owns one retained source and one command lane per path.** File
and table editors of that path share accepted input and publication order.
Binding a schema adds an interpretation, not another document or save owner.
Unmounting a view cancels no accepted work and forgets no source.

Editor saves, direct file writes, table sets, and deletes enter the same lane
in call order within a handle. Different paths may proceed independently.
A table set composes its fields and body over the held or known source at the
call; when none is known, it acquires the file inside the lane before composing.
It publishes the resulting whole source. A schema interprets content and reports
issues; it does not add a storage comparison base.

**Local publication is unconditional, whole-file last-write-wins.** A write
names no prior source. Another handle or outside program can change the file,
and the next local publication may replace that change without a conflict.
There is no edit-save merge, guarded retry, or conflict-resolution command.
Git synchronization still reconciles repository histories through its existing
merge rules; it is not the local publication contract. Browser tree-publication
retries and native path/text validation still protect storage consistency,
without preserving an outside version of this file against the next write.

**The editor exposes content and independent load and save facts.** Vanilla
code reads the immutable, cached `getSnapshot()`: `content`, `loadError`,
`isDirty`, `isSaving`, and `saveError`. `content` contains exact text, fields,
body, and schema diagnostics. Once text is acquired, it remains available
through deletion, binary replacement, and failed reads, with `loadError`
reporting the latest applicable acquisition failure. A successful text
observation clears that error. Typing does not.

Acquiring an editor and reading its snapshot start no I/O. `subscribe` delivers
the current snapshot immediately, then new snapshots; the first subscription
reads when nothing is known or the file changed while unobserved. `refresh()`
explicitly reads after admitted path commands. Svelte tracks the snapshot's
properties; React observes the same owner. Neither adapter owns another source.
Folder aggregate save indicators observe metadata without subscribing to
editors. `savingPaths` lists queued or running writes and deletes, `unsaved`
lists unacknowledged input, and `failures` lists held failed input with no
retry in flight. The aggregate derives from the same path lanes and accepted
input; it owns no second queue. Svelte's context tracks this metadata without
reading content. Tracking any editor getter instead demands content.
Storage notifications are best-effort change hints, reconciled through targeted
reads; the editor does not need a polling loop or a read that writes.

`replaceText()` accepts complete text even before a read. `change()` patches
known text and refuses when the required fields or body boundary are unknown.
Invalid text, including NUL or an unpaired surrogate, refuses before acceptance.
The caller consumes the returned acceptance Result at the interaction boundary,
using inline feedback or the shared error toast. A refusal changes no source
and is neither a read failure nor a save failure. The Svelte adapter adds
tracking, not presentation messages or another error state.
Malformed Markdown remains repairable text; the common framing rule in
[ADR-0665](0665-a-markdown-file-without-frontmatter-has-empty-fields-and-a-body.md)
still interprets headerless files as empty fields and body text.

**Acknowledgement follows captured input identity.** `isDirty` means accepted
input no successful publication or delete has acknowledged; it is not computed
by comparing text with disk. A receipt clears only the input it captured, so
later typing survives an older save even when the strings happen to match.
`isSaving` covers queued and running text publications, independently of dirty
state. An editor save failure remains in `saveError` through typing and retry,
until success or explicit discard. Direct file writes and table sets return
their failures separately; they do not set the editor's `saveError`.

Autosave follows changed accepted input. Explicit `save()` publishes the exact
current text even when clean and returns that publication's outcome.
`discard()` drops unpublished input and its pending autosave, clears the save
failure, writes nothing, and cancels no admitted publication; an older failure
cannot reappear after discard. A successful delete acknowledges the input it
captured. Newer input can subsequently save and recreate the path.

## Consequences

The API no longer needs `getText()`, `getMarkdown()`, `getBuffer()`, pending
variants, storage read-status projections, editor locks, or `resolveConflict()`.
Controls use the retained content and show load and save feedback separately.
Saving does not make typing readonly. Workflow admission and orderly close
have their own Folder contract; this decision owns source publication.

The lower coordination cost comes with a real loss: independently changed
fields or paragraphs from another writer are not preserved automatically by
a local publication. Applications must not promise conflict detection or merge
recovery that this storage contract no longer provides. Local publication does
not itself create a Git commit, so an overwritten intermediate version is not
guaranteed recoverable from history.

Input rejection also withdraws the earlier promise to retain invalid strings
in the shared editor. A refused NUL or lone surrogate leaves the prior content
unchanged; a control must handle that refusal if it needs to keep the rejected
value visible or copyable. The Folder retains accepted input, not every raw
value a control attempted to submit.

Retained source and detached recoveries live in memory. They survive component
lifetimes, not process failure. This decision adds no crash recovery store or
cross-process transaction. Disk files remain authoritative persisted data;
the source is the Folder's current editing state, not an independent database.

## Considered alternatives

- **Keep whole-source guards and nested unsaved states.** This detects outside
  changes but retains comparison bases, conflict witnesses, resolution commands,
  and a second public state model.
- **Merge local field or paragraph intent.** This requires command history and
  witnesses across saves, and gives direct writes a different contract.
- **Accept invalid text in memory and reject only publication.** This keeps
  every raw input available for repair or copying, but adds an unsavable local
  state. The current implementation instead refuses it before acceptance.
- **Let each view own its text.** That duplicates saving and recovery and loses
  accepted input when a component goes away.

## Evidence

`packages/folder/src/edit-owner.ts` owns sources, snapshots, command lanes,
publication receipts, and recovery. `packages/folder/src/handle.ts` routes file
and table operations through it. `packages/folder/README.md` documents current
signatures. Framework adapters and application callers were migrated in
`bd78bfb52b`; source-based documentation review does not repeat native UI
acceptance.
