# 0652. The folder plugin opens one window per app and directory

- **Status:** Proposed
- **Date:** 2026-10-20
- **Amends:** [ADR-0647](0647-a-native-window-edits-one-directory-bound-before-it-exists.md) at shell-owned window identity and standalone Todos's fixed label. Directory admission, binding before construction, and page storage remain unchanged.
- **Amended by:** [ADR-0701](0701-apps-run-as-separate-programs.md) at the Epicenter host half: Epicenter opens editor windows only; standalone Todos keeps its window rule.

## Context

Standalone Todos and Epicenter both open a static application page over one
native directory. Separate shell paths made Epicenter coordinate identity,
reuse, binding, and construction, while Todos maintained a fixed label.
Moving only binding into a helper left callers responsible for the ordering.

## Decision

Both shells call `FolderExt::open_folder_window(application, directory, url,
configure)`. The plugin derives the native label from the application key and
canonical directory. It serializes lookup, binding, configuration of Tauri's
actual builder, and construction on the main thread. Reopening the same pair
reveals the existing window after checking its complete binding. Shutdown
refuses reuse as well as new construction. Configuration and build failures
roll back the binding; presentation failures retain the live window's binding.
The plugin's destruction event removes it.

The shell still admits the directory and configures its page. Standalone
Todos creates its fixed AppData default; Epicenter creates initial defaults
or admits an existing selected folder. Both supply the `todos` application
key and use `todos:*` capabilities. Labels are local to a Tauri runtime.
No page chooses a directory or receives one through its startup URL.

Epicenter configures macOS native tab eligibility on the supplied builder;
Windows and Linux retain independent windows. Tabs introduce no new binding
owner. Settings remains a fixed `home` singleton that hides on close and uses
`bind_while_building`; the Folders launcher has no directory binding. These
role-based windows do not participate in app-and-directory identity.

## Considered alternatives

A custom builder would mirror Tauri's configuration API. A helper that bound
a window after construction would let a page run before its binding existed.
Caller-owned label generation and reveal/build callbacks would preserve the
coordination this API removes. A generic singleton mode would put Settings's
separate product lifetime into every application's opening contract.

## Consequences

Shells no longer hash labels or coordinate binding with construction. The
plugin adds one synchronous native opening operation and no second map.
Callers use setup or a blocking worker and preserve the supplied builder's
identity. The existing window-to-directory map remains the storage command's
authority and the owner of shared root watches.

The native runtime example verifies setup and concurrent opening, tab-group
closing through save guards, retained unfinished input, failed-save retry,
detach/merge identity, and destruction cleanup.
