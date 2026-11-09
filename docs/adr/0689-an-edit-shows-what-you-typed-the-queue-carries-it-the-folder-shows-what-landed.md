# 0689. An edit shows what you typed; the queue carries it; the folder shows what landed

- **Status:** Rejected
- **Date:** 2026-10-26
- **Rejected:** 2026-11-01, in favor of [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md): a contract client saves conditionally against the version it read, never unconditionally. A same-field `Conflict` keeps the typed text for retry (overwrite) or discard (take theirs); a change to different fields is carried over. The Folder engine (`openFolder`, `<OpenFolder>`, `svelteFolder`) that implemented this record had no caller left and was deleted.
- **Supersedes:** [ADR-0688](0688-one-folder-owned-text-document-per-path.md), [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md), [ADR-0664](0664-folder-close-drains-admitted-work-through-one-owner.md), [ADR-0657](0657-departure-prompts-only-for-pending-folder-saves.md), [ADR-0656](0656-a-folder-owns-typed-input-from-open-to-close.md), [ADR-0654](0654-visible-folder-queries-refresh-without-native-watchers.md), [ADR-0553](0553-a-pages-own-writes-keep-its-folder-cache-in-step-and-folder-queries-carry-their-read-policy.md), and [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md) at their Folder and page-editing decisions.
- **Amends:** [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) at local writes; Git sync still merges and uses conditional storage. [ADR-0663](0663-one-native-question-before-a-window-or-epicenter-leaves.md) at window Close; the shell-owned application Quit alert remains.
- **Unbuilt:** None. The Folder and Svelte APIs that implemented it are deleted.

## Context

A folder-owned working document previously held both saved source and typed
input. Its per-path edit lane, save status, and page query cache made a saved
row and unsaved input look like one value with several states. A caller had to
know which state it observed and which save promise acknowledged it. The
native Close prompt could dismiss typed input. Most editors already needed a
local value to keep text visible while a save was in flight.

The folder engines can read all listed text files at open and expose one
reactive mirror. A serial queue can compose structured updates against the
file as it stands when the write runs. Svelte can hold each editor's typed
value until the corresponding write answers.

## Decision

**An edit shows what you typed; the queue carries it; the Folder shows what landed.**
`files()` and table rows show what was last read or landed, never pending
input. A Svelte text editor uses one `edit(source, save)` per mounted editor.
Each typed value enters the Folder queue immediately. The edit shows that
value until its save answers. A failed value stays visible with Save again,
Discard, and Copy while the editor is mounted; leaving discards it. The page
never holds unsent text. How often the queue touches storage belongs to the
queue. An editor can await `edit.landed()` when its next action needs the
newest typed value to have landed; that answer is an error if its write failed.
The edit calls `save(value)` for every typed value. A retry resends the
failed value. `fileEdit` converts its LF text to the current file's newline
style and uses `replace` so a deleted file is not recreated.

**Every local write enters one serial queue and answers after the Folder shows
its result.** Waiting whole-file writes of the same kind keep the newest
data, and waiting updates through the same schema combine their patches.
`update` reads the file as storage holds it at its turn, applies the patch,
and puts only if the file still holds the bytes it read. On a conflict it
rereads and reapplies for up to three checked attempts, then answers
`KeptChanging` instead of writing unchecked. `write` creates or replaces a
whole file. `replace` writes only if the file exists at its turn and refuses
a deletion before its checked put with `NothingToUpdate`. A field, body, or
whole-file write sets its unit at its queue turn; the later write wins on that
unit. `create` expects an absent path. A stale reply that reads back the bytes
it tried to create counts as landed; identical existing content is
indistinguishable from that case. `delete` is unconditional.
`move(from, to)` reads the source at its queue turn, creates the destination
only if absent, then removes the source. If removal fails, both paths remain
and the error names both. A write's `Saved` promise returns after storage and
the Folder agree, or returns its `WriteError`. An outside writer can still land
a later whole-file replacement. A watcher hint naming a file already held by
the Folder rereads that file without relisting; unknown or unnamed hints
relist the Folder.

**Composition.** Files are the only durable authority. A collaboration layer (for example a Yjs document) is a session over text units only, the body, and persists through Folder instructions like any editor. Fields are never collaborative; they stay last-write-wins per field. No layer writes files except through the Folder. Agents may write files directly or issue the same Folder instructions through Epicenter; either way their changes reach editors through the Folder copy.

**Closing drains admitted writes before releasing storage.** The Folder
refuses new writes, drains its queue, and releases its host. `idle()` waits for
everything queued, including typed values that entered immediately.

**Leaving asks once, only when the page is unsure.** The page speaks the web's
own `beforeunload` protocol: `<OpenFolder>` is unsure while a write is out. A browser tab
shows its "Leave site?" question. A desktop window, whose webview never runs
`beforeunload`, can wait instead: its one close guard waits for `folder.idle()`
and closes. The page shows
"Saving…" meanwhile; closing again while it waits asks whether to close
anyway, so a save that never answers cannot trap the window. Text whose save failed stays on screen
with its error while the editor is open; leaving discards it without asking. The shell-owned
application Quit alert still applies. There is no folder status object, working document,
`settle`, Folder checkpoint, or global failure toast.
Git synchronization retains its own three-way merge, checkpoints, and
conditional storage publication.

## Consequences

A list and an editor can read the same landed row without sharing pending
input. An app awaiting `Saved` or a successful `edit.landed()` can read the
landed value immediately. A failed put leaves the last read value in the
Folder; a failed edit retains the typed input in its component until it
unmounts. Same-region overlapping writes can still lose the older change.
Leaving after a failed save loses that failed text. Crash recovery cannot
recover an edit that never landed. Checked updates preserve outside field
changes that arrive between read and put; after repeated contention the edit
keeps its typed value and shows the refusal. One serial queue orders unrelated
file writes too, trading concurrency for a single understandable publication
order.

## Considered alternatives

Keeping a folder-owned working document would retain shared input and status
machinery after the UI already owns each text control. Per-path queues would
allow unrelated writes to overlap, but would make the order of a structured
update and a whole-file write depend on timing across paths. Prompting on
every window Close would interrupt a write the queue can drain. A custom
close event or a registry of drafts would duplicate the queue's knowledge of
outstanding writes.
