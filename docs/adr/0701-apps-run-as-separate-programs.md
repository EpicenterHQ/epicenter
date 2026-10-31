# 0701. Apps run as separate programs

- **Status:** Proposed (awaiting the owner's review; flip to Accepted when approved)
- **Date:** 2026-10-31
- **Supersedes:** [ADR-0686](0686-one-https-site-is-one-portable-release-and-one-data-area.md) (a hosted HTTPS site), [ADR-0687](0687-opening-a-site-url-opens-its-derived-folder.md) (opening a site URL in Epicenter), [ADR-0691](0691-offline-reopening-keeps-the-sites-https-origin.md) (offline reopening of a hosted site), [ADR-0680](0680-rust-serves-each-installed-app-from-a-pinned-build-on-its-own-origin.md) (pinned installed builds), [ADR-0677](0677-one-source-repository-can-provide-many-desktop-apps.md) (source-installed desktop apps), and [ADR-0493](0493-whisperings-only-desktop-shell-is-epicenter.md) (Whispering's desktop shell is Epicenter).
- **Amends:** [ADR-0537](0537-epicenter-opens-to-your-folders-and-home-becomes-settings.md) at the Apps list; [ADR-0644](0644-the-shell-assigns-a-native-windows-default-folder.md) and [ADR-0652](0652-the-folder-plugin-opens-one-window-per-app-and-directory.md) at the Epicenter host's bundled app windows; [ADR-0674](0674-standalone-apps-release-independently-from-one-monorepo.md) at apps bundled with Epicenter; [ADR-0678](0678-app-storage-openers-use-runtime-bound-scopes.md) at bundled and installed app roots; [ADR-0683](0683-hosted-requests-use-a-resource-bound-account-fetch.md) at the desktop window's account command.
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

**An app ships its own builds.** Each app keeps its browser build. An app that
needs a desktop shell has its own (standalone Todos does); the shell builds
its own page bundle and loads it from its own origin.

**No shell command exists for one app's page.** Commands that only a hosted
app called leave with the hosting: local transcription and model listing for
Whispering's page, the account and AI sends through the CLI, Whispering's
connection rows, Messages' Beeper bridge, and the request a page made to open
a Settings section.

## Consequences

- The Folders window has Folders and the editor; its Apps and Sites sections
  are gone. Settings keeps its account, AI keys, and local model
  administration.
- `epicenter-app://localhost` serves only Settings (`/home/`), the Folders
  window (`/folders/`), and the editor (`/folders/editor/`).
- Whispering has no desktop build until its own Tauri app exists (milestone
  A), because its desktop ran inside the shell.
- Messages' web build runs its demo conversations only.
- Epicenter's releases carry no app pages; an app's release is its own
  (ADR-0674).

## Considered alternatives

- **Keep hosting the fixed bundled apps.** Each app would keep two builds, two
  release channels, and native commands written for one page, after ADR-0700
  removed the reason for them.
- **Host installed apps from source on per-app origins (ADR-0677, ADR-0680).**
  Never built in its pinned-origin form. This is the likely shape if hosting
  returns; see below.

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
