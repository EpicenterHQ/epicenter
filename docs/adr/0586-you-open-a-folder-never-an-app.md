# 0586. You open a folder, never an app

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) at the desktop address `~/Epicenter/so.epicenter.todos/`: a folder's directory name is the person's. [ADR-0535](0535-an-existing-folder-opens-with-its-own-declaration.md) at "Each is named by a scope": a folder's id is its directory name, admitted by one rule. [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) at the tree's `so.epicenter.todos/` and `Apps/<app-id>/` and "`Apps/` is beside it": installed apps live in app data. [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at "`so.epicenter.todos` stays itself" and "clones each into `~/Epicenter/<name>`, where its app looks for it": no app looks, and a clone takes a free name. [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md) at the `~/Epicenter/Apps/<app-id>/` tree: the clone is in app data. [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at "The Folders window offers every installed app that can run on every data folder": a new opening chooses the app a folder's `epicenter.json` names. [ADR-0568](0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md) at "two scopes on one root": one name reaches a root, and the mutex stays per canonical root. [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md) at `~/Epicenter/Apps/`: the clones are in `<data_dir>/apps/`. [ADR-0581](0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md) at each command's `scope` argument: it is a folder name. [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at `openFolder({ app, definition })` and `WindowFolder.app`: the opener takes no `app`, and `window_folder` answers the folder alone.
- **Amended by:** [ADR-0597](0597-an-installed-apps-approved-commit-is-its-bare-clones-detached-head.md) at `approvals.json` in its app-data tree: there is no such file; the approved commit is each bare clone's detached `HEAD`.
- **Amended by:** [ADR-0601](0601-the-generic-editor-edits-a-files-text-so-a-row-is-repaired-there.md) at "The generic editor is its own app": it edits any file's text, so an invalid row is repaired there on the desktop, and an app that runs in a browser keeps its own repair.
- **Relates:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) (`app` in `epicenter.json`, templates, the folder listing); [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md) (Epicenter keeps no folder, so `admit` names none); [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md) (every commit that runs is approved); [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) (an app is named by its address).
- **Unbuilt:** all of it.

## Context

An app opens first, and a folder follows from it. Opening an installed app
with no folder hands its window `<folder_dir>/<app-id>`
(`data_folders::own_folder`, called from
`apps/epicenter/src-tauri/src/installed_apps.rs:234`), which the first grant
creates (`register_own_folder`, `apps/epicenter/src-tauri/src/data_folders.rs:183`).
The page opens it with `openFolder({ app, definition })`; `handedFolder`
(`packages/folder/src/tauri-adapter.ts:88-104`) refuses a window that runs
another app as `AppMismatch` (`packages/folder/src/errors.ts:257`). The
shell's reply is `WindowFolder { app, folder }`
(`packages/tauri-plugin-epicenter-folder/src/lib.rs:71`). `<FolderApp>`
(`packages/svelte/src/folder-app.svelte`) takes `app={manifest}` and passes
`manifest.id` on. App ids are folder ids: `TODOS_FOLDER_ID`
(`apps/todos/src/lib/definition.ts:14`) and `WHISPERING_FOLDER_ID`
(`apps/whispering/src/lib/workspace/types.ts:45`) read `manifest.id` from
each app's `epicenter.app.json`, and Capture and Honeycrisp pass
`manifest.id` through `<FolderApp>`.

An app's id and title live in `epicenter.app.json`, which `parseManifest`
reads (`packages/cli/src/installed-apps.ts:163`), and its tables live in
`defineFolder` in code: two sources for one app. Installed apps are full
clones in `<folder_dir>/Apps/<app-id>/` (`apps_dir` and `APPS_DIRECTORY`,
`apps/epicenter/src-tauri/src/app_data.rs:81-88`; `APPS_DIRECTORY` and
`appsDir`, `packages/cli/src/app-paths.ts:32`, `:85`), each with
`node_modules` from `bun install` at its root (ADR-0552).

The shell admits windows to folders through a per-window scope registry
(`FolderKind`, `FolderConfig`, `ScopeConfig`, `register`, `permit`, and
`windows` in `packages/tauri-plugin-epicenter-folder/core/src/registry.rs`).
The Folders window holds a folder grant only because the generic editor
runs inside it.

ADR-0585 makes `app` in `epicenter.json` the link from a folder to its app,
makes every folder from its app's template, and lists every real, non-dot
directory in the Epicenter folder as a folder, which would list `Apps/`.

## Decision

**A new opening of a folder chooses the app its `epicenter.json` names.** A
folder with no `epicenter.json`, or one that names no `app`, opens in the
generic editor, which is the default app, not an exception. A folder whose
`app` is not installed on this machine, as after a clone, offers to install
it from that address (ADR-0589). "Open in" and "Open with…" go:
`installedOpeners` and `apps/epicenter/src/folders/openers.ts` with its
test, the menu in `apps/epicenter/src/folders/App.svelte`, and the Apps
list's opening of an app with no folder. "Open in…" may return later as a
file association.

**The generic editor is its own app, and the Folders window holds no
folder grant.** The editor moves out of `apps/epicenter/src/folders/`
(`FolderView.svelte` and the files it uses) into `apps/editor`, and runs in
an ordinary app window handed one folder. Every folder has a fixed "Show
files" action that opens it in the editor, whatever its `epicenter.json`
names. The Folders window lists folders, reading each `epicenter.json` in
Rust as it does today
(`apps/epicenter/src-tauri/src/data_folders.rs:219-226`), and opens each
folder in its app's window or the editor's.

**On the desktop every app window is handed a folder and never looks for
one.** `openFolder({ definition })` opens the folder `window_folder`
answers. Deleted:

- the `{ app }` option of `openFolder`, the window check in `handedFolder`,
  and `AppMismatch`;
- `WindowFolder.app`: `window_folder` answers the folder alone;
- `TODOS_FOLDER_ID` and `WHISPERING_FOLDER_ID`, and ADR-0560's app ids as
  folder ids;
- `<FolderApp>`'s `app` prop: the root page is
  `<FolderApp definition={todosDefinition}>`.

**The shell admits a window to a folder by one rule, `admit(label,
name)`, in place of the per-window scope registry:** an app window opens
the folder it was handed. A folder's id is its directory name, such as
`todos`; the `data:` prefix goes. Every storage and history command takes
that name as its folder id (today `scope`; renamed before the first
release by ADR-0584).

```txt
admit(label, name):
  name is one path segment, not a dot entry, naming a real directory directly in the Epicenter folder
  label "app:..."            its handed folder
  otherwise                  refused
```

- Deleted: `FolderKind`, `FolderConfig`, `ScopeConfig`, `register`,
  `permit`, `windows`, `permitted`, and `UnknownScope`
  (`packages/tauri-plugin-epicenter-folder/core/src/registry.rs`); the
  plugin's `register` and `permit` wrappers
  (`packages/tauri-plugin-epicenter-folder/src/lib.rs:91-97`);
  `DataFolderScopes`, `own_folder`, `register_own_folder`, and the
  registration branches of `list_in` (`data_folders.rs`), so the listing is
  a `read_dir` of names and descriptions; the own-folder fallback in
  `installed_apps.rs:234`; `epicenter-folder:default` in the Folders
  window's capability file.
- Kept: `Folders::hand` and `window_folder`; `grant`, which never creates a
  directory, so a missing folder is `Missing` and `prepare_directory` loses
  its `create` parameter (`core/src/root.rs:30`); `resolve_root` and
  `verify_layout`; the canonical-root cache; `admit_page_work`; one
  publishing mutex per canonical root, since `Todos` and `todos` name one
  directory on a case-insensitive disk; the shutdown fence.
- New: the change watcher sends a folder's changes to the windows granted
  that folder, recorded at grant and dropped when the page ends or the
  window closes, in place of `registry.windows(scope)`
  (`changed_reporter`, `packages/tauri-plugin-epicenter-folder/src/lib.rs:150-161`).

No window that can reach folders loads content Epicenter did not build:
the capability files that grant `epicenter-folder:default` are
`"local": true` with no remote URLs, every window loads
`epicenter-app://localhost`, and the scheme serves every document with
`default-src 'self'` (`apps/epicenter/src-tauri/src/scheme.rs:268`). The
label is a sufficient key for the rule.

**Installing an app makes its first folder from its template,** named by
the last segment of its address: installing `github.com/EpicenterHQ/todos`
makes `~/Epicenter/todos/`. When a directory of that name exists,
installing offers "New todos folder" under another name. "New todos
folder" makes a folder from the template under a name the person gives.
Two folders of one app are two entries in the Folders window. Nothing
searches for an app's folder or remembers a last-opened folder.
`epicenter clone` whose default directory is taken, including by a name
that differs only in case (`packages/cli/src/repository-commands.ts:155-157`),
clones into a free name.

**A standalone browser app opens first, because its origin is its only
folder's address** (ADR-0165): it opens the folder in its origin's storage,
or makes one from its template when there is none. It uses one fixed
folder directory per origin, where `openAnyFolder` names the directory by
the app id today (`packages/folder/src/browser-adapter.ts:136`). Several
folders in one browser origin are deferred.

**An app is named by its address and installed as a repository of built
files** (ADR-0589). The manifest, reverse-domain ids, and the install-time
build go there.

**Installed apps live in app data:**

```txt
~/Library/Application Support/so.epicenter/   <data_dir>
  approvals.json
  apps/<encoded address>/                     a clone of the app's built repository
```

What only Epicenter writes and only this machine needs lives in app data
(ADR-0539). The clones qualify: the CLI writes them, and ADR-0569 removed
the rows that carried a person's apps to another machine. `apps_dir`
becomes `data_dir.join("apps")` in `app_data.rs`, and `appsDir` becomes
`join(dataDir, 'apps')` in `app-paths.ts`.

**A repository's name is its folder's name.** Connect proposes the directory
name (ADR-0546), so `~/Epicenter/todos/` proposes
`git.epicenter.so/<namespace>/todos.git`, and no app id appears in the URL.

## Consequences

- A person names their folders, and the names reach their repositories.
  Two Todos lists are two folders, with no `so.epicenter.todos.work`.
- Opening a folder needs no ownership, search, or recency rule: the folder
  says which app it wants, and the app gets the folder it is handed.
- The Epicenter folder holds only folders a person reads; every app clone
  leaves it.
- The `window_folder` change lands before the first release, with
  ADR-0584's renames (ADR-0589).
- Whispering's global shortcut records while its window is hidden
  (ADR-0563). Today a person has one Whispering folder; which folder the
  shortcut records into once there are two is deferred to Whispering's move
  onto `<FolderApp>`.
- Follow-up: the shell stops naming Whispering. It serves the dictation
  overlay from a hard-coded path (`NAVIGATION_PREFIX`,
  `apps/epicenter/src-tauri/src/overlay.rs:26`), keeps the overlay's label
  in step with Whispering's window manager (`overlay.rs:22-24`), and
  generates its whole page API into
  `apps/whispering/src/lib/tauri/bindings.gen.ts` (`WHOLE_API`,
  `apps/epicenter/src-tauri/src/lib.rs:183-186`); all three go.
- Forks: a person forks an app's source, publishes it to their own
  address, and maps the original address to it with ADR-0589's machine-local
  substitution, so their folders, which keep the original `app`, open in
  the fork.
- No released build reads these directories, so nothing moves an existing
  `Apps/` or renames an app-named folder; a development machine reinstalls
  its apps.

## Considered alternatives

- **The folder name is the link: one folder per app, named by its
  reverse-domain id.** A person cannot name their folder, a second folder
  of one app needs an invented id, and the app id becomes every repository's
  name.
- **Search folders by `app`, open the most recent, prompt on collision.**
  Opening an app would open a folder the person did not choose, the last
  opened folder is per-machine state to keep, and two folders of one app
  mean a prompt or a hidden choice on every launch.
- **Keep "Open with…" for any installed app.** No app reads another app's
  folder today, and a second way to choose an app for a folder is not worth
  keeping until a viewer app exists.
- **Keep `Apps/` in the Epicenter folder and skip it in the listing.** An
  exception to "every directory is a folder", and app clones stay in a
  directory a person browses and backs up.
