# Epicenter desktop host

Epicenter is the repository's native application host. It owns one Tauri runtime, one native command API, and the list of compiled applications it serves. Product SPAs keep their source in their own `apps/*` folders; Epicenter builds and serves their desktop variants without copying that source into this folder.

Honeycrisp ships its own desktop shell and is built from `apps/honeycrisp`.

```text
trusted SPA source                 Epicenter build output

apps/whispering/src  -----------> dist/whispering
apps/capture/src     -----------> dist/capture
apps/todos/src       -----------> dist/todos
apps/epicenter/src/ui -----------> dist/home
                                          |
                                          v
                              Bun loopback sidecar
                                          |
                                          v
                              apps/epicenter/src-tauri
```

The host serves Home and three compiled applications: Whispering, Capture, and
Todos. Application routes live below `/apps/<id>/`; the Mail and Books routes
serve placeholder pages (`src/placeholder-pages.ts`). The `epicenter-host` build
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
Home Settings lets people sign in and out; it cannot change the server.

Debug Cloud builds retain `EPICENTER_API_URL` for the local development API.
This override accepts a loopback origin and does not affect release builds.
A self-hosted build takes precedence over that development override.

## Run locally

### Application data

Production keeps internal files under `so.epicenter` in the platform's local
application-data directory: `~/Library/Application Support` on macOS,
`$XDG_DATA_HOME` (default `~/.local/share`) on Linux, and `%LOCALAPPDATA%` on
Windows. Windows storage stays out of roaming profiles because databases and
recordings belong to this device. `EPICENTER_DATA_DIR` overrides the complete
path and must be absolute.

Development uses `so.epicenter.dev` for data, settings, and keyring entries.
Production's authored folder root is `~/Epicenter`; development's is `~/Epicenter Dev`.
`EPICENTER_FOLDER_DIR` overrides the authored folder root and must be absolute.
Overrides select an explicit location, so pointing both builds at the same
location deliberately shares those files. Development starts signed out after
credential isolation; production credentials are unchanged.

Rust resolves both directories once before recorder cleanup, stores them for the
desktop lifetime, and sends them through the versioned startup message. Bun and
the recorder consume those paths. Bun never derives a desktop root from its
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
Home disconnected and applications unable to open. The host rejects older
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

Finish sign-in in your browser, then return to Epicenter. Home shows the pending
attempt and lets you cancel without signing out of your existing account.
Development returns through the running host's loopback callback because a raw
macOS development executable has no registered URL scheme. Packaged builds keep
`epicenter://auth/callback`. If you set `EPICENTER_DEV_PORT`, set it on this root
command so the API approves the same exact callback port the host binds.

Epicenter opens Home, which is an application beside the others rather than a
shell above them (ADR-0209). Its Apps pane lists the compiled applications this
build can launch, and launching one opens its own window; the OS is the switcher
from there, and closing Home leaves everything it launched running. Home has
three panes: Apps, Chat, and Settings. Whispering hands transcription setup back to Home's Settings pane
when the host has no usable local model, and Settings offers the ordinary launch
action once there is one. The tray and deep links remain shortcuts into the same
windows:

```bash
open 'epicenter://app/whispering'
open 'epicenter://app/todos'
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
`@epicenter/folder`'s own engine: files through Tauri's fs plugin, writes and
Git through the shell (`write_folder_file`, `run_git`), which change only data
paths the shared path rule accepts, never Git's own state, and run only the
Git operations the engine uses. History
is real Git, so Save version is a commit and Sync pushes to and fetches from the
repository's own `origin` with the person's own Git credentials. Todos has its
own capability grant for the trusted production or development origin; its file
operations have no HTTP route.

A window close hides the loaded page and preserves its drafts. Quitting or
restarting Epicenter asks the page first (see [Leaving Epicenter](#leaving-epicenter));
reloading the page loses unsaved typing. Native shutdown waits for the file
changes and Git runs the shell already admitted; forced termination can leave
saved files uncommitted. Two native
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
folder with `@epicenter/folder`'s own engine, reading through Tauri's fs plugin
and writing and running Git through the shell. There is no Capture HTTP file
bridge. Native shutdown waits for changes already admitted. Browser Capture keeps a separate folder
in its origin's private file system (OPFS).

Closing the native window hides it with its drafts intact. Quitting or
restarting Epicenter asks the page first (see [Leaving Epicenter](#leaving-epicenter)).
A stopped sidecar leaves the page open for recovering its text. Forced
termination does not wait.

## Leaving Epicenter

Capture and Todos keep unsaved text in their pages, and the Folder plugin's
exit drain sees only writes a page already submitted, not a draft still inside
its 400 ms batch. So before the process quits, or restarts for an account
change, the native host runs one departure round
(`src-tauri/src/departure.rs`) and asks both windows. The pages own their
drafts; the host owns the round and a generation for each page. Nothing else
takes part: Whispering's shared-host build has no folder root, and Home holds
no file-backed drafts.

- **Who is asked.** The `capture` and `todos` windows that exist when the round
  starts, hidden ones included. No window joins later: while a round runs, a
  participant window cannot be created.
- **Every quit asks.** The round starts from `ExitRequested`. The tray's Quit
  and `app.exit` raise it directly. AppKit's own quits (the app menu's Quit and
  Cmd-Q, the Dock's Quit, logout, restart, shutdown, a `quit` Apple event) call
  `terminate:`, which Tao's application delegate would let through without
  `ExitRequested`. A quit guard (`src-tauri/src/departure/terminate.rs`) adds
  `applicationShouldTerminate:` to Tao's delegate class at startup and fails
  startup if it cannot. With no Capture or Todos window it lets AppKit
  terminate as before. Otherwise it refuses and requests an ordinary exit,
  which runs the round, so a logout or shutdown that reaches Epicenter is
  cancelled, and the person retries it once the round has finished. Epicenter
  does not resume a cancelled logout. Force Quit, a signal, or a crash still
  skips the round. Letting AppKit terminate runs Tao's exit path, which takes
  a lock Tao already holds during Tauri callbacks, so `terminate:` must never
  be answered "now" from inside one: it would hang the main thread. AppKit's
  own quits arrive from the run loop, and nothing in Epicenter calls
  `terminate:`; code that wants to quit calls `app.exit`. While a modal
  session runs, the nesting identified so far, the guard always takes the
  ordinary exit instead. Other nested run loops are not ruled out.
- **One owner.** The round and the participant windows belong to the main
  thread. Bun frames, timers, dialog answers, and page answers are carried
  there, and each hide or show happens inside the step that decided it, so
  nothing from an ended round can show or hide a window in a newer one.
- **Nothing pops up unasked.** Starting a round shows no window. A page that
  answers `asking` is shown, even if the person had closed it, so it can ask
  them; so is every undecided page when the person asks again.
- **Agreeing never ends the page.** A page answers `ready` once its draft is
  flushed, or once the person deliberately discards it in the page. Nothing is
  closed, discarded, or reloaded. If any page answers `cancel` ("Keep working"),
  every page the round held resumes, and every window the round showed or hid
  goes back as the round found it, shown or hidden.
- **Silence is not permission.** A page that has not answered after three
  seconds is listed in a native dialog: "Keep open" (the default), "Discard
  and quit" or "Discard and restart", and "Cancel". Only the discard button
  lets the round go on; "Cancel", a dialog that fails, and any other answer
  keep Epicenter open. The discarded window
  is hidden, and confirmed hidden, before its vote counts, and nothing shows it
  again until the round ends without leaving. A hide that was applied but not
  confirmed ends the round with an error and shows the window again.
- **Asking again.** Quitting during a quit or a restart round asks the
  undecided pages again in the same round, with the same intent, so a page that
  hung after `asking` reaches the dialog ("Discard and restart" during a
  restart); a live page re-sends `asking` and shows its own prompt once. Quit
  and restart never merge: a second restart is refused as busy, and quitting
  while a restart is granted says so and leaves the grant to Bun.
- **Restart is granted, then finished.** An account change asks over the
  private Bun pipe (`prepare-relaunch`, protocol 8) and gets exactly one answer.
  Granting hides every participant window, each confirmed hidden, and refuses
  to show them; `relaunch` then calls `request_restart`, whose Exit lets the
  Folder plugin drain admitted writes. `relaunch-abort`, or the Bun generation
  ending, restores them. A page that reloads or closes while the round collects
  ends the round: a restart gets its error, a quit says so. While granted it
  only loses its vote, and every page stays fenced.
- **The Window menu.** AppKit lists open windows in the Window menu and raises
  the one chosen. Capture and Todos are left out of that list and get their
  own Window-menu items instead, which open or show them through the same
  checked path as Home's launcher, so the menu cannot show a discarded or
  granted window.
- **Bun stopping** leaves both windows and their native folders running, and
  sends them `host-stopped`. Their HTTP session does not come back; they are
  shown when no round is in progress.

### The page wire

[`src/departure-wire.ts`](src/departure-wire.ts), exported as
`@epicenter/epicenter/departure`, is the published shape, with a strict reader
the native harness uses. It imports nothing, so a browser bundle can take it.
[`src/departure-page.svelte.ts`](src/departure-page.svelte.ts), exported as
`@epicenter/epicenter/departure/page`, is the one page client that follows the
rules below; Capture and Todos each attach their owner to it as a participant
(`holdsUnsaved`, `fence`, `settle`, `resume`) and word the notice themselves.
[`src/departure-window.ts`](src/departure-window.ts), exported as
`@epicenter/epicenter/departure/window`, binds the client to the Tauri window;
only a page's host build imports it.

```text
Rust -> page   emit_to(label, "departure-changed", ())     no payload
               emit_to(label, "host-stopped", ())          no payload
page -> Rust   departure_status() -> Status
               departure_answer({ generation, round, answer: asking | ready | cancel }) -> Status
Status = { version, generation, phase: idle | collecting | granted | leaving,
           round?, intent?: quit | restart, vote?: none | asking | ready | discarded }
```

Rust identifies the caller by its window, never by a label the page sends. A
stale generation or round changes nothing and returns the current status.
`version` rises with every change. The `departure-*` capabilities grant both
commands to `capture` and `todos` alone, and neither window holds a
`core:window` grant, so a page cannot show itself.

A page must, in this order: await registration of
`getCurrentWebviewWindow().listen('departure-changed', ...)`; read status; and
only on `idle` become editable. It drops any status older than the newest it
applied, fences before its first await when a round arrives, answers `ready`
directly when it holds nothing unsaved (`asking` shows its window), thaws only on an
authoritative `idle` newer than its own answer, and stays fenced on `granted`,
`leaving`, or `discarded`. A lost or rejected answer never thaws it. A global
`listen` registers for every target and can hear the other window's nudge;
that is harmless, because a nudge only means "read again".

## Build and verify

```bash
# Build Home, every compiled application, and the Bun sidecar
bun run --cwd apps/epicenter build:desktop

# Package the complete native application
bun run --cwd apps/epicenter desktop:build

# Typecheck the host and Home
bun run --cwd apps/epicenter typecheck

# Typecheck the host, Home, Whispering, Capture, and Todos
bun run --cwd apps/epicenter typecheck:desktop

# Host, routing, sidecar, and window tests
bun test apps/epicenter/scripts apps/epicenter/src

# Native command and fixture tests
cargo test --manifest-path apps/epicenter/src-tauri/Cargo.toml

# The departure round alone, with no dependencies
rustc --edition 2021 --test apps/epicenter/src-tauri/src/departure/machine.rs -o apps/epicenter/src-tauri/target/departure-machine
apps/epicenter/src-tauri/target/departure-machine
```

The root `bun typecheck` runs each workspace's checks, including the apps checked
by `typecheck:desktop`. Use `typecheck:desktop` for standalone verification of
the host with Whispering, Capture, and Todos.

## Ownership rules

- `src-tauri` owns native commands, permissions, windows, deep links, and packaging.
- `src` owns the Bun host, built-in routes, static-asset containment, and Home session.
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
