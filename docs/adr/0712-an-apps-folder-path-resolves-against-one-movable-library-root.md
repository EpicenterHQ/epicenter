# 0712. An app's folder path resolves against one movable library root

- **Status:** Proposed
- **Date:** 2026-11-03
- **Amends:** [ADR-0701](0701-apps-run-as-separate-programs.md) at decision 96's removal of `EPICENTER_FOLDER_DIR` for standalone apps and at remembering only a chosen folder: every program reads one library root, and an app remembers the folder it first opened; [ADR-0670](0670-native-shells-share-explicit-machine-local-app-homes.md) at its remembered folder: an app also remembers the default after its first open.
- **Unbuilt:** a `root` key naming the library root, read by every program (the file that holds it is undecided), and its reader in `@epicenter/folder`; relative `folder` values; writing `folder` after the first open of the default; the first-open inspection and its two-choice question; Epicenter's "Move library…"; the warning for a root inside a file-syncing service; removing the refusal of "first-use persistence" from `apps/epicenter/AGENTS.md` (its refusal of collision suffixes stays).

## Context

A standalone app on `epicenter-standalone` opens `~/Epicenter/<productName>`,
made when missing, or the folder named by `folder` in its AppData
`settings.md` (`openDataFolder`, `packages/folder/src/desktop-folder.ts`). The
`folder` key is written only when the person picks a folder other than the
default (`pickDataFolder` forgets it for the default). The default is computed
again at every launch, so a person who moves `~/Epicenter/Whispering` and
reopens the app gets a new empty folder at the old path, with no sign that
their recordings exist elsewhere.

The library root has three sources today. Epicenter's shell resolves
`EPICENTER_FOLDER_DIR`, else `~/Epicenter` or `~/Epicenter Dev` by bundle
identifier (`resolve_folder_root`, `apps/epicenter/src-tauri/src/desktop_paths.rs`).
The CLI resolves `folderDir` from the same variable (`packages/cli/src/app-paths.ts`).
Standalone apps ignore it (ADR-0701, decision 96) and join `homeDir()` with
`Epicenter`.

An existing directory at the default is opened as found: a dev build's
leftovers, a restored backup, and another program's files are treated alike.
`apps/epicenter/AGENTS.md` refuses first-use persistence and collision
suffixes for these defaults.

## Decision

**One `root` key names the library root, and every program reads it.**

```txt
EPICENTER_FOLDER_DIR, when set     wins, for apps, the CLI, and Epicenter
the root key, when present         written only by Epicenter's "Move library…"
~/Epicenter                        otherwise  (development builds: ~/Epicenter Dev)
```

A standalone app reads the key without Epicenter installed; absent, it
uses the default. The root is a plain directory, never a repository
(`admission.rs` keeps refusing it as one).

**A relative `folder` resolves against the root; an absolute one is used as written.**

```txt
<AppData so.epicenter.whispering>/settings.md
  folder: Whispering                      → <root>/Whispering
  folder: /Volumes/Archive/Whispering     → used as written
```

Epicenter's registered-folder list in global Git configuration
(`epicenter.folder`, `packages/cli/src/sync/setup.ts`) follows the same rule for
folders under the root.

**The app writes `folder` after the first successful open of its default.**
The value is relative (`Whispering`). From then on a missing folder reaches the
existing recovery (`Missing`) with "Locate…" and "Open existing folder…", never
a new empty folder.

**Before its first write, the app inspects the default folder.**

| What is there | What happens |
| --- | --- |
| nothing, or an empty directory | the app uses it |
| files that pass the app's contract check, or an `AGENTS.md` naming its contract ([ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md)) | the app opens it; notes that do not read are listed for repair |
| anything else | the app asks "Use this folder" or "Choose another", showing the path |

No folder name gets a suffix.

**Changing the root is Epicenter's "Move library…".** It moves the folders,
then writes the `root` key. Relative `folder` values follow without any app
changing. Folders outside the root stay where they are.

**A folder may live outside the root.** "Open existing folder…" (today
"Choose data folder…", `pickDataFolder`) records its absolute path and never
moves files.

**Epicenter warns when the root is inside Dropbox, iCloud Drive, or OneDrive.**
Git and a second file-syncing service on one `.git` directory corrupt it.

## Consequences

- A moved or renamed folder produces a "Locate…" screen instead of an empty
  app; one AppData value per app makes that possible.
- Moving the whole library is one key plus a directory move; apps,
  the CLI, and Epicenter's list agree afterward.
- First launch asks a question only when the default holds unrecognized
  files. Every other first launch asks nothing.
- A title change ([ADR-0710](0710-a-contracts-title-names-everything-a-person-reads.md)) leaves existing folders at their old label,
  because the remembered value wins over the default.

## Considered alternatives

- **One repository at `~/Epicenter` holding every app's folder.** One history
  and one remote, but purging a private file rewrites every app's history, a
  stuck sync stops every app, and sharing one app means sharing all.
- **A `Whispering-2` suffix on collision.** Starts a second history silently
  while the person believes they reopened the first.
- **No remembered folder.** Moving the default before reopening creates an
  empty app; recovery depends on the person knowing to choose the moved folder.
- **Absolute paths only.** Moving the library means rewriting every app's
  AppData and Epicenter's list; an app that is not running cannot update.
- **A root that cannot move.** The default suits most people, but a library on
  another volume would then require every folder to be absolute.
