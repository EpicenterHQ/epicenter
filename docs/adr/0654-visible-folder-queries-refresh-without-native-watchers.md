# 0654. Visible folder queries refresh without native watchers

- **Status:** Accepted
- **Date:** 2026-10-20
- **Amends:** [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md), external-change detection and UI refresh policy.

## Context

Standalone and hosted pages already read files through their own folder context
and QueryClient. Native filesystem watchers added another lifecycle: shared root
membership, debounce workers, event targeting, listener readiness, and a wall-clock
thread to compensate for missed events after sleep. These resources only told
cached readers when to read again. Saves protect their starting bytes independently.

## Decision

The shared TypeScript folder context owns one visible-page poll. QueryClient
selects active queries below `['folder']` and joins reads already running, with
`cancelRefetch: false`. Each context has its own QueryClient, so that prefix
selects one opened folder's cached reads. Polling starts no per-observer timer.
The context cancels its timer when close begins and schedules nothing after close.

A poll waits at least two seconds after its preceding batch completes. It also
waits nine times that batch's duration, limiting repeated polling reads to roughly
10% of elapsed time. This is a wall-time budget, not a CPU or byte-rate guarantee.
A first observer and visibility return read again immediately; an additional
observer shares the existing active query. Visibility means the
document's visibility state, not OS input focus. Visible side-by-side windows can
both refresh. A macOS Wry probe confirmed that a truly inactive native tab and
a minimized window report hidden, so both pause polling without a native adapter.

Own successful writes continue to report known paths. The context invalidates the
affected table; app file readers invalidate their exact file keys and listings.
An unknown change can invalidate the folder prefix. Committed-write refresh waits
for an older active read before invalidating without cancellation, so a draft is
released only after a read that includes its save. This avoids abandoning scans
whose underlying disk operations do not accept cancellation.

The native plugin keeps window-to-directory bindings and storage commands. It
starts no file watcher, debounce worker, wake clock, or file-change event channel.
Native `Folder.onChange` reports participating handles' saves inside one page or
Bun process; it does not promise notifications for arbitrary external programs.
Direct reads always reach storage. Browser handle notifications remain intact.

## Consequences

Outside edits appear on the next visible read, with longer delays for expensive
folders. A macOS debug Wry probe over real plugin IPC and roughly 1 KB Markdown
files measured 1,000-file scans at 0.43 to 0.58 seconds and 10,000-file scans at
3.48 to 5.03 seconds. These are warm local-machine observations, not portable limits.
The latter imply roughly 35 to 50 seconds between periodic scan starts. Explicit
refresh, mounting a reader, visibility return, and own writes do not wait for the
poll timer. The repeatable Bun read benchmark is
`packages/folder/src/__benchmarks__/folder-reads.bench.ts`.

Polling rereads contents even when unchanged. It trades read work and finite
freshness latency for removing native notification resources. A future stat-based
change detector would add a metadata snapshot, comparison rules, and another
observation contract; it is not part of this decision.

Drafts remain outside query data. Refresh must keep both pending and failed input
visible and copyable when a saved file changes, disappears, becomes binary, or
cannot be read. Window close continues to drain saves and refuse loss of unsaved
input. File save merging and native permission boundaries are unchanged.
