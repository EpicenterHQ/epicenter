# 0561. Rust serves every app from one epicenter-app origin

- **Status:** Accepted
- **Date:** 2026-10-16
- **Amends:** [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) at "Bun-hosted", its loopback port, and its per-launch token: Rust serves the one trusted origin over the `epicenter-app` scheme.
- **Amends:** [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) at where apps are served, `epicenter-app://localhost/apps/<app-id>/`, and at its consequence that one origin shares Web Locks and `BroadcastChannel`: the desktop uses neither.
- **Amended by:** [ADR-0570](0570-every-installed-apps-window-gets-the-same-grant.md) at "Each app has one file": there is one capability file per kind of window, `folders.json`, `home.json`, and `installed-app.json`.
- **Amended by:** [ADR-0571](0571-on-desktop-rust-owns-the-microphone-and-the-page-never-opens-one.md) at the microphone probe: Whispering's page in Epicenter opens no microphone, so the probe narrows to another installed app's WebView microphone on the scheme.
- **Amended by:** [ADR-0588](0588-an-installed-apps-window-runs-one-approved-commits-own-build.md) at the installed app's URL: `/apps/<app-id>/<commit>/`, served from that commit's build, so a window keeps the build it opened on.
- **Relates:** [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) (no Bun host runs, so something else serves pages), [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md) (each app's capability file).
- **Built:** the scheme handler, `apps/epicenter/src-tauri/src/scheme.rs`: GET only, a path resolved inside the page's directory or the app's current build with links and anything outside refused, `index.html` for an extensionless route, the Content-Type, and a Content-Security-Policy hashing each inline script; Folders at `/folders/`, Settings at `/home/`, and installed apps at `/apps/<app-id>/`, with navigation held to the origin; capability files with `"local": true` and no `remote.urls`, the `*-development.json` files deleted; and the loopback server, its per-launch token, and the Bun host lifecycle in `lib.rs` deleted. The probe ran on macOS only ([ADR-0567](0567-epicenter-ships-for-macos-only-for-now.md)): `isSecureContext`, `crypto.randomUUID()`, `crypto.subtle.digest`, `localStorage` across a relaunch, IPC as a local page, and the policy enforced.
- **Unbuilt:** another installed app's WebView microphone on the scheme, `getUserMedia({ audio: true })` then `enumerateDevices()` with labels, untested because the probe machine had no audio device (Whispering's desktop build calls neither, ADR-0571); Windows and Linux, which wait for those platforms (ADR-0567).

## Context

The Bun host serves every page Epicenter shows at `http://127.0.0.1:39130` (or
39131), and each window's initialization script carries the host's per-launch
token ([ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md)).
Installed apps are served at `/apps/<app-id>/` on that origin
([ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md)).
Because a page's origin is a loopback URL, each capability file names it in
`remote.urls`, and each comes in a development and a production twin that
differ only in `identifier` and `remote.urls`
(`apps/epicenter/src-tauri/capabilities/*-development.json`).

[ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md)
removes the Bun host, so the pages need another server.

## Decision

**Rust serves every page from one registered scheme, `epicenter-app`.** Tauri's
`register_asynchronous_uri_scheme_protocol` (tauri 2.12.1, `app.rs:2335`)
registers it. Its origin is `epicenter-app://localhost` on macOS and Linux and
`http://epicenter-app.localhost` on Windows (`app.rs:2256-2264`);
`use_https_scheme` is chosen once. It is not `epicenter`, the deep-link scheme.

```txt
epicenter-app://localhost/<page>/…           Epicenter's own pages, from apps-dist
epicenter-app://localhost/apps/<id>/…        an installed app, from <cache_dir>/builds/<id>/<commit>/
```

The handler answers GET only. It resolves a path inside `apps-dist` or the
app's current build, refusing links and anything outside; falls back to the
app's own `index.html` for an extensionless path; and sets a
`Content-Security-Policy` header with a hash for each inline script, keeping
`connect-src 'self' ipc: http://ipc.localhost`.

**Every page shares the one origin.** WebView2 gives one host per scheme, and a
scheme cannot be registered for an app installed after startup, so a scheme
per app is not available. The desktop uses no Web Locks or `BroadcastChannel`
(`packages/folder/src/tauri-directory.ts:41-58`).

**Capability files are local and come once.** A page on a registered scheme is
local to Tauri (`webview/mod.rs:1961-2000`), so each capability file sets
`"local": true` and names no `remote.urls`. Each app has one file,
`apps/epicenter/src-tauri/capabilities/installed-<app>.json`, and every
`*-development.json` file is deleted.

## Consequences

- No port, no port collision on 39130, and no per-launch token in any window.
- The origin changes, so browser storage at `http://127.0.0.1:39130` is
  orphaned: the theme, Whispering's microphone choice, and Todos' pasted Git
  tokens. Folder data is on disk. Nothing is migrated: Epicenter has no users.
- A page that needs a secure context or the microphone learns whether the
  scheme gives it from the probe, on all three platforms, before the loopback
  server is deleted.
- Every installed app shares storage with every other, as on the loopback
  origin; under ADR-0540 that exposes nothing a build has not already reached.

## Considered alternatives

- **Bun keeps serving the app files.** Keeps the port, token, cookie, and
  per-port capabilities, and a long-lived Bun process ADR-0556 removes.
- **Rust serves HTTP on loopback.** Keeps the current origin and plain
  `fetch`, and keeps the port, the token, and remote capabilities. It is the
  replacement if the probe fails.
- **One scheme per app.** WebView2 gives one host per scheme, and an app
  installed after startup could not get one.
