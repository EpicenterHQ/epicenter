# Epicenter desktop app

Epicenter is where a person sees and manages every folder in the Epicenter
folder, `~/Epicenter` (ADR-0816), and it keeps every folder in sync while it
runs (ADR-0819). Its Folders window does that by composing the same package
functions the `epicenter` CLI does, `@epicenter/folder/platform`
(ADR-0817), and never runs the CLI. That window is not built yet: it shows
the commands to use meanwhile (see [The Folders window](#the-folders-window)).
Apps are separate programs that read and write folders
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
Cargo package, `epicenter`. The app links to it at `~/.epicenter/bin/epicenter`.

The one binary has these uses:

- The shell's narrow CLI runner (`src-tauri/src/cli.rs`) runs its bundled copy for a page's
  fixed commands. A page has no generic exec: each command maps to one
  `epicenter` invocation, writes stdin on its own task, and reads each stdout
  line. Development installs the sidecar in `~/.epicenter-dev/bin/epicenter`.
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

After launch, the app links its bundled CLI at `~/.epicenter/bin/epicenter`,
or `~/.epicenter-dev/bin/epicenter` for a development build. The link follows
the app when it moves or updates. On Windows the app writes an `epicenter.cmd`
shim. Git commands carry credentials and the merge driver for that invocation.

## Configure the server

A desktop build connects to one server. The default is Epicenter Cloud. Set
`EPICENTER_SERVER_ORIGIN` when compiling the native host to build for a
self-hosted HTTP(S) origin. Changing it requires rebuilding the app.
Rust uses that origin to choose which account pages open in the system browser,
and passes it to every CLI command it runs.
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
Production's Epicenter folder is `~/Epicenter`; development's is
`~/Epicenter Dev`. Native locations live in `DesktopPaths`
(`src-tauri/src/desktop_paths.rs`). The shell stores no folder list there.
Each standalone app derives its folder beneath it from the host of its site:
`whispering.epicenter.so` uses `whispering`, and `zhongwen.bradenwong.com`
uses `bradenwong.com/zhongwen`.
The shell resolves its data directory and environment once, then sets
`EPICENTER_DATA_DIR` and `EPICENTER_ENVIRONMENT` on every `epicenter` command
it runs, from which the CLI derives the Epicenter folder. A terminal command
defaults to the environment embedded when the sidecar was built.
`EPICENTER_ENVIRONMENT` overrides it
(`packages/cli/src/app-paths.ts`).

Files split by what they cost to lose (ADR-0539):

```txt
~/Epicenter/                                  read, edited, and versioned as files
  <name>/                                     a folder `epicenter clone` made
~/Library/Application Support/so.epicenter/   written only by Epicenter
  auth/<grant>.lock                           the lock a sign-in refreshes under (the CLI writes it)
  local-transcription.json                    the active local model and when to unload it
```

The Epicenter folder and application data are derived, never saved: no
configuration selects or remembers them. Release and development data remain
separate.

Every directory directly inside `~/Epicenter`, or `~/Epicenter Dev` in
development, is a folder (ADR-0813); one elsewhere joins by a symbolic link
there. Nothing registers a folder, and neither application-data directory
holds a folder list.

Overrides select an explicit location, so pointing both builds at the same
location deliberately shares those files. Development signs in separately
from production.

Rust resolves both directories once at startup and stores them for the
desktop lifetime, and every `epicenter` command the shell runs receives
both. Local model files are not here:
they are in the shared Hugging Face cache (`~/.cache/huggingface/hub`, or
`$HF_HOME/hub`), which Epicenter downloads into and never deletes from (ADR-0579).
Settings shows a model's folder there; deleting that folder removes the model.
Local transcription settings, `local-transcription.json`, belong to the
transcription plugin (`packages/transcription`), which
keeps them in the bundle identifier's local data directory: the data directory
above, except that `EPICENTER_DATA_DIR` does not move them. Standalone Local
Books defaults to production data; use `EPICENTER_DATA_DIR` when directing its
CLI to development storage.

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
it. It opens Settings from its Settings button with `open_home`.

Settings is the window labelled `home`. It signs the app in and out and alone
administers the local transcription model (ADR-0180). The tray (Show Folders,
Show Settings) and deep links are shortcuts into the same windows; no link
opens an app. An `epicenter://init?path=…` link, which a standalone app
opens to ask that its folder sync, shows the Folders window, where a
folder's first sync is the person's (ADR-0813); nothing is queued from it:

```bash
open 'epicenter://'
open 'epicenter://app/folders'
open 'epicenter://app/home'
open 'epicenter://init?path=%2FUsers%2Fme%2FNotes'
```

## The Folders window

The Folders window (`folders`, served at `/folders/`) is where a person will
see every folder in the Epicenter folder with its title, state, and members,
sync, share, and accept folders, and where Epicenter keeps every folder in
sync while it runs: its page composes `@epicenter/folder/platform`
(`listHome`, `syncEvery`, `shareFolder`, `acceptIntoHome`), the functions the
CLI composes, and runs no CLI command (ADR-0816, ADR-0817, ADR-0819). Its
page source is `src/folders`, built by `build:folders` into `dist/folders`.

That page is not built yet. It needs two things the shell does not give a
page today: the Epicenter folder as a root the folder plugin opens (each
directory in it a store, with its device and inode), and a sign-in of the
app's own (`so.epicenter`, with `folders:all`) whose requests Rust sends, as
`epicenter-account` does for standalone apps. Until then the window says the
folder model is coming and lists the `epicenter` commands to use, and its
capability grants it only `open_home`. The CLI-driven window it replaced
(the `epicenter sync --watch` service, and `status`, `init`, `connect`,
`clone`, `forget`, and the namespace sharing over the old Git model) is
deleted.

### Capabilities

Each kind of window has one capability file, and every file is `"local": true`
because its page is served on the scheme: `folders.json`, which grants the
Folders window `open_home` alone (`src-tauri/src/command_names.rs` lists every
app command); and `home.json`, which alone grants sign-in and model
administration: the transcription plugin's `epicenter-transcription:` commands
that its shared pane (`@epicenter/transcription`) calls. Neither grants
the folder plugin: the shell does not install it, so no window is granted
the transcription plugin's file
transcription either. A development build selects the same two. This is wiring, not a sandbox (ADR-0179, ADR-0334).

Native dictation, which no page reaches, compiles only with the `dictation`
Cargo feature, off by default: paste at the cursor and the keyboard supervisor
that watches its Accessibility grant, pausing other apps' media,
`prewarm_model` (over the transcription plugin's model cache), the macOS
overlay panel (`src-tauri/src/overlay.rs`), and the clipboard-manager plugin
paste uses. The global-shortcut plugin is ADR-0555's
plugin awaiting a grant; nothing uses it, so it is parked with the feature. A
default build neither registers nor starts any of it and its generated
bindings name none of it, because the page API only grows after the first
release; it joins that API when a native API decision grants it (ADR-0555).
Autostart is not registered yet; ADR-0819 has Epicenter start at login and
keep every folder in sync while it runs, which the Folders window's page
will do. Of the official plugins ADR-0555 lists, a default build registers the
opener and grants no page its URLs.

## Quitting Epicenter

Quit quits, with no question: no Epicenter window holds unsaved input, and
apps are separate programs (ADR-0701). The app menu's Quit, Cmd-Q (routed
through `app.exit` by `src-tauri/src/macos_menu.rs`), and tray Quit all exit
through Tauri's exit lifecycle, then through the transcription
plugin's `run`, which on macOS ends the process without C++ static
finalizers, so quitting with Settings' model loaded cannot race ggml-metal's.
A downloaded update asks on its own whether to install and restart (see
[Releasing](RELEASING.md)); it restarts by `request_restart`, which that same
path relaunches.

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
