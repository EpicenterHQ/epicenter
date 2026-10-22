# 0663. One native question before a window or Epicenter leaves

- **Status:** Accepted
- **Date:** 2026-10-21
- **Amends:** [ADR-0657](0657-departure-prompts-only-for-pending-folder-saves.md) at desktop window Close and application Quit, and [ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md) at departure metadata and the removed recorder cancel operation.
- **Lifecycle:** [ADR-0664's write-only closure amendment](0664-folder-close-drains-admitted-work-through-one-owner.md#amendment-2026-10-22-folder-tracks-writes-not-app-workflows) removes public workflow admission. Folder submits held input and drains submitted writes; apps refuse new work and late results. [ADR-0669](0669-folder-actions-track-lifetime-without-reserving-paths.md) and the `run(action)` paragraph below preserve the intermediate lifetime-only model. The native departure policy and its evidence remain unchanged.
- **Source reconciliation:** 2026-10-22, against `bd78bfb52b` and current callers. The native runs below remain October 21 evidence, not a new acceptance of the latest editor build.

## Context

Folder knows whether its window has accepted input that has not saved. The
native recorder knows whether capture is active and owns WAV finalization.
Window Close and application Quit have different scopes. Page workflow teardown
cannot promise to finish when the native host destroys the WebView.

Earlier versions combined Close and Quit in one native departure coordinator,
then used independent window confirmation and a window-attached Quit sheet.
An independent window close could remove that sheet's parent and strand Quit;
parent and attempt tracking repaired the reproduced case. The user accepted a
standalone native Quit alert instead, removing that parent dependency.

## Decision

**Window Close warns only for unfinished Folder saves.** Each page uses its
current local save status and awaits one native confirmation. A recording alone
closes silently and keeps captured audio. A single status snapshot determines
whether to ask; a save finishing while the question opens does not withdraw it.
Cancel keeps input and the window. Confirmation dispatches destruction without
waiting for page workflows. A successful dispatch keeps the page inert until
it is gone; a failed dispatch restores input and permits retry. A retired guard
cannot act on, unlock, or release a replacement guard. Other windows answer
independently, including members of native tab groups.

**Epicenter always confirms application Quit.** Its standalone alert mentions
active capture, using the native recorder directly, and warns that unsaved input
may be lost. It has no window parent. Repeated Quit requests share that alert;
Cancel returns to Ready, and confirmation sets Approved so Tauri's next exit
request can proceed. QuitState has only Ready, Prompting and Approved. There
are no parent labels, attempt IDs, counters, destruction hooks, page status
query/reply events, timeouts or page-facing recording-status command.

On macOS the installed dialog backend uses CFUserNotificationDisplayAlert for
the unparented alert. The user accepted its appearance and manually clicked
Cancel and Quit Anyway in the final isolated build. Computer use verified that
Cancel retained both windows and usable navigation, and an independent process
check confirmed exit after a fresh Quit request and Quit Anyway. The alert's
system-owned surface remains unavailable to computer use.

**Native departure finalizes captured audio.** Recorder page/window/exit cleanup
keeps the WAV; recorder commands do not delete captured audio. A file whose
capture never started can still be removed. The page's Stop/finalization flow
writes `durationMs` while it remains active and the Folder admits that write.
An interruption can enter the same flow; repeated Stop joins its completion
through the metadata write.
Departure preserves audio without promising duration metadata. Browser departure
can lose an in-memory recording and adds no recording-only unload warning.

**Product disposal is synchronous.** Whispering refuses new work and late
answers, aborts a starting capture, releases microphone tests and subscriptions,
and starts Folder closure without awaiting it. It neither calls Stop on active
capture nor drains provider workflows. Folder.close independently refuses fresh
input and actions, submits held input once, and drains admitted actions and
writes through the ordinary Folder. `run(action)` admits lifetime only: it
reserves no paths, flushes no input, and locks nothing. File and table calls
remain usable until storage is released; writes started by any caller while
draining prolong close. Confirmed native destruction does not wait for those
page promises. No second Folder, save owner or shutdown queue is introduced.

Standalone Todos' app-menu Quit and Cmd-Q continue to request its one window's
ordinary guarded close. That custom menu route does not establish coverage
for macOS Dock Quit or logout. Startup, selected folders, schemas, stored formats
and unsubmitted forms do not change.

## Evidence and limits

Before the standalone-alert change, isolated macOS runs verified conditional
window Close, independent dirty tabs, failed and pending input, Cancel retaining
exact input and capture, repeated requests, and readable WAVs after confirmed
Close or application Quit. Those capture and local Close rules remain unchanged.
The standalone alert's appearance was accepted; its isolated native suite passed
143 tests with one hardware test ignored. Manual checks of the final build
verified Cancel, retry, and Quit Anyway with saved Todos and Folders windows.
No capture was active in that run; the recording evidence remains from the
preceding attached-sheet build.

Shared tests cover local confirmation, stale guard cleanup, rejection recovery
and Folder closure. Capture tests cover held Stop, retained audio paths, repeated
Stop and synchronous disposal. The [desktop verification record](../../apps/whispering/docs/desktop-verification.md)
separates current evidence from historical policies and lists remaining checks.
Windows/Linux presentation, physical microphone interruption and abrupt process
termination remain outside this native acceptance.

## Built

`apps/epicenter/src-tauri/src/shell.rs`, shared `window-close.ts` and
`folder-context.ts`, Whispering's single app owner, and the native recorder.
The former shared Departure protocol, recorder cancellation API, page recording
read and parented-Quit lifecycle are removed. Their earlier decisions and
superseded tests remain in Git history.

## Historical decisions before source reconciliation

The following decision text and amendments are preserved from `4a2b61c25b`.
Only their heading level changes. They record the transitions from recording-aware
Close and status-based Quit to unsaved-only Close and a standalone Quit alert.
The current policy above governs; references below to removed commands,
parent tracking, and rejected alternatives describe those earlier designs.

### Amendment: application Quit uses a standalone native alert

Application Quit has no window parent. The unparented native alert belongs to
the application and remains pending when any individual window closes. Its
appearance was tried in the isolated macOS app and accepted by the user.

Delete Quit's parent selection and tracking, window-destruction hook, attempt
IDs, and global counter. Only ready, prompting, and approved state remains:
repeated requests share one alert; Cancel permits another request; confirmation
allows Tauri's next exit request. The native recording warning and each page's
conditional Close confirmation remain unchanged.

On macOS, the installed dialog backend uses `CFUserNotificationDisplayAlert`
for the unparented dialog. Computer use cannot inspect that system-owned alert;
the user accepted its appearance and manually clicked Cancel and Quit Anyway in
the final isolated build. Computer use verified that Cancel retained both windows
and usable navigation, and an independent process check confirmed exit after a
fresh Quit request and Quit Anyway. This run used saved Todos and Folders windows
with no active capture; recording evidence remains from the preceding
attached-sheet build. The attached-sheet and stale-parent checks below describe
the superseded design. Startup does not change.

### Amendment: always confirm Quit; Close warns only for unsaved edits

Application Quit always asks one native question. The native recorder adds a
recording warning when capture is active. No folder page reports save status:
the query/reply events, expected-window set, channel, timeout, reporter lifecycle,
and asynchronous collection phase are deleted.

A window Close warns only for unfinished Folder saves, using the page's local
status and `await confirm(...)`. A recording alone adds no Close warning:
closing ends capture and keeps its audio. The page-facing recording command,
its grants, generated bindings, and host-origin detection are deleted. Rust
keeps its direct recorder read for application Quit.

Repeated prompts, Cancel/retry, failed destruction recovery, and stale Quit
answers retain their existing protections. The Quit sheet still owns an attempt
ID and parent label; independent parent destruction releases only that attempt.
Startup, folder selection, and stored formats do not change.

The following sections describe the prior policy and its evidence. This
amendment supersedes their Close and Quit selection rules.

### Decision

Each page answers its own window close through an awaited native `confirm(...)`.
The Folder owns accepted input and pending or failed saves. Epicenter exposes
`window_is_recording`, which reads the native recorder's owner for Tauri's
invoking window. The page combines these facts into one warning. Cancel keeps
the window, input, and recording. Confirmation destroys the window without
waiting for pending saves; native destruction finalizes captured audio.

Each close uses one save-status snapshot. A save finishing while focus or the
native question opens does not withdraw it. This keeps the message unconditional
inside the pending-save-or-recording branch.

Repeated close requests for one window share its decision. Other windows answer
independently, including members of a native tab group. A successful destruction
dispatch keeps its page inert and occupied until it is gone. A failed dispatch
restores input and permits another attempt. A retired listener cannot act on a
replacement page. Focus is best-effort and cannot block confirmation.

Application Quit remains a separate Rust-owned check and native sheet across
all bound folder pages and any native recording. Saved applications quit
silently. Missing status replies conservatively require confirmation. Cancel
performs no application-owned window destruction. These are bounded snapshots,
not a freeze on input across windows.

A window close can destroy a queued Quit sheet's parent. Each Quit attempt has
an ID and records its parent: destruction releases that attempt; a late answer
cannot settle a later attempt. This keeps the chosen sheet presentation without
a shared close/Quit admission gate.

Standalone Todos has one window. Its macOS app-menu Quit and Cmd-Q request that
window's ordinary close, so the same page confirmation applies. AppKit's default
Quit bypasses this guard; macOS Dock Quit and logout remain outside the custom
menu/tray route. Startup and fixed-default folder selection do not change.

### Alternatives

A shared native departure coordinator would need to queue independent window
requests or drop them. Closing each window in turn for application Quit would
allow some windows to disappear before another window's Cancel. Continuously
mirroring pending-save booleans into Rust introduces stale state and lifecycle
coordination. The current owners can answer directly instead.

An unparented application Quit alert could remove parent tracking, but changes
the chosen native sheet appearance. Always warning could remove status checks,
but adds a prompt for saved windows. Neither presentation change is adopted.

### Evidence

Installed Tauri, dialog-plugin, rfd, and Tao sources establish close-event
prevention, dispatch-only destruction, invoking-window dialog parenting, and
AppKit's predefined Quit behavior. Automated checks cover Cancel, duplicate
requests, status/dialog/destroy failures, retired listeners, recording warnings,
and stale Quit answers.

Isolated packaged macOS runs verified saved departure, pending and failed-save
warnings, complete input after Cancel, independent dirty native tabs, minimized
Todos Quit, recording Close and application Quit, and combined recording/failed
input in the same window. Confirmed departure left readable WAVs while failed
input remained unwritten. A queued Quit whose parent closed reproduced a stuck
Quit before the lifecycle repair and allowed a fresh Quit afterward.

The [native verification record](../../apps/whispering/docs/desktop-verification.md)
distinguishes source evidence, automated coverage, actual native checks, and
remaining Windows/Linux verification. No user folders were moved.
