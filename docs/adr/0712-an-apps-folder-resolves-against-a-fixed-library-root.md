# 0712. An app's folder resolves against a fixed library root

<!-- doc-path-check: ignore-file (cites the waiting folder sync product (ADR-0840), kept at tag folder-sync-product) -->

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Amends:** [ADR-0701](0701-apps-run-as-separate-programs.md) at decision 96's removal of `EPICENTER_FOLDER_DIR` for standalone apps and at remembering only a chosen folder: every program uses one fixed root per environment, `EPICENTER_FOLDER_DIR` overrides it only in tests, and an app remembers the folder it first opened, always as a name under the root; [ADR-0670](0670-native-shells-share-explicit-machine-local-app-homes.md) at its remembered folder: an app also remembers the default after its first open.
- **Amended by:** [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) at the remembered `folder` value, the other-name choice after a collision, and "Open existing folder…": no location is stored, a first launch is read from AppData's absence, and apps choose no folder.; [ADR-0728](0728-a-build-states-its-environment.md) at `EPICENTER_FOLDER_DIR` for standalone apps: the standalone shell reads no such variable.
- **Unbuilt:** a warning when the library root is inside a file-syncing service.

## Context

A standalone app on `epicenter-standalone` opens `~/Epicenter/<productName>`,
made when missing, or the folder named by `folder` in its AppData
`settings.md` (`openDataFolder`, `packages/folder/src/desktop-folder.ts`). The
`folder` key is written only when the person picks a folder other than the
default (`pickDataFolder`). The default is computed again at every launch, so
a person who moves `~/Epicenter/Whispering` and reopens the app gets a new
empty folder at the old path, with no sign that their recordings exist
elsewhere.

The library root has three sources today. Epicenter's shell resolves
`EPICENTER_FOLDER_DIR`, else `~/Epicenter` or `~/Epicenter Dev` by bundle
identifier (`resolve_folder_root`, `apps/epicenter/src-tauri/src/desktop_paths.rs`).
The CLI resolves `folderDir` from the same variable (`packages/cli/src/app-paths.ts`).
Standalone apps ignore it (ADR-0701, decision 96) and join `homeDir()` with
`Epicenter`, including development builds.

An existing directory at the default is opened as found: a dev build's
leftovers, a restored backup, and another program's files are treated alike.

## Decision

**The library root is fixed per environment, and no program stores it.**

```txt
production builds     ~/Epicenter
development builds    ~/Epicenter Dev
tests                 EPICENTER_FOLDER_DIR, when set
```

Apps, the CLI, and Epicenter compute the same root. The root is a plain
directory, never a repository (`admission.rs` keeps refusing it as one).
Machine-wide state that programs share lives in `~/.epicenter` ([ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md)),
never in a root setting.

**Moving the library is a directory move plus a symlink.**

```sh
mv ~/Epicenter /Volumes/Archive/Epicenter
ln -s /Volumes/Archive/Epicenter ~/Epicenter
```

Every program keeps opening `~/Epicenter`. A later Epicenter command may run
these two steps for the person; it writes no setting. Paths are compared after
canonicalizing the root, since `resolve_folder` returns a picked folder's
canonical path.

**Everything a person owns is in the root, and a folder is always a name under it.**
An app's remembered `folder` is a name, never a path:

```txt
<AppData so.epicenter.whispering>/settings.md
  folder: whispering                      → <root>/whispering
  folder: whispering-personal             → <root>/whispering-personal, a name picked after a collision
```

**A folder that lives elsewhere is a symlink inside the root.** Epicenter and
every app follow the link like any directory; links are not a feature with its
own setting.

```sh
ln -s ~/Documents/Vault ~/Epicenter/notes
epicenter link ~/Documents/Vault notes     # the same link, made by the CLI
```

"Add folder…" in Epicenter runs `epicenter link`. Forgetting a folder removes
the link and leaves the files. When the link's target is missing, as on an
unplugged drive, the app says "This folder is on a drive that isn't
connected." `resolve_folder` canonicalizes paths, so the shell grants the
link's target.

**The app writes `folder` after the first successful open of its default.**
The value is the slug (`whispering`, [ADR-0710](0710-an-apps-slug-names-everything-a-program-reads.md)). From then on a
missing folder reaches the existing recovery (`Missing`) with "Locate…" and
"Open existing folder…", never a new empty folder.

**Before its first write, the app inspects the default folder.**

| What is there | What happens |
| --- | --- |
| nothing, or an empty directory | the app uses it |
| files that pass the app's contract check, or an `AGENTS.md` naming its contract ([ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md)) | the app opens it; notes that do not read are listed for repair |
| anything else | the app asks "Use this folder" or "Choose another", showing the path; "Choose another" takes a name under the root or an existing folder, which becomes a link |

No folder name gets a suffix. Two apps sharing a slug meet here.

**Onboarding shows the folder and asks nothing.** The first launch says "Your
recordings are files in ~/Epicenter/whispering" with "Show in Finder". There
is no choice between this folder and the app's AppData.

**Epicenter warns when the root is inside Dropbox, iCloud Drive, or OneDrive.**
Git and a second file-syncing service on one `.git` directory corrupt it.

## Consequences

- A moved or renamed folder produces a "Locate…" screen instead of an empty
  app; one AppData value per app makes that possible.
- Agents and Finder see every folder in one tree, including folders stored on
  other drives.
- No program stores a list of folders; scanning the root finds them all.
- No program reads another program's files to learn the root.
- Time Machine backs up the symlink, not the library it points to; a library
  on another volume is backed up there.
- On Windows a symlink needs developer mode; a directory junction serves
  instead.
- First launch asks a question only when the default holds unrecognized
  files. Every other first launch asks nothing.

## Considered alternatives

- **A stored root setting with a "Move library…" command.** Every app reads
  another program's file to find its own folder, and the setting duplicates
  what a symlink already does.
- **A pointer file read by every program (Dropbox's `info.json`).** One more
  file to find and parse before any app opens; the symlink needs none.
- **One repository at `~/Epicenter` holding every app's folder.** Purging a
  private file rewrites every app's history, a stuck sync stops every app,
  and sharing one app means sharing all.
- **A `whispering-2` suffix on collision.** Starts a second history silently
  while the person believes they reopened the first.
- **No remembered folder.** Moving the default before reopening creates an
  empty app.
- **Absolute paths only.** Moving the library breaks every remembered path.
- **Absolute `folder` paths beside relative ones.** Two kinds of folder, and a
  folder outside the root that agents and a root scan never see.
- **A registry of folders anywhere (Obsidian's `obsidian.json`, Syncthing).** A
  stored list that goes stale when a folder moves, no single tree for agents,
  and the question of where a new folder goes comes back.
- **An onboarding choice between this folder and the app's AppData.** A
  first-launch question, and two kinds of location to support.
