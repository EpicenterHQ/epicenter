# 0652. The folder plugin opens one window per app and directory

- **Status:** Proposed
- **Date:** 2026-10-20
- **Amends:** [ADR-0647](0647-a-native-window-edits-one-directory-bound-before-it-exists.md) at shell-owned window identity and standalone Todos's fixed label. Directory admission, binding before construction, and page storage remain unchanged.
- **Relates:** [ADR-0701](0701-apps-run-as-separate-programs.md) (each app is its own desktop program; Epicenter opens no folder window).

## Context

Each desktop program opens a static application page over one native
directory. Separate shell paths made each shell coordinate identity, reuse,
binding, and construction, and Todos maintained a fixed label. Moving only
binding into a helper left callers responsible for the ordering.

## Decision

A shell calls `FolderExt::open_folder_window(application, directory, url,
configure)`. The plugin derives the native label from the application key and
canonical directory. It serializes lookup, binding, configuration of Tauri's
actual builder, and construction on the main thread. Reopening the same pair
reveals the existing window after checking its complete binding. Shutdown
refuses reuse as well as new construction. Configuration and build failures
roll back the binding; presentation failures retain the live window's binding.
The plugin's destruction event removes it.

The shell still admits the directory and configures its page.
`epicenter-standalone`, the shell every app's desktop program runs on, makes
the app's AppData settings root, opens the window bound to it under the
app's page key, and lets the page open its data root by path (ADR-0701).
Labels are local to a Tauri runtime. No page chooses a directory or receives
one through its startup URL.

Epicenter opens no folder window (ADR-0701): its Settings and launcher
windows bind no directory and do not participate in app-and-directory
identity.

## Considered alternatives

A custom builder would mirror Tauri's configuration API. A helper that bound
a window after construction would let a page run before its binding existed.
Caller-owned label generation and reveal/build callbacks would preserve the
coordination this API removes.

## Consequences

Shells no longer hash labels or coordinate binding with construction. The
plugin adds one synchronous native opening operation and no second map.
Callers use setup or a blocking worker and preserve the supplied builder's
identity. The existing window-to-directory map remains the storage command's
authority and the owner of shared root watches.

The plugin's tests (`windows.rs`) verify identity by application and
canonical root, separate runtimes, refusing a live label bound to another
directory, rollback of configuration and build failures, and refusal after
shutdown.
