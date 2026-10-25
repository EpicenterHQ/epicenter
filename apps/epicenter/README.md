# Epicenter desktop app

Epicenter hosts Settings, a Folders window, and the apps it bundles in one
Tauri runtime. The Folders editor opens native
directories through `@epicenter/folder/next`. Apps supply their own
table schemas; local opening and saving require no account or Git repository.
Git commands still exist outside a Folder handle, but the current folder and
product pages offer no Save version, Connect, or Sync action.

The existing app owns one Tauri runtime, one native command API, and the short
list of what it compiles in. It bundles [Todos, Capture, Honeycrisp, Whispering, and
Messages](#bundled-apps), each built from its own folder under `apps/` with
Epicenter's own pages. Epicenter installs no other app: there is no source
installer, manifest, approval, or app build on this machine. Clones and
builds an earlier version installed are left on disk, never read and never
removed ([Application data](#application-data)).

```text
page source                         build output        served at

apps/epicenter/src/ui ------------> dist/home --------> epicenter-app://localhost/home/
apps/epicenter/src/folders -------> dist/folders -----> epicenter-app://localhost/folders/
apps/<page> (build:host) ---------> dist/<page> ------> epicenter-app://localhost/<page>/
  for todos, capture, honeycrisp, whispering, messages
```

Rust serves every page Epicenter shows from one origin,
`epicenter-app://localhost`, through a scheme the shell registers
(`src-tauri/src/scheme.rs`, ADR-0561): Settings (the `home` window) at
`/home/`, the Folders window at `/folders/`, and each bundled app at
`/<page>/`. No server listens on a port and no Bun process outlives a
command. The `epicenter-host` build condition selects each product's host
integrations.

The scheme answers GET only. It serves a regular file inside the page's
directory, refusing a symbolic link and any path that leaves it, and answers
an extensionless path that names no file with that directory's `index.html`,
so client-side routes load. Every response carries one
Content-Security-Policy: a page reaches its own origin and Tauri's IPC
(`connect-src 'self' ipc: http://ipc.localhost`) and nothing else, and a
document's policy admits each of its inline scripts by hash. Each window
navigates only below the path it opened at, a built-in page's or a bundled
app's `/<page>/`, so an app window never loads another app's page; a
new-window link opens in the system browser only when it is the hosted
account website.

App pages reach native file folders through the shared Folder plugin. Each
page opens a directory the shell grants (ADR-0531). The editor and Settings
use `@epicenter/folder/next`; other bundled pages still use the previous
folder API. A bundled app's window is granted the native commands its page
calls by its window label ([Bundled apps](#bundled-apps)).

The shell serves product bundles and holds no credential: the `epicenter`
CLI holds the account and every key (ADR-0556). Settings opens its records
folder through `<OpenFolder>`, creates connection rows with
`folder.tables.connections.create`, and updates title and model through row
patches. Each text field keeps its own draft until its write answers. Failed
writes keep the typed value and show Save again, Discard, and Copy beside the
field. Connection creation and deletion report their own failures beside the action.

## The epicenter binary

Epicenter ships one compiled Bun binary (ADR-0556): the `epicenter` CLI from
[`packages/cli`](../../packages/cli/README.md). `bun run build:sidecar`
compiles its entry, `packages/cli/src/bin.ts`, to
`src-tauri/binaries/epicenter-cli-<target triple>`, the `externalBin`. The
bundle calls it `epicenter-cli` because Tauri refuses a sidecar named like the
Cargo package, `epicenter`; on `PATH` it is `epicenter`.

The one binary has these uses:

- The shell's narrow CLI runner (`src-tauri/src/cli.rs`) runs it for a page's
  fixed commands. A page has no generic exec: each command maps to one
  `epicenter` invocation, writes stdin on its own task, and streams each
  stdout line to the page's `Channel`. Development runs the CLI's source
  under `bun` instead of the binary.
- Settings' Account section runs the CLI's desktop sign-in through three
  fixed commands, granted to the `home` window by `home.json`
  (ADR-0558). `auth_login(onEvent)` runs `epicenter auth login --desktop
  --json`: the CLI listens once on
  `http://127.0.0.1:<random port>/callback` and prints `{"open": "<url>"}`,
  which the shell opens with the opener only when it is the deployment's
  `/auth/oauth2/authorize`, then `{"signedIn"}` or `{"error"}`; every line
  goes to `onEvent`. `auth_status()` runs `epicenter auth status --desktop
  --json` and `auth_logout()` runs `epicenter auth logout --desktop --json`.
  `ai_send` runs `epicenter send --json --desktop` for user-supplied provider
  connections.
- `account_send(audience, generation, request, requestId, onEvent)` sends a
  page's resource-bound Account request (ADR-0683). Whispering alone has this
  command permission, and Rust admits only its API-resource hosted
  transcription, completion, and profile paths. The target sent to the CLI
  includes the Account's captured grant generation. The CLI checks that
  generation before selecting a cached or refreshed token, then streams the
  response through the same event protocol as `ai_send`. A replaced sign-in
  answers `GrantChanged`; a missing grant answers `NoAccountToken`.
  `send_cancel(requestId)` stops that window's one request and response stream.
  No page or Rust command receives an access token (ADR-0549).
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
Production's library, the authored folder root, is `~/Epicenter`; development's
is `~/Epicenter Dev`. `EPICENTER_FOLDER_DIR` overrides the library at startup
and must be absolute; changing it opens another library and moves no files.
Native locations live in `tauri_plugin_epicenter_folder::defaults::DesktopPaths`,
shared with standalone Todos. Each app's default is a fixed reverse-DNS child
from the shared `library` table (ADR-0672), the same `library::TODOS` row for
both Todos shells; changing an app's display name does not redirect its
authored work.
The shell resolves both directories once and sets `EPICENTER_DATA_DIR` and
`EPICENTER_FOLDER_DIR` on every `epicenter` command it runs, so the CLI
writes where the shell reads. A terminal's `epicenter` uses the same
variables, or the release app's directories when they are unset
(`packages/cli/src/app-paths.ts`).

Files split by what they cost to lose (ADR-0539):

```txt
~/Epicenter/                                  read, edited, and versioned as files
  so.epicenter/                               Epicenter’s portable records (Settings)
    epicenter.json                            optional older declaration, retained if present
    connections/<id>.md                       one row per AI connection
  so.epicenter.todos/                         Todos's default
  so.epicenter.capture/                       Capture's default
  so.epicenter.honeycrisp/                    Honeycrisp's default
  so.epicenter.whispering/                    Whispering's default
  so.epicenter.messages/                      Messages's default
  Notes/, ...                                 other data folders, each listed and opened as files
~/Library/Application Support/so.epicenter/   written only by Epicenter
  auth/<grant>.lock                           the lock a sign-in refreshes under (the CLI writes it)
  navigation.sqlite                           machine-local pins and recent openings
  local-transcription.json                    the active local model and when to unload it
```

Defaults are derived, never saved: an ordinary launch creates its missing
default and reuses an existing one with its files, without an ownership
claim. No configuration selects or remembers them. Ordinary launches ignore
an earlier build's `folders.json` and earlier default names such as
`~/Epicenter/Todos`. Those folders stay listed as root children and open
explicitly; nothing moves their data. Release and development data remain separate.

An earlier version installed apps from Git repositories. Its bare clones in
`apps/<app-id>/` under the application-data directory, and its builds, logs,
and lock under `~/Library/Caches/so.epicenter/` (or `EPICENTER_CACHE_DIR`),
stay on disk. Epicenter never reads them and never removes them; delete them
by hand to reclaim the space. The folders those apps opened under the same
reverse-DNS names, such as `~/Epicenter/so.epicenter.todos`, are now those
apps' defaults, reused with their files.

Overrides select an explicit location, so pointing both builds at the same
location deliberately shares those files. Development starts signed out after
credential isolation; production credentials are unchanged.

Rust resolves both directories once at startup and stores them for the
desktop lifetime, and every `epicenter` command the shell runs receives
both. The recorder
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
Settings, the Folders window, and the five bundled apps into `dist/` and compiles the
`epicenter` binary. A development build's scheme serves the pages from that `dist/`
directly, so after changing a page, run `bun run --cwd apps/epicenter build`
and reload its window (Cmd-R). There is no dev server and no hot reload: the
scheme is the one way a page is served, in development as in a release.
It requires the API's [local Postgres and Infisical setup](../api/README.md#development).
Settings' Sign in is the CLI's desktop sign-in (`epicenter auth login
--desktop`, client `so.epicenter`): finish it in your browser and Settings
shows who the app is signed in as. Nothing restarts. It is a separate grant
from a terminal's `epicenter auth login`, and signing one out leaves the
other signed in.

An app opens the local directory bound to its window before any account flow. Each
bundled app uses the same `Folder` table schemas on desktop and in the
browser.

Epicenter opens the [Folders window](#the-folders-window) (ADR-0537): launching
Epicenter, reopening it from the Dock, and `epicenter://` without a path all show
it. It lists your data folders, opens each in an editor window of its own,
offers "Open with…" on every folder for each bundled app, lists the bundled
apps under Apps with Open and Choose folder…, and opens Settings from its
Settings button with `open_home`. Opening an app opens its own window; the OS
is the switcher from there, and closing the Folders window leaves everything
it opened running.

Settings is the window labelled `home`. It signs the app in and out and alone
administers the local transcription model (ADR-0180). An app that needs
a local model opens it with `open_home('transcription')`, and Settings scrolls
to the model (`src/ui/home-section.ts`). The tray (Show Folders,
Show Settings) and deep links remain shortcuts into the same windows; bundled
apps have no deep link:

```bash
open 'epicenter://'
open 'epicenter://app/folders'
open 'epicenter://app/home'
```

### Try saved views with sample data (macOS)

From the repository root, run:

```bash
bun demo:views
```

This builds and opens **Epicenter Views Demo**, using the real desktop file
commands and SQL engine. Its separate application identity and fresh temporary
folders leave your normal Epicenter data alone. No API server or sign-in is
needed. The terminal prints the sample data location; files remain there after
the demo exits. Quit the demo before running the command again.

1. Open **Project**, then choose **Project board** from **Saved views**. Move
   **Try moving this card** from Todo to Doing with its lane selector.
2. Choose **All tasks** to inspect the same record in the grid. Edit its title,
   then open its file in **Files** to see the changed frontmatter and retained body.
3. Choose **Progress by status**, then **Run SQL**. After that move, the counts
   should be Doing: 2, Done: 1, Todo: 1.
4. Change a view's title and click **Save view**. Close and reopen Project to
   check that its saved settings return. Record edits save when you pause;
   view settings save only when you ask.
5. Open **Plain notes** and choose **Tables**, then the **notes** directory.
   It has no schema or declaration. Saving its first named view creates an
   `epicenter.json` containing only `views`.

This is an interactive desktop walkthrough. The mounted editor tests run with
`bun run --cwd apps/epicenter test:mounted`; they do not launch a native WebView.

## The Folders window

The Folders window (`folders`, served at `/folders/`) is a launcher over the
data folders under the authored folder root and the apps Epicenter bundles.
Its page source is `src/folders`, built by `build:folders` into
`dist/folders`. It is the window Epicenter opens to, and
`epicenter://app/folders` opens it. The shell binds no folder to it, and its
capability grants no folder command.

The page asks the shell for one derived listing, grouped in order as
**Pinned**, the library root's name (such as **Epicenter Dev**), and
**Recent**. Pins are explicit folder preferences. The middle group contains
visible real direct children of the library root. Recent records successful
app and editor openings, newest first, up to 20. A directory appears once:
pin takes precedence over library membership, which takes precedence over
recency. References resolving to the same physical directory share one row.
The launcher remains a compact single column; app launch and Choose Folder
controls stay under Apps, and Settings opens in its own window.

Each row shows its path. An existing fixed app default takes that app's title
and says **Default for Todos**; a directory elsewhere with the same name is
ordinary. An optional `epicenter.json` can supply another folder's display
title. Missing pinned and recent references stay visible with an availability
problem and can be removed. Listing creates no folders or missing defaults.
It retries removal of obsolete bookmark metadata; a cleanup failure appears
among listing problems.

Rows have native IDs derived from resolved paths. Opening an editor or choosing
an app in **Actions** passes that ID. Rust rebuilds current membership and
checks the directory before binding a window. A stale row cannot select
another directory. Pin is available for an admitted row; Unpin and Remove
from Recent remain available when a referenced directory has gone missing.
Epicenter's records directory can open in the generic editor, while bundled
apps keep their protected-directory checks. Application data and save staging
cannot open as ordinary folders.

The shell watches the root and `navigation.sqlite` from setup until exit. Root
children, their `epicenter.json` declarations, and navigation writes invalidate
the listing. Focus refreshes it too, so outside paths are checked again.

### Incoming folders and navigation

A standalone app can ask Epicenter to open
`epicenter://open?path=<percent-encoded absolute directory>`. Receiving the
link only queues it and shows the launcher. **Open** resolves the existing
directory and opens its own bound editor; **Dismiss** reads none of its files.
Handoffs refuse folders overlapping Epicenter's Settings or app data. The
editor receives the same canonical directory that passed admission.

After any successful app or editor opening, including default, listed, chosen,
and accepted handoff openings, the shell records its canonical directory in
Recent. A cancelled picker, failed opening, queued handoff, listing, and edits
within an existing window record nothing. If persistence fails, the opened
window remains open, a warning appears, and the directory remains in a
temporary Recent row for this run. Temporary rows appear first in Recent,
newest first, until saved again or removed. Pins change only when requested. Pin,
Unpin, and Remove from Recent move no files and leave windows and drafts open.
Opening another directory changes no app default: each remains its fixed
`<root>/<id>` (ADR-0672).

The CLI's `epicenter folders pin|unpin|list|remove-recent` shares
`<app data>/navigation.sqlite` with the native shell. Independently keyed
`pins(path)` and `recent(path, sequence)` tables keep pin intent separate from
opening history. SQLite immediate write transactions serialize both writers;
a deferred read transaction returns one consistent listing. The database uses
the DELETE rollback journal and a 10-second busy timeout. Foreign, future,
corrupt, or non-DELETE-journal databases are refused without replacement.
On startup, Epicenter also discards obsolete `bookmarks.json` under its old
save lock without reading it or following a symlink; each CLI folders command
does the same. A cleanup problem is reported. The earlier `folders.json`, its
lock, and app-scoped device storage remain separate. Stray `navigation.json`
files are ignored. Navigation is machine-local.

### Folder editor windows

Choosing a listed folder calls `open_folder_editor(id)`. The shell rebuilds
the combined list and requires a current, available row with that ID. It
binds that exact directory to a window labelled `files:<digest of the
canonical root>` and opens `/folders/editor/`. Choosing it again reveals
the existing window. This works for listed folders outside the root
without copying or creating a directory.

The editor mounts `<OpenFolder>` with no table schemas, so Files, grid, board,
and SQL share one opened folder and its window lifetime. Files opens exact
source text, retaining byte-order marks and CRLF endings. Files also reads
unkept extensions such as `.py` on demand and edits them when they decode as
UTF-8. Binary content and mixed line endings remain available without text editing.

Tables reads root-level and nested Markdown through the same generic document
reader as SQL. Columns combine observed fields with declared properties from
optional `epicenter.json`. Missing frontmatter means empty fields; malformed
source remains visible with diagnostics and a link to Files. Scalar cells are
editable; nested JSON values remain readable through the grid and editable in
Files. The folder's schema interprets values and never refuses a save.
Unparseable source locks structured edits until it is repaired in Files;
schema diagnostics alone do not lock editing.

Grid and board settings retain columns, typed filters, and ordered sort rules.
Filters and sorting use landed values. A row edited out of a filter stays
visible while it has focus, labelled "No longer matches this view's filters".
A saved grid or board names one top-level directory; it needs no declared
table schema. The unsaved Tables view can also browse all Markdown, the folder
root, or nested directories.

Boards group one field into distinct string, number, boolean, and null lanes.
Enum and boolean schema hints retain empty destinations. **No value** represents
an absent field. Object and array values appear in **Other**, which cannot be
chosen as a move destination. Moving a card changes its grouping field through
`folder.update(path, { fields }, { schema })`. A failed move leaves the card
in its current lane and reports the error beside the control.
Cards have no separate rank or drag-order record.

The mirror reads every kept text file when it opens and gives Files its exact
source through `folder.file(path)`. Tables interprets the same file values with
`documentsOf`, while the SQL CLI builds the same values from disk. Each text
input has a local `draft` that debounces writes and shows typing until its write answers; folder
writes then update the mirror's landed values. Structured edits use
`folder.update(path, patch, { schema })`, including root and nested Markdown.
Each write takes a turn in the folder queue. A patch reads the file as it is
when its turn comes, so adjacent cell edits do not overwrite one another.
A file read failure can be retried with `folder.refresh()`. Failed drafts keep
their value and offer Save again, Discard, and Copy beside the editor.
Checkboxes and board moves write directly and report failures beside the action.
Switching file editors mounts the next editor immediately; teardown sends the
previous editor's latest unsent text.

The folder owner refreshes on focus, visibility, and connectivity. Drafts send
their latest text on page hide and folder close.
Closing an editor window waits for writes in flight before destroying it.
Saved-view submissions compose from the latest submitted declaration text while
a write is waiting. Whole-file edits in Files and saved-view saves use last
write wins when they race.

The SQL console uses `documents(path, directory, stem, fields, body, issues)`.
`fields` and `issues` contain JSON. Each run reads saved files into disposable
Bun SQLite; it excludes unreadable and non-text files by name, retains readable
malformed records with issues, and writes no query result back. Runs have a 15-second request deadline, and results stop at 1,000 rows or
4 MiB of encoded row data. Each SQL view keeps its own unfinished statement,
running request, result, and error while another view is selected. The console
warns when results belong to a previous statement. The native command
accepts SQL only; Rust derives the directory from the invoking window's
existing binding and uses the owned CLI child lifetime. There is no browser
SQL engine or page-supplied filesystem root. Public CLI `query` keeps its
separate declared-table contract.

**Save view** persists grid, board, or SQL settings in root `epicenter.json`.
Browsing and changing view settings write nothing until that action. The first save
can create a declaration containing only `views`. The editor assigns an opaque
UUID key; changing the display title keeps that key. **Save as new** creates a
separate entry. These views travel with the folder and have no personal override.

A saved view reads the current `epicenter.json` mirror value. Editing its
controls creates an unsubmitted form value retained across selections. **Reload
settings** drops that form and refreshes the folder. Saving transforms the
latest submitted declaration text, preserving unrelated JSON sections and other
views, then sends that text through `folder.write`. There is no source
precondition or separate native writer.

A submitted copy gets its new key immediately. The local `sending` text composes
later view submissions while earlier writes are waiting; `submitted` keeps each
view visible until its save answers. A failed save restores the form for retry
and offers source access and the error beside the form. The form keeps settings
that have not yet been submitted.
Invalid and future view entries stay in the source with diagnostics while valid
siblings remain available. The pure `changeSavedView(text, { key, value })`
transform is portable across storage backends.

The mirror notifies the editor when a write lands or outside changes are read.
It refreshes on focus, visibility, and connectivity; **Reload
settings** also refreshes. Files, Tables, and saved views then read the same
current file values without query invalidation or manual refresh.

### Opening apps

Beside each listed directory except protected ones such as Epicenter's records
directory, "Open with…" offers every bundled app (`src/folders/openers.ts`).
The Apps list offers Open, on the app's fixed default, and Choose folder…,
which asks the shell to show the
native folder picker. The app interprets its files through its own schemas.
The Folders view does not use `epicenter.json` to authorize any of them.

## Bundled apps

Epicenter bundles Todos, Capture, Honeycrisp, Whispering, and Messages
(`src-tauri/src/bundled_apps.rs`). One closed table, `BundledApp`, names for
each its page, its shared `library` default, its window label and capability,
and its build path:

| Page | Default folder | Window label | Capability |
| --- | --- | --- | --- |
| `todos` | `<folderDir>/so.epicenter.todos` | `todos:<digest>` | `bundled-app.json` |
| `capture` | `<folderDir>/so.epicenter.capture` | `capture:<digest>` | `bundled-app.json` |
| `honeycrisp` | `<folderDir>/so.epicenter.honeycrisp` | `honeycrisp:<digest>` | `bundled-app.json` |
| `whispering` | `<folderDir>/so.epicenter.whispering` | `whispering:<digest>` | `whispering.json` |
| `messages` | `<folderDir>/so.epicenter.messages` | `messages:<digest>` | `messages.json` |

`build:bundled` (`apps/epicenter/scripts/build-bundled-apps.ts`) runs each app's own
`build:host` (`EPICENTER_HOST=1`) in `apps/<page>` and copies its `dist/` to
`dist/<page>/`, which the scheme serves at `/<page>/`; each build loads its
assets by relative path. Standalone Todos builds the same `dist/` for its own
Tauri shell (`bun run --cwd apps/todos build:desktop`). Opening an app clones,
builds, and fetches nothing, and asks for no approval, account, network, or
Git action.

The Folders window opens one in three ways, each deciding the folder in Rust:

- **Open**, under Apps, calls `open_bundled_app(app, null)`. The shell opens
  the app's fixed default, such as `~/Epicenter/so.epicenter.todos` in
  production, creating it when missing and reusing it with its files
  otherwise; nothing is saved, so a removed default is made again. Its
  permanent directory name is independent of the displayed app title. The
  app's rows land directly in it, such as `todos/<id>.md`. A disk that stores
  the default under another casing opens that directory. A file or a link at
  the path is refused; no other folder is opened instead.
- **Open in an app**, under a listed folder’s Actions menu, calls `open_bundled_app(app, id)`.
  Rust rechecks current listing membership, including outside pinned and recent folders.
  A missing, stale, or protected directory is refused. Nothing is created and
  the app's default is never opened as a replacement.
- **Choose folder…**, under Apps, calls `choose_folder_for_app(app)`. The
  shell shows the native folder picker and opens the app on what the person
  chose; cancelling opens nothing. The chosen directory must exist and be a
  real directory, never a link, though its parent may be one; it is never
  created. Epicenter's own folder is refused however it is reached. No page
  passes a path. Bundled app pages can show close confirmation, but no page has
  the dialog plugin's file picker.

The shell passes the app key, admitted directory, page URL, and builder
configuration to the folder plugin's `open_folder_window`
(`folder_windows.rs`). The plugin binds before the WebView exists and owns
identity, reuse, construction, and cleanup. Its label combines the app key
and a digest of the canonical root: the same app on the same directory reveals its window, and
two directories with one name in different places are two windows. The page
calls `openFolder({ tables })`, which opens the folder bound to its window;
Whispering's recorder writes into the same folder, and no call names it. Two
apps opened on one folder are two windows with separate bindings to one root, sharing its save lock. A folder removed after its window opened is refused `Missing` when
the page opens it again; a later Open of a removed default makes it again,
empty, and reveals that window on the same path.

The native Folder reads ordinary files as they stand. File writes, table assignments,
and editor saves publish without a source precondition. The last publication wins. Opening writes
nothing and does not start Git. The separate `epicenter` CLI retains Git
commands; no current product page exposes them as a Folder action. See Todos'
[README](../todos/README.md) and Capture's [README](../capture/README.md) for
app-specific files.

Closing a bundled app's window destroys it; only Epicenter's own windows
hide. The recorder finalizes a Whispering recording
when its window is destroyed, and the CLI runner ends the `epicenter`
children that page started.

On macOS, folder windows can share the system tab bar. Automatic grouping
follows the macOS tab preference. The **Window** menu offers **Merge Folder
Windows**, **Move Tab to New Window**, and **Close Tab Group** (Shift-Command-W).
Settings and the Folders launcher stay separate because closing them hides
them. Windows and Linux keep separate app-and-folder windows.

Each native tab keeps its own window, page, directory binding, and save
guard. Detaching or merging changes presentation without reopening the
folder or transferring drafts. Tab membership lives in AppKit, never in
application data.

Bundled app pages still use native close confirmation for unfinished Folder
saves (ADR-0663). The Folders editor waits for its mirror writes and closes
without a prompt. A saved window closes silently, including while recording:
native destruction ends capture and keeps the audio captured so far. Cancel
keeps unfinished input; confirmation destroys the window without waiting for a
save. Repeated requests for one window share its answer. Other windows answer
independently, including native tab-group members. A dispatched destruction
keeps the page inert until it is gone; a rejected close restores it for retry.

Application Quit always asks one separate native question. The recorder adds
an active-recording warning, without asking any folder page for save status.
Cancel preserves every window. There is no cross-window status protocol,
timeout, or global gate over individual window closes.

### Native commands for a bundled app

`capabilities/bundled-app.json` selects `todos:*`, `capture:*`, and
`honeycrisp:*` and grants the folder plugin and its change event. Inside
Epicenter the close guard confirms through `dialog:allow-message`,
focuses with `core:window:allow-set-focus`,
and destroys with `core:window:allow-destroy`.

`capabilities/whispering.json` selects `whispering:*` and grants what
Whispering's page calls:

- the folder plugin and its change event, for the one folder the shell binds
  to its window;
- the recorder plugin, and the opener's `allow-open-url` scoped to
  `x-apple.systempreferences:`, to open System Settings' microphone pane;
- `list_inference_models`, `transcribe_audio_bytes`,
  `get_local_transcription_readiness`, and `open_home`, for optional local
  transcription with the active model (ADR-0180);
- `ai_send`, `ai_key_set`, and `ai_key_state`, for user-supplied AI
  connections (ADR-0557);
- `auth_status`, `account_send`, and `send_cancel`, for its API-bound
  Epicenter Account (ADR-0683);
- `whispering_connection_read` and `whispering_connection_set`, for its two
  connection rows in Epicenter's records folder. The page names
  `transcription` or `text`; the shell runs
  `epicenter whispering-connection read|set`, which computes the same fixed
  `<folderDir>/so.epicenter` from `EPICENTER_FOLDER_DIR`, opens that
  directory, reads or saves the row under its save lock, and closes it. A read
  creates nothing; a save creates the folder when missing. A save assigns only
  `kind` (`openai-compatible`), `title`, and `model` to the current row.
  Settings opens the same records folder.

No bundled app's window is granted folder history (`status`, `history`,
`save_version`, `sync`), `ai_key_remove`, or model
administration. Whispering's page opens its folder and recovers interrupted
recordings before any connection or account is read, so local recording and
editing never wait for sign-in.

The save lock, `.<directory name>.epicenter-save-lock`, sits beside the folder
in the folder root; WebView data and the page builds live in the application
data and resource directories. The Folder engine stages a save's bytes in
`.<directory name>.epicenter-scratch` beside the folder. Whispering's own
folder was `so.epicenter.whispering` when it was installed; under that same
name it is now Whispering's default and opens with its files.

Each kind of window has one capability file, and every file is `"local": true`
because its page is served on the scheme: `folders.json`, `home.json`,
`bundled-app.json`, `whispering.json`, and `folder-editor.json`, which selects
`files:*` and grants the folder plugin, its change event,
and destroying its own window. A development build selects the same five. This is wiring, not a sandbox (ADR-0179, ADR-0334).

Whispering's page has no recording overlay and
registers no global shortcuts, so neither is created or granted.
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

Application Quit always shows a native confirmation, even when every folder is
saved. Its message warns that unsaved changes may be lost. If the native
recorder is capturing, it also explains that Quit ends the recording and keeps
its captured audio. Cancel keeps every window and its input; Quit Anyway exits
without waiting for pending saves. Repeated requests share the current alert.

Quit queries no page and waits for no status reply or timeout. Its standalone
native alert has no window parent, so closing a window leaves the Quit question
in place. Window close remains independent; bundled pages can warn for unsaved
Folder work, while the Folders editor waits for writes. Quit owns only ready, prompting, and approved state; it needs no attempt
ID or window-destruction hook. On macOS, the unparented dialog uses the system's
standalone alert presentation rather than an attached window sheet.

The app menu's Quit, Cmd-Q, and tray Quit use this path. macOS Dock Quit,
logout, and abrupt process termination are outside it. Standalone Todos' Cmd-Q
still uses its one window's conditional close. Atomic file replacement and
native recording finalization keep their existing guarantees.

- **An account change restarts nothing.** The account is the CLI's desktop
  grant (ADR-0556); a page that uses it reads it again when its window
  regains focus.
- **Closing a window hides it.** The built-in windows are hidden, not
  destroyed, so their pages and folders stay open until Epicenter quits. A
  bundled app's window is destroyed when it closes, which
  finalizes a Whispering recording.

## Build and verify

Signed distribution builds, the native update action, the draft release and
publication workflows, and an isolated packaged Epicenter-to-Epicenter update
rehearsal are documented in [Releasing](RELEASING.md). Bundled pages ship with
Epicenter; standalone products have no release workflow here.

```bash
# Build Settings, the Folders window, the bundled apps, and the epicenter binary
bun run --cwd apps/epicenter build:desktop

# Package the complete native application
bun run --cwd apps/epicenter desktop:build

# Typecheck Settings, the Folders window, and the build scripts
bun run --cwd apps/epicenter typecheck

# Page builds, the epicenter binary, and window tests
bun test apps/epicenter/scripts apps/epicenter/src

# Native command, scheme, capability, and fixture tests
cargo test --manifest-path apps/epicenter/src-tauri/Cargo.toml

# macOS runtime regression with real Todos pages and temporary native folders
bun run --cwd apps/todos build:host
cargo run --offline --manifest-path apps/epicenter/src-tauri/Cargo.toml --example native_tabs --features native-tabs-smoke

# The same tests with the parked native dictation code compiled in
cargo test --manifest-path apps/epicenter/src-tauri/Cargo.toml --features dictation
```

The root `bun typecheck` runs each workspace's checks. The bundled apps, such
as Whispering and Honeycrisp, are checked in their own folders.

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
makes each connection a row of a `connections` table in Epicenter's records
folder, keeps its key in this machine's keychain bound to the endpoint it was saved for, and
sends every AI request through `epicenter send`. Check that record's Unbuilt
line for what has landed.
[ADR-0672](../../docs/adr/0672-native-app-defaults-are-fixed-reverse-dns-children-of-one-library.md)
fixes that folder at `<folderDir>/so.epicenter`; no configuration selects it.

### Messages and Beeper

Messages starts with fictional demo conversations. Its `FolderApp` opens the
bound folder for drafts and send recovery records, never for a message mirror.
Only `messages:*` windows receive `messages_beeper`; the fixed command passes a
validated operation to `epicenter messages --json` over stdin. The CLI owns the
Beeper token in the device keychain and uses the local Desktop API. The page's
connection policy remains unchanged. See [Messages](../messages/README.md) for
persistence, manual connection setup and checks that use no live data.
