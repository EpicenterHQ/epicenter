# 0646. A native app hands Epicenter a directory path, and the person accepts it

- **Status:** Accepted
- **Date:** 2026-10-20
- **Relates:** [ADR-0641](0641-epicenter-remembers-folders-as-machine-local-paths.md) (remembered paths and the handoff rule this builds), [ADR-0644](0644-the-shell-assigns-a-native-windows-default-folder.md) (a shell's folder assignment), [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) (composition through paths), and [ADR-0537](0537-epicenter-opens-to-your-folders-and-home-becomes-settings.md) (the Folders window).
- **Unbuilt:** the `epicenter folders` and `epicenter open` CLI commands, Open in Epicenter in any standalone app but Todos, and verification of the operating system's delivery on a packaged build.

- **Amended by:** [ADR-0647](0647-a-native-window-edits-one-directory-bound-before-it-exists.md): the sender reads its window binding; acceptance opens a separate bound editor. The launcher holds no folder, scope map, or switching state. Remembered entries are path shortcuts checked again on reopen, and forgetting leaves editors open. The scope and folder-switch mechanics below describe the original decision.

## Context

Standalone Todos (`apps/todos/src-tauri`) registers its whole app-data
directory as its window's folder. Epicenter's Folders window lists only the
direct children of its folder root (`data_folders::list_in`), and its deep
links (`parse_app_deep_link`) open built-in windows. ADR-0641 decided that a
handoff names a directory, that receiving it grants nothing, and that the
desktop remembers an accepted path in `<Epicenter app data>/folders.json`. It
left the link, the acceptance, and the write coordination unbuilt.

## Decision

**The handoff is one link, `epicenter://open?path=<percent-encoded absolute directory>`.**
`folder_opening::parse_open_link` accepts exactly the host `open`, no path,
user, port, or fragment, and one `path=` pair with no `&`, `;`, `=`, or raw
`+`, whose `%` escapes are all valid. The decoded path is UTF-8, absolute, free
of control characters, and spelled as its own components: no `.`, `..`,
doubled, or trailing separator. Any other form is ignored. The existing
`epicenter://app/<id>` and bare `epicenter://` links keep their meaning.

**The sending shell names its own grant.** Standalone Todos's
`open_in_epicenter` command reads the root its folder plugin granted the
calling window (`Folders::granted_root`), encodes it, and opens the link with
`tauri-plugin-opener` from Rust. The page passes no path and has no opener
permission. A successful detached opener call means the computer was asked
to open the link; it does not prove Epicenter received it. The page says so
and never that the folder opened. The page shows
**Open in Epicenter** only when `getIdentifier()` answers
`so.epicenter.todos` or `so.epicenter.todos.dev`. The browser build has no
shell, and Todos bundled in Epicenter runs under Epicenter's identifier
without the permission to read it.

**Receiving queues; accepting opens.**

| Step | Shell | What touches the directory |
| --- | --- | --- |
| A cold start, a running app, or a forwarded launch receives the link | `folder_opening::receive` adds the path once to `FolderOpenings`, emits `epicenter://folder-openings-changed` to `folders`, and shows the Folders window | nothing |
| The Folders window shows "Open this folder?" with **Open** and **Dismiss** | `pending_folder_openings`, `dismiss_folder_opening` | nothing |
| The person chooses **Open** | `accept_folder_opening` takes the pending path, then admits it | `symlink_metadata`, `canonicalize`, then registration |
| Remembering | `remembered_folders::add` | `folders.json` only |

Admission (`folder_opening::admit`) refuses a path that is missing, a link, or
not a directory, and never creates one. It refuses a directory whose
resolved directory is, holds, or lies inside Epicenter's own folder
(`<folder root>/so.epicenter`) or Epicenter's app data. An admitted directory
is registered by its checked resolved path with `FolderConfig::data` under the
scope `opened:<n>` for the `folders` window alone. The same resolved directory
keeps one scope for the run; remembered paths retain their original spelling
so **Forget** can match them exactly. No
bundled app's window is permitted into it: `open_bundled_app` resolves only
listed names under the folder root, and the window offers no "Open with" on
it.

The window opens an accepted folder through its folder switch. The switch
waits for unfinished drafts to save. If a save fails, it keeps the current
folder and its draft; the accepted folder remains in the list.

**`folders.json` is changed only under its save lock and replaced whole.**
Each change holds `.folders.json.epicenter-save-lock` in the app-data
directory, the exclusive SQLite transaction every folder save takes
(`epicenter_folder_core::lock::SaveLock`). Under it the writer reads the list,
changes it, and renames a staged file over it. A change that changes nothing
writes nothing. Content that is not a JSON array of strings, or a path that is
not a regular file, is reported and left byte-identical; adding and forgetting
are refused until it is repaired. A string entry this build would not admit
stays in the file and is listed with its problem.

**A failed remember does not undo an opening.** `accept_folder_opening`
answers `{ id, rememberProblem }`. The folder stays open and stays in the
window's "Opened folders" list for the run, marked "Opened this time only".

**"Opened folders" lists `folders.json` and this run's acceptances.**
`list_remembered_folders` admits each entry that is there by the same rule,
which registers a remembered entry after a restart without a new request. An
entry that is missing or refused is listed with its problem. **Forget**
(`forget_remembered_folder`) removes the stored path exactly as listed and
deletes no files.

**The link carries no app metadata.** It names no app ID, manifest, schema,
or folder ID. The Folders window opens any directory with no tables and edits
its files as text, so it needs nothing from the sender beyond the path.

## Consequences

- One click in a standalone app and one click in Epicenter show that app's
  files in the Folders window, with no common parent directory.
- A person sees the full path before Epicenter reads it. A link from any local
  program can ask; only the person's **Open** admits it.
- Folder saves use a lock beside the selected directory. Opening `~/Notes`
  may create `~/.Notes.epicenter-save-lock` on save; a parent that cannot be
  written makes saves fail while the draft remains available for repair.
- An entry added to `folders.json` by a person or a later CLI is admitted on
  the next listing, under the same refusal rules as a request.
- A directory reached by two spellings may be two remembered entries, but it
  has one scope for the resolved root in a run. If a linked parent is later
  redirected, a new safe root gets a new scope.
- Forgetting an entry does not revoke the window's registration for the run;
  the folder stays open until the person chooses another.
- A future `epicenter folders` writer must take the same lock and keep string
  entries it does not understand.

## Considered alternatives

- **Show the request in a native dialog.** Adds a dialog plugin and a second
  trusted surface; the Folders window already holds the folder switch and its
  unsaved-draft rule.
- **Grant on receipt and ask afterwards.** Lets any local program that can
  open a URL put a directory into the Folders window before the person agrees.
- **Send the app's ID and let Epicenter find its folder.** Needs an app
  registry and an ID-to-path rule; the sender already knows its granted root.
- **The page builds and opens the link.** Gives the page a path and an opener
  permission it otherwise lacks, and lets it name any directory.
- **A `flock` on `folders.json`.** Bun has no portable file lock; it already
  takes the SQLite save lock.
