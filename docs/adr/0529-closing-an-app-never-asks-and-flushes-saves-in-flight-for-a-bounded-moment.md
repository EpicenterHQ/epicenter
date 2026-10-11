# 0529. Closing an app never asks and flushes saves in flight for a bounded moment

- **Status:** Proposed
- **Date:** 2026-10-11
- **Relates:** [ADR-0523](0523-applications-own-drafts-in-edit-sessions-and-leave-one-open-item.md) (the edit sessions and admissions a flush waits for), [ADR-0515](0515-snapshot-saves-serialize-writes-and-retain-only-the-latest-pending-text.md) (the held snapshot a flush sends), [ADR-0476](0476-whisperings-desktop-folder-uses-one-rust-library-in-both-tauri-shells.md) and [ADR-0461](0461-portable-data-folders-live-under-local-and-derived-account-scopes.md) (edited with this record: their quit prompts are withdrawn)
- **Unbuilt:** acceptance in the real desktop apps: Cmd-Q and window close while a save is running, in Epicenter, Honeycrisp, and Whispering.

## Context

Three desktop shells asked their pages before they quit. Epicenter ran a
departure round over a versioned wire (`departure_status`, `departure_answer`)
with generations, fencing, a three-second native "Keep open / Discard and
quit" dialog, and an AppKit `applicationShouldTerminate:` guard that cancelled
logout and shutdown. Honeycrisp ran a close gate with page generations and
request ids; Whispering relayed the question through its Bun host and showed
a leave prompt. Together about 13,000 lines, and a quit could be held open
indefinitely by a page that never answered or a person who chose Keep working.

What that machinery protected was mostly a draft whose save had already
failed. The save bar warns about that when it fails. The only state a person
cannot know is at risk is a save in flight: work an app admitted and has not
finished, and an autosave's latest snapshot still waiting behind a running
write, which the folder plugin's exit drain cannot see.

## Decision

Closing or force-closing an app just closes it. Nothing asks, fences input, or
waits on a person, with one exception: a recording in progress.

- On quit, and on a window close that ends the page, the host sends each page
  that holds file-backed drafts one close signal and waits for one
  acknowledgement or about 1 second, whichever comes first. Then it exits.
- The page flushes: it awaits `admissions.quiet()` and each open session's
  `settled()`, which sends the held snapshot, bounded to 800 ms by
  `flushOnClose` (`@epicenter/svelte/flush-on-close`), then acknowledges. A
  hung save, a failed save, or a page that never answers cannot hold the quit.
- A draft whose save failed or conflicted, text not added, and an unanswered
  transcript are lost on quit.
- While a recording is in progress, the first quit or close shows one native
  dialog, "A recording is in progress. Quit anyway?", with Quit and Cancel.
  Cancel keeps the app open and recording; Quit continues to the flush and
  exit. The page tells the shell when a recording starts and stops, as one
  boolean (`set_recording`), granted only to the window that records; the
  shell reads it synchronously when a quit arrives. Only Whispering records:
  its standalone shell holds the flag. Epicenter's hosted Whispering opens no
  session today, and Capture and Todos hold no recordings, so Epicenter has no
  such dialog.
- The Rust folder plugin still drains the writes it accepted on
  `RunEvent::Exit`.
- In a browser, `pagehide` starts the same flush without waiting, and the
  existing "Leave site?" warning stays while a save runs or has failed.
- Each shell keeps a Quit menu item of its own for Cmd-Q, because the
  predefined one calls AppKit's `terminate:`, which skips `ExitRequested`.
- No shell answers `applicationShouldTerminate:`. Tao 0.37 implements only
  `applicationWillTerminate:`, so the Dock's Quit, logout, shutdown, and a
  `quit` Apple event reach the app as `RunEvent::Exit` on the main thread,
  where a page's IPC cannot be served. Those quits drain only the writes the
  folder plugin already accepted; a snapshot still waiting in a page is lost,
  and a recording in progress is lost without the dialog. The apps no longer
  cancel a logout or shutdown.
- An Epicenter account change still asks Bun's `prepare-relaunch`, which Rust
  now grants at once; `relaunch` flushes the pages, then restarts.

## Consequences

A quit takes at most about a second longer than the process exit, and never
needs an answer. A person loses what the save bar already said was not saved,
and, on a system quit, at most the snapshot typed while a write ran. The
departure machine, the terminate guards and their evidence harnesses, the
consent wires, the prompts, input fencing, and Whispering's Bun event stream
are deleted.

## Considered alternatives

- **Keep the AppKit guard, cancelling and re-raising the quit.** Flushes on
  every system quit, but cancels logout and shutdown, which the person must
  retry, and needs a delegate patch that must fail startup when Tao changes.
  The loss it prevents is one snapshot behind a running write.
- **Answer `NSTerminateLater` and reply after the flush.** Keeps logout
  going, but runs the flush inside AppKit's modal run loop, where Tauri's IPC
  and event delivery are unverified.
- **Prompt only when a save failed.** Brings back the consent round for the
  one case the save bar already reported.
- **Lose a live recording without asking.** A recording is not a draft with a
  save bar: nothing tells the person it is not saved yet, and Cmd-Q while
  dictating is an easy slip. One native dialog, gated by one boolean, is the
  smallest guard.
