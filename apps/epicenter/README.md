# Epicenter desktop app

Epicenter hosts installed application pages, Settings, and a Folders window in
one Tauri runtime. The Folders window opens native directories through the
public `@epicenter/folder` API. Installed apps supply their own table schemas;
local opening and saving require no account or Git repository. Git commands
still exist outside a Folder handle, but the current folder and product pages
offer no Save version, Connect, or Sync action.

The existing app owns one Tauri runtime, one native command API, and the short list of what it compiles in. It ships with no apps installed (ADR-0552): every app, Todos, Capture, Whispering, and Honeycrisp included, is a folder in a Git repository that Epicenter clones and builds on this machine (see [Installed apps](#installed-apps)).

```text
page source                        build output            served at

apps/epicenter/src/ui -----------> dist/home ------------> epicenter-app://localhost/home/
apps/epicenter/src/folders ------> dist/folders ---------> epicenter-app://localhost/folders/
an installed app's folder -------> builds/<id>/<commit>/ -> epicenter-app://localhost/apps/<id>/<commit>/
```

Rust serves every page Epicenter shows from one origin,
`epicenter-app://localhost`, through a scheme the shell registers
(`src-tauri/src/scheme.rs`, ADR-0561): Settings (the `home` window) at
`/home/`, the Folders window at `/folders/`, and each installed app's build of
one commit at `/apps/<app-id>/<commit>/`. No server listens on a port and no Bun process outlives a
command. The `epicenter-host` build condition selects each product's host
integrations.

The scheme answers GET only. It serves a regular file inside the page's
directory or the build of the commit the URL names, refusing a symbolic link and any path
that leaves it, and answers an extensionless path that names no file with that
directory's `index.html`, so client-side routes load. Every response carries
one Content-Security-Policy: a page reaches its own origin and Tauri's IPC
(`connect-src 'self' ipc: http://ipc.localhost`) and nothing else, and a
document's policy admits each of its inline scripts by hash. Each window
navigates only below the path it opened at: a built-in page's, or an installed
app's `/apps/<app-id>/<commit>/`, so an app window never loads another build;
a new-window link opens in the system browser only when it is the hosted
account website.

Installed apps reach native file folders through the shared Folder plugin.
Each page runs `@epicenter/folder`'s own engine over a directory the shell
grants (ADR-0531). An app that needs other native commands is granted them by
its app id (see [Native commands for an installed app](#native-commands-for-an-installed-app)).

The shell serves product bundles and holds no credential: the `epicenter`
CLI holds the account and every key (ADR-0556). Product pages own unsaved
input.

## The epicenter binary

Epicenter ships one compiled Bun binary (ADR-0556): the `epicenter` CLI from
[`packages/cli`](../../packages/cli/README.md). `bun run build:sidecar`
compiles its entry, `packages/cli/src/bin.ts`, to
`src-tauri/binaries/epicenter-cli-<target triple>`, the `externalBin`. The
bundle calls it `epicenter-cli` because Tauri refuses a sidecar named like the
Cargo package, `epicenter`; on `PATH` it is `epicenter`.

The one binary has these uses:

- `epicenter app …` installs and builds apps, running the same binary as
  `bun` with `BUN_BE_BUN=1` ([Installed apps](#installed-apps)).
- The shell's narrow CLI runner (`src-tauri/src/cli.rs`) runs it for a page's
  fixed commands. A page has no generic exec: each command maps to one
  `epicenter` invocation, writes stdin on its own task, and streams each
  stdout line to the page's `Channel`. The installed-app commands are below.
  Development runs the CLI's source under `bun` instead of the binary.
- Settings' Account section runs the CLI's desktop sign-in through three
  fixed commands, granted to the `home` window by `home.json`
  (ADR-0558). `auth_login(onEvent)` runs `epicenter auth login --desktop
  --json`: the CLI listens once on
  `http://127.0.0.1:<random port>/callback` and prints `{"open": "<url>"}`,
  which the shell opens with the opener only when it is the deployment's
  `/auth/oauth2/authorize`, then `{"signedIn"}` or `{"error"}`; every line
  goes to `onEvent`. `auth_status()` runs `epicenter auth status --desktop
  --json` and `auth_logout()` runs `epicenter auth logout --desktop --json`.
  `ai_send` runs `epicenter send --json --desktop`, so an Epicenter
  connection sends with the app's grant.
- `account_send(audience, request, onEvent)` is a page's account request
  (ADR-0549, ADR-0556). It runs `epicenter send --json --desktop` with the
  target `{"kind":"account","audience"}`, where `audience` is `api` or `git`,
  a closed enum that names one of the deployment's resources by role. The CLI
  sends only a path below the deployment's `/api/`, adds the app's grant's
  access token for that resource, and streams the response back as
  `ai_send`'s lines do, followed by the same `{"type":"exit"}` line; with no
  sign-in it answers `NoAccountToken`. No page holds an access token
  (ADR-0549's desktop row), so there is no command that hands one out.
  Each of these passes the shell's configured server as `EPICENTER_API_URL`,
  so the CLI and the shell name one deployment. The grant's refresh token and
  cached access tokens are in the CLI's keychain entry; no token reaches a
  page or Rust.

At every launch a release build runs `epicenter install-command --json`,
which points `~/.local/bin/epicenter` at the bundled binary, so the Git
configuration that names that link survives moving the app (ADR-0566,
ADR-0567). It never needs `sudo`. To run `epicenter` in a terminal, add
`~/.local/bin` to your `PATH` once:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

## Configure the server

A desktop build connects to one server. The default is Epicenter Cloud. Set
`EPICENTER_SERVER_ORIGIN` when compiling the native host to build for a
self-hosted HTTP(S) origin. Changing it requires rebuilding the app.
Rust uses that origin to choose which account pages open in the system browser,
and passes it to the CLI it runs for sign-in and `send`.
Settings lets people sign in and out; it cannot change the server.

Debug Cloud builds retain `EPICENTER_API_URL` for the local development API.
This override accepts a loopback origin and does not affect release builds.
A self-hosted build takes precedence over that development override.

## Run locally

### Application data

Production keeps internal files under `so.epicenter` in the platform's local
application-data directory: `~/Library/Application Support` on macOS,
`$XDG_DATA_HOME` (default `~/.local/share`) on Linux, and `%LOCALAPPDATA%` on
Windows. Windows storage stays out of roaming profiles because databases and device
caches belong to this device. `EPICENTER_DATA_DIR` overrides the complete
path and must be absolute.

Development uses `so.epicenter.dev` for data and settings.
Production's authored folder root is `~/Epicenter`; development's is `~/Epicenter Dev`.
`EPICENTER_FOLDER_DIR` overrides the authored folder root and must be absolute.
Built installed apps go to the platform cache directory, `so.epicenter` (or
`so.epicenter.dev`) under `~/Library/Caches` on macOS; `EPICENTER_CACHE_DIR`
overrides it and must be absolute. The shell resolves all three directories
once and sets `EPICENTER_DATA_DIR`, `EPICENTER_FOLDER_DIR`, and
`EPICENTER_CACHE_DIR` on every `epicenter app` command it runs, so the CLI
writes where the shell reads. A terminal's `epicenter app` uses the same
variables, or the release app's directories when they are unset
(`packages/cli/src/app-paths.ts`).

Files split by what they cost to lose (ADR-0539):

```txt
~/Epicenter/                                  read, edited, and versioned as files
  so.epicenter/                               Epicenter's own folder
    epicenter.json                            optional older declaration, retained if present
    connections/<id>.md                       one row per AI connection
~/Library/Application Support/so.epicenter/   written only by Epicenter
  apps/<app-id>/                              an installed app's bare clone; its detached HEAD is the approved commit (the CLI writes it)
  local-transcription.json                    the active local model and when to unload it
~/Library/Caches/so.epicenter/                disposable
  sources/<app-id>/                           the approved commit's files, only while it builds
  builds/<app-id>/<commit>/                   built app bundles, checked at every open; none is cleaned up yet
  builds/<app-id>/<commit>.log                what the install and build printed
  apps.lock                                   one install or build at a time
```
Overrides select an explicit location, so pointing both builds at the same
location deliberately shares those files. Development starts signed out after
credential isolation; production credentials are unchanged.

Rust resolves the three directories once at startup and stores them for the
desktop lifetime; the scheme serves installed apps from the cache directory,
and every `epicenter` command the shell runs receives all three. The recorder
writes into a folder a window was granted, not into application data
(`tauri-plugin-epicenter-recorder`, ADR-0543). Local model files are not here:
they are in the shared Hugging Face cache (`~/.cache/huggingface/hub`, or
`$HF_HOME/hub`), which Epicenter downloads into and never deletes from (ADR-0579).
Settings shows a model's folder there; deleting that folder removes the model.
Local transcription settings, `local-transcription.json`, are in the data
directory. A file an earlier build kept in Tauri's config directory, which
differs from the data directory on Linux and Windows, is not read.
Standalone Local Books still defaults to production data; use
`EPICENTER_DATA_DIR` when directing its CLI to development storage.

Earlier Windows builds used `%APPDATA%\so.epicenter`. Existing files are not
moved automatically. To carry them forward, stop Epicenter and any CLI using
its data, back up the old directory, then copy it to
`%LOCALAPPDATA%\so.epicenter` before launching the new build. If the destination
already contains data, do not merge or overwrite the directories. Set
`EPICENTER_DATA_DIR` to the full path of the directory you intend to use instead.
The same override can keep an existing installation at its old location.

### Start the app

Start Epicenter from the repository root:

```bash
bun dev:epicenter
```

This starts the local API on `http://localhost:8787` and the desktop app.
Before the app starts, Tauri runs `bun run build:desktop`, which builds
Settings and the Folders window into `dist/` and compiles the `epicenter`
binary. A development build's scheme serves the pages from that `dist/`
directly, so after changing a page, run `bun run --cwd apps/epicenter build`
and reload its window (Cmd-R). There is no dev server and no hot reload: the
scheme is the one way a page is served, in development as in a release.
It requires the API's [local Postgres and Infisical setup](../api/README.md#development).
Settings' Sign in is the CLI's desktop sign-in (`epicenter auth login
--desktop`, client `so.epicenter`): finish it in your browser and Settings
shows who the app is signed in as. Nothing restarts. It is a separate grant
from a terminal's `epicenter auth login`, and signing one out leaves the
other signed in.

An installed app opens its granted local directory before any account flow.
Todos uses the same `Folder` table schema on desktop and in the browser.

Epicenter opens the [Folders window](#the-folders-window) (ADR-0537): launching
Epicenter, reopening it from the Dock, and `epicenter://` without a path all show
it. It lists your data folders, offers "Open in <app>" for each installed app
on every folder, lists the installed apps under Apps, and opens
Settings from its Settings button with `open_home`. Opening an app opens its own
window; the OS is the switcher from there, and closing the Folders window
leaves everything it opened running.

Settings is the window labelled `home`. It signs the app in and out and alone
administers the local transcription model (ADR-0180). An app that needs
a local model opens it with `open_home('transcription')`, and Settings scrolls
to the model (`src/ui/home-section.ts`). The tray (Show Folders,
Show Settings) and deep links remain shortcuts into the same windows; installed
apps have no deep link:

```bash
open 'epicenter://'
open 'epicenter://app/folders'
open 'epicenter://app/home'
```

## An app's own folder

An installed app opened without a folder, from the Apps list, is handed its
own folder: `<folderDir>/<app-id>`, under the authored folder root native
startup resolved (`~/Epicenter` in production, `~/Epicenter Dev` in
development, or `EPICENTER_FOLDER_DIR`), with the scope `<app-id>` (ADR-0552).
Installed Todos opens `so.epicenter.todos`, installed Capture
`so.epicenter.capture`, installed Whispering `so.epicenter.whispering`, and
installed Honeycrisp `so.epicenter.honeycrisp`. The shell registers that scope the first time the app
is opened that way or the Folders window lists a folder named by an installed
app's id, whichever comes first (`own_folder` in `src-tauri/src/data_folders.rs`).
The first grant creates the directory. A folder the Folders window listed as
`data:<app-id>` before its app was installed moves to the app's scope when the
app is first opened; if the Folders window already holds it under the data
scope, both scopes share the one root and publish under its one mutex
(ADR-0568).

The page calls `openFolder({ directory, tables })`, where `directory` is
the scope the shell handed to its window. The shell grants that scope and
checks every file path. The native Folder reads ordinary files as they stand,
merges row edits with current bytes, and lands one guarded file change per
save. Opening writes nothing and does not start Git. The shell retains separate
Git commands for CLI use; no current product page exposes them as a Folder
action. See Todos' [README](../todos/README.md) and Capture's
[README](../capture/README.md) for app-specific files.

## The Folders window

The Folders window (`folders`, served at `/folders/`) opens any data
folder under the authored folder root, including an installed app's own folder
while the app is open. Its page source is `src/folders`, built by
`build:folders` into `dist/folders`.
It is the window Epicenter opens to, and `epicenter://app/folders` opens it.

The page asks the shell for `list_data_folders`. The shell lists real,
non-hidden child directories under the authored folder root, including ones
without `epicenter.json`. An existing declaration can provide a display title;
it is not required to open or edit files. Each listed directory has a
registered scope. The page calls `openFolder({ directory: folder.id, tables:
{} })` from `@epicenter/folder/tauri` and edits files through `folder.files`.

- **An installed app's own folder**, a directory named by the id of an
  installed app, is listed under the app's scope (`so.epicenter.todos`), as
  [An app's own folder](#an-apps-own-folder) describes. The `folders` window
  and the app's window share that one scope, and both windows' saves are
  checked and published under the plugin's one mutex per root (ADR-0535).
- **Epicenter's own folder**, `so.epicenter`, is registered at setup for the
  `folders` and `home` windows and listed under that scope.
- **Any other data folder** gets the scope `data:<directory name>` the first
  time it is listed, registered for the `folders` window alone. Listing again
  in the same run returns the same scope. Registrations last until the
  process exits; a folder removed from the root keeps an unused scope.

The shell watches the root from setup until exit (`watch_data_folders`). When
an entry directly under it, or a folder's `epicenter.json`, is created,
changed, or removed, it sends `epicenter://data-folders-changed` to the
`folders` window, which calls `list_data_folders` again. A rescan or a watch
error is sent the same way. Deeper changes, such as a row saved in a folder,
are not.

### What the view does

The page lists directories and opens one at a time. It supplies no table
schemas, so every source file appears in a file tree and opens as text when
its bytes are editable text. The window subscribes to `folder.onChange` and
invalidates the relevant TanStack Query reads. The shell watcher reports
changes from other windows and processes. File drafts belong to the Folders
window and survive switching files. A failed save keeps its text visible and
prevents leaving the directory until the person retries or discards it.

Beside each directory, the page offers every installed app ready to run through
"Open in". The shell hands that directory's scope to the app window; the app
interprets its files through its own schemas. Opening an app from the Apps list
hands it its own directory. The Folders view does not use `epicenter.json` to
authorize either action.

## Installed apps

An app is a folder holding `epicenter.app.json` in a Git repository, the
repository's root unless installing names another folder (ADR-0540,
ADR-0552):

```json
{ "id": "com.example.board", "title": "Board" }
```

- `id` is a lowercase reverse-domain name. Only `so.epicenter`, Epicenter's
  own folder, is refused. Todos (`so.epicenter.todos`), Capture
  (`so.epicenter.capture`), Whispering (`so.epicenter.whispering`), and
  Honeycrisp (`so.epicenter.honeycrisp`) install from `apps/todos`,
  `apps/capture`, `apps/whispering`, and `apps/honeycrisp` of Epicenter's
  repository. Each imports its id from this file.
- `id` and `title` are the only fields, and both are read before approval,
  from a clone where nothing runs. Any other field is refused.
- The build is always `bun run build:installed` in the app's folder, and its
  output is always `dist/`: a single-page app built with relative asset paths,
  holding `index.html`.

Installing lives in the `epicenter` CLI
(`packages/cli/src/installed-apps.ts`, ADR-0556, ADR-0558); a terminal or an
agent runs the same commands the Folders window does. The shell's commands
in `src-tauri/src/installed_apps.rs` are each one fixed invocation, whose
NDJSON lines (`{"progress"}`, then `{"app"}` or `{"error"}`) go to the page's
`Channel`; `src/folders/app-commands.ts` reads them and the page says each
step while it runs:

```txt
list_installed_apps    epicenter app list --json
list_repository_apps   epicenter app list --repository=<source> --json
install_app            epicenter app install [--folder=<folder>] --json -- <source>
update_app             epicenter app update --json -- <id>
approve_app            epicenter app update --commit=<commit> --approve --json -- <id>
open_installed_app     epicenter app update --commit=<commit> --json -- <id>, before every open
```

The Folders window's Apps list has "Install from a repository…"
(`src/folders/InstallApps.svelte`). It takes a Git URL (`https`, `http`,
`ssh`, `git`, `file`, or `user@host:path`) or an absolute local path and calls
`list_repository_apps`, which clones the repository shallowly into a dot
directory of `apps/` in app data, reads each tracked `epicenter.app.json` up to four
directories deep outside `node_modules`, and removes the clone. It lists each
app's title and folder; choosing one calls `install_app` with the source and
that folder. With no app installed yet, the list offers "Install Todos": the
same `install_app` with `https://github.com/EpicenterHQ/epicenter.git` and
`apps/todos`.

`install_app` clones the repository's default branch bare
(`git clone --bare --single-branch --no-tags`) into
`~/Library/Application Support/so.epicenter/apps/<app-id>/`, writes
`info/attributes` so no attribute changes a byte (`neutralizeAttributes`),
writes the one refspec `+refs/heads/<default>:refs/remotes/origin/<default>`,
deletes every ref the clone wrote (its own branch, and any a refspec in a
person's global configuration mapped), fetches once with that refspec passed
on the command line with `--refmap=` and `--no-tags`, so the tracking ref is
the clone's only ref, and records the folder in the clone's `config` as
`epicenter.folder` (absent for the root). Its `HEAD` stays symbolic, so
nothing is approved and nothing builds: the CLI exits 1 with the app and the
fetched commit's review (`pending`). Everything about an installed app is
read from its clone, never from a row (ADR-0597). The page shows the title,
the source, the commit, its log, and that building runs the app's code on
this computer. "Approve and build" calls `approve_app` with the commit shown;
the CLI refuses an approval without the commit shown, refuses if the fetched
commit moved since, and refuses a commit whose manifest names another id,
then approves it with
`git update-ref --no-deref HEAD <commit>` and builds it. Approval covers the
whole repository's commit.

Until publishing builds apps (ADR-0589), a build runs from source: the CLI
extracts the approved commit with `git archive` into `sources/<app-id>/`,
runs `bun install --frozen-lockfile --ignore-scripts` at its root (when it
has a `package.json`) and `bun run build:installed` in the app's folder,
writes the regular files of its `dist/` into the clone as a tree named
`refs/epicenter/builds/<commit>` (a link in `dist/` fails the build), extracts
that tree with `git archive` into
a sibling of `builds/<app-id>/<commit>/`, renames it into place, and removes
the source. Every Git command runs with replace refs ignored, and the
attributes file unsets filters, line-ending conversion, `ident`,
`working-tree-encoding`, `export-subst`, and `export-ignore`, so the source
and the build hold each blob's bytes and every file (Git LFS files build as
their pointers). `epicenter app remove <id>` deletes the clone and leaves its
builds for any window still running one; the window has no Remove yet.

Only approving moves the approved commit (ADR-0597):

- "Update" fetches, which writes `refs/remotes/origin/<default>` and never
  `HEAD`. A fetched commit that differs from `HEAD` waits for approval with
  `git log` and `git diff --stat` since the approved commit, and the
  approved commit keeps opening meanwhile.
- `git pull` and `git merge` refuse to run in a bare clone, and the clone has
  no working tree, so nothing uncommitted, untracked, or ignored can reach a
  build: what runs is always an approved commit.
- An `approvals.json` or `builds/<app-id>/current` left by an earlier build
  of Epicenter is never read; an app installed before is installed again.
  Its old clone in `~/Epicenter/Apps/<app-id>/` is left on disk, with any
  commits made there, for the person to keep or delete.

The CLI runs every Git command for an app through `@epicenter/folder`'s
runner (`createGitRunner`): no hooks, no fsmonitor, no terminal prompt, and
no inherited variable pointing Git at another repository, with the `ext` and
`fd` transports refused. One install, update, or build runs at a time on a
machine (`apps.lock`). Builds stop after 15 minutes. `bun` is the binary
running the command: in a release the bundled
[`epicenter` binary](#the-epicenter-binary) itself (`BUN_BE_BUN=1`, linked as
`bun` first on the build's `PATH`); in development the CLI's source runs under
the `bun` on `PATH`.

The scheme serves each build of an installed app at
`epicenter-app://localhost/apps/<app-id>/<commit>/`, from
`builds/<app-id>/<commit>/`, refusing a linked build directory.
`open_installed_app` asks the CLI before every open
(`epicenter app update --commit=<commit>`), which answers only for the
approved commit. It builds that commit when it is not built, and otherwise
compares `builds/<app-id>/<commit>/` with the commit's build tree by path and
blob hash, ignoring a `.DS_Store`, and writes nothing. A build that differs,
edited, partly copied, or with a file added, is answered `damaged`; the shell
then reserves that commit, which succeeds only when no window runs it
(`InstalledWindowCommits`) and no other open holds it, and asks again with
`--restore`, which extracts the build again into a new sibling, checks it,
and swaps it in. Opens of an intact build take no reservation, so two of them
never refuse each other. When the reservation fails, the shell opens nothing
and asks the person to close that app's windows first. A window is pinned to its
commit before its WebView is created, so no page loads a build being
replaced. The check runs at each open, not at each request: bytes a local
process changes under `builds/` afterward are served until the next open,
which is the trust ADR-0540 already grants local processes. It
then opens the commit it answered ready in its own window, labelled
`app:<id with _ for .>:<folder scope in hex>`. The window keeps that build
until it is closed and opened again: a later approval and build changes
which commit the next window opens, never an open window. Opening an app
whose window is already open on that folder reveals that window when the
shell recorded it opening on the same commit, and otherwise leaves it and
says the app is open on another version.
Navigation pins a window's page and its relative assets to its build; every
app shares the one origin, so it does not fence requests. Opened from the Apps list, the
app is handed its own folder, [`<app-id>`](#an-apps-own-folder); from "Open
in", the folder it was opened on. The window is permitted into that folder's
scope and into `so.epicenter`, whose `connections` table its AI commands
name, and the folder plugin records which app the window runs and which
folder it was handed. The page asks for it (`window_folder`), so its URL
names no folder and its routes and reloads cannot change it, and the app opens it with `openFolder({ directory: handed.folder, tables })`.
Settings opens `so.epicenter` with the connections schema; the Folders window
opens each listed directory with no table schemas.

### Native commands for an installed app

Every installed app's window gets the same grant, one capability file,
`src-tauri/capabilities/installed-app.json` (ADR-0570):

- Its `windows` is `app:*`. Tauri matches it against a window's label as a
  glob (`glob::Pattern`, in Tauri 2.12's `ipc::authority`), so it selects
  every label `installed_window_label` makes, for any app id and folder, and
  no window of Epicenter's own.
- Its `permissions` are the union of what any installed app's page calls: the
  folder plugin and its change event; the folder's history (`status`,
  `history`, `save_version`, `sync`); the recorder plugin,
  which lists the microphones, reads one's level, and writes into the folder
  the window was granted, asking macOS for microphone access before it opens
  one (ADR-0543, ADR-0571); the opener's `allow-open-url`, scoped to
  `x-apple.systempreferences:`, to open a privacy pane in System Settings
  (ADR-0555);
  `list_inference_models`, `transcribe_audio_bytes`, and
  `get_local_transcription_readiness`, for transcription with the one active
  local model (ADR-0180); `open_home`, to open Settings; `ai_send`,
  `ai_key_set`, `ai_key_remove`, and `ai_key_state`, for AI connections
  (ADR-0557); and `auth_status` and `account_send`, for who Epicenter is
  signed in as and an account request such as Todos' `GET /api/repos`
  (ADR-0558).
- Approving an app trusts its code fully (ADR-0540), so this is wiring, not a
  sandbox, and a per-app grant would protect nothing. A native feature an app
  may use is one line in that file, and it reaches every app.
- Native state an app owns, such as an overlay window or global shortcuts, is
  created when the app's window opens, never at startup.

Each kind of window has one capability file, and every file is `"local": true`
because its page is served on the scheme: `folders.json`, `home.json`, and
`installed-app.json`. A development build selects the same three.

Whispering's page has no recording overlay and registers no global shortcuts,
so neither is created or granted.
Native dictation, which no page reaches, compiles only with the `dictation`
Cargo feature, off by default: paste at the cursor and the keyboard supervisor
that watches its Accessibility grant, pausing other apps' media,
`prewarm_model`, the macOS overlay panel (`src-tauri/src/overlay.rs`), and the
clipboard-manager plugin paste uses. The global-shortcut plugin is ADR-0555's
plugin awaiting a grant; nothing uses it, so it is parked with the feature. A
default build neither registers nor starts any of it and its generated
bindings name none of it, because the page API only grows after the first
release; it joins that API when a native API decision grants it (ADR-0555).
There is no shell command for permissions: the recorder plugin asks for
microphone access itself, and a page opens System Settings through the opener.
Autostart is not registered; enabling it once on first run (ADR-0328) is
unbuilt. Of the official plugins ADR-0555 lists, a default build registers the
opener and grants a page only its System Settings URLs; the notification
plugin is a dependency but stays unregistered until a capability grants it.

## Quitting Epicenter

Quitting is immediate
([ADR-0542](../../docs/adr/0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)).
No window is asked, nothing is waited for, and no dialog appears. Every save
is an atomic rename into the folder, a recording streams into its folder from
the moment it starts, and a Whispering run writes its result row when it
starts, so nothing finished lives only in a page. Text a person typed and did
not submit is lost, as people expect.

- **Every quit is the same.** The tray's Quit calls `app.exit`. AppKit's own
  quits (the app menu's Quit and Cmd-Q, the Dock's Quit, logout, restart,
  shutdown) end Tao's loop directly. Either way Tauri delivers `RunEvent::Exit`,
  where the Folder plugin fences new work and releases each folder's lock.
- **An account change restarts nothing.** The account is the CLI's desktop
  grant (ADR-0556); a page that uses it reads it again when its window
  regains focus.
- **Closing a window hides it.** The built-in windows are hidden, not
  destroyed, so their pages and folders stay open until Epicenter quits. An
  installed app's window is destroyed when it closes.

## Build and verify

```bash
# Build Settings, the Folders window, and the epicenter binary
bun run --cwd apps/epicenter build:desktop

# Package the complete native application
bun run --cwd apps/epicenter desktop:build

# Typecheck Settings, the Folders window, and the build scripts
bun run --cwd apps/epicenter typecheck

# Page builds, the epicenter binary, and window tests
bun test apps/epicenter/scripts apps/epicenter/src

# Native command, scheme, capability, and fixture tests
cargo test --manifest-path apps/epicenter/src-tauri/Cargo.toml

# The same tests with the parked native dictation code compiled in
cargo test --manifest-path apps/epicenter/src-tauri/Cargo.toml --features dictation
```

The root `bun typecheck` runs each workspace's checks. Installed apps, such as
Whispering and Honeycrisp, are checked in their own folders.

## Ownership rules

- `src-tauri` owns native commands, permissions, windows, deep links, the `epicenter-app` scheme that serves every page, and packaging.
- `src` owns the Settings page and the Folders window's page. The CLI's commands live in `packages/cli`.
- `dist` is generated. Never edit it or commit product source beneath it.
- A product SPA owns its UI and browser deployment from its own app folder.
- A multi-host SPA selects implementations through build-time `#platform/*` conditions. Runtime checks guard optional capabilities; they do not choose which implementation was bundled.
- Do not create `apps/epicenter/<app>` source copies. The build must consume the canonical app source directly.

The one trusted origin is recorded in [ADR-0118](../../docs/adr/0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md), and Rust serving it over the scheme in [ADR-0561](../../docs/adr/0561-rust-serves-every-app-from-one-epicenter-app-origin.md).

## Shared AI connections

The shell keeps no AI connections and serves no `/_epicenter/ai` routes.
[ADR-0557](../../docs/adr/0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md)
makes each connection a row of a `connections` table in `so.epicenter`, keeps
its key in this machine's keychain bound to the endpoint it was saved for, and
sends every AI request through `epicenter send`. Check that record's Unbuilt
line for what has landed.
