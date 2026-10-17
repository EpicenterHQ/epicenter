# 0586. You open a folder, never an app

- **Status:** Proposed
- **Date:** 2026-10-17
- **Amends:** [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) at the desktop address `~/Epicenter/so.epicenter.todos/`: a folder's directory name is the person's. [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) at the tree's `so.epicenter.todos/` and `Apps/<app-id>/`, and "`Apps/` is beside it, and the folder listing skips it": installed apps live in app data. [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) at "clones it into `~/Epicenter/Apps/<app-id>/`" and the manifest: the clone is in app data and the installer reads `template/epicenter.json`. [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at "`so.epicenter.todos` stays itself" and "clones each into `~/Epicenter/<name>`, where its app looks for it": no app looks; the clone's `epicenter.json` names its app. [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md) at the `~/Epicenter/Apps/<app-id>/` tree and an installed app opened without a folder being handed `<folder_dir>/<app-id>`: every window is handed a folder. [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at `epicenter.app.json`, `parseManifest`, "Each app imports its id from its own `epicenter.app.json`", and "The Folders window offers every installed app that can run on every data folder": the manifest folds into the template, a folder opens only in the app its `epicenter.json` names, and `installedOpeners` with "Open in" and "Open with…" goes. [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md) at `~/Epicenter/Apps/`: the clones are in `<data_dir>/apps/`. [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at `openFolder({ app, definition })` and `WindowFolder.app`: the opener takes no `app`, and `window_folder` answers the folder alone. [ADR-0535](0535-an-existing-folder-opens-with-its-own-declaration.md) at "Each is named by a scope: an application's folder by the application's own ... and any other by `data:<directory name>`": a folder's id is its directory name, admitted by one rule. [ADR-0568](0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md) at "two scopes on one root": one name reaches a root, and the mutex stays per canonical root. [ADR-0581](0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md) at each command's `scope` argument: it is a folder name.
- **Relates:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) (`app` in `epicenter.json`, templates, the folder listing); [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md) (Epicenter keeps no folder, so `admit` names none); [ADR-0574](0574-an-app-opens-its-folder-behind-await-and-provides-its-options-through-context.md), which is Proposed and changes in place when this is accepted: `<FolderApp definition>` takes no manifest and no app id.
- **Unbuilt:** all of it.

## Context

An app opens first, and a folder follows from it. Opening an installed app
with no folder hands its window `<folder_dir>/<app-id>`
(`data_folders::own_folder`, called from
`apps/epicenter/src-tauri/src/installed_apps.rs:255`), which the first grant
creates (`register_own_folder`, `apps/epicenter/src-tauri/src/data_folders.rs:183`).
The page opens it with `openFolder({ app, definition })`; `handedFolder`
(`packages/folder/src/tauri-adapter.ts:88-104`) refuses a window that runs
another app as `AppMismatch` (`packages/folder/src/errors.ts:257`). The
shell's reply is `WindowFolder { app, folder }`
(`packages/tauri-plugin-epicenter-folder/src/lib.rs:71`). `<FolderApp>`
(`packages/svelte/src/folder-app.svelte`) takes `app={manifest}` and passes
`manifest.id` on. App ids are folder ids: `TODOS_FOLDER_ID`,
`CAPTURE_FOLDER_ID`, `HONEYCRISP_FOLDER_ID`, and `WHISPERING_FOLDER_ID` read
`manifest.id` from each app's `epicenter.app.json`.

An app's id and title live in `epicenter.app.json`, which `parseManifest`
reads (`packages/cli/src/installed-apps.ts:155`), and its tables live in
`defineFolder` in code: two sources for one app. Installed apps are full
clones in `<folder_dir>/Apps/<app-id>/` (`apps_dir` and `APPS_DIRECTORY`,
`apps/epicenter/src-tauri/src/app_data.rs:81-88`; `APPS_DIRECTORY` and
`appsDir`, `packages/cli/src/app-paths.ts:31`, `:84`), each with
`node_modules` from `bun install` at its root (ADR-0552).

ADR-0585 makes `app` in `epicenter.json` the link from a folder to its app,
makes every folder from its app's template, and lists every real, non-dot
directory in the Epicenter folder as a folder, which would list `Apps/`.

## Decision

**A folder opens only in the app its `epicenter.json` names.** A folder
with no `epicenter.json`, or one that names no `app`, opens in the Folders
app's generic editor, which is the default app, not an exception. The
Folders window lists folders, not apps: each shows the title and icon of
the installed app it names, and opening it opens that app's window handed
that folder. A folder whose `app` is not installed on this machine, as after
a clone, shows the app id it needs and opens in the generic editor
meanwhile. "Open in" and "Open with…" go: `installedOpeners` and
`apps/epicenter/src/folders/openers.ts` with its test, the menu in
`apps/epicenter/src/folders/App.svelte`, and the Apps list's opening of an
app with no folder.

**On the desktop every app window is handed a folder and never looks for
one.** `openFolder({ definition })` opens the folder `window_folder`
answers. Deleted:

- the `{ app }` option of `openFolder`, the window check in `handedFolder`,
  and `AppMismatch`;
- `WindowFolder.app`: `window_folder` answers the folder alone;
- `TODOS_FOLDER_ID`, `CAPTURE_FOLDER_ID`, `HONEYCRISP_FOLDER_ID`, and
  `WHISPERING_FOLDER_ID`, and ADR-0560's app ids as folder ids;
- `<FolderApp>`'s `app` prop: the root page is
  `<FolderApp definition={todosDefinition}>`.

**The shell admits a window to a folder by one rule, `admit(label,
name)`, in place of the per-window scope registry.** A folder's id is its
directory name, such as `Todos`; the `data:` prefix goes. Every storage and
history command keeps its `scope` argument as that name, since the Folders
window reaches every folder.

```txt
admit(label, name):
  name is one path segment, not a dot entry, naming a real directory directly in the Epicenter folder
  label "folders"            any such folder
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
  a `read_dir` of names and titles; the own-folder fallback in
  `installed_apps.rs:255`.
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
the three capability files that grant `epicenter-folder:default`
(`folders.json`, `home.json`, `installed-app.json`) are `"local": true`
with no remote URLs, every window loads `epicenter-app://localhost`, and
the scheme serves every document with `default-src 'self'`
(`apps/epicenter/src-tauri/src/scheme.rs:265`). The label is a sufficient
key for the rule.

**Installing an app makes its first folder from its template,** named by the
app's title: installing Todos makes `~/Epicenter/Todos/`. When a directory
of that name exists, installing makes no folder. "New Todos folder" copies
the template into a new directory the person names. Two folders of one app
are two entries in the Folders window. Nothing searches for an app's folder,
resolves a collision, prompts for a choice, or remembers a last-opened
folder.

**A standalone browser app opens first, because its origin is its only
folder's address** (ADR-0165): it opens the folder in its origin's storage,
or makes it from its template when there is none. Several folders in one
browser origin are deferred.

**The manifest folds into the template.** `epicenter.app.json`, `MANIFEST`,
`Manifest`, `parseManifest`, and `readManifest`
(`packages/cli/src/installed-apps.ts`) are deleted. An app in a repository
is a folder holding `template/epicenter.json` with an `app` key, searched to
the same depth as today. The installer reads `app` and `title` from that
committed file with `git cat-file`, running no code, so it works before a
commit is approved (ADR-0540). An app's identity has one source,
`defineFolder({ app, title, tables })` in its code, which `epicenter
generate` writes into the template; apps import their id from their
definition, including Todos' OAuth `clientId`
(`apps/todos/src/lib/platform/auth.browser.ts`). After the approved
build, the installer runs `epicenter generate` in the approved checkout and
refuses to install when the result differs from the committed
`template/epicenter.json`, so on an installed machine the template and the
code name one id and title.

**Installed apps live in app data:**

```txt
~/Library/Application Support/so.epicenter/   <data_dir>
  approvals.json
  apps/<app-id>/                              a full clone, node_modules included
```

What only Epicenter writes and only this machine needs lives in app data
(ADR-0539). The clones qualify: the CLI writes them, ADR-0569 removed the
rows that carried a person's apps to another machine, and each carries
`node_modules`. `apps_dir` becomes `data_dir.join("apps")` in `app_data.rs`,
and `appsDir` becomes `join(dataDir, 'apps')` in `app-paths.ts`.

**A repository's name is its folder's name.** Connect proposes the directory
name (ADR-0546), so `~/Epicenter/Todos/` proposes
`git.epicenter.so/<namespace>/todos.git`, and no app id appears in the URL.

## Consequences

- A person names their folders, and the names reach their repositories.
  Two Todos lists are two folders, with no `so.epicenter.todos.work`.
- Opening a folder needs no ownership, search, or recency rule: the folder
  says which app it wants, and the app gets the folder it is handed.
- Being an app means making a kind of folder. A future app that only views
  other apps' folders still ships a template, one with no tables.
- `template/epicenter.json` in an app's source looks like a folder to the
  CLI's `check`, as it is: the folder every new one starts from.
- The Epicenter folder holds only folders a person reads; `node_modules`
  leaves it, along with every clone's history.
- Installed apps rebuild against the changed `window_folder` reply
  (ADR-0581).
- Whispering's global shortcut records while its window is hidden
  (ADR-0563). Today a person has one Whispering folder; which folder the
  shortcut records into once there are two is deferred to Whispering's move
  onto `<FolderApp>`.
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
- **Keep `epicenter.app.json` beside the template.** Two committed files
  carry the app's id and title, and they can disagree.
- **Keep `Apps/` in the Epicenter folder and skip it in the listing.** An
  exception to "every directory is a folder", and `node_modules` stays in a
  directory a person browses and backs up.
