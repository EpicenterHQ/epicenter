# 0644. The shell assigns a native window's default folder

- **Status:** Accepted
- **Date:** 2026-10-20
- **Amends:** [ADR-0636](0636-an-app-opens-local-files-through-one-folder-handle.md) at native default selection and missing-location behavior.
- **Built:** Standalone Todos assigns its app-data directory as the Folder root. The Epicenter host assigns a fixed default or a listed folder to each bundled app window.
- **Unbuilt:** Reveal folder in standalone Todos and portable watcher rearming after a fixed default is deleted and recreated.

## Context

ADR-0636 described a standalone app passing a directory to `openFolder` and
keeping authored files under `work/` inside app data. The installed Epicenter
host already chooses a directory before creating each app window. Browser apps
already call `openFolder({ tables })`. App code does not need to choose a path
again after the shell has assigned one.

## Decision

**The native shell selects and grants the window's default Folder.** Ordinary
browser and Tauri app code calls `openFolder({ tables })`. The native opener asks
the shell for that window's assignment and refuses a window with none. The
Epicenter host may assign its existing per-app default or a directory the person
chose. Explicit Tauri opening by registered directory ID remains available for
windows that deliberately read several folders. Bun tools receive an explicit
filesystem path through `@epicenter/folder/bun`.

A standalone Tauri shell assigns its entire app-data directory as the Folder
root. It does not add a `work/` child or a location marker. The shell may
create or recreate this fixed, computed default when absent. The Epicenter
host likewise may recreate a bundled app's fixed default under its folder
root when the person opens that app. A person-chosen external
directory is opened only while it exists; the shell reports its missing path
instead of replacing it. Registration, permission, and directory resolution
belong to the shell. `openFolder` opens its assignment and does not infer where
the app was launched.

## Consequences

- The Svelte app opener calls the same public `openFolder({ tables })` on both
  runtimes. Tauri lookup and grant live in the Folder native entry.
- A standalone app needs no preference row merely to remember its fixed
  app-data default. If it later offers a chosen external location across
  launches, its shell must remember that choice outside the chosen directory.
- A fixed default can reappear when the person opens the app after deletion,
  including in the same shell. A page whose open handle finds its folder
  missing still reports that failure. A missing chosen directory is always a
  refusal. A linked or redirected root is refused.
- A shell must keep WebView runtime files and other non-authored machine state
  from colliding with the Folder root. This record does not specify where its
  WebView profile lives.

## Considered alternatives

- **Pass a path from every Tauri app page.** Repeats the shell's assignment and
  asks page code to own native path selection.
- **Put authored files under `work/`.** Adds a second root under the fixed
  standalone app-data directory without a current need for it.
- **Store a first-use marker for the fixed default.** Makes a computed location
  depend on extra machine state. A chosen external path still needs an explicit
  remembered selection if it must persist across launches.
- **Let `openFolder` identify the installed app and derive a path.** Moves
  launch policy and filesystem permission out of the shell.
