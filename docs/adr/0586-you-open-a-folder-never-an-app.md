# 0586. An app is independent of its data location

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) at the desktop address `~/Epicenter/so.epicenter.todos/`: a folder's directory name is the person's. [ADR-0535](0535-an-existing-folder-opens-with-its-own-declaration.md) at "Each is named by a scope": a folder's id is its directory name, admitted by one rule. [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) at the tree's `so.epicenter.todos/` and `Apps/<app-id>/` and "`Apps/` is beside it": installed apps live in app data. [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at "`so.epicenter.todos` stays itself" and "clones each into `~/Epicenter/<name>`, where its app looks for it": no app looks, and a clone takes a free name. [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md) at the `~/Epicenter/Apps/<app-id>/` tree: the clone is in app data. [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at "The Folders window offers every installed app that can run on every data folder": a new opening chooses the app a folder's `epicenter.json` names. [ADR-0568](0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md) at "two scopes on one root": one name reaches a root, and the mutex stays per canonical root. [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md) at `~/Epicenter/Apps/`: the clones are in `<data_dir>/apps/`. [ADR-0581](0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md) at each command's `scope` argument: it is a folder name. [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at `openFolder({ app, definition })` and `WindowFolder.app`: the opener takes no `app`, and `window_folder` answers the folder alone.
- **Amended by:** [ADR-0597](0597-an-installed-apps-approved-commit-is-its-bare-clones-detached-head.md) at `approvals.json` in its app-data tree: there is no such file; the approved commit is each bare clone's detached `HEAD`.
- **Amended by:** [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) at "installed as a repository of built files", `approvals.json` and "a clone of the app's built repository" in its app-data tree, and "every window loads `epicenter-app://localhost`": an installed app is the person's clone of its source, and its window loads its app's own host; and at installing's first folder "named by the last segment of its address": it is named by the app's name, the last segment with a leading `app-` removed.
- **Amended by:** [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md) at "On the desktop every app window is handed a folder and never looks for one", `openFolder({ definition })` opening the folder `window_folder` answers, the admit rule's handed folder, "Kept: `Folders::hand` and `window_folder`", a browser app's one fixed folder directory per origin, and "the app gets the folder it is handed": an app window is admitted to every data folder, the launcher names the folder on the app's URL as `?folder=<id>`, and a browser origin holds several folders.
- **Amended by:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) at mandatory app association, source installation, and its generic editor as an installed app: the data browser lists disk clones and may open a chosen local built app over a selected clone.
- **Relates:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) (`app` in `epicenter.json`, templates, the folder listing); [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md) (Epicenter keeps no folder, so `admit` names none); [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md) (every commit that runs is approved); [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) (an app is named by its address).
- **Unbuilt:** independent app integration and migration of the legacy launcher; the Epicenter desktop app and its runner remain deferred under ADR-0635.

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

**An app and the local data it opens have independent locations and lifetimes.**
An app can open compatible data chosen by the person. Making local data does
not install an app, and launching an app does not require an Epicenter-owned
data root. A directory name, reverse-domain app ID, or schema file does not
establish ownership of that data.

**A local dataset is selected independently of any hosted repository.**
Its identity survives sign-in, sign-out, remote selection, and an app update
(ADR-0633). On disk its folder can have any name; a hosted repository's label
is not its local path or stable service ID (ADR-0612).

**The Epicenter desktop app is an optional later client.**
Its browsing and runner workflow follow ADR-0635. Independent desktop apps,
web apps, and the CLI require neither the Folders window nor an installed-app
association to open data.

## Consequences

- Whispering can save local data before choosing a remote or an account.
- Several compatible apps can use the same files without being installed
  through Epicenter. Web origins retain separate local storage.
- No app association, source installer, build approval, or template is
  inferred from the contents of epicenter.json.
