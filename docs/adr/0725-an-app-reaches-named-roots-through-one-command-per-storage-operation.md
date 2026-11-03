# 0725. An app reaches named roots through one command per storage operation

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Supersedes:** [ADR-0647](0647-a-native-window-edits-one-directory-bound-before-it-exists.md) (a native window edits one directory bound before it exists): a standalone app has one window, and what it may touch belongs to the app, not to a window label.
- **Amends:** [ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md) at "the shell grants the directory": the shell names roots instead of granting paths; [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) at "the shell computes the derived path, resolves links, and grants that one path": nothing is resolved or granted, the operating system follows links, and one refusal rule remains.
- **Unbuilt:** none. `root_status` and `create_root` are not built (ADR-0726): `open_root` opens the root's path and makes the folder when nothing is there.
- **Amended by:** [ADR-0726](0726-an-apps-path-is-its-claim.md) at `root_status`, `create_root` and the status values: the shell states no status.; [ADR-0729](0729-a-link-is-followed-only-at-or-above-a-root.md) at links: a root is resolved once when it opens, and a link inside it is refused.

## Context

The folder plugin binds one directory to each window before the window
exists, keyed by the window's label (ADR-0647). Commands name their root by
the absolute path `open_folder` answered, and any root other than the bound
one must be allowed by Tauri's runtime file-system scope
(`packages/tauri-plugin-epicenter-folder/src/scope.rs`). The model served one
Epicenter host running many apps, one per window.

Each standalone app now opens exactly one window
(`open_folder_window` in `packages/tauri-epicenter-standalone/src/lib.rs`),
and the Epicenter app opens no folder window. Window binding, window
construction and the other-roots scope are about 1,000 lines
(`src/folders.rs`, `src/windows.rs`, `src/scope.rs`). Around them sit a
`data_folder` command, the data folder's grant in the file-system scope,
`tauri-plugin-persisted-scope`, `resolve_folder`, and canonical paths handed
to TypeScript, which the review of commit `233d389069` found leaking: a
symlinked library root bypassed the containment check, and a dangling link
read as a missing folder.

Storage itself stays in Rust for the reasons in
[ADR-0581](0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md):
a store built from primitive file calls costs `2d + 1` bridge calls per read
`d` folders deep, cannot tell `todos/a.md` from `Todos/a.md` on a
case-insensitive disk without listing every parent, and cannot create a file
exclusively.

## Decision

**An app reaches named roots, never paths.** At startup the shell names two
roots and the page never sees or sends an absolute path, except to display
one:

```txt
Root::Data      <library root>/<name>          (ADR-0722; ~/Epicenter/whispering)
Root::AppData   the operating system's AppData directory for this app
```

**Storage is one command per operation, each taking a root and a relative
path.** The relative path passes the shared path rule
(`core/src/paths.rs`, `fixtures/path-rules.json`), so a page cannot leave its
root:

```txt
list(root, dir) · read(root, path) · put(root, path, bytes, over) · watch(root)
```

**Rust states facts; the page decides.**

```txt
root_status(Root::Data) → Ready | Missing { first_launch } | Disconnected
create_root(Root::Data)   only after the page decides to
```

- **`first_launch`** is true when the app's AppData directory did not exist
  before startup created it.
- **`Disconnected`** is a symbolic link at the data root whose target is
  gone (`symlink_metadata` finds the link; following it fails).
- **The operating system follows links.** Nothing is canonicalized or
  granted; `root.join(path)` is opened as is.
- **One refusal rule:** a data root whose resolved location is the person's
  home folder, an ancestor of it, or the library root itself is refused at
  startup. Safety beyond that is the first-open contract check of ADR-0721
  ("[Show in Finder] [Use it anyway]").

The page's screens follow the status: `Ready` opens the app;
`Missing { first_launch: true }` creates the folder and shows the onboarding
line; `Missing { first_launch: false }` offers [Locate…] and [Start a new
folder]; `Disconnected` says "This folder is on a drive that isn't
connected." [Retry]. "Locate…" hands a picked folder to the shell, which
puts a link at the data root and reports `Ready`.

## Consequences

- Window binding, window labels as authority, `open_folder_window`, the
  other-roots scope, `open_folder`, `resolve_folder`, `data_folder`, the
  data folder's file-system grant, and `tauri-plugin-persisted-scope` are
  deleted. The folder plugin keeps storage, the path rule, exclusive create,
  watching and unfinished writes.
- TypeScript holds no absolute path, so it cannot disagree with Rust about
  one.
- A second window in an app shares its roots without new code.
- The Epicenter app's later browsing ([ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md))
  uses the same commands with its own root set.
- A compromised page can still read and write anything under its own roots;
  the path rule bounds it to them, as window binding did.

## Considered alternatives

- **Bind each window to its data folder instead of its AppData.** Keeps
  binding and window labels for apps that have one window, and needs a
  window that exists before its folder does for recovery.
- **TypeScript over Tauri's file-system plugin, no Rust storage.** Returns to
  the primitive-call store ADR-0581 replaced.
- **The whole folder engine in Rust.** Two implementations of the data model,
  since the browser, Bun and the server run TypeScript
  ([ADR-0476](0476-whisperings-desktop-folder-uses-one-rust-library-in-both-tauri-shells.md),
  superseded by ADR-0531).
- **Storage through the `epicenter` engine.** Apps must work without Epicenter
  installed.
