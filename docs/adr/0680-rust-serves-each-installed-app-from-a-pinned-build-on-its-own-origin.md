# 0680. Rust serves each installed app from a pinned build on its own origin

- **Status:** Proposed
- **Date:** 2026-10-22
- **Amends:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) and [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) at the optional runner's exclusion of installed source-built pages and native app admission, if this proposal is accepted.
- **Relates:** Historical [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md) and [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md); [ADR-0674](0674-standalone-apps-release-independently-from-one-monorepo.md) keeps standalone releases and fixed bundled pages separate; [ADR-0672](0672-native-app-defaults-are-fixed-reverse-dns-children-of-one-library.md) defines fixed first-party folders; [ADR-0678](0678-app-storage-openers-use-runtime-bound-scopes.md) proposes runtime-bound device storage; the proposed launcher grouping concerns data folders.
- **Unbuilt:** Installed-page serving, per-installation origins and labels, pinned-window builds, installed-page grants, and current-platform isolation probes. Rust presently serves only built-in and fixed bundled pages from `epicenter-app://localhost`.

## Context

Epicenter already serves static app builds inside Tauri WebViews. Its Rust
scheme handler answers GET requests from the bundled output, contains each
file request within its page directory, supplies a Content-Security-Policy,
and opens an extensionless client route with that page's `index.html`.
The handler currently selects a fixed page by the first path segment on
`epicenter-app://localhost`. The `BundledApp` table and window-label
capability files admit only the apps shipped with Epicenter.

A source-installed app needs the same static-file service, but its code can
change independently of the Epicenter release. Serving it below another path
on `localhost` would share that browser origin's storage with Settings and
the bundled apps. Separate origins prevent accidental storage-key collisions
and limit what a page compromised while running can read from other pages.
They do not make downloaded source safe to build: its build scripts already
run as the person's operating-system user. Giving a CLI build command a
loopback web-server lifetime would add a resident process, port ownership,
and a second file-serving and permission path. The CLI currently runs as a
short-lived child for fixed operations; it does not own WebView or window
lifetimes.

## Decision

**Rust serves installed static builds through Epicenter's existing scheme.**

The CLI acquires source and builds a chosen target. A successful build
atomically changes its active-build record. The CLI runs no persistent server
for an installed page. Rust reads that record and serves files from its
completed build with the scheme handler's existing containment, fallback, and
response policy. The handler never serves the checkout's mutable `dist/`
directory. A build is a set of static files; an app that requires its own
long-running server is outside this runner.

**Each local installation has a separate origin and a host-chosen identity.**

Epicenter assigns an opaque, DNS-safe installation key. On macOS, its page
opens at `epicenter-app://<key>/`, while Epicenter's own and fixed bundled
pages retain `epicenter-app://localhost/<page>/`. The manifest cannot select
`<key>`, a WebView label, or a native grant. The installed window's label uses
an `installed:` prefix outside every bundled-app selector. Rust checks that
the requested host matches the key bound to the requesting WebView before
serving any file, and keeps navigation on that origin. An app cannot fetch
another installation's build through a different host from its own window.

The installation key is also an installed page's only host-assigned identity
for browser and device storage. Its browser origin storage is separated by
that key.
If native device storage is later granted under ADR-0678, its scope derives
from the key in a namespace separate from the first-party logical app IDs
compiled into standalone and bundled shells. A manifest identifier, title,
target path, or Git remote cannot select a first-party device scope. Thus a
source-installed Todos, including a fork of the first-party source, does not
silently share standalone or bundled Todos's device state. Sharing that state
would need a separate native admission and migration decision; a manifest
claim alone cannot authorize it.
This qualifies ADR-0678's shared first-party device scope for source-installed
apps without changing how standalone and fixed bundled versions share it.

**An open window keeps the build it opened.**

At window creation Rust resolves the active build and binds its output
directory to that window before its WebView loads. The scheme resolves
requests from the requesting WebView's label to that pinned directory. A
later successful CLI build changes the active pointer for newly constructed
windows, not files under an open window. Rust rejects a missing, incomplete,
or incompatible build instead of falling back to source files or another
app's output.
Installing and building an app do not restart Epicenter or reload its open
windows. A request to open the same installation on the same canonical data
folder reveals the existing window on its pinned build. A newly constructed
window uses the active build. Reloading an existing window does not change
its binding; closing and reopening it selects the active build.

**Installed pages start with one fixed, narrow native grant.**

The grant allows the folder API on the one directory that Rust binds to
the window, its change events, and the close behavior those pages need.
It grants no generic process execution, CLI runner, Epicenter account
operation, recorder, model administration, or device-storage binding.
`openDeviceStorage()` refuses an installed page without a binding. Rust
admits the selected data folder with the same protected-directory checks
used for bundled apps before the WebView exists; the page supplies no
filesystem path to its native calls. A manifest cannot expand this grant.
Additional native powers require a separate host decision and
implementation. An installed app opens only an existing folder selected,
listed, or handed off by the host. It has no launch default, does not create
a library child, and cannot claim a fixed first-party default through its
manifest. The person can explicitly open the same data folder with a
bundled and an installed app.

The launcher lists installed targets among its app launch controls, keyed
by installation rather than title and distinguished by source directory.
Each installed target can offer Choose folder and appear in a folder row's
Open with menu. Its source availability and active build are visible there.
Opening or revealing a window updates that folder's recency under the
proposed launcher grouping;
installations themselves are not folder pins or recent folders.

A CLI command may ask the installed Epicenter desktop app to open an app
window through a handoff. That command does not start a server or turn a
regular browser into the native host. Source management and building remain
usable from the CLI when Epicenter is not running. If the handoff cannot return
the native window's outcome, the CLI reports only that the request was sent;
it does not claim that a window opened successfully.

## Consequences

- The desktop needs no listening port, long-lived Bun child, or second
  static-file server to open a source-installed app. Its CLI remains usable
  headlessly for acquisition, updates, and builds.
- Source, completed builds, and application data have separate locations and
  lifetimes. A running window continues to use its pinned bytes if source
  changes or a newer build fails.
- An installation key gives a reinstalled copy new browser storage unless
  its former inventory is deliberately restored. Installing two worktrees
  creates two keys and two origins even if their manifests name the same app.
- A narrow WebView grant does not sandbox the CLI's build process. Building
  downloaded source still executes code as the person's operating-system user.
- Origin isolation must be verified with current Tauri and WebView versions
  before installed pages ship. The historical macOS probe established
  separate `localStorage` keys, a secure context, and local-capability IPC
  within one run. It did not establish IndexedDB, OPFS,
  `BroadcastChannel`, persistence after relaunch, or other platforms.
  Windows and Linux support remains unbuilt until the same admission and
  isolation properties are demonstrated there.

## Considered alternatives

- **Have the CLI serve each build on a loopback port.** A page loaded from
  a loopback URL can call Tauri commands when the host grants that remote
  origin and window explicitly. File serving and origin isolation are
  separate choices: one server and port with paths for each app would still
  be one origin; distinct ports would create origins tied to port numbers.
  The CLI would need a resident child, port ownership, remote-page grants,
  and another reviewed file server. A loopback preview for ordinary browser
  development is a different tool, not the installed page's runtime. If a
  required WebView feature fails on the custom scheme, serving through a
  host-owned loopback server is a separate decision to revisit.
- **Serve every installed app under a path on `localhost`.** Paths do not
  divide a browser origin. A source-installed page would share origin storage
  with Epicenter's own pages and other apps, even though their native grants
  still differ by window.
- **Serve the checkout's latest build directly.** An agent or build command
  can replace those files while a window is using them. Pinned completed
  builds make activation and rollback independent of source editing.
- **Restart Epicenter after every successful build and read installed apps only at
  startup.** A restart would prevent old and new windows from coexisting, but
  it would not remove the need for per-window admission, immutable builds,
  atomic activation, or recovery. It would close unrelated app windows and
  interrupt edits or recordings; the current host does not restore those
  windows after restart. Reading the active build when a window opens keeps
  the runtime rule small without making installation a host-wide interruption.
