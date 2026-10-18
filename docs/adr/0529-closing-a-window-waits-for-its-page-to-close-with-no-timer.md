# 0529. Closing a window waits for its page to close, with no timer

- **Status:** Proposed
- **Date:** 2026-10-12
- **Relates:** [ADR-0523](0523-applications-own-drafts-in-edit-sessions-and-leave-one-open-item.md) (the edit sessions and admissions `close()` waits for), [ADR-0515](0515-snapshot-saves-serialize-writes-and-retain-only-the-latest-pending-text.md) (the held snapshot a close sends), [ADR-0476](0476-whisperings-desktop-folder-uses-one-rust-library-in-both-tauri-shells.md) and [ADR-0461](0461-portable-data-folders-live-under-local-and-derived-account-scopes.md) (edited with this record: their quit prompts are withdrawn)
- **Unbuilt:** acceptance in the real desktop apps: Cmd-Q, a window close, and an Epicenter account-change restart while a save is running, in Epicenter, Honeycrisp, and Whispering, including the "Still saving…" notice and Whispering's ask while recording.

## Context

Three desktop shells used to ask their pages before they quit: Epicenter's
departure round with fencing and a native "Keep open / Discard and quit"
dialog, Honeycrisp's close gate, and Whispering's leave prompt relayed through
its Bun host. A quit could be held open indefinitely by a page that never
answered. A first replacement kept a handshake instead: the shell sent each
page a close signal, waited up to a second for an acknowledgement, and exited
either way, while the page bounded its own flush to 800 ms. That traded the
prompt for two timers and a wire, and a slow disk still lost the last save.

What needs protecting is a save in flight: work an owner admitted and has not
finished, and an autosave's latest snapshot waiting behind a running write.
Each app's owner already has the one operation that finishes those: `close()`
refuses new work, lets admitted work and open sessions settle, and releases
the folder.

## Decision

A window's close runs the page's own ending, and waits for it. This is VS
Code's shape: a window's shutdown waits for the work that joined it, and after
1.2 seconds shows progress with a "Close Anyway" button.

- **The owner.** `close()` is the owner's only ending verb in Todos, Capture,
  Honeycrisp, and Whispering. It is idempotent and the same in every phase.
- **The page.** Each desktop page registers Tauri's
  `getCurrentWindow().onCloseRequested` before its owner can be edited. Tauri
  awaits the handler and destroys the window when it returns, unless it called
  `preventDefault()`. The handler awaits `close()` with no timeout
  (`createClosing` in `@epicenter/svelte/closing`). A close while the owner is
  opening, or after its opening failed, resolves at once. Unmounting calls the
  same `close()`.
- **The notice.** If the close has not finished after about 1,200 ms, the page
  shows "Still saving…" with **Close anyway** (`ClosingNotice`). Close anyway
  stops waiting and lets the window go. The delay only decides when the notice
  shows.
- **Whispering's ask.** While `library.recording` is true, the layout shows
  and focuses the window and asks in the page, with the shared
  `confirmationDialog`. Cancel calls `preventDefault()`, and nothing has been
  closed; a second close request joins the same ask. The dialog ends every
  opening in a confirmation or `onCancel`, so the ask cannot be left waiting.
- **The shells.** Quit closes windows; the app exits, or relaunches, when the
  last is gone. Nothing acknowledges, no thread waits, and no timer backs the
  close up.
  - Epicenter's Quit, from the menu or the tray, marks the app as quitting and
    closes every built-in window; installed app windows are destroyed. The
    last window's `ExitRequested { code: None }` exits while quitting and is
    prevented otherwise, so the tray stays. Capture and Todos windows no
    longer hide on close: closing one ends its page. An account-change
    relaunch closes the windows the same way and relaunches once they are
    gone (`src-tauri/src/leaving.rs`).
  - Honeycrisp's and Whispering's Quit close the main window.
  - Each shell keeps a Quit menu item of its own, because the predefined one
    calls AppKit's `terminate:`, which closes no window.
- **Permissions.** `core:window:allow-destroy` is granted only to built-in
  window labels whose pages close themselves: `capture` and `todos` in
  Epicenter, `main` in Honeycrisp and Whispering. An installed app's window is
  never granted it. Whispering's `main` also gets show, unminimize, and
  set-focus for its ask.
- **The browser.** No close handler. Each app has one rule:
  `beforeNavigate(n => { if (n.willUnload && owner.unsaved) n.cancel() })`,
  which raises the browser's own "Leave site?". In-app navigation unmounts the
  page, and `onDestroy` calls `close()`.
- The Rust folder plugin still drains the writes it accepted on
  `RunEvent::Exit`.

## Consequences

A close takes as long as the saves in flight, and the person sees why after a
moment and can stop waiting. A draft whose save failed or conflicted, text not
added, and an unanswered transcript end with the page: the save bar already
said so. The flush module, the host close signal, `flush_done`,
`set_recording`, the native quit dialog, and the close-flush wait threads are
deleted.

Known limits:

- **Dock Quit, logout, shutdown, and a `quit` Apple event** call AppKit's
  `terminate:` directly. Tao 0.37 answers only `applicationWillTerminate:`,
  so these reach the app as `RunEvent::Exit` with no window closed first. They
  drain only the writes the folder plugin already accepted; a snapshot still
  in a page is lost, and a Whispering recording is lost without the ask. The
  apps never cancel a logout or shutdown.
- **A frozen page** never returns from its handler, so its window, and a quit
  waiting on it, stays open. Its Close anyway cannot run either; Force Quit
  ends it.
- Force Quit, a signal, a crash, or power loss skip everything above.

## Considered alternatives

- **Keep the bounded flush and acknowledgement.** Two timers chosen against
  each other, a wire per shell, and the last save of a slow disk still lost.
  Waiting on `close()` with a visible escape is simpler and loses nothing it
  can avoid.
- **A native backstop timer after Quit.** Turns a slow save back into a lost
  one without the person choosing it. Close anyway is that choice, made in
  the page.
- **Keep hiding Capture and Todos on close.** Keeps a page alive that no one
  can see, and makes a window close and a quit two different paths.
- **A native recording dialog in the shell.** Needs the page to report a
  boolean over IPC and a dialog plugin; asking in the page needs neither.
- **Answer `applicationShouldTerminate:` with `NSTerminateLater`.** Would
  cover system quits, but runs page IPC inside AppKit's modal run loop, where
  Tauri's event delivery is unverified, and needs a Tao delegate patch.
