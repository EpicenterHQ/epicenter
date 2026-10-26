# 0689. A folder shows what landed; a draft holds what was typed until it lands

- **Status:** Proposed
- **Date:** 2026-10-26
- **Supersedes:** [ADR-0688](0688-one-folder-owned-text-document-per-path.md), [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md), [ADR-0664](0664-folder-close-drains-admitted-work-through-one-owner.md), [ADR-0657](0657-departure-prompts-only-for-pending-folder-saves.md), [ADR-0656](0656-a-folder-owns-typed-input-from-open-to-close.md), [ADR-0654](0654-visible-folder-queries-refresh-without-native-watchers.md), [ADR-0553](0553-a-pages-own-writes-keep-its-folder-cache-in-step-and-folder-queries-carry-their-read-policy.md), and [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md) at their Folder and page-editing decisions.
- **Amends:** [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) at local writes; Git sync still merges and uses conditional storage. [ADR-0663](0663-one-native-question-before-a-window-or-epicenter-leaves.md) at window Close; the shell-owned application Quit alert remains.
- **Unbuilt:** None. The Folder and Svelte APIs implement this proposal; acceptance remains open.

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

**A Folder mirrors landed storage, and each editor owns its typed draft.**
`files()` and table rows show what was last read or landed, never pending
input. A Svelte text editor uses one `draft(source, save)` per mounted editor.
Each typed value enters the Folder's queue immediately. The draft shows that
value until its save answers. A failed value stays visible with Save again,
Discard, and Copy while the editor is mounted; leaving discards it. The page
never holds unsent text. How often the queue touches storage belongs to the
queue.

**Every local write enters one serial queue and answers after the mirror shows
its result.** Waiting writes for one path merge even when unrelated turns sit
between them, provided that path has no intervening operation. `update` reads
the file as storage holds it at its turn, applies the patch, and puts only if
the file still holds the bytes it read. On a conflict it rereads and reapplies,
up to three checked attempts, then puts unconditionally. `create` expects an
absent path and answers `Exists` if another writer created it. Whole-file
`write` and `delete` remain last-write-wins. `move(from, to)` reads the source
at its queue turn, creates the destination only if absent, then removes the
source. If removal fails, both paths remain and the error names both. A
write's `Saved` promise returns after storage and the mirror agree, or returns
its `WriteError`. An outside writer can still land a later whole-file
replacement. A watcher hint naming a file
already held by the mirror rereads that file without relisting; unknown or
unnamed hints relist the folder.

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
input. An app awaiting `Saved` can read the landed value immediately. A failed
put leaves the last read value in the mirror; a failed text draft retains the
input in its own component until it unmounts. Crash recovery cannot recover a
draft that never landed. Checked updates preserve outside field changes that
arrive between read and put; after repeated contention the fourth attempt
accepts last-write-wins. One serial queue orders unrelated file writes too,
trading concurrency for a single understandable publication order.

## Considered alternatives

Keeping a folder-owned working document would retain shared input and status
machinery after the UI already owns each text control. Per-path queues would
allow unrelated writes to overlap, but would make the order of a structured
update and a whole-file write depend on timing across paths. Prompting on
every window Close would interrupt a write the queue can drain. A custom
close event or a registry of drafts would duplicate the queue's knowledge of
outstanding writes.
