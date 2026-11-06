# Epicenter desktop app

Epicenter is where a person sees and manages every folder in the Epicenter
folder, `~/Epicenter` (ADR-0816), and it keeps every folder in sync while it
runs, with or without a window (ADR-0819). Its Folders window does that by
composing the same package functions the `epicenter` CLI does,
`@epicenter/folder/platform` (ADR-0817); it neither runs nor carries the CLI
(ADR-0793). Apps are separate programs that read and write folders
([ADR-0701](../../docs/adr/0701-apps-run-as-separate-programs.md)); Epicenter
does not open, install, or serve them.

The app owns one Tauri runtime, one native command API, and the short list of
what it compiles in. Its pages are Settings and the Folders window:

```text
page source                         build output        served at

apps/epicenter/src/ui ------------> dist/home --------> epicenter-app://localhost/home/
apps/epicenter/src/folders -------> dist/folders -----> epicenter-app://localhost/folders/
```

Rust serves these pages from one origin, `epicenter-app://localhost`, through
a scheme the shell registers (`src-tauri/src/scheme.rs`, ADR-0561): Settings
(the `home` window) at `/home/` and the Folders window at `/folders/`. No
server listens on a port.

The scheme answers GET only. It serves a regular file inside the page's
directory, refusing a symbolic link and any path that leaves it, and answers
an extensionless path that names no file with that directory's `index.html`,
so client-side routes load. Every response carries one
Content-Security-Policy: a page reaches its own origin and Tauri's IPC
(`connect-src 'self' ipc: http://ipc.localhost`) and nothing else, and a
document's policy admits each of its inline scripts by hash. Each window
navigates only below the path it opened at; a new-window link opens in the
system browser only when it is the hosted account website.

## The sign-in

Epicenter signs in as its own OAuth client, `so.epicenter`, with
`folders:all`, which reaches every folder the person holds (ADR-0820), on the
API and Git audiences. The shell holds it through
[`epicenter-account`](../../packages/tauri-epicenter-account/README.md), as
the standalone apps do: the system browser signs in (RFC 8252 loopback with
PKCE), the refresh token stays in the app's `credentials.json`, which no page
reads, and the shell sends each request a page makes on the account
(`account_fetch`), so no token reaches a page. Who is signed in is
`account.json` in the app's data, which both windows read through
`@epicenter/local`. The Folders window's account sends every request with the
Git audience's token (`createTauriAuth({ audience: 'git' })`), as the folder
routes expect. Quitting waits for a refresh in flight to store the token it
rotated.

A terminal's `epicenter auth login` is the CLI's own sign-in, a separate
client and refresh-token family; signing one out leaves the other signed in.

## Configure the server

A desktop build connects to one server. The default is Epicenter Cloud. Set
`EPICENTER_SERVER_ORIGIN` when compiling the native host to build for a
self-hosted HTTP(S) origin. Changing it requires rebuilding the app. Rust
uses that origin to sign in and to choose which account pages open in the
system browser. Settings lets people sign in and out; it cannot change the
server.

Debug Cloud builds retain `EPICENTER_API_URL` for the local development API.
This override accepts a loopback origin and does not affect release builds.
A self-hosted build takes precedence over that development override.

## Run locally

### Where things are

The Epicenter folder is `~/Epicenter` in production and `~/Epicenter Dev` in
development (`tauri.dev.conf.json` states the environment). Every directory
directly inside it is a folder (ADR-0813); one elsewhere joins by a symbolic
link there. Nothing registers a folder.

The app's own data is the operating system's application data directory for
its identifier, `so.epicenter` or `so.epicenter.dev` (`~/Library/Application
Support/so.epicenter` on macOS): written only by Epicenter, never synced.

```txt
~/Epicenter/                                  read, edited, and versioned as files
  <name>/                                     a folder
~/Library/Application Support/so.epicenter/   written only by Epicenter
  credentials.json                            the sign-in's refresh token (no page reads it)
  account.json                                who is signed in
  start-at-login.defaulted                    starting at login was turned on once
  local-transcription.json                    the active local model and when to unload it
```

Rust resolves both once at startup (`src-tauri/src/desktop_paths.rs`) and
names them to the folder plugin: the app's data as its `AppData` root, and
the Epicenter folder, whose every directory opens as a root of its own
(`Root::Folder`). No folder may be the home folder, hold it, or overlap the
app's data. Release and development data remain separate. Local model files
are in the shared Hugging Face cache (`~/.cache/huggingface/hub`, or
`$HF_HOME/hub`), which Epicenter downloads into and never deletes from
(ADR-0579).

### Start the app

Start Epicenter from the repository root:

```bash
bun dev:epicenter
```

This starts the local API on `http://localhost:8787` and the desktop app.
Before the app starts, Tauri runs `bun run build:desktop`, which builds
Settings and the Folders window into `dist/`. A development build's scheme
serves the pages from that `dist/` directly, so after changing a page, run
`bun run --cwd apps/epicenter build` and reload its window (Cmd-R). There is
no dev server and no hot reload. It requires the API's
[local Postgres and Infisical setup](../api/README.md#development).

Epicenter opens the [Folders window](#the-folders-window) (ADR-0537):
launching Epicenter, reopening it from the Dock, and `epicenter://` without a
path all show it. It opens Settings from its Settings button with
`open_home`. The tray (Show Folders, Show Settings, Quit) and deep links are
shortcuts into the same windows; no link opens an app, and a link with a
query, such as the retired `epicenter://init?path=…`, opens nothing:

```bash
open 'epicenter://'
open 'epicenter://app/folders'
open 'epicenter://app/home'
```

### Starting at login

Epicenter starts when the person logs in, a setting in Settings, on by
default (`src-tauri/src/login.rs`). The login item is the operating system's
(`tauri-plugin-autostart`, a launch agent on macOS) and is the setting
itself. A release build turns it on at its first start and marks that it did,
so turning it off sticks; a development build never turns it on by itself.
Started at login, the app opens the Folders window unseen, and its page keeps
every folder in sync until the person shows it.

## The Folders window

The Folders window (`folders`, served at `/folders/`, source `src/folders`)
shows every folder in the Epicenter folder with its title, its mark (✓
synced, ◌ waiting, ⚠ conflict or deletions waiting, ✗ refused), its state
(on this computer only, synced, shared, or kept by Git), and who holds it;
the shares waiting for the person; and the folders they hold that this
computer does not. From it a person syncs now, answers which folder a
folder not synced here is (one they hold, or a new one), says whether
files deleted here are deleted on the server or brought back, adds
`epicenter.json`, brings a folder
held elsewhere here, accepts or declines a share, shares a folder by email
as a member or a reader, changes a member's role or removes them, cancels an
invitation, and attaches or detaches an app.

Every one of these is a function of `@epicenter/folder/platform` over
`epicenterRoot()` from `@epicenter/folder/tauri` and the app's sign-in
(`src/folders/home.svelte.ts`). While signed in, the page runs
`keepEverySynced`: one request for where every folder is, and a sync of each
folder that moved on either side, at start, after a burst of a folder's
changes, every few seconds, and on Sync now. The window hides when closed,
so its page, and the sync, run until Epicenter quits.

Which directory is which folder is proven by the platform (ADR-0822): a
record at `~/Epicenter/.epicenter/synced/<folder-id>.json` holds when the
directory's inode and birth time match it, or, after a move to a new
computer, its name and exact files in a folder held alone. A copied folder
stays on this computer as a local folder until the person syncs it, which
asks which folder it is. A folder an app made (its usual name and a
contract that fits the app) syncs without asking when nothing else fits.
Epicenter never syncs a folder Git keeps, nor an Epicenter folder inside a
file-sync service.

### Capabilities

Each kind of window has one capability file, and every file is `"local":
true` because its page is served on the scheme (`src-tauri/src/command_names.rs`
lists every app command):

- `folders.json` grants the Folders window `open_home`, the sign-in's
  requests and sign-in (`account_sign_in`, `account_fetch`,
  `account_fetch_cancel`), the folder plugin (`epicenter-folder:default`, and
  `epicenter-folder:epicenter` to list and make folders), and event listening.
- `home.json` grants Settings sign-in and sign-out, the login item
  (`start_at_login`, `set_start_at_login`), the folder plugin's default set
  (for `account.json`), and model administration: the transcription plugin's
  `epicenter-transcription:` commands its shared pane calls.

This is wiring, not a sandbox (ADR-0179, ADR-0334).

Native dictation, which no page reaches, compiles only with the `dictation`
Cargo feature, off by default: paste at the cursor and the keyboard supervisor
that watches its Accessibility grant, pausing other apps' media,
`prewarm_model` (over the transcription plugin's model cache), the macOS
overlay panel (`src-tauri/src/overlay.rs`), and the clipboard-manager plugin
paste uses. The global-shortcut plugin is ADR-0555's plugin awaiting a grant;
nothing uses it, so it is parked with the feature. A default build neither
registers nor starts any of it and its generated bindings name none of it.

## Quitting Epicenter

Quit quits, with no question: no Epicenter window holds unsaved input, and
apps are separate programs (ADR-0701). The app menu's Quit, Cmd-Q (routed
through `app.exit` by `src-tauri/src/macos_menu.rs`), and tray Quit all exit
through Tauri's exit lifecycle, where the sign-in finishes a refresh in
flight, then through the transcription plugin's `run`, which on macOS ends the
process without C++ static finalizers, so quitting with Settings' model loaded
cannot race ggml-metal's. A downloaded update asks on its own whether to
install and restart (see [Releasing](RELEASING.md)); it restarts by
`request_restart`, which that same path relaunches.

- **An account change restarts nothing.** Both windows read `account.json` as
  it changes, and the Folders window's sync starts again for the new account.
- **Closing a window hides it.** The built-in windows are hidden, not
  destroyed, so their pages stay open until Epicenter quits.

## Build and verify

Signed distribution builds, the native update action, the draft release and
publication workflows, and an isolated packaged Epicenter-to-Epicenter update
rehearsal are documented in [Releasing](RELEASING.md). Epicenter ships no app
pages; standalone products have no release workflow here.

```bash
# Build Settings and the Folders window
bun run --cwd apps/epicenter build:desktop

# Package the complete native application
bun run --cwd apps/epicenter desktop:build

# Typecheck Settings, the Folders window, and the build scripts
bun run --cwd apps/epicenter typecheck

# Page builds and window tests
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
- `src` owns the Settings page and the Folders window's page. What they do to folders lives in `@epicenter/folder/platform`.
- `dist` is generated. Never edit it or commit product source beneath it.
- An app is a separate program: it owns its UI, builds, and releases from its own app folder (ADR-0701). Epicenter serves no app page.

The shared origin is recorded in [ADR-0118](../../docs/adr/0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) and [ADR-0561](../../docs/adr/0561-rust-serves-every-app-from-one-epicenter-app-origin.md). App hosting, removed by [ADR-0701](../../docs/adr/0701-apps-run-as-separate-programs.md), is archived at the tag `archive/app-hosting`; that record says how to restore it.
