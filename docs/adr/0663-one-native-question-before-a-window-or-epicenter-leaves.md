# 0663. One native question before a window or Epicenter leaves

- **Status:** Accepted
- **Date:** 2026-10-21
- **Amends:** [ADR-0657](0657-departure-prompts-only-for-pending-folder-saves.md) to warn about a native recording as well as unfinished saves.

## Amendment: application Quit uses a standalone native alert

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
the user verified its appearance directly. Final manual Cancel and Quit Anyway
verification remains pending. The attached-sheet and stale-parent checks below
describe the superseded design. Startup does not change.

## Amendment: always confirm Quit; Close warns only for unsaved edits

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

## Decision

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

## Alternatives

A shared native departure coordinator would need to queue independent window
requests or drop them. Closing each window in turn for application Quit would
allow some windows to disappear before another window's Cancel. Continuously
mirroring pending-save booleans into Rust introduces stale state and lifecycle
coordination. The current owners can answer directly instead.

An unparented application Quit alert could remove parent tracking, but changes
the chosen native sheet appearance. Always warning could remove status checks,
but adds a prompt for saved windows. Neither presentation change is adopted.

## Evidence

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
