# 0657. Departure prompts only for pending Folder saves

- **Status:** Superseded
- **Date:** 2026-10-21
- **Superseded by:** [ADR-0689](0689-a-folder-shows-what-landed-a-draft-holds-what-was-typed-until-it-lands.md).
- **Amends:** [ADR-0542](0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md) for application Quit, window close, and browser departure, and [ADR-0574](0574-an-app-opens-its-folder-behind-await-and-provides-its-options-through-context.md) for the context's former `busy`, `leaving`, and `registerUnsent` departure policy. File-first recovery and orderly context teardown remain.

- **Lifecycle amendment:** [ADR-0664](0664-folder-close-drains-admitted-work-through-one-owner.md) replaces context action admission and the split shutdown sequence with Folder-owned work and close.

## Context

ADR-0542 made application Quit immediate and later made individual window close settle every edit and wait for saves. The latter also guarded unsubmitted forms and app actions. A subsequent native Quit path closed each folder window through that guard, so a failed save could leave some windows closed and others open. A window could also be kept open for a form the person had not submitted even when its Folder was fully saved.

The Folder already reports whether an accepted edit is saving or held unsaved. The host binds each window to a directory but does not hold the page's Folder handle or its save status.

## Decision

At a departure request, prompt only when that page's `folder.getStatus().saving` is true or `folder.getStatus().unsaved` is nonempty. Unsubmitted form text, query activity, and an app action before its first Folder write do not trigger the prompt. Cancel keeps the page and its input. Confirm closes the window or quits immediately without waiting for a save.

Browser unload and page navigation read that status through the page's Folder context. A desktop window reads it in its close listener and uses a native confirmation dialog. Epicenter's application Quit asks each mounted Folder context for a current status snapshot, then shows one confirmation if any answers pending. A page that cannot answer makes the host ask rather than assume saved. Quit does not close windows one by one.

Normal page teardown remains separate: the context refuses new work, waits for started app actions that may write after an `await`, then closes the Folder and settles its edits. `context.run` and `context.closing` express that lifecycle. They do not decide whether departure prompts. Page hide may still send edits sooner.

## Consequences

The departure model has one source of save risk, the Folder's status. Forms typed but not submitted can be lost without a prompt. An accepted app action that has not reached its first Folder write can also be cut off by confirmed window close or application Quit. Work that must survive Quit needs a durable Folder record before a long await. Normal component teardown still lets such actions finish.

The native host needs a short status request and reply because Rust has only the bound directory, not the page's Folder handle. An unanswered request prompts after a bounded timeout. A status snapshot can become stale as a save finishes; the window close path checks again immediately before opening its dialog.

## Considered alternatives

- **Wait for saves at departure.** It can hold Quit indefinitely after a failed save and makes the host coordinate window teardown.
- **Prompt for every unsubmitted form or app action.** It treats drafts and work not yet accepted by Folder as unsaved files, including a new Todo title before Add.
- **Remove `run` and `closing`.** A queued message write or recorder finalization can reach Folder only after an await. Normal page teardown would otherwise close Folder before that write.

## Built

`FolderApp` and `holdWindowClose` use current Folder save status. Epicenter asks bound folder windows for that status, with a 750 ms timeout, and parents its single Quit confirmation to a window. The reporter is scoped to that webview window and removed during orderly context close.

Mounted tests cover Cancel, confirmed departure without starting a pending save, explicit retry, and browser reload shortcuts. The native two-window demo verified one Quit sheet, repeated Quit, Cancel preserving both windows and failed input, and confirmed Quit leaving the saved file intact. Quit also remained available while a window-close sheet was open. Dock Quit and operating-system termination were not verified; abrupt termination cannot promise a prompt.
