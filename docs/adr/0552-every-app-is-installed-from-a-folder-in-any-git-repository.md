# 0552. Every app is installed, from a folder in any Git repository

- **Status:** Accepted
- **Date:** 2026-10-15
- **Amended by:** [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md) at "Whispering's recorder and global shortcuts, and Honeycrisp's terminal and 'reveal folder', are host functions": shortcuts come from the global-shortcut plugin, reveal is a folder action every window offers, and the terminal is refused.
- **Amended by:** [ADR-0557](0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md) at "AI settings live in `kv.json` in `so.epicenter`": AI connections are rows of a `connections` table in `so.epicenter`, read by every app, and which connection an app uses is the app's own setting.
- **Amended by:** [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at "`opens`, `build`, and `output` in `epicenter.app.json` are relative to that folder": the manifest is `id` and `title`, and the build is `bun run build:installed` in the folder, writing `dist/`.
- **Amended by:** [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md) at "every app is a row, and the row gains `folder`" and the `apps` row's `folder` that lets another machine install the same app: there is no row, and `epicenter.folder` in the clone is the only record of the folder.
- **Amended by:** [ADR-0586](0586-you-open-a-folder-never-an-app.md) at the `~/Epicenter/Apps/<app-id>/` tree: the clone is in `<data_dir>/apps/`.
- **Amended by:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at "installed from a folder in any Git repository", `epicenter.folder`, and `bun install` at the root: an app is a whole repository of built files at an address, built before it is published.
- **Relates:** updates [ADR-0493](0493-whisperings-only-desktop-shell-is-epicenter.md) (Whispering is an installed app), [ADR-0537](0537-epicenter-opens-to-your-folders-and-home-becomes-settings.md) (the Folders window offers installed apps only), [ADR-0538](0538-an-app-opens-any-folder-whose-declaration-contains-its-shape.md) (no built-in app to offer on other folders), [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) (every app is a row, and the row gains `folder`), and [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) (an app is a folder in a repository) in place, since all five are Proposed.
- **Built:** installing from a folder in a repository, recorded as `epicenter.folder` in the clone, with `bun install` at the root and the build in the folder, and listing the apps in a repository (`apps/epicenter/src-tauri/src/installed_apps.rs`); `epicenter.app.json` ([ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md)) and an installed build (`build:installed`) that writes `dist` with relative asset paths, in `apps/todos`, `apps/capture`, `apps/whispering`, and `apps/honeycrisp`, Honeycrisp opening the folder it is handed or its own (`apps/honeycrisp/src/routes/+page.svelte`, through `<FolderApp>`); "Install from a repository…" and "Install Todos" while no app is installed (`apps/epicenter/src/folders/InstallApps.svelte`); only `so.epicenter` refused; an installed app opened without a folder handed its own folder, `<folder_dir>/<app-id>` (`own_folder` in `apps/epicenter/src-tauri/src/data_folders.rs`); the Folders window opening Settings with `open_home`; native commands granted to an installed app by its app id (`installed-whispering-*` in `apps/epicenter/src-tauri/capabilities`, the rule in `apps/epicenter/README.md`); and the deletions below: Honeycrisp's standalone Tauri shell with its terminal, reveal, and per-file history commands, `build:honeycrisp`, and `test:native`; the built-in Whispering, Todos, Capture, Honeycrisp, Mail, and Books, `launch_application` and its capability files, `APPLICATION_FOLDERS` and its capability files, `FOLDER_OPENERS`, the placeholder pages, `build:whispering`, `build:todos`, and `build:capture`, `@epicenter/whispering` as a dependency of Epicenter, and `capture-application.test.ts`.
- **Unbuilt:** every other first-party app as an installed app; Honeycrisp's "reveal folder", a folder action under ADR-0555 (Honeycrisp's unreachable terminal and per-note history UI is deleted); deleting `test-apps-dist.ts`, which the server tests still use for the Folders window.

## Context

Epicenter compiles its apps in. The Rust shell names them in one closed enum,
`BuiltInApp` (`apps/epicenter/src-tauri/src/lib.rs:97-194`): Home, Whispering,
Honeycrisp, Capture, Mail, Todos, Books, Folders. Bun mirrors it as
<!-- doc-path-check: ignore-next-line (deleted with the Bun host in wave 3) -->
`BUILT_IN_ROUTES` (`apps/epicenter/src/routes.ts:29-38`) and
<!-- doc-path-check: ignore-next-line (deleted with the Bun host in wave 3) -->
`COMPILED_APPLICATIONS` (`apps/epicenter/src/applications.ts:69-74`). The
Folders window and Settings open them with `launch_application`
(`apps/epicenter/src-tauri/src/lib.rs:568`), which resolves an id against that
enum. Todos and Capture get their folders from `APPLICATION_FOLDERS`
(`apps/epicenter/src-tauri/src/data_folders.rs:62-74`). Mail and Books are
<!-- doc-path-check: ignore-next-line -->
placeholder pages (`apps/epicenter/src/placeholder-pages.ts`). Building
Epicenter builds Whispering, Capture, and Todos (`build:apps` in
`apps/epicenter/package.json:12`).

[ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md)
added a second model: an installed app, cloned into `~/Epicenter/Apps/<app-id>/`
and built there. Installing a built-in app's id is refused
(`app_id_problem`, `apps/epicenter/src-tauri/src/installed_apps.rs:141-148`).
ADR-0540 planned to move Todos and Capture into their own repositories so they
could be installed and forked.

That move does not work yet. The build runs
`bun install --frozen-lockfile --ignore-scripts` in the clone
(`apps/epicenter/src-tauri/src/installed_apps.rs:959-963`). Todos depends on
`@epicenter/folder`, `@epicenter/svelte`, `@epicenter/auth`,
`@epicenter/constants`, and `@epicenter/epicenter` as `workspace:*`
(`apps/todos/package.json`), none of them published. A standalone Todos
repository could not install until those packages are published, which brings
back release tooling for every package. At the monorepo root, Bun resolves
them from source: `@epicenter/folder`, `@epicenter/ui`, `@epicenter/svelte`, and
`@epicenter/definition` export `.ts` files directly, with no build step.

## Decision

**Epicenter ships with no apps installed.** Its own interface is the Folders
window, Settings, and installing apps. Todos, Whispering, Capture, Honeycrisp,
Vocab, and every other app are installed apps; none is compiled into
Epicenter's bundle.

**An app is a folder holding `epicenter.app.json` inside a Git repository.**
Installing names a repository and a folder within it; the folder defaults to
the repository root. `opens`, `build`, and `output` in `epicenter.app.json` are
relative to that folder. `bun install --frozen-lockfile --ignore-scripts` runs
at the repository root, where the lockfile is, and `build` runs in the folder.

```txt
https://github.com/EpicenterHQ/epicenter   folder apps/todos       id so.epicenter.todos
https://github.com/EpicenterHQ/epicenter   folder apps/whispering  id so.epicenter.whispering
https://github.com/someone/board           folder (root)           id com.example.board
```

**Pasting a repository URL lists every app found in it.** Epicenter clones the
repository into its staging directory, finds each tracked
`epicenter.app.json`, and shows each app's title and folder. Choosing one
installs it; choosing two installs two clones.

**Layout and trust stay as ADR-0540 has them.**

```txt
~/Epicenter/Apps/<app-id>/                     a full clone of the repository; the app is at its folder
~/Epicenter/Apps/<app-id>/.git/config          epicenter.folder = apps/todos   (the shell reads this)
~/Epicenter/so.epicenter/apps/<app-id>.md      title, source, folder, commit   (the page writes this)
~/Library/Application Support/so.epicenter/approvals.json   { [appId]: { commit, approvedAt } }
```

The folder is the only new datum. The shell keeps it in the clone's own Git
configuration as `epicenter.folder`, because the shell reads everything about
an installed app from its clone: `inspect` takes the source URL from `origin`
and the commit from `HEAD`
(`apps/epicenter/src-tauri/src/installed_apps.rs:677-727`) and never reads a
<!-- doc-path-check: ignore-next-line -->
row. The `apps` row in `so.epicenter` (`apps/epicenter/src/folders/epicenter-folder.ts:36-45`)
gains a `folder` field beside `source`, written by the page as it writes
`source`, so another machine can install the same app from the row. Approval
stays per app id and commit; the commit is the repository's `HEAD`.
Customizing is committing in the clone; updating is fetching.

**The empty Folders window offers "Install Todos".** It is the same install,
with `https://github.com/EpicenterHQ/epicenter` and `apps/todos` filled in, and
the same approval. Nothing is installed before a person asks.

**Apps that need native features get them from Epicenter's host, one
implementation each.** Whispering's recorder and global shortcuts, and
<!-- doc-path-check: ignore-next-line -->
Honeycrisp's terminal and "reveal folder" (`apps/honeycrisp/src-tauri/src/terminal.rs`,
<!-- doc-path-check: ignore-next-line -->
`apps/honeycrisp/src-tauri/src/reveal.rs`), are host functions an installed
app's window reaches. Honeycrisp's standalone Tauri shell
<!-- doc-path-check: ignore-next-line -->
(`apps/honeycrisp/src-tauri/`) is deleted as Whispering's is by ADR-0493.

**AI settings live in `kv.json` in `so.epicenter`**
([ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md)),
read by every app, not kept in each app.

## Consequences

Deleted:

- Six of `BuiltInApp`'s eight variants, with `is_launchable` and `is_hosted`
  (`apps/epicenter/src-tauri/src/lib.rs:97-194`, 98 lines); Folders and Home
  remain as Epicenter's own windows.
- `launch_application`, `launch_on_main_thread`, and `parse_application_id`
  (`apps/epicenter/src-tauri/src/lib.rs:540-622`, 83 lines), its handler
  wiring (`apps/epicenter/src-tauri/src/lib.rs:634`,
  `apps/epicenter/src-tauri/src/lib.rs:681`), `launchApplication`
  (`apps/epicenter/src/ui/runtime.ts:31`), and its capability files
  <!-- doc-path-check: ignore-next-line -->
  (`apps/epicenter/src-tauri/capabilities/launch-application-production.json`
  and its development twin, 22 lines). The Folders window opens Settings with
  `open_home` (`apps/epicenter/src-tauri/src/lib.rs:525`).
- Six of eight `BUILT_IN_ROUTES` entries and six route constants
  <!-- doc-path-check: ignore-next-line (deleted with the Bun host in wave 3) -->
  (`apps/epicenter/src/routes.ts:29-55`); the Whispering, Capture, and Todos
  <!-- doc-path-check: ignore-next-line (deleted with the Bun host in wave 3) -->
  entries in `apps/epicenter/src/applications.ts` and `LAUNCHABLE_APPLICATIONS`,
  leaving `COMPILED_APPLICATIONS` as the Folders window alone;
  `FOLDER_OPENERS` (`apps/epicenter/src/folders/openers.ts:52-64`).
- `APPLICATION_FOLDERS`, its registration, and its listing branch
  (`apps/epicenter/src-tauri/src/data_folders.rs:52-74`, `95-108`, `208-222`),
  with `capture-folder-*.json` and `todos-folder-*.json` (60 lines). An
  installed app's window is granted the folder it opens, as any installed app's
  is (`open_installed_window`, `apps/epicenter/src-tauri/src/lib.rs:1702`).
<!-- doc-path-check: ignore-next-line -->
- The Mail and Books placeholder pages (`apps/epicenter/src/placeholder-pages.ts`,
  <!-- doc-path-check: ignore-next-line (deleted with the Bun host in wave 3) -->
  47 lines) and their routes (`apps/epicenter/src/server.ts:346-359`).
- The refusal to install a built-in app's id
  (`apps/epicenter/src-tauri/src/installed_apps.rs:141-148`); only `so.epicenter`
  stays refused.
- The rule that an installed row overrides a built-in app, and that
  built-in apps are not rows. No code implemented either.
- Building apps into Epicenter: `build:whispering`, `build:capture`,
  `build:todos`, and their place in `build:apps` and `typecheck:desktop`
  (`apps/epicenter/package.json:12-27`); the dependencies `@epicenter/capture`,
  `@epicenter/todos`, and `@epicenter/whispering`
  (`apps/epicenter/package.json:35-42`), which Epicenter needs only to build
  those apps and to import two definitions in `openers.ts`;
  `capture-application.test.ts` (87 lines) and `test-apps-dist.ts` (36 lines).
- The plan to move Todos and Capture into their own repositories before they
  can be installed.

Costs:

- Disk: one full clone of the monorepo per installed first-party app. Measured
  in this repository on 2026-10-15: `git count-objects -vH` reports a
  `size-pack` of 125 MiB, for an object store that worktrees and branches
  share, so a fresh clone of `main` may be smaller; the tracked files at
  `HEAD` total 26 MiB. Bun links `node_modules` from its shared cache, so each
  clone's dependencies cost little more.
- A first install needs the network and a build. The build time is an
  estimate of tens of seconds; nobody has measured it.
- A person who has installed nothing sees an empty Epicenter, with "Install
  Todos".
- Approval covers the whole repository's commit, because `bun install` at the
  root reaches every workspace package. Updating Todos asks again after any
  commit to the monorepo, and the approval shows a monorepo-wide
  `git diff --stat`.
- The dev loop is unchanged: `bun dev:todos` runs Todos from the checkout.

What the code contradicts today, each to change before Todos installs this way:

- Todos' Epicenter build writes into Epicenter's bundle and serves at a fixed
  path: `apps/todos/svelte.config.js:15` sets `pages` to
  `../epicenter/dist/todos`, and `:20` sets the absolute base `/apps/todos`.
  An installed app writes `output` in its own folder with a relative base and
  is served at `/apps/so.epicenter.todos/`.
- No first-party app has an `epicenter.app.json`.
- `apps/epicenter/AGENTS.md:12` requires `launch_application` as the one launch
  verb of the Folders window and Settings.
- Native access follows window labels: `trusted-whispering-native-*.json`
  grants the `whispering` label, the shell creates Whispering's overlay and
  shortcuts for `BuiltInApp::Whispering` at startup, and an installed app's
  window has a per-folder label (`installed_window_label`). Only Whispering's
  capability files grant `open_home` today, so the Folders window needs it.
- Approval covers the whole monorepo, as stated above.
- `--ignore-scripts` skips Todos' `prepare` script, `svelte-kit sync`
  (`apps/todos/package.json`). SvelteKit's Vite plugin is expected to sync
  during `vite build`; nobody has tested it.

## Considered alternatives

- **Built-in apps compiled in (the status quo).** Two app models, two launch
  verbs, and a list of ids installing must refuse.
- **Each app in its own repository, with published packages.** Needs release
  tooling for every package Todos imports. Later, when a public registry
  exists; such an app installs from its repository root under the same rule.
- **Prebuilt downloads.** Rejected by ADR-0540: a distribution channel, and
  code Epicenter did not build.
- **One shared monorepo clone for every first-party app, with a Git worktree
  per app.** Less disk, but approval, update, and customizing each act on a
  worktree sharing objects with others. Deferred.
- **The folder only in the `so.epicenter` row.** The shell reads nothing from
  rows, and a row synced from another machine is not trusted to say what runs.
- **The shell searching the clone for the manifest whose id matches.** A
  repository can hold two manifests with one id, and the search runs on every
  listing.
