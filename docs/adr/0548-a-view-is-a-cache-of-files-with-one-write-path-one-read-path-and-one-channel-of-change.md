# 0548. A view is a cache of files, with one write path, one read path, and one channel of change

- **Status:** Proposed
- **Date:** 2026-10-15
- **Built:** `table.save` with the merge in the engine, its result naming each replaced value and where it stands; the line merge that keeps neighboring edits, for save and Sync alike; `folder.onFilesChanged` with the browser's relay and resume detector and the desktop page's listener for the shell's event; repository creation by the first commit, staging, or remote on every host; `folderOptions`, `createDraft`, and `createSaveBases` in `@epicenter/folder/query`.
- **Unbuilt:** the shell's file watcher that sends `epicenter-folder://changed`; moving every app onto `folderOptions` and drafts, which removes their own focus rereads and `createSaveBases`; the Folders window's UI for what a save replaced.

## Context

A desktop demo run on 2026-10-15 found that an edit made in the Folders window
did not appear in the open Todos window until Todos tried to save. Freshness ran
three ways, differently in each app: a `BroadcastChannel` relay between pages,
which does not reach separate Tauri windows; TanStack Query's focus refetch,
which listens to `visibilitychange` and so never fires between two desktop
windows that stay on screen; and per-app rereads on focus or visibility. A
refresh in the Folders grid also replaced the version an edit had started from,
so its save skipped the merge. The merge itself lived only in the Folders
window (`apps/epicenter/src/folders/save-row.ts`); every other app received a
bare `Conflict` from `table.replace`.

## Decision

**Files are the truth.** No cache, event, or window state is authoritative.

**One write path: `save`.** A folder table's `replace(capture, row)` is renamed
`save(capture, row)` and merges inside the engine: if the file is still the
version `capture` names, it writes; otherwise it reads the current file, merges
by field and the body by line (`mergeRow`, with the edit winning only where both
sides changed the same field or lines), writes the result against the current
version, and reports what of the other side it replaced, with where it stood,
so a person can put it back. Every app, script, and agent saves the same way.
The strict compare-and-swap is the engine's internal step. Changes that do not
overlap always combine: lines compete only where both sides changed the same
lines, for a save and for Sync. An overlap is decided by fresh intent when
there is one (a save) and by a person when there is not (a Sync). A merged row
is checked against the definition the handle reads with before it is
written.

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
| Browser | Other pages of the origin, which post the paths each write landed on a `BroadcastChannel`, their own Sync's included; and resuming from being frozen or from the back-forward cache | The paths; "everything" on resume |
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

The factory holds no query client. The app root wires the channel once, so
invalidation stays visible:
`folder.onFilesChanged((change) => queryClient.invalidateQueries(folder$.pathFilter(change)))`,
which marks stale exactly the queries the paths name. No page has its own
refresh logic, and TanStack's own focus refetch is off.

**An edit holds its own starting version.** An editor captures the row and its
version at the first change, not on focus, and keeps its draft outside the
cache. A refetch updates the cache, never the draft; `save` uses the starting
version. "Changed elsewhere; your edit will be merged" shows when the cache's
version differs from the draft's, derived, with no state of its own.

## Consequences

- Deleted: each app's focus and visibility rereads; the merge in
  `apps/epicenter/src/folders/save-row.ts`, now the engine's `save`, and its
  row-edit bookkeeping, replaced by the shared draft helper. The
  `BroadcastChannel` relay stays as the browser's detector; the desktop page
  no longer opens one.
- An agent's edit, Sync landing a change, or another window's save appears in an
  open desktop window within the watcher's debounce.
- A browser tab sees another tab's edits as they land, and everything again
  when it resumes from being frozen. A change from outside the browser's
  pages cannot happen to its private storage.
- The desktop shell holds one watcher per granted folder.
- `save` cannot fail because another writer moved the file; it fails when the
  row was deleted, the merged values are invalid, or the file kept changing past
  its retries.

## Considered alternatives

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
