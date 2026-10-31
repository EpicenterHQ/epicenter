# Epicenter desktop app

Epicenter manages folders: it registers, syncs, shares, and shows the status
of the folders the `epicenter` CLI syncs. Apps are separate programs that read and write those folders
through the file contract
([ADR-0701](../../docs/adr/0701-apps-run-as-separate-programs.md),
[ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md));
Epicenter does not open, install, or serve them. History and sync belong to
the `epicenter` CLI: the [Folders window](#the-folders-window) is a front end
over it, listing the folders it syncs and running its commands. Epicenter
opens no folder's files: an app or any editor does.

The app owns one Tauri runtime, one native command API, and the short list of
what it compiles in. Its pages are Settings and the Folders window:

```text
page source                         build output        served at

apps/epicenter/src/ui ------------> dist/home --------> epicenter-app://localhost/home/
apps/epicenter/src/folders -------> dist/folders -----> epicenter-app://localhost/folders/
```

Rust serves these pages from one origin, `epicenter-app://localhost`, through
a scheme the shell registers (`src-tauri/src/scheme.rs`, ADR-0561): Settings
(the `home` window) at `/home/` and the Folders window at `/folders/`. No server listens on a port and no Bun
process outlives a command.

The scheme answers GET only. It serves a regular file inside the page's
directory, refusing a symbolic link and any path that leaves it, and answers
an extensionless path that names no file with that directory's `index.html`,
so client-side routes load. Every response carries one
Content-Security-Policy: a page reaches its own origin and Tauri's IPC
(`connect-src 'self' ipc: http://ipc.localhost`) and nothing else, and a
document's policy admits each of its inline scripts by hash. Each window
navigates only below the path it opened at; a new-window link opens in the
system browser only when it is the hosted account website.

The shell holds no credential: the `epicenter` CLI holds the account and
every key (ADR-0556).

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
  `epicenter` invocation, writes stdin on its own task, and reads each stdout
  line. Development runs the CLI's source
  under `bun` instead of the binary.
- The Folders window's actions each run one `epicenter` command, and the
  shell runs `epicenter sync --watch --json --desktop` in the background for
  as long as the app runs ([The Folders window](#the-folders-window)).
- Settings' Account section runs the CLI's desktop sign-in through three
  fixed commands, granted to the `home` window by `home.json`
  (ADR-0558). `auth_login(onEvent)` runs `epicenter auth login --desktop
  --json`: the CLI listens once on
  `http://127.0.0.1:<random port>/callback` and prints `{"open": "<url>"}`,
  which the shell opens with the opener only when it is the deployment's
  `/auth/oauth2/authorize`, then `{"signedIn"}` or `{"error"}`; every line
  goes to `onEvent`. `auth_status()` runs `epicenter auth status --desktop
  --json` and `auth_logout()` runs `epicenter auth logout --desktop --json`.
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
Native locations live in `tauri_plugin_epicenter_folder::defaults::DesktopPaths`.
Epicenter's records are a fixed reverse-DNS child from the `library` table
(ADR-0672), `library::RECORDS`. Nothing writes them any more (Settings kept
AI connections there); no window or `epicenter init` may claim them, so files
already there stay as they are. The standalone apps keep their data at
`~/Epicenter/<productName>`, outside that table.
The shell resolves both directories once and sets `EPICENTER_DATA_DIR` and
`EPICENTER_FOLDER_DIR` on every `epicenter` command it runs, so the CLI
writes where the shell reads. A terminal's `epicenter` uses the same
variables, or the release app's directories when they are unset
(`packages/cli/src/app-paths.ts`).

Files split by what they cost to lose (ADR-0539):

```txt
~/Epicenter/                                  read, edited, and versioned as files
  so.epicenter/                               Epicenter’s records, no longer written
  <name>/                                     a folder `epicenter clone` made
~/Library/Application Support/so.epicenter/   written only by Epicenter
  auth/<grant>.lock                           the lock a sign-in refreshes under (the CLI writes it)
  local-transcription.json                    the active local model and when to unload it
```

Defaults are derived, never saved: an ordinary launch creates its missing
default and reuses an existing one with its files, without an ownership
claim. No configuration selects or remembers them. Release and development
data remain separate.

The folders Epicenter syncs may sit anywhere on disk. Their list is the
global Git configuration's multi-valued `epicenter.folder`, which `epicenter
init`, `clone`, and `forget` change; neither application-data directory
holds a list of folders. The shell sets no Git configuration of its own, so
release, development, and a terminal's `epicenter` share that one list.

Overrides select an explicit location, so pointing both builds at the same
location deliberately shares those files. Development signs in separately
from production.

Rust resolves both directories once at startup and stores them for the
desktop lifetime, and every `epicenter` command the shell runs receives
both. Local model files are not here:
they are in the shared Hugging Face cache (`~/.cache/huggingface/hub`, or
`$HF_HOME/hub`), which Epicenter downloads into and never deletes from (ADR-0579).
Settings shows a model's folder there; deleting that folder removes the model.
Local transcription settings, `local-transcription.json`, are in the data
directory. Standalone Local Books defaults to production data; use
`EPICENTER_DATA_DIR` when directing its CLI to development storage.

### Start the app

Start Epicenter from the repository root:

```bash
bun dev:epicenter
```

This starts the local API on `http://localhost:8787` and the desktop app.
Before the app starts, Tauri runs `bun run build:desktop`, which builds
Settings and the Folders window into `dist/` and compiles the
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

Epicenter opens the [Folders window](#the-folders-window) (ADR-0537): launching
Epicenter, reopening it from the Dock, and `epicenter://` without a path all show
it. It lists the folders the `epicenter` CLI syncs and runs the CLI's
commands on them, and opens Settings from its Settings button with
`open_home`.

Settings is the window labelled `home`. It signs the app in and out and alone
administers the local transcription model (ADR-0180). The tray (Show Folders,
Show Settings) and deep links are shortcuts into the same windows; no link
opens an app. An `epicenter://init` link
([Requests to sync a folder](#requests-to-sync-a-folder)) only asks:

```bash
open 'epicenter://'
open 'epicenter://app/folders'
open 'epicenter://app/home'
open 'epicenter://init?path=%2FUsers%2Fme%2FNotes'
```

## The Folders window

The Folders window (`folders`, served at `/folders/`) is a front end over the
`epicenter` CLI ([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)):
it lists the folders the CLI syncs, and each of its actions is one CLI call a
person or an agent could type. Its page source is `src/folders`, built by
`build:folders` into `dist/folders`; its native side is
`src-tauri/src/synced_folders.rs`. It is the window Epicenter opens to, and
`epicenter://app/folders` opens it. The shell binds no folder to it, and its
capability, `folders.json`, grants no folder plugin command.

### The folder list

`synced_folders` runs `epicenter status --json`, which reads every folder in
the global Git configuration's `epicenter.folder`, and joins each line with
that folder's last round of `epicenter sync --json`. A row shows the folder's
name, where it syncs to (the `origin`'s `<owner>/<name>`, or "This computer
only" when it has none), and its last round in the CLI's own words: synced, with any changes
not yet synced; will try again; or stopped, with the CLI's message. A
registered folder the CLI cannot read shows why: missing from disk, not a Git
repository, or a repository `epicenter init` has not adopted. The shell keeps
rounds and requests in memory for this run and saves nothing.

The window lists again when the shell emits
`epicenter://synced-folders-changed` (a round ended, the service changed, or a
request arrived) and when it gains focus. A page names a folder by the path
the last listing held; every command that takes a folder refuses any other
path, so a page acts only on folders the CLI registered.

### Background sync

At startup the shell runs `epicenter sync --watch --json --desktop` and keeps
it running for as long as the app runs. Each `{"sync": ...}` line it prints
becomes that folder's last round. Adding, cloning, or forgetting a folder
restarts it, so `--watch` watches the new set. When it exits, the shell starts
it again after 5 seconds; after three exits in a row within 20 seconds of
starting, it stops, and the window shows **Syncing is paused** with the CLI's
last line of stderr and **Start syncing again** (`restart_sync_service`). No
window owns the service, so reloading or closing a page does not end it. At
application exit the shell sends `SIGTERM` to its process group on macOS and
Linux. An app that crashes or is killed sends nothing, so the shell also
holds the run's stdin open without writing to it; the system closes it
however the app ends, and `sync --watch --desktop` stops when it does.

### Folder actions

Every action runs one CLI command with `--json --desktop`,
then the window lists again:

| Action | Command | CLI call |
| --- | --- | --- |
| **Add folder** | `add_synced_folder` | The native folder picker, shown and answered in Rust, then `epicenter init <dir>` |
| **Clone** | `clone_synced_folder(source)` | `epicenter clone <owner>/<name>` or `epicenter clone <url>`, into the Epicenter folder |
| **Sync now** | `sync_folder_now(path)` | `epicenter sync <dir>`, kept as the folder's last round |
| **Stop syncing…** | `forget_synced_folder(path)` | `epicenter forget <dir>`, after a confirmation; files and history stay |
| **Sharing…** | `folder_sharing(path)` | `epicenter share <dir>`, listing who the repository is shared with |
| | `share_folder(path, person, level)` | `epicenter share <dir> <handle> --read` or `--write` |
| | `unshare_folder(path, person)` | `epicenter unshare <dir> <handle>` |

The shell passes a clone source or handle as one argument and refuses an
empty one, one with a control character, or one that starts with `-`.
Before `epicenter init`, a folder that already exists must be a real
directory holding none of Epicenter's own files, so neither the records nor
the library root becomes a repository.
`init` and `clone` report warnings, such as a missing command link, beside the
list. **Sharing…** is offered for a folder with a remote.

### Requests to sync a folder

Another app or a web page can ask Epicenter to sync a folder with
`epicenter://init?path=<absolute path>[&contract=<URL or absolute path>]`.
Both values are percent-encoded, in that order, with nothing else in the link;
the path must be spelled plainly, with no `.`, `..`, or doubled or trailing
separator, and the contract must be an `https:` or `http:` URL or an absolute
path (`parse_init_link`). Any other link is ignored.

Receiving the link only queues the request, once per path, and shows the
Folders window. The window shows the path and, when given, the contract.
**Set up** (`accept_folder_setup`) runs `epicenter init <dir>`; a failure keeps
the request so the person can read why and dismiss it. **Dismiss**
(`dismiss_folder_setup`) drops it without reading the folder. The contract is
shown but not passed, because `epicenter init` takes no contract yet.

### Capabilities

Each kind of window has one capability file, and every file is `"local": true`
because its page is served on the scheme: `folders.json`, which alone grants
the Folders window's CLI commands (`src-tauri/src/command_names.rs` lists every
app command); and `home.json`, which alone grants sign-in and model
administration. Neither grants the folder plugin: no window is bound to a
folder, and the shell does not install the plugin. A development build
selects the same two. This is wiring, not a sandbox (ADR-0179, ADR-0334).

Native dictation, which no page reaches, compiles only with the `dictation`
Cargo feature, off by default: paste at the cursor and the keyboard supervisor
that watches its Accessibility grant, pausing other apps' media,
`prewarm_model`, the macOS overlay panel (`src-tauri/src/overlay.rs`), and the
clipboard-manager plugin paste uses. The global-shortcut plugin is ADR-0555's
plugin awaiting a grant; nothing uses it, so it is parked with the feature. A
default build neither registers nor starts any of it and its generated
bindings name none of it, because the page API only grows after the first
release; it joins that API when a native API decision grants it (ADR-0555).
Autostart is not registered; enabling it once on first run (ADR-0328) is
unbuilt. Of the official plugins ADR-0555 lists, a default build registers the
opener and grants no page its URLs.

## Quitting Epicenter

Application Quit always shows a native confirmation. Its message still warns
that unsaved changes may be lost. Cancel keeps every window; Quit Anyway
exits. Repeated requests share the current alert.

Quit queries no page and waits for no status reply or timeout. Its standalone
native alert has no window parent, so closing a window leaves the Quit question
in place. Quit owns only ready, prompting, and approved
state; it needs no attempt ID or window-destruction hook. On macOS, the
unparented dialog uses the system's standalone alert presentation rather than
an attached window sheet.

The app menu's Quit, Cmd-Q, and tray Quit use this path. macOS Dock Quit,
logout, and abrupt process termination are outside it. Standalone Todos' Cmd-Q
still uses its one window's conditional close. Atomic file replacement keeps
its existing guarantees.

- **An account change restarts nothing.** The account is the CLI's desktop
  grant (ADR-0556); a page that uses it reads it again when its window
  regains focus.
- **Closing a window hides it.** The built-in windows are hidden, not
  destroyed, so their pages stay open until Epicenter quits.

## Build and verify

Signed distribution builds, the native update action, the draft release and
publication workflows, and an isolated packaged Epicenter-to-Epicenter update
rehearsal are documented in [Releasing](RELEASING.md). Epicenter ships no app
pages; standalone products have no release workflow here.

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

The root `bun typecheck` runs each workspace's checks. Apps are checked in
their own folders.

## Ownership rules

- `src-tauri` owns native commands, permissions, windows, deep links, the `epicenter-app` scheme for Epicenter's own pages, and packaging.
- `src` owns the Settings page and the Folders window's page. The CLI's commands live in `packages/cli`.
- `dist` is generated. Never edit it or commit product source beneath it.
- An app is a separate program: it owns its UI, builds, and releases from its own app folder (ADR-0701). Epicenter serves no app page.

The shared origin is recorded in [ADR-0118](../../docs/adr/0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) and [ADR-0561](../../docs/adr/0561-rust-serves-every-app-from-one-epicenter-app-origin.md). App hosting, removed by [ADR-0701](../../docs/adr/0701-apps-run-as-separate-programs.md), is archived at the tag `archive/app-hosting`; that record says how to restore it.

## AI connections

The shell keeps no AI connections and serves no `/_epicenter/ai` routes, and
Settings no longer lists or edits them. The `epicenter` CLI keeps
[ADR-0557](../../docs/adr/0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md)'s
keychain half: `epicenter auth key` saves an endpoint and key under a
connection id, and `epicenter send` sends a request with it.
