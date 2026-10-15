# Epicenter desktop host

Epicenter is the repository's native application host. It owns one Tauri runtime, one native command API, and the list of compiled applications it serves. Product SPAs keep their source in their own `apps/*` folders; Epicenter builds and serves their desktop variants without copying that source into this folder.

Honeycrisp ships its own desktop shell and is built from `apps/honeycrisp`.

```text
trusted SPA source                 Epicenter build output

apps/whispering/src  -----------> dist/whispering
apps/capture/src     -----------> dist/capture
apps/todos/src       -----------> dist/todos
apps/epicenter/src/ui -----------> dist/home
apps/epicenter/src/folders ------> dist/folders
                                          |
                                          v
                              Bun loopback sidecar
                                          |
                                          v
                              apps/epicenter/src-tauri
```

The host serves Settings (the `home` document) and four compiled applications:
Whispering, Capture, Todos, and its own Folders window. Whispering is built and
served but not offered for now, because inside Epicenter no folder or host of
its own is registered for it: no window lists it, `launch_application` refuses
it, neither the tray nor a deep link opens it, and the shell opens neither its
hidden window nor its recording overlay at startup (`BuiltInApp::is_hosted`
and `LAUNCHABLE_APPLICATIONS` in `src/applications.ts`). Application routes live below `/apps/<id>/`; the Mail and Books routes
serve placeholder pages (`src/placeholder-pages.ts`). Apps a person installs
from a Git repository are served below `/apps/<app-id>/` too (see
[Installed apps](#installed-apps)). The `epicenter-host` build
condition selects each product's host integrations. Honeycrisp has a separate
desktop shell.

Capture and Todos reach native file folders through the shared Folder plugin.
Each page runs `@epicenter/folder`'s own engine over a directory the shell
grants (ADR-0531). The shared-host Whispering bundle currently has no supported
folder bridge and refuses before acquiring a folder; being served by the host
does not establish usable hosted editing.
Standalone Whispering owns its own folder and lifecycle.

The host brokers credentials and owns native resources. Product pages own
unsaved input. The Bun sidecar serves product bundles without owning their row
input.

## Configure the server

A desktop build connects to one server. The default is Epicenter Cloud. Set
`EPICENTER_SERVER_ORIGIN` when compiling the native host to build for a
self-hosted HTTP(S) origin. Changing it requires rebuilding the host.
Rust passes this descriptor to Bun and uses the same origin to validate native
sign-in URLs. App windows receive the descriptor with their identity snapshot.
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

Development uses `so.epicenter.dev` for data, settings, and keyring entries.
Production's authored folder root is `~/Epicenter`; development's is `~/Epicenter Dev`.
`EPICENTER_FOLDER_DIR` overrides the authored folder root and must be absolute.
Built installed apps go to the platform cache directory, `so.epicenter` (or
`so.epicenter.dev`) under `~/Library/Caches` on macOS; `EPICENTER_CACHE_DIR`
overrides it and must be absolute.

Files split by what they cost to lose (ADR-0539):

```txt
~/Epicenter/                                  read, edited, and versioned as files
  so.epicenter/                               Epicenter's own folder
    epicenter.json                            declares the apps table and settings
    kv.json                                   settings: defaultApp, by folder id
    apps/<app-id>.md                          one row per installed app
  Apps/<app-id>/                              an installed app's source repository
~/Library/Application Support/so.epicenter/   written only by Epicenter
  approvals.json                              which app commits may run here
~/Library/Caches/so.epicenter/                disposable
  builds/<app-id>/<commit>/                   built app bundles
  builds/<app-id>/<commit>.log                what the install and build printed
  builds/<app-id>/current                     the commit the host serves
```
Overrides select an explicit location, so pointing both builds at the same
location deliberately shares those files. Development starts signed out after
credential isolation; production credentials are unchanged.

Rust resolves the three directories once at startup, stores them for the
desktop lifetime, and sends them through the versioned startup message. Bun
consumes those paths. The recorder writes into a folder a window was granted,
not into application data (`tauri-plugin-epicenter-recorder`, ADR-0543). Bun never derives a desktop root from its
process environment. Native model settings retain Tauri's app-config location.
Standalone Local Books still defaults to production data; use
`EPICENTER_DATA_DIR` when directing its CLI to development storage.

Earlier Windows builds used `%APPDATA%\so.epicenter`. Existing files are not
moved automatically. To carry them forward, stop Epicenter and any CLI using
its data, back up the old directory, then copy it to
`%LOCALAPPDATA%\so.epicenter` before launching the new build. Retain the old
directory: native model settings still use Roaming AppData. If the destination
already contains data, do not merge or overwrite the directories. Set
`EPICENTER_DATA_DIR` to the full path of the directory you intend to use instead.
The same override can keep an existing installation at its old location.

### Start the host

Use Bun 1.3.14 or newer (`bun --version`; update with `bun upgrade`).
Bun 1.3.1 and 1.3.3 can close the native input stream during sign-in, leaving
Settings disconnected and applications unable to open. The host rejects older
runtimes before startup. Packaged builds embed Bun and must be rebuilt with
the supported version.

Start Epicenter from the repository root:

```bash
bun dev:epicenter
```

This starts the local API on `http://localhost:8787` and the desktop host.
It requires the API's [local Postgres and Infisical setup](../api/README.md#development).
The API rebuilds its sign-in page at startup so both sides use the current
session handoff. Development never needs the deployed production sign-in page.

Finish sign-in in your browser, then return to Epicenter. Settings shows the pending
attempt and lets you cancel without signing out of your existing account.
Development returns through the running host's loopback callback because a raw
macOS development executable has no registered URL scheme. Packaged builds keep
`epicenter://auth/callback`. If you set `EPICENTER_DEV_PORT`, set it on this root
command so the API approves the same exact callback port the host binds.

Epicenter opens the [Folders window](#the-folders-window) (ADR-0537): launching
Epicenter, reopening it from the Dock, and `epicenter://` without a path all show
it. It lists your data folders, offers "Open in Todos" or "Open in Capture" on
the folder that app opens, lists every other app under Apps, and opens Settings
from its Settings button. Launching an app opens its own window; the OS is the
switcher from there, and closing the Folders window leaves everything it
launched running.

Settings is the window labelled `home`, with two panes: Chat and Settings. It
alone administers the local transcription model (ADR-0180). While Whispering is
launchable, it hands transcription setup back to its Settings pane when the
host has no usable local model, and Settings offers the ordinary launch action
once there is one. The tray (Show Folders, Show Settings) and deep links remain
shortcuts into the same windows:

```bash
open 'epicenter://'
open 'epicenter://app/todos'
open 'epicenter://app/folders'
open 'epicenter://app/home'
```

## The Todos folder

Todos keeps each todo as a Markdown file in an ordinary Git repository:
`so.epicenter.todos` under the authored folder root native startup resolved
(`~/Epicenter` in production, `~/Epicenter Dev` in development, or
`EPICENTER_FOLDER_DIR`). Other programs edit the same files and run `git` in
the same repository.

The Rust shell installs the shared `tauri-plugin-epicenter-folder` and registers
`so.epicenter.todos` for the `todos` window alone (ADR-0531). The first grant
creates the directory, takes the cross-process lock until shutdown, and lets
the window read beneath it. The page opens the folder with
`@epicenter/folder`'s own engine: reads, writes, and Git through the shell
(`read_folder_file`, `write_folder_file`, `run_git`), which read only beneath
the root, never through a link, change only data
paths the shared path rule accepts, never Git's own state, and run only the
Git operations the engine uses. History
is real Git, so Save version is a commit and Sync pushes to and fetches from the
repository's own `origin` with the person's own Git credentials. Todos has its
own capability grant for the trusted production or development origin; its file
operations have no HTTP route.

A window close hides the loaded page and preserves its drafts. Quitting or
restarting Epicenter is immediate and asks nothing (see
[Quitting Epicenter](#quitting-epicenter)); saved files stay, and a save or Git
run cut off at exit leaves the old file or a lock Git names. Reloading the page
loses unsaved typing. Two native
processes cannot open the same directory. See Todos' [README](../todos/README.md)
for version checks, terminal interleaving, and external-edit limits.

## The Capture folder

Capture keeps one Markdown file per capture under
`<folderDir>/so.epicenter.capture/captures`. Frontmatter holds `capturedAt`;
the body holds the original text and an ordered list under `## Thoughts`.
The page edits that source, and its full-source editor exposes the same bytes.
It opens without an Epicenter account.

The Rust shell registers `so.epicenter.capture` for the `capture` window alone
(ADR-0531), as it does for Todos. The first grant creates the
directory and takes the cross-process lock until shutdown; the page opens the
folder with `@epicenter/folder`'s own engine, reading, writing, and running Git
through the shell. There is no Capture HTTP file
bridge. Browser Capture keeps a separate folder in its origin's private file
system (OPFS).

Closing the native window hides it with its drafts intact. Quitting or
restarting Epicenter is immediate (see [Quitting Epicenter](#quitting-epicenter)):
text typed and not added is lost, and a stopped sidecar reloads the window.

## The Folders window

The Folders window (`folders`, served at `/apps/folders/`) opens any data
folder under the authored folder root, including Todos's and Capture's while
those apps are open. Its page source is `src/folders`, built by
`build:folders` into `dist/folders` and served like any compiled application.
It is the window Epicenter opens to, and `epicenter://app/folders` opens it.

The page asks the shell for `list_data_folders`, granted to this window alone
(`folders-*` capabilities, beside `epicenter-folder:default`). The shell lists
the direct children of the root that are real directories, not links or dot
entries, holding a regular file `epicenter.json`, and answers each with
`{ id, title, app, declaration }`: `title` is `epicenter.json`'s `title` when
it is a string, else the directory name, `app` names the application that owns
the folder, and `declaration` is the text of `epicenter.json`. The page passes `id` to `openDataFolder({ id })` from
`@epicenter/folder/tauri`. The reply carries no paths; the page learns a
folder's root from the plugin's grant, as Todos and Capture do.

- **An application's folder** keeps its application's scope
  (`so.epicenter.todos`, `so.epicenter.capture`). The plugin holds one
  cross-process lock per folder, so a second scope on the same root would be
  refused `Busy`; listing permits the `folders` window into the existing scope
  instead (`Folders::permit`), and both windows' saves are checked and
  published under the plugin's one mutex per root (ADR-0535).
- **Epicenter's own folder**, `so.epicenter`, is registered at setup for the
  `folders` and `home` windows and listed under that scope. `Apps/` is not
  listed: it holds no `epicenter.json`.
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

The page lists the folders and opens the chosen one in place; choosing another
closes the open handle first.

The open folder is read through TanStack Query with `folderOptions(folder)`
from `@epicenter/folder/query` (ADR-0548). The page's root subscribes the
folder's `onFilesChanged` when it opens it, before anything reads, and each
report invalidates the queries `pathFilter` names; switching folders stops the
subscription and drops the folder's cache. On the desktop the reports are the
shell's file watcher's. Focus refetch is off and the view has no refresh of its
own, so another window's save, an agent's edit, or Sync landing a change
appears within the watcher's debounce. A changed `epicenter.json` opens the
folder again once queued saves settle, so the grid follows the new declaration.

Beside a folder, the page offers the apps that open it (`src/folders/openers.ts`,
ADR-0538). An app is offered when the folder's declaration contains the app's
shape, `shapeProblems(declared, shape)` from `@epicenter/definition`, where the
shape is the app's own folder definition (`todosDefinition`,
`captureDefinition`). One match shows "Open in Todos"; several show "Open
with…". A built-in app opens only its own folder today, so it is offered only
on that folder; another folder of the same shape is not offered it until an
app can open the folder it is handed. An installed app that can run is offered
on every folder whose declaration contains its shape, and is handed that
folder at launch. Every compiled application not offered
on a listed folder is listed under Apps with an Open button, so Todos stays
reachable before its folder exists. Every button launches through
`launch_application`, which this window shares with Settings
(`launch-application-*` capabilities); model administration stays in Settings. An opened folder shows the tables its `epicenter.json` declares
(`folder.definition.tables`). The selected table is a grid of its rows read
with `table.list()`: one column per declared field, in declared order. A row's
stem opens a side panel with every field, keys the table does not declare
(shown, kept, and not editable), and the Markdown body. A row that does not
read (`InvalidRow`) shows its issues and text and cannot be edited. A folder
that declares no tables says so and lists its files, read only.

Each field gets the editor its schema and `x-field` hint resolve to
(`fieldEditorOf`, mapped in `src/folders/field-input.ts`): a checkbox for
`boolean`, a menu for `select`, toggles for `multiSelect`, comma-separated
text for `tags`, a date input for `date`, JSON text for `json` and for any
field whose hint does not fit its schema, and a text input for the rest.
Instants and datetimes are edited as their ISO text. A field with no hint at
all, as a hand-written JSON Schema declares it, gets the editor its type
implies: a checkbox for `boolean`, a number input for `integer` and `number`,
a menu for a string `enum`, a date input for a `date` string, ISO text for a
`date-time` string, toggles for an array of a string `enum`, tags for an array
of strings, and a text input for any other string. A hint that is present
always wins. Clearing an optional field removes it from the row.

### Saves and merges

Each row's edit is a draft (`createDraft` from `@epicenter/folder/query`, in
`src/folders/row-edits.svelte.ts`) that captures the row and its version at
the first change: the first keystroke in a box, or the click of a checkbox,
menu, or toggle. Until then a box follows the stored value, even while
focused. A text field saves on Enter or when it loses focus, the body when its
box loses focus, and every other editor on change; Escape, or leaving a box
with the text it showed, saves nothing. An edit the page has not yet sent when
Epicenter quits is lost, such as body text still being typed (see
[Quitting Epicenter](#quitting-epicenter)).

A refetch updates the cache, never the draft. While a row's draft is open and
the cache's version differs from the draft's, the row says "Changed elsewhere;
your edit will be merged". Every save is `table.save` over the draft's
starting version, through the table's save mutation, one save at a time. The
engine merges with whatever changed since (ADR-0548): a field or body lines
only one side changed keep that side's change. Where both changed a field, or
the same body lines, this edit wins, and a notice names each value it replaced,
by field or by notes line, with what was kept and what was theirs. The notice
stays until dismissed. "Restore theirs" is one more save of
`restoreTheirs(saved)`, over the version the first save wrote, that puts their
values back in those fields and their side of those lines (ADR-0551). A row
another window deleted, or saved in a form that does not read as a row, is not
overwritten. When a save fails, the view says why and the editors show the
stored values again.

"Save version" runs the folder's `saveVersion` mutation, `folder.git.commit()`
(ADR-0529), and reports a version saved, nothing new to save, or why none was
saved; the header shows how many files changed since the last version, from
the history's `status` query. The window never writes `epicenter.json`.

## Installed apps

An app is a Git repository with `epicenter.app.json` at its root (ADR-0540):

```json
{
  "id": "com.example.board",
  "title": "Board",
  "opens": "shape.json",
  "build": "bun run build",
  "output": "dist"
}
```

- `id` is a lowercase reverse-domain name. `so.epicenter` and the built-in
  apps' ids are refused.
- `opens` is the repository path of the shape the app reads (ADR-0538): a
  JSON declaration, the output of `formatDeclaration(definition)` from
  `@epicenter/folder`, committed in the repository.
- `build` and `output` default to the values shown. The output is a
  single-page app built with a relative `base`, holding `index.html`.

The Folders window's Apps list has "Install from Git URL…". It takes a Git URL
(`https`, `http`, `ssh`, `git`, `file`, or `user@host:path`) or an absolute
local path, and calls `install_app`. The shell clones it into
`~/Epicenter/Apps/<app-id>/` and builds nothing. The page shows the title, the
source, the commit, its log, and that building runs the app's code on this
computer. "Approve and build" calls `approve_app`, which records the commit in
`approvals.json`, runs `bun install --frozen-lockfile --ignore-scripts` (when
the repository has a `package.json`) and the build command in the clone, and
copies the output to `builds/<app-id>/<commit>/`. The page then writes the
app's row, `so.epicenter/apps/<app-id>.md`, with its title, source, and
commit, through the folder engine (`src/folders/epicenter-folder.ts`).

What runs is decided per commit:

- A commit made on this machine, by a person or an agent committing in
  `Apps/<app-id>/`, runs without asking: every commit since the approved one
  is unreachable from every remote-tracking ref and from `FETCH_HEAD`.
  Opening the app builds it and records it as approved, so pushing it later
  does not ask again.
- Anything else, such as "Update" (fetch, then a fast-forward or a rebase of
  the commits made here onto upstream), waits for approval with `git log` and
  `git diff --stat` since the approved commit. A rebase that conflicts is
  undone and reported.
- Uncommitted changes do not build: what runs is always a commit.

The shell runs every Git command for an app as the folder plugin runs a
page's: no hooks, no fsmonitor, no terminal prompt, and no inherited variable
pointing Git at another repository. Builds stop after 15 minutes. In a
release, `bun` is the bundled host itself (`BUN_BE_BUN=1`, linked as `bun`
first on the build's `PATH`); development uses the `bun` on `PATH`.

The Bun host serves an installed app's current build at `/apps/<app-id>/` on
Epicenter's origin, behind the same session gate and auth bootstrap as a
compiled app, with its document's inline scripts hashed into its own
Content-Security-Policy. `open_installed_app` opens it in its own window,
labelled `app:<id with _ for .>`, plus `:<folder scope in hex>` when it is
opened on a folder; the `installed-app-windows-*` capability grants those
windows `epicenter-folder:default` alone. Opened on a folder, the window is
permitted into that folder's scope and the page gets `?folder=<scope>`, which
the app opens with `openDataFolder({ id, lens })`.

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
  where the Folder plugin fences new work and releases each folder's lock, and
  `shutdown_host` closes Bun's stdin and gives it `SHUTDOWN_TIMEOUT` to stop.
- **An account change restarts at once.** Sign-in or sign-out writes the next
  credential, then sends `relaunch` over the private Bun pipe, and Rust calls
  `request_restart` ([ADR-0415](../../docs/adr/0415-runtime-replacement-ends-application-sessions.md)).
  No window can refuse it.
- **A host restart reloads the windows.** When Bun stops, every window it
  served is destroyed, because its initialization script carries that host's
  token. The built-in windows a person could see are queued and created again
  once the next host is ready, and each page reopens its folder. Installed
  apps' windows stay closed; the person opens them again from the Apps list.
  Destroying the last window does not quit Epicenter: an exit request with no
  code is refused, and Epicenter stays in the tray meanwhile. The failure
  dialog offers Retry, which starts the next host and opens those windows.
  Whispering's recording overlay is an `NSPanel` that cannot be destroyed
  (destroying it throws an AppKit exception that aborts the process), so a
  host restart hides it instead (`on_host_stop` in `src-tauri/src/lib.rs`).
- **Closing a window hides it.** The built-in windows are hidden, not
  destroyed, so their pages and folders stay open until Epicenter quits. An
  installed app's window is destroyed when it closes.

## Build and verify

```bash
# Build Settings, every compiled application, and the Bun sidecar
bun run --cwd apps/epicenter build:desktop

# Package the complete native application
bun run --cwd apps/epicenter desktop:build

# Typecheck the host, Settings, and the Folders window
bun run --cwd apps/epicenter typecheck

# Typecheck the host, Settings, Whispering, Capture, and Todos
bun run --cwd apps/epicenter typecheck:desktop

# Host, routing, sidecar, and window tests
bun test apps/epicenter/scripts apps/epicenter/src

# Native command and fixture tests
cargo test --manifest-path apps/epicenter/src-tauri/Cargo.toml
```

The root `bun typecheck` runs each workspace's checks, including the apps checked
by `typecheck:desktop`. Use `typecheck:desktop` for standalone verification of
the host with Whispering, Capture, and Todos.

## Ownership rules

- `src-tauri` owns native commands, permissions, windows, deep links, and packaging.
- `src` owns the Bun host, built-in routes, static-asset containment, and the Settings chat session.
- `dist` is generated. Never edit it or commit product source beneath it.
- A product SPA owns its UI and browser deployment from its own app folder.
- A multi-host SPA selects implementations through build-time `#platform/*` conditions. Runtime checks guard optional capabilities; they do not choose which implementation was bundled.
- Do not create `apps/epicenter/<app>` source copies. The build must consume the canonical app source directly.

The durable host and trust decision is recorded in [ADR-0118](../../docs/adr/0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md).

## Shared AI connections

Apps built for `epicenter-host` use one custom inference catalog per desktop
profile. The host stores endpoint metadata in `ai/connections.json` under its
resolved data directory and optional keys in the OS keychain. This configuration
is shared across apps on that profile; it does not sync between devices or enter
an application's store data.

The `/_epicenter/ai` broker uses the existing browser session. Mutations also
require the exact host Origin. Open apps receive committed snapshots over SSE;
inference requests identify an immutable connection ID and captured access
version. Apps receive `hasApiKey`, never the stored key. Their workflow choices
remain separate. See the [App API](../../packages/app/README.md).
