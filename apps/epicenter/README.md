# Epicenter desktop host

Epicenter is the repository's native application host. It owns one Tauri runtime, one native command API, and the trusted app catalog. Product SPAs keep their source in their own `apps/*` folders; Epicenter builds and serves their desktop variants without copying that source into this folder.

Honeycrisp ships its own desktop shell and is built from `apps/honeycrisp`.

```text
trusted SPA source                 Epicenter build output

apps/whispering/src  -----------> dist/whispering
apps/capture/src     -----------> dist/capture
apps/local-mail/ui   -----------> dist/mail
apps/todos/src       -----------> dist/todos
apps/epicenter/src/ui -----------> dist/home
                                          |
                                          v
                              Bun loopback sidecar
                                          |
                                          v
                              apps/epicenter/src-tauri
```

The host serves Home and four compiled applications: Whispering, Capture,
Local Mail, and Todos. Application routes live below `/apps/<id>/`. The
`epicenter-host` build condition selects each product's host integrations.
Honeycrisp has a separate desktop shell.

Capture and Todos reach native file folders through the shared Folder plugin.
Installed applications also reach the native folder registered for their ID.
Local Mail uses its account-bound store and SQLite capability. The shared-host
Whispering bundle currently has no supported folder bridge and refuses before
acquiring a folder; its inclusion in the catalog does not establish usable
hosted editing. Standalone Whispering owns its own folder and lifecycle.

The host brokers credentials and owns native resources. Product pages own
unsaved input. The native Folder owner owns file publication, watching, and Git;
the Bun sidecar serves product bundles without owning their row input.

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

Local Mail's Google client arrives at build time, because a page cannot read a
machine's environment. The launcher supplies it and changes nothing else:

```bash
bun dev:epicenter:mail
```

It is `bun dev:epicenter` wrapped in `infisical run` against the development
environment, reading `VITE_GMAIL_CLIENT_ID` and `VITE_GMAIL_CLIENT_SECRET` from
Infisical `/apps/local-mail`. They are stored under the names the build reads,
so no secret is named twice and the launcher stays one command. Without it the
build is honest about having no client and says so where a person would click
Connect.

A release needs the same values or it ships that honest refusal to everyone, so
`desktop:build:remote` is the packaging command rather than bare `desktop:build`
(`:remote` means production Infisical, per the suffix convention in the root
`AGENTS.md`). The client identifies Local Mail to Google and is compiled into
the bundle by design; the per-account refresh token is the secret, and it never
leaves the machine's keychain (ADR-0310).

Epicenter opens Home, which is an application beside the others rather than a
shell above them (ADR-0209). Its Apps pane lists what this build can launch, the
compiled applications plus the selected catalog generation's members, and
launching one opens its own window; the OS is the switcher from there, and
closing Home leaves everything it launched running. Its Data pane is Epicenter's
own job: every workspace id as real read-only tables, where picking one makes
`SELECT * FROM notes` mean something and "Everything raw" shows the storage as it
is. Whispering hands transcription setup back to Home's Settings pane
when the host has no usable local model, and Settings offers the ordinary launch
action once there is one. The tray and deep links remain shortcuts into the same
windows:

```bash
open 'epicenter://app/whispering'
open 'epicenter://app/todos'
open 'epicenter://app/home'
```

## The Todos folder

Todos keeps each todo as a Markdown file in an ordinary directory:
`so.epicenter.todos` under the authored folder root native startup resolved
(`~/Epicenter` in production, `~/Epicenter Dev` in development, or
`EPICENTER_FOLDER_DIR`). Other programs edit the same files.

The Rust shell installs the shared `tauri-plugin-epicenter-folder` and registers
`so.epicenter.todos` for the `todos` window. Registration selects the directory;
first attach opens it. The folder owner survives page reloads and sibling
client departures until native shutdown drains it.

The page uses the shared TypeScript Folder adapter over generated Tauri invoke
commands. Todos has its own capability grant for the trusted production or
development origin. The Bun host serves its compiled UI; Todos file operations
have no HTTP route. Markdown interpretation and the restricted terminal remain
shared TypeScript code, while Rust owns file publication, Git, watching, and the
cross-process lock.

Closing the Todos window ends its page once the page has closed its todos,
and never asks. Quitting or restarting Epicenter closes it the same way (see
[Leaving Epicenter](#leaving-epicenter)). Reloading the page loses
unsaved typing. Native shutdown drains accepted saves
and commits; forced termination can leave saved files uncommitted. Two native
processes cannot open the same directory. See Todos' [README](../todos/README.md)
for version checks, terminal interleaving, and external-edit limits.

## The Capture folder

Capture keeps one Markdown file per capture under
`<folderDir>/so.epicenter.capture/captures`. Frontmatter holds `capturedAt`;
the body holds the original text and an ordered list under `## Thoughts`.
The page edits that source, and its full-source editor exposes the same bytes.
It opens without an Epicenter account.

The Rust shell registers `so.epicenter.capture` for the `capture` window through
the shared Folder plugin. The page opens that scope through Tauri commands;
there is no Capture HTTP file bridge. First attach opens the directory, and
native shutdown drains admitted work. Browser Capture keeps a separate folder
in its origin's private file system (OPFS).

Closing the native window ends its page once the page has closed its
captures, and never asks. Quitting or restarting Epicenter closes it the same
way (see [Leaving Epicenter](#leaving-epicenter)).
A stopped sidecar leaves the page open for recovering its text. Forced
termination does not wait.

## Leaving Epicenter

Quitting never asks, and nothing in the host waits on a page or sets a timer
(`src-tauri/src/leaving.rs`, ADR-0529). The one thing worth protecting is a
save in flight: Capture and Todos keep drafts in their pages, and a draft's
latest snapshot can still be waiting behind a running write, where the Folder
plugin's exit drain cannot see it. So their pages end themselves:

1. Each Capture and Todos page registers Tauri's `onCloseRequested` for its
   window before anything can be edited (`#platform/window`).
2. A close request runs that handler, which awaits the owner's `close()`
   with no timeout (`createClosing` from `@epicenter/svelte/closing`). After
   about 1,200 ms the page shows "Still saving…" with **Close anyway**.
3. When the handler returns, Tauri destroys the window. The `page-close-*`
   capabilities grant `core:window:allow-destroy` to `capture` and `todos`
   alone; no installed app's window holds it.

Quit, from the app menu (Cmd-Q) or the tray, marks Epicenter as quitting and
closes every built-in window; installed app windows are destroyed. Windows
that hide on close (Home, Whispering, installed apps) close while quitting.
When the last window is gone, the run loop's `ExitRequested { code: None }`
exits; without a quit or restart under way it is prevented, so closing the
last window leaves Epicenter in the tray. The Folder plugin drains the writes
it accepted on `Exit`.

A draft whose save failed or conflicted, and text not added yet, is lost on
close. Its page's save bar already said so. Nothing is fenced and nobody is
prompted.

- **Which quits close windows.** The tray's Quit and the app menu's Quit. The
  app menu's Quit is an item of Epicenter's own, because the predefined one
  calls AppKit's `terminate:`, which closes no window. An `app.exit` with a
  code, such as the startup failure dialog's Quit, exits at once.
- **Which quits do not.** The Dock's Quit, logout, restart, shutdown, and a
  `quit` Apple event call `terminate:` directly. Tao 0.37 answers only
  `applicationWillTerminate:`, so they reach Epicenter as `RunEvent::Exit`
  with no window closed first. They drain the writes the Folder plugin
  already accepted; a snapshot still waiting in a page is lost. Epicenter
  does not cancel a logout or shutdown. Force Quit, a signal, or a crash
  also skip the pages.
- **A frozen page.** A handler that never returns keeps its window, and so a
  quit, open until Epicenter is force quit.
- **Restart.** An account change asks over the private Bun pipe
  (`prepare-relaunch`, protocol 8). Rust grants it at once to that Bun
  generation; `relaunch` then closes every window the same way and, once the
  last is gone, calls `request_restart`, whose Exit lets the Folder plugin
  drain admitted writes. `relaunch-abort`, a withdrawn preparation, or the Bun
  generation ending drops the grant. A quit outranks a restart.
- **Bun stopping** leaves the Capture and Todos windows and their native
  folders running, sends them `host-stopped`, and shows them. Their HTTP
  session does not come back.

### The page wire

[`src/host-stopped.ts`](src/host-stopped.ts), exported as
`@epicenter/epicenter/host-stopped`, is the page's side of the one event the
host sends. Only a page's host build imports it.

```text
Rust -> page   emit_to(label, "host-stopped", ())     the Bun host stopped
```

## Install a local application release

The local installer accepts one already-built release. It does not install
dependencies, run build scripts, or read application source (ADR-0179). How the
folder was produced, and by whom, is outside the contract:

```text
release/
|-- manifest.json
|-- index.html
`-- assets/
```

Install it from the repository root:

```bash
# Stop Epicenter first, then restart it after installation.
bun run --cwd apps/epicenter app:install -- /path/to/release --data-dir /tmp/epicenter-data
```

Epicenter validates the manifest and static files, copies them into
`<data-root>/apps/<app-id>/bundle`, and preserves every existing app-owned file
outside `bundle/`. Restart Epicenter after installation so startup discovers the
new application and composes it with the compiled applications.

An installed app opens `@epicenter/folder` with its manifest ID. Native launch
registers that scope for the app's exact window label, at one dataset named by
the app ID under the owner the native process captured from Bun's first ready
frame (ADR-0461):

```text
signed out   <folderDir>/local/<app-id>                    created on launch
signed in    <folderDir>/accounts/<account-key>/<app-id>   downloaded first
```

The shell supplies the path; the page never chooses a native directory. The
folder uses the repository's author and `origin` when configured, with local
history otherwise. A Bun recovery that boots with another account is refused;
only a full restart opens another owner's folders. Signing out never redirects
a missing account dataset to Local.

A signed-in installed app opens its account dataset only once that folder is a
Git repository on this device: a real `.git` with `HEAD`, `objects`, and `refs`,
which a download or a clone leaves, including an unborn `main`. Home's Apps pane
reads this from the folder each time and shows "Available locally"; nothing
records that a download happened. Where nothing is there it offers Download,
and launching alone refuses with a request to download. A directory at that
path that is not a repository, empty, holding files, or holding an empty
`.git`, is neither opened nor downloaded over: Home shows how to repair it by
hand (move it aside, download, copy files back in), and nothing in it changes.
The Folder owner checks the same rule again under the folder's lock, so a
`.git` that disappears after Home looked never becomes new history. The
download:

1. confirms the active generation lists the app, and asks Bun for the account's
   GitHub pairing of the folder named by the app ID;
2. reserves `<folderDir>/accounts/<account-key>/<app-id>` with the folder's
   sibling lock, refusing anything already there;
3. fetches `main` through a relay into a dot-prefixed sibling, writes its files
   as their exact bytes, and refuses links, executables, attribute
   conversions, and case collisions. A repository with no ref at all gives an
   unborn `main`; one with any other branch or tag but no `main` is refused
   with its refs named and its staging kept. This is narrower than the browser
   folder's download, which can start `main` beside other refs;
4. records the canonical `origin` and `.git/epicenter/hosted.json`: the account,
   folder ID, GitHub repository ID, pairing revision, URL, and branch;
5. retires the relay in the Bun generation that started it, which must confirm
   the transfer finished: a relay already gone (the Account was disposed or Bun
   restarted), a refusal it saw, or a host that cannot answer keeps the
   staging directory and publishes nothing;
6. unless cancelled by then, publishes with a rename that refuses anything at
   the destination, even an empty directory, and Home launches the app.

A failure after history arrived keeps the staging directory and names it; a
cancellation or an earlier failure leaves nothing. A running download belongs
to the Bun generation that started it and is cancelled when that generation is
deactivated or replaced, as on quitting. A cancel that lands with the rename
leaves the complete folder in place and is reported, not opened: Home then
shows it as available locally. Download never returns success after a cancel. Windows refuses before
reserving anything until such a publication is proven there.

`hosted.json` is the one record of the repository a person selected. It holds
no credential, is never replaced, and is read under the folder's lock when a
transfer starts. Each transfer is then admitted only if the folder's `origin`
is that canonical URL and branch, and the pairing the account's server holds
now, read through the boot Account, equals the record in every field:
account, folder, repository ID, revision, URL, and branch. A replacement
repository at the same URL, a replaced pairing, or a record edited by hand
starts no relay. Discovery never rewrites the record. A missing, malformed,
linked, or foreign record refuses hosted transfers and nothing else: editing
never needs the network, the session, or the pairing. A changed `origin` is
not repeated in the refusal, since a configured URL can carry a credential.

Git never holds an Epicenter or GitHub credential. For each fetch or push the
folder's owner asks the current Bun generation, on its own loopback listener
with the launch token, for a relay (`src/account-git-relay.ts`): a capability
path that forwards one service of one pairing revision through the boot
Account. Git receives only the relay URL, under fixed controls: HTTP only, no
hooks, fsmonitor, maintenance, proxy, or trace, and its destination pinned
against URL rewrites. The relay URL is a capability while it lives: Git's
output is redacted before any error, snapshot, or log reads it, naming the
canonical repository instead. Redirects, session refusals, and connector refusals reach Git as a
plain 502, so no credential helper or prompt runs. A cancel retires the relay
before Git is stopped; completion and failure retire it too, and disposing the
Account retires every relay at once. Only the original generation's own
confirmation counts as a finished transfer: when retiring finds the relay
already gone, sees a recorded refusal, or cannot reach that generation, a push
Git completed is reported as unconfirmed (it may have landed; nothing is undone
or retried) and a fetch is not reported as fetched. The relay's upstream fetch sets
`keepalive: false`, which the Account passes to the underlying fetch even for
a streamed body.

Bun discovers installed IDs once and names them in its versioned ready frame.
Rust admits launches against that list and its matching launch token before
registering a folder. Unknown IDs open nothing. Registrations survive Bun
restarts for the native process's lifetime. Closing an installed app hides its
window and keeps its drafts; host restart destroys its page. Quitting and an
account-change restart destroy installed app windows without running a close
handler, so they drain only the writes their folder already accepted.

## Build and verify

```bash
# Build Home, every compiled application, and the Bun sidecar
bun run --cwd apps/epicenter build:desktop

# Package the complete native application
bun run --cwd apps/epicenter desktop:build

# Package it for release, with Local Mail's Google client compiled in
bun run --cwd apps/epicenter desktop:build:remote

# Typecheck the host and Home
bun run --cwd apps/epicenter typecheck

# Typecheck the host, Home, Whispering, Capture, and Todos
bun run --cwd apps/epicenter typecheck:desktop

# Host, routing, sidecar, and window tests
bun test apps/epicenter/scripts apps/epicenter/src

# Native command and fixture tests
cargo test --manifest-path apps/epicenter/src-tauri/Cargo.toml

# Twenty real restarts through a granted relaunch, in an isolated profile
bun apps/epicenter/scripts/native-runtime-evidence.ts
```

The runtime harness proves what the mock-runtime tests cannot: each restart
reaches Exit and the Folder plugin's shutdown, every relaunch closes the
windows and restarts once the last is gone, every Bun sidecar stops, and the
last process's exit with a code is not held. It does not open Capture or
Todos, so it does not prove a page's close handler, that an in-flight Folder
write drains, or anything about Cmd-Q, the Dock, the tray, or logout.

The root `bun typecheck` runs each workspace's checks, including the apps checked
by `typecheck:desktop`. Use `typecheck:desktop` for standalone verification of
the host with Whispering, Capture, and Todos.

## Ownership rules

- `src-tauri` owns native commands, permissions, windows, deep links, and packaging.
- `src` owns the Bun host, trusted route catalog, static-asset containment, and Home session.
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

Run `bun packages/app/scripts/shared-ai-catalog.native.mjs` from the repository
root for native acceptance with two installed test applications. The runner
uses a disposable profile and keychain service, restarts both native and Bun
processes, and checks SSE recovery and request cancellation. See the
[procedure and recorded evidence](../../packages/app/scripts/shared-ai-catalog-native/README.md)
for build prerequisites and the scope of the fixture.
Add `--whispering` with an existing speech fixture and cached model to verify
the product's desktop picker, imported-audio transcription, and saved result
after document reload.
