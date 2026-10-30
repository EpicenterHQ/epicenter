# 0607. An app opens any data folder by its id, on every host

- **Status:** Superseded
- **Date:** 2026-10-17
- **Superseded by:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md): the full desktop app platform; only a local built-app runner over chosen data repositories remains, without source installation, build approvals, or general native services.
- **Amends:** [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) at principle 7, "A window opens exactly the folder it was handed, on exactly the build it opened on", the bold "an app is code the host hands one folder", and the diagram's "handed exactly one", "windows: label -> one commit, one folder", and "+ one folder, for its lifetime": principle 7 reads "A window runs exactly its build", and an app opens folders by id. [ADR-0586](0586-you-open-a-folder-never-an-app.md) at "On the desktop every app window is handed a folder and never looks for one", `openFolder({ definition })` opening the folder `window_folder` answers, the admit rule's `label "app:..."  its handed folder` and "an app window opens the folder it was handed", "Kept: `Folders::hand` and `window_folder`", a browser app's "one fixed folder directory per origin" and "Several folders in one browser origin are deferred", and the consequence "the app gets the folder it is handed": an app window is admitted to every data folder, the launcher names the folder on the app's URL, and a browser origin holds several folders; the name rule, the folder id as directory name, a new opening choosing the app `epicenter.json` names, the generic editor, and installing's first folder stand. [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at "An app opens the folder it was handed" and "on the desktop the shell decides which folder a window opens (`Folders::hand`, `window_folder`), never the page's URL": an app opens any folder by id, and the launcher names the first one on the URL; opening with the app's own definition and never reading `epicenter.json` stand. [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md) at "an app window reaches only the folder it was handed", "which ADR-0586 reduces to one: an app window opens the folder it was handed", and "no window reaches a folder it was not handed": an app window reaches every data folder; Epicenter keeping no folder stands. [ADR-0570](0570-every-installed-apps-window-gets-the-same-grant.md) at "an app window reaches only the folder it was handed", as ADR-0587 restated it. [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at the rename of `WindowFolder.folder` to `folderId`: `WindowFolder` is deleted, so nothing is renamed.
- **Amended by:** [ADR-0610](0610-on-macos-epicenter-deletes-a-file-by-moving-it-to-the-trash.md) at the consequence "Files a folder's `.gitignore` ignores, such as Whispering's audio (ADR-0592), and changes not yet committed are gone once a page deletes them, since a storage deletion keeps no copy": on the desktop a deleted file goes to the macOS Trash, and in a browser tab a deletion stays permanent.
- **Relates:** [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) (installing trusts the author fully, and no build is sandboxed), [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md) (a window keeps its build), [ADR-0165](0165-browser-origins-contain-independent-epicenter-replicas.md) (each browser origin holds its own replica), [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) (a folder's id is its directory name and its repository name, and a reference is a relative path).
- **Unbuilt:** all of it: the shell admitting an installed app's window to every data folder; the launcher's `?folder=<id>` and `openFolder` keeping it in `sessionStorage`; several folders in one browser origin with the default folder named by the app's address; and the removal of the fence: `admit_installed_window` (`apps/epicenter/src-tauri/src/data_folders.rs:94-110`), the scopes registered for the Folders window alone (`register_own_folder`, `:178-184`, and the `data:<name>` registration, `:250-255`), `permitted` and `WindowNotPermitted` (`dda3b5cdaa57:packages/tauri-plugin-epicenter-folder/core/src/registry.rs`), the one handed folder per label (`Folders.handed` and `hand`, `packages/tauri-plugin-epicenter-folder/src/lib.rs:85`, `:106-112`), `window_folder`, `WindowFolder`, `handedFolder`, and the test `a_registered_data_folder_is_granted_to_the_folders_window_alone` (`data_folders.rs:813-822`).

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

On the desktop a window reaches one folder. `open_installed_window`
(`apps/epicenter/src-tauri/src/lib.rs:808-817`) calls
`admit_installed_window` (`apps/epicenter/src-tauri/src/data_folders.rs:94-110`),
which permits the window's label into the folder's scope and `so.epicenter`
(`Folders::permit`) and hands it a `WindowFolder { app, folder }`
(`Folders::hand`). The page asks `window_folder`
(`packages/tauri-plugin-epicenter-folder/src/commands.rs:48`), and
`handedFolder` (`9d13dd25854e:packages/folder/src/tauri-adapter.ts`) refuses a
window running another app as `AppMismatch`. Any other scope is refused by
the per-window scope registry: `grant` goes through `permitted`
(`dda3b5cdaa57:packages/tauri-plugin-epicenter-folder/core/src/registry.rs`),
which answers `WindowNotPermitted`. A data folder's scope, `data:<name>`, is
registered for the Folders window alone (`data_folders.rs:250-255`). The
window label encodes the folder (`installed_window_label`, `lib.rs:679-688`).

[ADR-0586](0586-you-open-a-folder-never-an-app.md) keeps this fence in a
smaller form, `admit(label, name)`, where an app window opens "its handed
folder", and [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md)
states it as principle 7.

In a browser tab there is no fence. `openFolder({ id })` opens the
directory named `id` at the root of the origin's private file system
(`9d13dd25854e:packages/folder/src/browser-adapter.ts`, header), whatever `id` is. A
probe of the browser opener held two folders, `crm` and `journal`, open in
one page, each with its own `epicenter.json`, `.git`, locks, and change
channel.

Two facts broke the fence. Installing trusts the author fully and the build
runs natively as the person, unsandboxed
([ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md)),
so an author's build script reads `~/Epicenter` with no window involved; the
fence guards nothing against an author. And the same app reached one folder
on the desktop and any folder in its origin in a tab.

## Decision

**An app opens any data folder it can reach by its id, by one rule in a
browser tab and on the desktop.** `openFolder({ id, definition })` takes the
folder's id, its directory name (ADR-0586): on the desktop a real, non-dot
directory directly in `~/Epicenter`; in a tab a directory at the origin's
OPFS root. What each reaches differs: a desktop window reaches every folder
in `~/Epicenter`, and a tab reaches only the folders cloned into its own
origin, since OPFS is per origin (ADR-0165).

**The shell admits an installed app's window to every data folder:**

```txt
admit(label, name):
  name is one path segment, not a dot entry, naming a real directory directly in the Epicenter folder
  label "app:..."            admitted
  otherwise                  refused
```

**A window runs exactly its build.** Principle 7 of
[ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md)
reads: A window runs exactly its build (ADR-0588, ADR-0605).

**The launcher opens a folder in the app its `epicenter.json` names, and
names the folder on the app's URL:**

```txt
epicenter-app://<app host>/?folder=todos      the Folders window opening ~/Epicenter/todos/ in its app (ADR-0605's host)
```

- `openFolder({ definition })` with no `id` opens the window's folder. It
  reads `folder` from the URL the first time the window loads and keeps it
  in `sessionStorage`, which belongs to that one window or tab, so a reload
  or the app's own navigation reopens the same folder and the author carries
  nothing through their routes. With neither, it opens the app's default
  folder. The app may open more folders by id.
- `app` in `epicenter.json` is the launcher's default. Another app that
  understands a folder's tables may open it.
- The window label keeps the folder it was launched on, so launching a
  folder already open in its app reveals that window (ADR-0588); the label
  no longer limits what the window reaches.
- "Show files" still opens any folder in the generic editor (ADR-0586).

**A browser origin holds several folders.** In a tab with no `folder`
parameter, the app opens its default folder, named by the app's name (the
last segment of its address with a leading `app-` removed, ADR-0605) as
installing names the first folder (ADR-0586), or makes it from its
template: `github.com/alice/app-kanban` opens `kanban`.

Deleted: `admit_installed_window`'s one folder, the Folders-window-only
registrations, `permitted`'s `WindowNotPermitted` for an app window,
`Folders.handed`, `Folders::hand`, `window_folder`, `WindowFolder`,
`handedFolder`, and `AppMismatch`.

## Consequences

- On the desktop every installed app reads and writes every folder in
  `~/Epicenter`; in a tab it reads and writes the folders cloned into its
  origin.
- Removing the fence gives up containment against a bug in an app's page
  or a later compromise of it: one app's page can damage or delete another
  app's folder. Git recovers only committed, tracked content. Files a
  folder's `.gitignore` ignores, such as Whispering's audio (ADR-0592), and
  changes not yet committed are gone once a page deletes them, since a
  storage deletion keeps no copy.
- Naming a folder follows one rule in both runtimes, so an app's folder code
  has no desktop branch for which folder it may open.
- A folder its app has never written holds no table directories yet, so
  another app opening it by id with its own definition finds no rows until
  one is written (ADR-0585).

## Considered alternatives

- **Keep the fence (ADR-0586's handed folder).** The author's build runs
  natively as the person, so the fence stops only the page, and it made the
  desktop and the tab two models.
- **Fence folders in the browser too.** A tab already reaches only its own
  origin's clones (ADR-0165). A second fence among those would live in the
  library, which runs as the app's own code, so the app could skip it.
- **Ask the person before an app opens a second folder.** The app's build
  already ran with the person's whole account, so the prompt protects
  nothing the install did not hand over.
