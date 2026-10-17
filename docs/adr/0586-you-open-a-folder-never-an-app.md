# 0586. You open a folder, never an app

- **Status:** Proposed
- **Date:** 2026-10-17
- **Amends:** [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) at the desktop address `~/Epicenter/so.epicenter.todos/`: a folder's directory name is the person's. [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) at "named by Epicenter's id as every app's folder is named by its id", the tree's `so.epicenter.todos/` and `Apps/<app-id>/`, and "`Apps/` is beside it, and the folder listing skips it": installed apps live in app data. [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) at "clones it into `~/Epicenter/Apps/<app-id>/`" and the manifest: the clone is in app data and the installer reads `template/epicenter.json`. [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at "`so.epicenter.todos` stays itself" and "clones each into `~/Epicenter/<name>`, where its app looks for it": no app looks; the clone's `epicenter.json` names its app. [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md) at the `~/Epicenter/Apps/<app-id>/` tree and an installed app opened without a folder being handed `<folder_dir>/<app-id>`: every window is handed a folder. [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at `epicenter.app.json`, `parseManifest`, "Each app imports its id from its own `epicenter.app.json`", and the Folders window offering every app on every folder: the manifest folds into the template, and the Folders window lists folders. [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md) at `~/Epicenter/Apps/`: the clones are in `<data_dir>/apps/`. [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at `openFolder({ app, definition })` and `WindowFolder.app`: the opener takes no `app`, and `window_folder` answers the folder alone.
- **Relates:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) (`app` in `epicenter.json`, templates, the folder listing); [ADR-0574](0574-an-app-opens-its-folder-behind-await-and-provides-its-options-through-context.md), which is Proposed and changes in place when this is accepted: `<FolderApp definition>` takes no manifest and no app id.
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

**The Folders window lists folders, not apps.** Each folder shows the title
and icon of the installed app its `epicenter.json` names in `app`; opening
it opens that app's window handed that folder. A folder with no
`epicenter.json`, or no `app`, opens in the Folders window's generic editor.
A folder whose `app` is not installed on this machine, as after a clone,
shows the app id it needs and opens in the generic editor meanwhile.

**On the desktop every app window is handed a folder and never looks for
one.** `openFolder({ definition })` opens the folder `window_folder`
answers. Deleted:

- the `{ app }` option of `openFolder`, the window check in `handedFolder`,
  and `AppMismatch`;
- `WindowFolder.app`: `window_folder` answers the folder alone;
- `own_folder`, `register_own_folder`, and the scope named by an app's id
  (`data_folders.rs`), so the shell creates no directory for an app;
- `TODOS_FOLDER_ID`, `CAPTURE_FOLDER_ID`, `HONEYCRISP_FOLDER_ID`, and
  `WHISPERING_FOLDER_ID`, and ADR-0560's app ids as folder ids;
- `<FolderApp>`'s `app` prop: the root page is
  `<FolderApp definition={todosDefinition}>`.

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
(`apps/todos/src/lib/platform/auth.browser.ts`).

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

**Epicenter's own folder keeps its fixed directory name,
`~/Epicenter/so.epicenter/`.** It is the one folder found by a fixed name,
because the built-in Settings page and every installed app window read its
`connections` table (ADR-0557, ADR-0570) without a person picking it.
Nothing renames it or searches for it by `app`.

**Open question:** whether the Folders window keeps "Open with" for any
installed app beside opening a folder in the app it names. `window_folder`
hands any folder to any window, so keeping it costs one menu.

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
