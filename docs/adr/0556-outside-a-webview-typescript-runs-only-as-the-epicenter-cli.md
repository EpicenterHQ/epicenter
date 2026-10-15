# 0556. Outside a WebView, TypeScript runs only as the epicenter CLI

- **Status:** Proposed
- **Date:** 2026-10-16
- **Built:** the save lock in the shell and the Bun host, and the Bun Git runner's hook rule (ADR-0559). The one binary: `packages/cli` compiled by `apps/epicenter/scripts/build-sidecar.ts` from `apps/epicenter/src/epicenter-binary.ts`, which is the `externalBin`, runs the Bun host as its hidden `__host` mode, and is `bun` under `BUN_BE_BUN=1`; the bundle names it `epicenter-cli`, because Tauri refuses a sidecar named like the Cargo package `epicenter`. `epicenter install-command`, which links it onto `PATH` as `/usr/local/bin/epicenter` (no Settings button yet). The narrow CLI runner (`apps/epicenter/src-tauri/src/cli.rs`) with one page command, `folder_check`, granted to the Folders window.
- **Unbuilt:** the rest, including `epicenter sync <dir>` started by Rust with no window open; when it runs is not decided here. Six checks come first. (1) A probe page on the scheme, on macOS, Windows, and Linux, records `isSecureContext`, `getUserMedia({ audio: true })` then `enumerateDevices()` with labels, `crypto.randomUUID()`, `crypto.subtle.digest`, and a `localStorage` value across a relaunch; the loopback server is deleted only after it passes. (2) ADR-0555's push-to-talk test on a window hidden for 30 minutes. (3) `Bun.secrets` `set` and `get` from the signed release binary on macOS, Windows, and Linux, and again after an update. (4) Todos installed from a release build on a clean Windows machine. (5) `epicenter sync` and a page saving one file in the same folder at once, with neither save lost. (6) A 30 MB response through `send` into a page's `Channel`; only the child pipe was measured.
- **Supersedes:** [ADR-0323](0323-background-work-runs-in-the-host-and-a-window-is-for-looking-at.md), whose background work runs in a long-lived Bun host. Background TypeScript is an `epicenter` command Rust starts and waits for. 0323's measurement stands: a hidden WebView's timers stop after about seven minutes.
- **Supersedes:** [ADR-0112](0112-the-cli-watcher-is-not-a-callable-action-server.md), whose CLI resident watcher remains. No `epicenter` process outlives its command. Its refusal of a local action server stands.
- **Amends:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) at what the host is: the Rust shell serves bundles, the `epicenter` CLI holds credentials, and no TypeScript host runs. The refusal of application data in the host is unchanged.
- **Amends:** [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) at "Bun-hosted", its loopback port, and its per-launch token. Epicenter stays one trusted origin; Rust serves it over a custom scheme.
- **Amends:** [ADR-0155](0155-epicenter-desktop-auth-is-one-credential-free-window-bun-authority.md) at "one Bun authority": the authority is the `epicenter` CLI. Windows stay credential-free.
- **Amends:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at the desktop row: the refresh token is held and refreshed by the `epicenter` CLI under its file lock, as the CLI row's is, and access tokens are cached by the CLI beside it instead of in the Bun host's memory. Withdrawn: "the desktop shell registers the same helper for its `git` runs"; the CLI's own Git uses its own helper. The client, grant, redirect, and "WebViews hold none" are unchanged.
- **Amends:** [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) at "`approvals.json` in app data, written only by the shell": it is written only by the `epicenter` CLI's `app install --approve` and `app update --approve`.
- **Amends:** [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) at where apps are served, `epicenter-app://localhost/apps/<app-id>/` instead of the loopback port, and at its consequence that one origin shares Web Locks and `BroadcastChannel`: the desktop path uses neither.
- **Amends:** [ADR-0541](0541-a-desktop-folder-needs-no-web-locks-and-a-commit-that-loses-a-race-retries.md) at its Bun row, "saves from separate processes do not" take turns: the CLI's saves and the shell's checked renames take turns under one save lock per folder.
- **Amends:** [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md) at the host session a remote device attaches to: Home Chat is deleted, so no session exists. Agents reach folders through `git`, the `epicenter` CLI, and the MCP server ([ADR-0550](0550-epicenters-mcp-server-reaches-hosted-folders-through-grants-that-target-namespaces.md)).
- **Relates:** [ADR-0009](0009-the-cli-dispatches-through-a-mandatory-daemon.md), already superseded by ADR-0112, and [ADR-0084](0084-super-chat-shell-is-a-bun-hosted-local-server-not-a-bundled-spa.md), already superseded by ADR-0118. [ADR-0533](0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md), unchanged: a Bun process is the engine's third host. [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md) and [ADR-0557](0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md) move the rest of the host's work. [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) names the CLI's commands, and [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md) moves desktop Git into it.

## Context

Epicenter runs two long-lived processes. Rust starts a compiled Bun host
(`epicenter-host`, `externalBin` in `apps/epicenter/src-tauri/tauri.conf.json:34`)
with a boot frame over stdin, waits up to 15 seconds for a ready frame on port
39130 or 39131, and destroys every window when the host stops, since each
window's initialization script carries the dead host's launch token
(`apps/epicenter/src-tauri/src/lib.rs:84-95`, `:758-1257`, `:1583-1873`). The
Bun host serves every app, bootstraps a session cookie, brokers the account,
holds AI connections, and runs Home Chat (`apps/epicenter/src/server.ts`).

Rust does the rest. It runs `git` for every page through `run_git`
(ADR-0559 moves it), keeps OS credentials with the
`keyring` crate (`apps/epicenter/src-tauri/src/keyring_storage.rs`), and
installs apps (`apps/epicenter/src-tauri/src/installed_apps.rs`, 2,017 lines),
running `bun` as the compiled host with `BUN_BE_BUN=1` on Unix (`:355-382`)
and nothing on Windows (`:385-388`).

<!-- doc-path-check: ignore-next-line -->
The `epicenter` CLI is `scripts/epicenter.ts` (404 lines: `check`, `query`,
`generate`), run by `bun` from a checkout. It ships to nobody.

## Decision

**Outside a WebView, TypeScript runs only as the `epicenter` CLI, a short-lived
child Rust starts with `--json` and waits for.** No daemon and no server: no
`epicenter` process listens on a port or outlives its command.

**The CLI owns the network, secrets, Git, auth, and installing apps. Rust keeps
only what must be native, runs per keystroke, or is always on.**

```txt
Rust shell     Tauri core; serving epicenter-app://; IPC and capabilities
               folder grants, checked writes with the save lock, the watcher
               the recorder, local transcription, the panel, paste, media, official plugins (ADR-0555)
               a narrow CLI runner
epicenter CLI  every network request (send, sync, clone, repos), every keychain item,
               every git process, auth, app install|update|list|remove, check, query, generate
pages          the UI, and the folder engine for interactive work (ADR-0531, ADR-0533)
```

Rust gets no HTTP client, no keychain, and no OAuth.

**The `epicenter` binary is the CLI compiled with `bun build --compile`, and it
is Epicenter's only Bun.** Run as `bun` (`BUN_BE_BUN=1`), it runs
`bun install --frozen-lockfile --ignore-scripts` and an app's Vite build. It is
the `externalBin` of `Epicenter.app`, in place of `epicenter-host`. Settings
offers "Install the epicenter command" once, which links that binary onto
`PATH`, so a terminal, an agent, and the app run one version.

**The CLI contains no logic of its own.** Each command is a thin wrapper over a
function in a shared package, and the browser build calls the same function
through its own `#platform` implementation.

| Capability | Shared package | Desktop | Browser |
| --- | --- | --- | --- |
| Files | `@epicenter/folder` | the shell's read and checked change commands (`packages/folder/src/tauri-directory.ts`) | OPFS (`packages/folder/src/browser-adapter.ts`) |
| Watching | `@epicenter/folder` | the shell's watcher (`packages/folder/src/changes-tauri.ts`) | `packages/folder/src/changes-browser.ts` |
| Git and sync | `@epicenter/folder` | the CLI over system `git` (`packages/folder/src/git/native-backend.ts`, ADR-0559) | isomorphic-git over OPFS (`packages/folder/src/git/browser-backend.ts`) |
| Inference and account calls | `@epicenter/ai`, `@epicenter/auth` | `epicenter send` | the page's own `fetch` (ADR-0557) |
| Sign-in | `@epicenter/auth` | `epicenter auth login --loopback` | redirect (`packages/auth/src/browser-redirect-auth.ts`) |

The browser's `send` uses no CLI and no Rust pipe because a browser has
nothing outside the page, so it calls `fetch` directly. On the desktop the
request leaves the page, so the key stays outside the page and CORS does not
apply; where the key lives follows from that and is not the reason.

Only installing apps, `auth git-credential`, and the keychain are desktop-only
by nature.

**The CLI runner is narrow.** A page calls fixed Rust commands (`send`,
`sync`, `status`, `history`, `save_version`, `auth_status`, and the like),
each mapped to one fixed `epicenter` invocation with typed arguments. Secrets
and bodies cross on stdin, never in arguments. There is no generic exec.

**`send` is `epicenter send`.** Rust writes the request body to the child's
stdin on one task and reads NDJSON from its stdout on another, piping each line
to the page's `Channel`; a fetch-shaped shim in the page wraps it. Measured on
macOS arm64 with a tokio parent: 40 MB in and 30 MB out in about 47 ms, and a
compiled CLI that imports the folder engine starts in 25 to 50 ms (each `git`
it spawns adds about 7 ms). The CLI never calls `process.exit` before stdout
drains, since a pipe can truncate at 64 KB multiples, and it chunks a large
body across lines instead of one JSON line (today's sidecar caps a line at
8 MiB, `lib.rs:136-138`). AI targets are ADR-0557's; account targets are
ADR-0549 resources.

**The keychain belongs to the CLI, through `Bun.secrets`.** It holds refresh
tokens, cached access tokens, and ADR-0557's AI keys. `Bun.secrets` is in Bun
1.3.14 and works in a compiled binary (`get` verified on macOS); Bun marks it
experimental, Linux needs libsecret and a running Secret Service, and an
unsigned development build may prompt for keychain access on macOS.

**All desktop Git runs in the CLI, one child per operation** (ADR-0559).

**Auth is the CLI's.** `epicenter auth token` and `epicenter auth
git-credential` share one refresh implementation under a file lock (ADR-0549).
Settings' Sign in runs the desktop's sign-in through the CLI (ADR-0558).

**Rust serves every page from one registered scheme.** Tauri's
`register_asynchronous_uri_scheme_protocol` (tauri 2.12.1, `app.rs:2335`)
registers `epicenter-app`, whose origin is `epicenter-app://localhost` on macOS
and Linux and `http://epicenter-app.localhost` on Windows (`app.rs:2256-2264`);
`use_https_scheme` is chosen once. Not `epicenter`, the deep-link scheme. The
handler answers GET only: it resolves `/apps/<id>/…` inside `apps-dist` or
`<cache_dir>/builds/<id>/<commit>/`, refusing links and anything outside;
falls back to the app's own `index.html` for an extensionless path; and sets a
`Content-Security-Policy` header with a hash for each inline script, keeping
`connect-src 'self' ipc: http://ipc.localhost`. A page on a registered scheme is
local to Tauri (`webview/mod.rs:1961-2000`), so capability files set
`"local": true` and the development twins go. One origin still holds: WebView2
gives one host per scheme, and a scheme cannot be added for an app installed
after startup. The desktop uses no Web Locks or `BroadcastChannel` today
(`packages/folder/src/tauri-directory.ts:41-58`).

**Installing moves to the CLI.** `installed_apps.rs` keeps opening an app's
window (`open_installed_app`, `:1268`), the current build the scheme serves
(`current_build`, `:648`), and the approval screen's calls to `epicenter app
… --json`. The manifest, approvals, staged clones, `git`, `bun install`, and
the build (`:1-647`, `:655-1203`, about 1,200 lines, and 733 lines of tests)
move into the CLI.

**The CLI and the shell may write one folder, and take turns under one save
lock (built).** The shell's `RootLock`
(`packages/tauri-plugin-epicenter-folder/core/src/lock.rs`), an exclusive SQLite
transaction on `.<name>.epicenter-lock`, is held from a folder's first grant
until the shell exits, so the CLI cannot take it. Both take the save lock
instead: an exclusive SQLite transaction on `.<name>.epicenter-save-lock`,
taken by the shell's `publishing()` and by the Bun host's rename and remove
(`packages/folder/src/bun.ts`), waiting at most 10 seconds. A check that fails
under the lock stays `Conflict`. `RootLock` stays the one-shell-per-folder
lock. Commits keep Git's lock files and `casBranch`, and ADR-0551's merges
settle the rest.

**Home Chat is deleted.**

**Bun is the build tool because the monorepo locks with `bun.lock`**, which
`--frozen-lockfile` reads, and one binary is both the runtime a build script
needs and the package manager; npm or pnpm would need Node as well.

**Deleted** (`wc -l` at `999012befb`):

- The Bun host: `apps/epicenter/src/sidecar-runtime.ts` (670) and test (664), `apps/epicenter/src/server.ts` (586) and test (1,699), `apps/epicenter/src/desktop-auth-authority.ts` (300) and test (954), `apps/epicenter/src/account-transport.test.ts` (483), `apps/epicenter/src/static-assets.ts` (316, ported) and test (36), `apps/epicenter/src/main.ts` (203), `apps/epicenter/src/app-secrets.ts` (82), `apps/epicenter/src/routes.ts` (44), `apps/epicenter/src/test-apps-dist.ts` (36), `apps/epicenter/scripts/build-sidecar.ts` (39) and test (240).
- About 1,030 lines of Rust in `lib.rs` and about 250 of its tests: frames and `HostState` (`:138-353`), `request_start` through `send_native_frame` (`:758-1257`), child stop (`:1355-1417`), and `OnHostStop`, `invalidate_windows`, `refuses_exit`, host logs, `launch_token`, `boot_frame_json`, `read_ready_frame`, `initialization_script`, the loopback navigation check, and port selection (`:1583-1873`). The auth-server descriptor (`:1258-1354`) moves to the CLI's configuration.
- Rust's keychain: `apps/epicenter/src-tauri/src/keyring_storage.rs` (131, and 43 of tests) and the `keyring` dependency.
- Each `*-development.json` capability file, which differs from its production twin only in `identifier` and `remote.urls`.
- The page-side broker: `packages/auth/src/desktop-broker-auth.ts` (223) and test (428), its `./desktop` export, and the stamped boot snapshot.
<!-- doc-path-check: ignore-next-line -->
- Home Chat: `apps/epicenter/src/host.ts` (505) and test (582), `apps/epicenter/src/test-home-host.ts` (22), `apps/epicenter/src/ui/session.svelte.ts` (161), `Chat.svelte` (209), `Composer.svelte` (54), `Transcript.svelte` (78), and `homeEngineFromEnvironment` with the `EPICENTER_INFERENCE_*` variables. `@epicenter/agent`, `@epicenter/agent-protocol`, and `bindAgentConversation` stay for `apps/vocab/src/lib/chat/session.svelte.ts`.
<!-- doc-path-check: ignore-next-line -->
- Dead code: `apps/epicenter/src/session-client.ts` (90), `apps/epicenter/src/local-source-catalog.ts` (128), `apps/epicenter/src/stdio-mcp-catalog.ts` (184), and `packages/ai/src/endpoint-transport.ts` (26) with the `/_epicenter/inference` relay.
- The API's desktop callbacks: `epicenter://auth/callback` and `http://127.0.0.1:<port>/_epicenter/sign-in/callback` (`apps/api/worker/session-callbacks.ts:18-20`), the `desktopPort` parameter, and `EPICENTER_DEV_PORT` (`apps/api/scripts/dev.ts:13`, `:81`; `apps/api/worker/index.ts:100`). ADR-0549's loopback redirect replaces both.
- `'tauri://localhost'` in `apps/api/worker/trusted-origins.ts:26`, which no page uses.
- The `bun` link shim in `build_environment` (`installed_apps.rs:355-389`) and the `build:sidecar` step; the `epicenter` binary takes the host's place.
- Dependencies of `apps/epicenter` nothing imports afterward: `hono`, `mime`, `@modelcontextprotocol/sdk`, `openai`, `@epicenter/client`, `@epicenter/agent`, `@epicenter/principal`, and, unused already, `@epicenter/server` and `@epicenter/constants`.
- The `http` and `os` plugin registrations (`lib.rs:524`, `:527`), granted to no window.

Added in Rust: the scheme handler and the narrow CLI runner. Added in the CLI:
the desktop OAuth client, `send`, and installing; ADR-0559 adds the Git
operations.

## Consequences

- One long-lived process. No port collision on 39130, no readiness race, no
  window torn down because a sidecar restarted, no stdin frame protocol.
- One binary for the app, the terminal, and agents, so a folder checked in a
  terminal and opened in the app are read by the same code at the same version.
- Every credential lives in one program.
- Each call into the CLI costs 25 to 50 ms of startup plus about 7 ms per
  `git` it spawns. Typing never pays it: reads and saves stay the shell's
  `invoke` commands.
- The origin changes, so browser storage at `http://127.0.0.1:39130` is
  orphaned: the theme, Whispering's microphone, and Todos' pasted Git tokens.
  Folder data is on disk. Nothing is migrated: Epicenter has no users.
- Todos keeps a pasted Git token in `localStorage`
  (`apps/todos/src/lib/git-access.ts:85`), which contradicts "secrets stay in
  the CLI" until ADR-0546's credential helper replaces it.
- An agent with a terminal can run `epicenter app install --approve`. It could
  already write `approvals.json`; approval guards against remote code, not
  local processes (ADR-0540).
- A Linux machine without a Secret Service cannot keep a key or sign in until
  one runs.
- Windows release builds stop depending on the person's `PATH`.

## Considered alternatives

- **Bun keeps serving the app files.** Keeps the port, token, cookie, and
  per-port capabilities, which are most of what this removes.
- **Rust serves HTTP on loopback.** Keeps the current origin and plain
  `fetch`, and keeps the port, token, and remote capabilities; the fallback if
  the probe fails `getUserMedia` on macOS.
- **Rust keeps `send`, the keychain, and an OAuth client.** Refresh in Rust for
  the app and in TypeScript for the terminal, and two keychain writers.
- **A generic exec command for pages.** Every CLI invocation becomes a page
  capability; fixed commands keep the surface reviewable.
- **A resident `epicenter` daemon for background sync.** A second long-lived
  process, which is what this removes.
- **Pages hold short-lived access tokens.** ADR-0549's desktop row says
  WebViews hold none, and every approved app shares the origin.
- **The CLI takes `RootLock`.** It is held while Epicenter has the folder
  open, so the CLI could never write a folder the app has open.
- **Home Chat moves into Settings or becomes an installed app.** It answers
  nothing until a person sets three environment variables.
- **npm or pnpm as the build tool.** Needs Node too, and does not read
  `bun.lock`.
