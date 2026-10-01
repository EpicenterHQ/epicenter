# Epicenter desktop host

Epicenter is the repository's native application host. It owns one Tauri runtime, one native command API, and the trusted app catalog. Product SPAs keep their source in their own `apps/*` folders; Epicenter builds and serves their desktop variants without copying that source into this folder.

```text
trusted SPA source                 Epicenter build output

apps/whispering/src  -----------> dist/whispering
apps/honeycrisp/src  -----------> dist/honeycrisp
apps/epicenter/ui     -----------> dist/home
                                          |
                                          v
                              Bun loopback sidecar
                                          |
                                          v
                              apps/epicenter/src-tauri
```

A compiled application is a `dist/<id>` build this release declares, served
below `/apps/<id>/`. Whispering and Honeycrisp are the two. Each keeps its
independently deployable browser build, and the variant Epicenter serves is
selected at build time by the `epicenter-host` resolve condition.

That condition does not decide where the data lives. Every build opens its own
store, with no platform seam, and reaches one authority per signed-in account
(ADR-0226, ADR-0227). The host serves bundles and brokers credentials; it owns
no application data and constructs no database. What the condition still selects
is the credential path (`#platform/auth`, `#platform/instance`), because the
host really does broker a credential its windows cannot obtain.

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
Production's working copy is `~/Epicenter`; development's is `~/Epicenter Dev`.
`EPICENTER_FOLDER_DIR` overrides the working-copy directory and must be absolute.
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
open 'epicenter://app/honeycrisp'
open 'epicenter://app/home'
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

# Typecheck the host, Home, Whispering, and Honeycrisp
bun run --cwd apps/epicenter typecheck:desktop

# Host, routing, sidecar, and window tests
bun test apps/epicenter/scripts apps/epicenter/src

# Native command and fixture tests
cargo test --manifest-path apps/epicenter/src-tauri/Cargo.toml
```

The root `bun typecheck` runs each workspace's checks, including the apps checked
by `typecheck:desktop`. Use `typecheck:desktop` for standalone verification of
the host with Whispering and Honeycrisp.

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
