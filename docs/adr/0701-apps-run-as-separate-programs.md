# 0701. Apps run as separate programs

- **Status:** Proposed (awaiting the owner's review; flip to Accepted when approved)
- **Date:** 2026-10-31
- **Supersedes:** [ADR-0686](0686-one-https-site-is-one-portable-release-and-one-data-area.md) (a hosted HTTPS site), [ADR-0687](0687-opening-a-site-url-opens-its-derived-folder.md) (opening a site URL in Epicenter), [ADR-0691](0691-offline-reopening-keeps-the-sites-https-origin.md) (offline reopening of a hosted site), [ADR-0680](0680-rust-serves-each-installed-app-from-a-pinned-build-on-its-own-origin.md) (pinned installed builds), [ADR-0677](0677-one-source-repository-can-provide-many-desktop-apps.md) (source-installed desktop apps), and [ADR-0493](0493-whisperings-only-desktop-shell-is-epicenter.md) (Whispering's desktop shell is Epicenter).
- **Amends:** [ADR-0537](0537-epicenter-opens-to-your-folders-and-home-becomes-settings.md) at the Apps list; [ADR-0644](0644-the-shell-assigns-a-native-windows-default-folder.md) and [ADR-0652](0652-the-folder-plugin-opens-one-window-per-app-and-directory.md) at the Epicenter host's bundled app windows; [ADR-0674](0674-standalone-apps-release-independently-from-one-monorepo.md) at apps bundled with Epicenter; [ADR-0678](0678-app-storage-openers-use-runtime-bound-scopes.md) at bundled and installed app roots; [ADR-0683](0683-hosted-requests-use-a-resource-bound-account-fetch.md) at the desktop window's account command; [ADR-0672](0672-native-app-defaults-are-fixed-reverse-dns-children-of-one-library.md) at standalone app defaults: an app on `epicenter-standalone` defaults to `~/Epicenter/<productName>`, not a reverse-DNS child; [ADR-0682](0682-secrets-use-one-persistent-api-and-a-shared-tauri-plugin.md) at `tauri-plugin-epicenter-secrets`: a standalone app reaches the keychain through `epicenter-account`.
- **Revised:** 2026-10-31 for decisions 79 to 97: per-app desktop programs, two roots, Tauri's grants, startup and recovery, settings notes, and the sign-in crate (see [Revisions](#revisions)).
- **Unbuilt:** standalone Todos on `epicenter-standalone` and two roots; a native client for Capture or Honeycrisp, which sign in to nothing today.
- **Relates:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (apps share data through a file contract, so no app needs Epicenter to reach its data).
- **Archive:** the annotated tag `archive/app-hosting` at `728e820cc0`, the last commit with app hosting.
- **Removed by:** `0320d9980b`, `e06a42c039`, and `ed2068ded8` (see [Restoring app hosting](#restoring-app-hosting)).

## Context

Until this decision the Epicenter desktop app did two jobs. It managed folders:
it registered, synced, shared, and showed the status of folders, and opened a
folder's files in an editor window. It also hosted apps: its Folders window had
an Apps section that opened Todos, Capture, Honeycrisp, Whispering, and
Messages in windows of their own, and a Sites section that opened a published
HTTPS site bound to a derived folder. Each bundled app needed a second build of
its own (`build:host`), a build condition, native commands only that app
called, a capability file, and a release that shipped inside Epicenter's.

ADR-0700 made an app's data a file layout recorded in Git that any program may
write. An app no longer needs Epicenter to open, sync, or share its data, so
hosting it bought a second runtime per app and a second release channel, and
it made Epicenter the only desktop shell Whispering had.

## Decision

**Apps are separate programs; the Epicenter desktop app manages folders only.**
It registers, syncs, shares, and shows the status of folders, and opens a
registered folder's files in its editor window. It does not list, open,
install, serve, or update apps, and it does not open published sites.

**An app ships its own builds.** Each app keeps its web build. Its desktop
variant is a small Tauri program of its own on the shared
`epicenter-standalone` crate (`packages/tauri-epicenter-standalone`):
Capture, Honeycrisp, Vocab and Whispering. Standalone Todos still has its own
older shell (below). The desktop variant is the web app's UI built with other
leaves: `desktopVariant()` from `@epicenter/vite-config` turns on the `tauri`
condition for the app's `#platform/*` seams in `bun run build:native` (into
`build-desktop/`), `tsconfig.tauri.json` typechecks those leaves, and a bundle
test names a seam whose desktop leaf went missing. The root scripts
`dev:<app>:desktop` and `build:<app>:desktop` start and build each one.

**No Epicenter command exists for one app's page.** Commands that only a
hosted app called left with the hosting: local transcription and model
listing for Whispering's page, the account and AI sends through the CLI,
Whispering's connection rows, Messages' Beeper bridge, and the request a page
made to open a Settings section. An app's own shell carries what its page
needs (Whispering's recorder, local transcription and global shortcut).

**A desktop app has two roots, and no first-run question.**

- **AppData** is the operating system's application data directory for the
  app: fixed, one per installation, never synced, never chosen. Its
  `settings.md` holds `folder` only when the person chose a data folder.
- **The data folder** is the person's files: `~/Epicenter/<productName>` by
  default, made when missing, or the folder `settings.md` names. "Choose data
  folder…" opens a folder's existing contents and never moves files. Only
  the data folder is synced, by Epicenter, once the person presses Sync with
  Epicenter (`syncWithEpicenter({ path, contract })`, which sends
  `epicenter://init?path=…&contract=…`).

`productName` comes from the merged Tauri configuration, so the app's
identity has one source: `tauri.dev.conf.json` sets it to "<App> Dev" with
an identifier ending in `.dev`, which gives a development build
`~/Epicenter/<App> Dev` and an AppData of its own.

**Tauri decides which folders a window may open.** At startup the crate
allows the app's own default folder in the fs plugin's runtime scope
(`fs_scope().allow_directory(default, true)`). A folder picked in the native
dialog is allowed by the dialog plugin and kept across launches by
`tauri-plugin-persisted-scope`. A `folder` written by hand or by an agent
opens as `NotGranted` until the person picks it. Capability files hold only
plugin permissions, never a folder, and each configuration lists its
capabilities in `app.security.capabilities`, so nothing is enabled
implicitly. The folder plugin keeps only its refusals (`scope::Refusals`:
the top of a disk, the home folder, Epicenter's own records, a `.git`
folder, and the like).

**Startup is one awaited component under a boundary.** With Svelte's
`compilerOptions.experimental.async`, the app's layout wraps the variant's
`Startup` (from `#platform/root`) in `<svelte:boundary>`, whose `pending` is
the UI kit's spinner. The desktop `Startup.svelte` awaits
`openAppData(settingsContract)` and then `openDataFolder(contract, { appData })`
from `@epicenter/folder/tauri`, each a `Result<Client, OpenDeviceError>`:

- AppData fails: the shared `Recovery` (`@epicenter/svelte/recovery`) offers
  only Retry.
- The data folder fails: `Recovery` switches on `error.name` (`Missing`,
  `NotGranted`, `Refused`, `Unreadable`, `StorageUnavailable`) and offers
  what fixes it (Allow access, Choose folder…, Use the default folder,
  Retry), each writing or clearing `folder` and opening the roots again. It
  ends with `assertNever` (`@epicenter/ui/utils/assert-never`) and never
  opens another folder on its own.
- Both open: the app's `DesktopRoot` wraps each client once for Svelte with
  `fromClient` and gives it to the pages during its own initialization
  (`setAppData` and `setDevice` in Capture, Honeycrisp and Vocab; Whispering
  passes the wrapped data folder to its root component).

A local web variant's `Startup` simply awaits `openDevice(contract)`; two
roots are desktop only.

**Settings are flat notes per concern, resolved by a shallow spread.** The
same fixed-path notes (`settings.md`, `shortcuts.md`, …) may sit at the top
of both roots: the data folder holds the synced values, AppData this
computer's sparse overrides, and a reader resolves each note with
`{ ...defaults, ...data, ...appData }`. `folder` is the one key only AppData
holds. The settings contract is an ordinary `defineContract`. Rust never
reads or writes a settings note, and API keys never go in one.

**Sign-in is one shared crate, for capabilities only.** An app that signs in
(Whispering and Vocab; Capture and Honeycrisp make no hosted calls and do
not) uses `epicenter-account` (`packages/tauri-epicenter-account`) as its own
native client, `so.epicenter.<app>.native`, registered in
`apps/api/worker/oauth-registrations.ts` (`NATIVE_APPS`). The system browser
returns to a loopback listener with PKCE, the refresh token stays in the
keychain, and the page never holds a token: each of the account's requests
goes through `account_fetch`. The page's side is `createTauriAuth` and
`keychain` from `@epicenter/auth/tauri`; API keys are keychain entries too.

## Consequences

- The Folders window has Folders and the editor; its Apps and Sites sections
  are gone. Settings keeps its account, AI keys, and local model
  administration.
- `epicenter-app://localhost` serves only Settings (`/home/`), the Folders
  window (`/folders/`), and the editor (`/folders/editor/`).
- Whispering's desktop build is its own program again (milestone A), over
  `~/Epicenter/Whispering`.
- Messages' web build runs its demo conversations only.
- Epicenter's releases carry no app pages; an app's release is its own
  (ADR-0674).
- Data stays when an app is removed, and a development build never touches
  release data: different `productName`, different folder and AppData.
- The Epicenter manager's own library root is separate and unchanged: the
  folder plugin's `DesktopPaths` still uses `~/Epicenter` (`~/Epicenter Dev`
  in development, or `EPICENTER_FOLDER_DIR`) for Epicenter's records and for
  standalone Todos.
- Standalone Todos is not yet on this model: its shell (`apps/todos/src-tauri`)
  binds the fixed library default `so.epicenter.todos` before the page loads,
  its one build picks the store with `isTauri()`, and it has no AppData
  settings, picker or recovery screen.

## Considered alternatives

- **Keep hosting the fixed bundled apps.** Each app would keep two builds, two
  release channels, and native commands written for one page, after ADR-0700
  removed the reason for them.
- **Host installed apps from source on per-app origins (ADR-0677, ADR-0680).**
  Never built in its pinned-origin form. This is the likely shape if hosting
  returns; see below.
- **Ask where to keep files on first run** (decision 81, replaced by 88).
  The default folder and "Choose data folder…" cover the choice without a
  question before the app opens.
- **Rust reads `folder` and hands the page its paths** (decisions 86 and 89
  to 94: a config read, a grant command, `appFolders()`). Two readers of one
  settings format; Tauri's path API and `getName()` give the page both roots
  directly.
- **A static capability scope per default folder** (decisions 90 and 96,
  replaced by 97). Each configuration would need its own path in a
  capability file; the grant at startup, computed from the merged
  configuration, allows exactly each build's own folder.
- **Deep-merged settings layers** (`deepMerge`, decision 85, replaced by
  86). With flat notes per concern, a shallow spread resolves them and no
  merge function is needed.

## Restoring app hosting

### The architecture as it was

At `archive/app-hosting` (`728e820cc0`), in `apps/epicenter`:

- **Components.**
  - `src-tauri/src/bundled_apps.rs`: the closed `BundledApp` table (page,
    library default such as `so.epicenter.todos`, window label prefix,
    capability), with the commands `open_bundled_app` and
    `choose_folder_for_app`.
  - `src-tauri/src/hosted_sites.rs`: `open_hosted_site`, which parsed an HTTPS
    root URL and derived its folder (`todos.acme.dev` to
    `~/Epicenter/dev.acme.todos`), plus the macOS offline-proxy gate
    experiment (`evidence/offline-proxy/`, `src-tauri/examples/hosted_site_offline.rs`).
  - `src-tauri/src/scheme.rs`: the `epicenter-app://localhost` scheme, which
    also served each bundled page at `/<page>/` from `dist/<page>/`.
  - `src-tauri/src/folder_windows.rs` and the folder plugin's
    `open_folder_window`, which bound a directory to a window label
    (`<page>:<digest of the canonical root>`) before the WebView existed. These
    remain for the editor window.
  - Capabilities `bundled-app.json` (Todos, Capture, Honeycrisp),
    `whispering.json`, and `messages.json`.
  - `src/folders/App.svelte` (Apps and Sites sections),
    `src/folders/openers.ts`, and `src/ui/launch.svelte.ts`.
  - `build-bundled-apps.ts` in `apps/epicenter/scripts`, run by `build:bundled` inside
    `build:apps`.
- **Build.** Each app's `build:host` ran `EPICENTER_HOST=1 bun run build`.
  `hostAppViteConfig` (`packages/vite-config/src/index.ts`) turned on the
  `epicenter-host` condition for `#platform/*` seams, aliased
  `@epicenter/folder` to `@epicenter/folder/tauri`, and defined
  `import.meta.env.EPICENTER_HOST`, which each app's `+layout.ts` read to
  prerender with relative assets (`host-app.js`'s `hostAppAdapterOptions`
  wrote `dist/`). `build:bundled` copied each `dist/` to
  `apps/epicenter/dist/<page>/`, which the release bundled as a resource.
- **Opening an app.** The Folders window's Open called
  `open_bundled_app(app)`; Rust created or reused the app's fixed default
  under the folder library, bound it to a new window, and loaded
  `epicenter-app://localhost/<page>/`. Choose folder… called
  `choose_folder_for_app(app)`, which showed the native picker in Rust. The
  page called `openFolder({ tables })` and reached only the bound directory.
- **Opening a site.** The Sites section called `open_hosted_site(url)`; Rust
  bound the derived folder, added a runtime capability granting
  `epicenter-folder:default` to that window label and exact HTTPS origin, and
  loaded the live site. macOS only.
- **Security model.** A page never named a path; Rust chose and bound the
  directory before the WebView existed, and refused Epicenter's own records,
  staging, and app data directories (`overlaps_epicenter_files`). A window's
  label prefix selected its one capability file, so each app received only
  the native commands its page called. The scheme served GET only, refused
  symbolic links and paths that left the page directory, sent one
  Content-Security-Policy that limited `connect-src` to the origin and IPC,
  and kept each window's navigation below its own `/<page>/`. Sites could not
  navigate off their origin, open new windows, or receive device permissions.
  This was wiring, not a sandbox (ADR-0179, ADR-0334).
- **Native commands for hosted pages.** Whispering: `transcribe_audio_bytes`,
  `list_inference_models`, `get_local_transcription_readiness`, `ai_send`,
  `account_send`, `send_cancel`, `whispering_connection_read|set` (the CLI's
  `whispering-connection` command), `open_home` with a section
  (`take_pending_home_section`), and the recorder plugin
  (`tauri-plugin-epicenter-recorder`). Messages: `messages_beeper` (the CLI's
  `messages` command over the Beeper Desktop API). Clients:
  `apps/whispering/src/lib/platform/desktop/`,
  `desktop-account-auth.ts` in `@epicenter/auth`, `sendThroughShell` in
  `packages/ai/src/send.ts`, and `runtime-transcriber.ts` in `@epicenter/ai`.

### Commits that built it

| Commit | Date | Subject |
| --- | --- | --- |
| `3cbbb09ea0` | 2026-10-07 | feat(epicenter): register native folders for installed applications |
| `3ff9f7e884` | 2026-10-15 | feat(epicenter): install apps from Git, approve commits, and serve them |
| `5b33f1f109` | 2026-10-15 | feat(epicenter): open to the Folders window and make Home the Settings window |
| `2034ddebcb` | 2026-10-15 | feat(whispering)!: install Whispering in Epicenter and delete its standalone shell |
| `7c4eab38ca` | 2026-10-16 | feat(honeycrisp)!: install Honeycrisp in Epicenter and delete its standalone shell |
| `f26be2d405` | 2026-10-16 | refactor(epicenter): install apps through the epicenter CLI and keep only opening them in Rust |
| `46dfdad9cb` | 2026-10-16 | feat(epicenter): serve every page from the epicenter-app scheme and delete the Bun host |
| `cc29e218c4` | 2026-10-16 | refactor(vite-config): give the installed app build one owner |
| `39456f968b` | 2026-10-16 | refactor(apps): one handed-folder opener and send adapter, and Whispering picks its workspace at build time |
| `098db56d1e` | 2026-10-17 | fix(epicenter): keep each installed app window on the build it opened |
| `21410d8db6` | 2026-10-20 | feat(epicenter): open bundled Todos on assigned folders |
| `c437114cde` | 2026-10-20 | feat(epicenter): bundle local folder apps in the host |
| `e3689a84c1` | 2026-10-20 | refactor(epicenter): remove source-installed apps |
| `8f96fe9d5e` | 2026-10-20 | refactor(build): name bundled app builds as host builds |
| `c85746a5f0` | 2026-10-21 | feat(messages): add Beeper replies with durable draft recovery |
| `b5b722a18e` | 2026-10-22 | feat(epicenter): add packaged desktop release flow |
| `0765f2cce4` | 2026-10-27 | feat(epicenter): reconcile hosted sites with current Folder |
| `d3aaf37787` | 2026-10-31 | refactor: stop cleaning up and pinning files earlier builds left |

Installing apps from Git existed from `3ff9f7e884` until `e3689a84c1`; read
that range for the earlier source installer.

### Commits that removed it

| Commit | Subject |
| --- | --- |
| `ff24d47a26` | docs(adr): propose that apps run as separate programs |
| `0320d9980b` | refactor(epicenter)!: remove app hosting from the desktop shell |
| `e06a42c039` | refactor(apps)!: drop the Epicenter host builds and their shell clients |
| `ed2068ded8` | docs: record that Epicenter manages folders and apps run separately |

To restore, revert `ed2068ded8`, `e06a42c039`, and `0320d9980b`, newest
first.

### Steps

```sh
# Read the hosting as it was
git fetch origin tag archive/app-hosting
git checkout archive/app-hosting

# Bring it back on a branch: revert the removal commits, newest first
git revert <removal commits>

# Or bring back part of it
git checkout archive/app-hosting -- apps/epicenter/src-tauri/src/bundled_apps.rs
```

What a restore must update since:

- Pages opened their data with `openFolder({ tables })`. ADR-0700 replaces
  `openFolder` and `defineTable` with the file contract, so a hosted page
  would open its contract's folder instead, and the shell would bind the
  folder the contract names.
- Regenerate the shell's bindings (`cargo test export_bindings` in
  `apps/epicenter/src-tauri`) and Whispering's, and restore
  `capabilities/*.json` with the commands they grant.
- Whispering's desktop leaves predate its move onto a contract; port them, or
  give Whispering its own shell.
- Supersede this record and restore the records it supersedes or write their
  successors.

The likely future shape installs an app from its source or a GitHub
repository: clone it, run its own build into an immutable per-installation
directory, serve that build from its own origin, and grant the window the
folder its contract names (ADR-0677 and ADR-0680 sketch this).

## Revisions

### 2026-10-31: decisions 79 to 97

The first version of this record left Whispering without a desktop build and
said only that an app needing a desktop shell has its own. Building those
shells for Capture, Honeycrisp, Vocab and Whispering settled how they work;
each point below is in the Decision above.

- **Per-app programs on one crate (decisions 79 and 80).** Each app gets a
  small Tauri program; what they share (two roots, grants, Quit, the
  startup dialog) is `epicenter-standalone`, so each `main.rs` stays a few
  dozen lines. The variant is chosen at build time, never by a runtime
  check. Decision 80's default `~/Epicenter/so.epicenter.<app>` and its
  discovery of library folders were replaced: the default is
  `~/Epicenter/<productName>` (decision 96), and Epicenter learns of a
  folder only through Sync with Epicenter's deep link (decision 81), so an
  app carries no "Open in Epicenter" command.
- **Two roots, no first-run question (decision 88).** Supersedes decision
  81's first-run question and decision 82's separate config contract and
  `defineAppConfig`. A chosen folder that cannot open shows recovery, never
  a silent fallback to another folder.
- **The page reads settings; Rust does not (decisions 89 and 94).** One
  reader and one format, at the cost of one small local read before the
  data folder opens. Supersedes decision 86's shell reading `folder` at
  startup and passing paths in, and the `appFolders()` bridge.
- **Identity from the Tauri configuration (decision 96).** `getName()` and
  `productName` replace a `root` or `name` option, `import.meta.env.DEV`, and
  `EPICENTER_FOLDER_DIR` for these apps; `~/Epicenter Dev/` no longer holds
  a standalone app's data. Supersedes decision 95.
- **Tauri's own grants (decisions 90 and 97).** Supersedes decision 89's
  grant command and decision 90's static capability scope; the folder
  plugin keeps only its refusals.
- **Startup (decisions 90 to 94).** `<svelte:boundary>` and one awaited
  `Startup` replace decision 90's `+layout.ts` `load`; decision 94 removed
  decisions 91 to 93's `StartupError`, `Roots.svelte` and roots holder.
  Setting context after an `await` throws in Svelte 5.56.3, so the root the
  pages read is set by a component rendered after both roots open. Errors
  are `OpenDeviceError` from `@epicenter/folder`, and `Recovery` is one
  exhaustive switch.
- **Flat settings notes (decision 86).** Keeps decision 83's layering
  (defaults, then synced, then this computer) per note, and supersedes
  decisions 84 and 85's deep merge.
- **One sign-in crate (decision 84).** One native client per app,
  `so.epicenter.<app>.native`, covering the desktop and a future mobile app
  with every redirect kind registered; the sign-in, the keychain and the
  token relay are shared in `epicenter-account`.
