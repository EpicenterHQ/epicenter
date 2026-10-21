# 0548. A view is a cache of files, with one write path, one read path, and one channel of change

- **Status:** Accepted
- **Date:** 2026-10-15
- **Amended by:** [ADR-0656](0656-a-folder-owns-typed-input-from-open-to-close.md) (Proposed): the folder holds typed input from open to close, so no page draft or app queue holds it; one write path, one read path and one channel of change remain.
- **Amended by:** [ADR-0654](0654-visible-folder-queries-refresh-without-native-watchers.md): visible queries discover outside edits through bounded polling; native file watchers and the wake clock are removed. The built inventory below records the earlier implementation.
- **Amended by:** [ADR-0554](0554-a-field-edit-sets-fields-on-the-file-as-it-is-now.md): a field edit sets fields on the file as it is now, as an `UPDATE` does; only document editors keep a starting version.
- **Amended by:** [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md): every write to a file, and Sync's settling, goes through one merge by the file's kind; taking a side of a text unit keeps the other side's lines that did not compete.
- **Amended by:** [ADR-0553](0553-a-pages-own-writes-keep-its-folder-cache-in-step-and-folder-queries-carry-their-read-policy.md): a page's own writes mark stale what a change to their paths would, and folder queries carry their read policy.
- **Amended by:** [ADR-0583](0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md) at "the app's own for `openFolder`, the folder's declaration for `openDataFolder`": the app's own in the folder named after the app, the folder's declaration in any other.
- **Built:** the desktop file watcher: one per granted root in `tauri-plugin-epicenter-folder` (`src/watcher.rs`), from the first grant until shutdown, debounced 50 ms, emitting the Tauri event `epicenter-folder://changed` with `{ scope, paths }` to the scope's permitted windows; `paths` is folder-relative, `.git` for history moving, or `null` for everything (see the plugin's README); `table.save` with the merge in the engine, its result naming each replaced value and where it stands; the line merge that keeps neighboring edits, for save and Sync alike; `folder.onFilesChanged` with the browser's relay and resume detector and the desktop page's listener for the shell's event; repository creation by the first commit, staging, or remote on every host; `folderOptions` and `createDraft` in `@epicenter/folder/query`, with writes that keep the cache in step themselves, `files.text`, `folder$.query` for a page's own query over named paths, `runMutation`, and `whenIdle`, and `createDraftState` in `@epicenter/folder/svelte`, whose `onSaved` is handed the save that restores theirs (the row draft and `createDraftState` since removed by ADR-0554, which keeps `createTextDraft` and adds `createBodyDraftState` for documents); Todos, Capture, Honeycrisp, Whispering, and Vocab on `folderOptions` and drafts, and the Git lab on `folder.onFilesChanged`, with their own focus rereads gone; the Folders window's notice naming each value a save replaced, with "Restore theirs".

- **Current edit implementation:** [ADR-0666](0666-one-source-draft-per-path-saves-against-its-observed-source.md) describes the implemented whole-source draft behavior; its decision remains Proposed. `FileEdit` commands change one pinned source in call order; storage matching neither its observed source nor its draft causes a whole-file `Conflict` rather than a field or body merge. Direct `files.write`, `tables.<name>.set`, and Git sync retain their content merge rules. The earlier draft-merge descriptions below record the prior model.

## Context

A desktop demo run on 2026-10-15 found that an edit made in the Folders window
did not appear in the open Todos window until Todos tried to save. Freshness ran
three ways, differently in each app: a `BroadcastChannel` relay between pages,
which does not reach separate Tauri windows; TanStack Query's focus refetch,
which listens to `visibilitychange` and so never fires between two desktop
windows that stay on screen; and per-app rereads on focus or visibility. A
refresh in the Folders grid also replaced the version an edit had started from,
so its save skipped the merge. The merge itself lived only in the Folders
window's `save-row.ts`; every other app received a
bare `Conflict` from `table.replace`.

## Decision

**Files are the truth.** No cache, event, or window state is authoritative.

**One write path: `save`.** A folder table's `replace(capture, row)` is renamed
`save(capture, row)` and merges inside the engine: if the file is still the
version `capture` names, it writes; otherwise it reads the current file, merges
by field and the body by line (`mergeRow`), writes the result against the current
version, and reports what of the other side it replaced.

**Save and Sync are the same merge.** Changes that do not overlap always
combine. An overlap is decided by fresh intent when there is some, and by a
person when there is none:

| | Overlap means | Decided by |
| --- | --- | --- |
| `save` | both sides changed the same field, or the same line of the body | the saver: the edit wins, the replaced value is named in the result, and the app offers "Restore theirs" until the notice is dismissed, since the other side may be committed nowhere |
| Sync | the same | the person, in the review; Sync never asks about files that merely differ |

Lines compete only when both sides changed the same line; edits to adjacent
lines are both kept. No clock breaks a tie: device clocks drift, and offline
edits are concurrent. Every merged row is validated against the definition the
handle reads with (the app's own for `openFolder`, the folder's declaration for
`openDataFolder`) before it is written, and an invalid result writes nothing;
invariants across fields belong in the declaration, because agents write files
directly. Every app, script, and
agent saves the same way. The strict compare-and-swap is the engine's internal
step.

**One read path.** Data reaches a view only through the engine's reads
(`table.get`, `table.list`, and their `files` and `kv` counterparts), which
parse and validate the file. No event carries content.

**One channel of change: `folder.onFilesChanged(paths)`.** Anything that is
evidence files may have changed reports the paths, or "everything", on this
channel, and the affected cache entries become stale. Nothing persists the
events: the files are the record, so a missed event costs a delay, never data.

**Each host has exactly one detector of changes made outside the page.**

| Host | Detector | Reports |
| --- | --- | --- |
| Desktop | The shell's file watcher on the granted root, debounced | Exact paths; "everything" when it starts, after the computer wakes, and when the operating system reports it dropped events; inside `.git`, only that history moved |
| Browser | The `BroadcastChannel` posts of same-origin tabs, which are the only writers of a browser folder, its own Sync included | Exact paths after each write lands; "everything" when a tab resumes from being frozen or restored from the back-forward cache |
| Bun | None by default; a script may watch with `fs.watch` | — |

A page's own `save` updates its cache directly and is not evidence of an
outside change, so it is not reported to that page. The files the page's own
Sync wrote are reported to it on every host. On the desktop the watcher also
sees the page's own writes and Sync's; at most this rereads a file whose
content did not change.

**Pages read folders through TanStack Query, by option factories.**
`folderOptions(folder)` in `@epicenter/folder/query` mirrors the folder, and each
operation exposes `.queryOptions()` or `.mutationOptions()` by what it is:

```ts
const folder$ = folderOptions(folder);
createQuery(() => folder$.todos.list.queryOptions());
createQuery(() => folder$.todos.get.queryOptions('abc'));
createMutation(() => folder$.todos.save.mutationOptions());
```

| Area | Operations |
| --- | --- |
| each table | `list`, `get`, `create`, `save`, `rename`, `delete` |
| `kv` | `get`, `set` |
| `files` | `list`, `read`, `write`, `move`, `delete` |
| `history` | `status`, `log`, `saveVersion`, `sync` |

The factory never holds the query client. The app's root wires the channel to
the cache in one line, so invalidation stays visible:

```ts
folder.onFilesChanged((paths) => queryClient.invalidateQueries(folder$.pathFilter(paths)));
```

No page has its own refresh logic, and TanStack's own focus refetch is off.

**An edit holds its own starting version.** An editor captures the row and its
version at the first change, not on focus, and keeps its draft outside the
cache. A refetch updates the cache, never the draft; `save` uses the starting
version. "Changed elsewhere; your edit will be merged" shows when the cache's
version differs from the draft's, derived, with no state of its own.

## Consequences

- Deleted: each app's focus and visibility rereads; the Folders window's merge in
  `save-row.ts`, now the engine's `save`, and its
  row-edit bookkeeping, replaced by the shared draft helper. The
  `BroadcastChannel` relay stays as the browser's detector; the desktop page
  no longer opens one.
- An agent's edit, Sync landing a change, or another window's save appears in an
  open desktop window within the watcher's debounce.
- A browser tab sees another tab's edits live. A tab that crashes after writing but before posting leaves other open tabs stale until they resume or reload; saves still merge, so nothing is lost.
- The desktop shell holds one watcher per granted folder.
- `save` cannot fail because another writer moved the file; it fails when the
  row was deleted, the merged values are invalid, or the file kept changing past
  its retries.

## Considered alternatives

- **Returning to the window as the browser's detector.** Coarse and late; the tabs' own posts are complete, because only same-origin tabs can write a browser folder.
- **Rereading on return only, on every host.** The window being looked at stays
  stale while an agent or Sync changes its files.
- **Returning to the window as the browser's detector.** Two tabs on screen
  side by side never hear each other, and every return rereads everything.
  Same-origin pages are the only writers of a browser folder's private
  storage, so their own reports of exact paths cover every change, and a
  resume covers the time a frozen page could not hear.
- **The shell announcing its own writes.** Misses agents, editors, and `git`
  in a terminal, which write without the shell.
- **Events that carry content.** A second way for data to reach a view, with no
  validation.
- **A watcher with return-to-window as a floor on the desktop.** Two detectors
  for one job; the watcher reports "everything" for its own gaps instead.
- **`bindFolderQueries(folder, queryClient)`.** A binding owns the wiring and
  must re-expose every TanStack feature; option factories compose with TanStack
  as tRPC's `queryOptions` and `mutationOptions` do.
- **Keeping `replace` with the merge in each app.** Every app writes its own
  merge, or does not merge at all.
