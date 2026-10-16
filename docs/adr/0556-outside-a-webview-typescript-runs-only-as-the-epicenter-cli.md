# 0556. Outside a WebView, TypeScript runs only as the epicenter CLI

- **Status:** Accepted
- **Date:** 2026-10-16
- **Supersedes:** [ADR-0323](0323-background-work-runs-in-the-host-and-a-window-is-for-looking-at.md), whose background work runs in a long-lived Bun host: background TypeScript is an `epicenter` command Rust starts and waits for, while 0323's measurement and its withdrawal of [ADR-0273](0273-an-epicenter-app-is-an-spa-with-a-namespace-and-background-work-is-a-hidden-window.md)'s hidden-window background work stand.
- **Amends:** [ADR-0112](0112-the-cli-watcher-is-not-a-callable-action-server.md) at "The CLI resident process remains": no `epicenter` process outlives its command, and the refusal of a local action server stands.
- **Amends:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) at what the host is: the Rust shell serves bundles, the `epicenter` CLI holds credentials, and no TypeScript host runs, while the refusal of application data in the host is unchanged.
- **Amends:** [ADR-0155](0155-epicenter-desktop-auth-is-one-credential-free-window-bun-authority.md) at "one Bun authority": the authority is the `epicenter` CLI, and windows stay credential-free.
- **Amends:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at the desktop row, at an installed app using the desktop grant "through the host's broker", and at "the desktop's Bun host in process": the `epicenter` CLI holds and refreshes the desktop refresh token under its file lock and caches access tokens beside it, while the client, grant, redirect, and "WebViews hold none" are unchanged.
- **Amends:** [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md) at the host session a remote device attaches to: no TypeScript host runs, so no session exists, and agents reach folders through `git`, the `epicenter` CLI, and the MCP server ([ADR-0550](0550-epicenters-mcp-server-reaches-hosted-folders-through-grants-that-target-namespaces.md)).
- **Built:** removing the Bun host: the hidden `__host` mode, the host's TypeScript under `apps/epicenter/src/`, the host lifecycle in `lib.rs`, and the host's dependencies listed under Deleted; Rust serves the pages instead ([ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md)).
- **Unbuilt:** `epicenter sync <dir>` started by Rust with no window open, whose timing is not decided. Checks: (1) `Bun.secrets` `set` and `get` from the signed release binary on macOS, and again after an update; (2) a 30 MB response through `send` into a page's `Channel`, since only the child pipe was measured. Windows and Linux checks wait for those platforms ([ADR-0567](0567-epicenter-ships-for-macos-only-for-now.md)).
- **Relates:** [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md) serves pages without the host, [ADR-0562](0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md) lets the CLI and the shell write one folder, [ADR-0563](0563-a-hidden-app-window-keeps-running-until-epicenter-quits.md) keeps hidden windows for events, [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md) and [ADR-0557](0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md) move the rest of the host's work, [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) names the CLI's commands, and [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md) moves desktop Git into it; [ADR-0022](0022-rust-owns-the-models-folder-the-webview-owns-the-catalog.md) (Rust downloads models), [ADR-0533](0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md) (a Bun process is the engine's third host), [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) (app data is written only by Epicenter, which the CLI is), [ADR-0111](0111-super-chat-v1-exposes-built-in-epicenter-apps-and-defers-extension-surfaces.md), [ADR-0113](0113-super-chat-session-commands-are-host-owned-transports-only-frame-them.md), and [ADR-0236](0236-remote-super-chat-attach-is-deferred-until-the-complete-product-exists.md) (Super Chat, whose host session was Home Chat), and [ADR-0009](0009-the-cli-dispatches-through-a-mandatory-daemon.md) and [ADR-0084](0084-super-chat-shell-is-a-bun-hosted-local-server-not-a-bundled-spa.md), already superseded by ADR-0112 and ADR-0118.

## Context

Line numbers below are at `999012befb`.

Epicenter runs two long-lived processes. Rust starts a compiled Bun host
(`epicenter-host`, `externalBin` in `apps/epicenter/src-tauri/tauri.conf.json:34`)
with a boot frame over stdin, waits up to 15 seconds for a ready frame on port
39130 or 39131, and destroys every window when the host stops, since each
window's initialization script carries the dead host's launch token
(`apps/epicenter/src-tauri/src/lib.rs:84-95`, `:758-1257`, `:1583-1873`). The
Bun host serves every app, bootstraps a session cookie, brokers the account,
and holds AI connections (`apps/epicenter/src/server.ts`).

Rust does the rest. It runs `git` for every page through `run_git`
([ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md)
moves it), keeps OS credentials with the `keyring` crate
<!-- doc-path-check: ignore-next-line -->
(`apps/epicenter/src-tauri/src/keyring_storage.rs`), downloads transcription
models ([ADR-0022](0022-rust-owns-the-models-folder-the-webview-owns-the-catalog.md),
`apps/epicenter/src-tauri/src/download.rs`), and installs apps
(`apps/epicenter/src-tauri/src/installed_apps.rs`, 2,017 lines), running `bun`
as the compiled host with `BUN_BE_BUN=1` on Unix (`:355-382`) and nothing on
Windows (`:385-388`).

<!-- doc-path-check: ignore-next-line -->
The `epicenter` CLI is `scripts/epicenter.ts` (404 lines: `check`, `query`,
`generate`), run by `bun` from a checkout. It ships to nobody.

Already gone: Home Chat, the host's chat session and the last running part of
Super Chat, with its dead catalogs (`session-client.ts`,
`local-source-catalog.ts`, `stdio-mcp-catalog.ts`) and the inference relay,
deleted in `2ecb00b5ca`; `'tauri://localhost'` as a trusted API origin,
removed in `e5e9fedacb`; and the `http` and `os` plugins, removed in
`0f987822ec`.

## Decision

**Outside a WebView, TypeScript runs only as the `epicenter` CLI, a short-lived
child Rust starts with `--json` and waits for.** No daemon and no server: no
`epicenter` process listens on a port or outlives its command.

**The CLI owns the network, secrets, Git, auth, and installing apps. Rust keeps
only what must be native, runs per keystroke, or is always on.**

```txt
Rust shell     Tauri core; serving epicenter-app:// (ADR-0561); IPC and capabilities
               folder grants, checked writes with the save lock (ADR-0562), the watcher
               the recorder, local transcription and model downloads, the panel, paste, media, official plugins (ADR-0555)
               a narrow CLI runner
epicenter CLI  every network request but model downloads (send, sync, clone, repos), every keychain item,
               every git process, auth, app install|update|list|remove, check, query, generate
pages          the UI, and the folder engine for interactive work (ADR-0531, ADR-0533)
```

**Rust holds no keychain item and no OAuth client, and makes one kind of
network request: downloading transcription models into app data
([ADR-0022](0022-rust-owns-the-models-folder-the-webview-owns-the-catalog.md)).**
Models are native transcription assets that only Rust loads, so their
download stays beside them, an explicit exception.

**The `epicenter` binary is the CLI compiled with `bun build --compile`, and it
is Epicenter's only Bun.** Run as `bun` (`BUN_BE_BUN=1`), it runs
`bun install --frozen-lockfile --ignore-scripts` and an app's Vite build. It is
the `externalBin` of `Epicenter.app`, named in the bundle as ADR-0558 says.
Settings offers "Install the epicenter command" until the command is on
`PATH`, and runs `epicenter install-command`, which links that binary onto
`PATH`, so a terminal, an agent, and the app run one version.

**The CLI holds no logic a page or the browser also needs.** Each command with
a browser twin is a thin wrapper over a function in a shared package, and the
browser build calls the same function through its own `#platform`
implementation. Desktop-only work, such as installing apps and the desktop
OAuth client, lives in the CLI's own modules (`packages/cli/src`).

| Capability | Shared package | Desktop | Browser |
| --- | --- | --- | --- |
| Files | `@epicenter/folder` | the shell's read and checked change commands (`packages/folder/src/tauri-directory.ts`) | OPFS (`packages/folder/src/browser-adapter.ts`) |
| Watching | `@epicenter/folder` | the shell's watcher (`packages/folder/src/changes-tauri.ts`) | `packages/folder/src/changes-browser.ts` |
| Git and sync | `@epicenter/folder` | the CLI over system `git` (`packages/folder/src/git/native-backend.ts`, ADR-0559) | isomorphic-git over OPFS (`packages/folder/src/git/browser-backend.ts`) |
| Inference and account calls | `@epicenter/ai`, `@epicenter/auth` | `epicenter send` | the page's own `fetch` (ADR-0557) |
| Sign-in | `@epicenter/auth` | `epicenter auth login --loopback` | redirect (`packages/auth/src/browser-oauth.ts`) |

The browser's `send` uses no CLI and no Rust pipe because a browser has
nothing outside the page, so it calls `fetch` directly. On the desktop the
request leaves the page, so the key stays outside the page and CORS does not
apply; where the key lives follows from that and is not the reason.

Installing apps, `auth git-credential`, and the keychain are not in the
browser build.

**The CLI runner is narrow.** A page calls fixed Rust commands, each mapped to
one fixed `epicenter` invocation (ADR-0558) with typed arguments:

```txt
folder_check   epicenter check <dir>
status         epicenter status <dir>
history        epicenter history <dir>
save_version   epicenter save-version <dir>
sync           epicenter sync <dir>
send           epicenter send
auth_status    epicenter auth status
```

ADR-0557 adds the key commands. Secrets and bodies cross on stdin, never in
arguments. There is no generic exec.

**`send` is `epicenter send`.** Rust writes the request body to the child's
stdin on one task and reads NDJSON from its stdout on another, piping each line
to the page's `Channel`; a fetch-shaped shim in the page wraps it. Measured on
macOS arm64 with a tokio parent: 40 MB in and 30 MB out in about 47 ms, and a
compiled CLI that imports the folder engine starts in 25 to 50 ms (each `git`
it spawns adds about 7 ms). The CLI never calls `process.exit` before stdout
drains, since a pipe can truncate at 64 KB multiples, and it chunks a large
body across lines instead of one JSON line (the Bun host's frame reader caps a
line at 8 MiB, `MAX_NATIVE_FRAME_BYTES`). `epicenter send` reads the access
token or key it needs itself. AI targets are ADR-0557's; account targets are
ADR-0549 resources.

**The keychain belongs to the CLI.** It holds refresh tokens, cached access
tokens, and ADR-0557's AI keys. The CLI uses `Bun.secrets` (Bun 1.3.14) if
check (1) passes; `get` is verified from a compiled binary on macOS, Bun marks
the API experimental, Linux needs libsecret and a running Secret Service, and
an unsigned development build may prompt for keychain access on macOS. If the
check fails on a platform, the keychain still belongs to the CLI, and a new
record names the library it uses there.

**All desktop Git runs in the CLI, one child per operation** (ADR-0559).

**Auth is the CLI's.** `epicenter auth token` and `epicenter auth
git-credential` share one refresh implementation under a file lock (ADR-0549).
Settings' Sign in runs `epicenter auth login --loopback`, the desktop client's
sign-in. The desktop grant serves only the commands Rust runs; a terminal or an
agent uses the device grant (ADR-0558).

**Installing moves to the CLI.** `installed_apps.rs` keeps opening an app's
window (`open_installed_app`, `:1268`), the current build ADR-0561's scheme
serves (`current_build`, `:648`), and the approval screen's calls to
`epicenter app … --json`. The manifest, approvals, staged clones, `git`,
`bun install`, and the build (`:1-647`, `:655-1203`, about 1,200 lines, and 733
lines of tests) move into the CLI.

**Bun is the build tool because the monorepo locks with `bun.lock`**, which
`--frozen-lockfile` reads, and one binary is both the runtime a build script
needs and the package manager; npm or pnpm would need Node as well.

**Deleted** (`wc -l` at `999012befb`):

<!-- doc-path-check: ignore-next-line -->
- The Bun host: `apps/epicenter/src/sidecar-runtime.ts` (670) and test (664), `apps/epicenter/src/server.ts` (586) and test (1,699), `apps/epicenter/src/desktop-auth-authority.ts` (300) and test (954), `apps/epicenter/src/account-transport.test.ts` (483), `apps/epicenter/src/static-assets.ts` (316, ported) and test (36), `apps/epicenter/src/main.ts` (203), `apps/epicenter/src/app-secrets.ts` (82), `apps/epicenter/src/routes.ts` (44), `apps/epicenter/src/test-apps-dist.ts` (36), `apps/epicenter/src/test-home-host.ts` (22), and the `__host` mode of `apps/epicenter/src/epicenter-binary.ts`.
- About 1,030 lines of Rust in `lib.rs` and about 250 of its tests: frames and `HostState` (`:138-353`), `request_start` through `send_native_frame` (`:758-1257`), child stop (`:1355-1417`), and `OnHostStop`, `invalidate_windows`, `refuses_exit`, host logs, `launch_token`, `boot_frame_json`, `read_ready_frame`, `initialization_script`, the loopback navigation check, and port selection (`:1583-1873`). The auth-server descriptor (`:1258-1354`) moves to the CLI's configuration.
<!-- doc-path-check: ignore-next-line -->
- Rust's keychain: `apps/epicenter/src-tauri/src/keyring_storage.rs` (131, and 43 of tests) and the `keyring` dependency.
<!-- doc-path-check: ignore-next-line -->
- The page-side broker: `packages/auth/src/desktop-broker-auth.ts` (223) and test (428), its `./desktop` export, and the stamped boot snapshot.
<!-- doc-path-check: ignore-next-line -->
- The API's desktop callbacks: `epicenter://auth/callback` and `http://127.0.0.1:<port>/_epicenter/sign-in/callback` (`apps/api/worker/session-callbacks.ts:18-20`), the `desktopPort` parameter, and `EPICENTER_DEV_PORT` (`apps/api/scripts/dev.ts:13`, `:81`; `apps/api/worker/index.ts:100`). ADR-0549's loopback redirect replaces both.
- `build_environment` and its `bun` link (`installed_apps.rs:355-389`), since the CLI runs itself as `bun`.
- Dependencies of `apps/epicenter` nothing imports afterward: `hono`, `mime`, `@modelcontextprotocol/sdk`, `openai`, `@epicenter/client`, `@epicenter/agent`, `@epicenter/principal`, and, unused already, `@epicenter/server` and `@epicenter/constants`.

Added in Rust: the narrow CLI runner. Added in the CLI: the desktop OAuth
client, `send`, and installing; ADR-0559 adds the Git operations.

## Consequences

- One long-lived process. No readiness race, no window torn down because a
  sidecar restarted, no stdin frame protocol.
- One binary for the app, the terminal, and agents, so a folder checked in a
  terminal and opened in the app are read by the same code at the same version.
- Every credential lives in one program.
- Each call into the CLI costs 25 to 50 ms of startup plus about 7 ms per
  `git` it spawns. Typing never pays it: reads and saves stay the shell's
  `invoke` commands.
- Todos keeps a pasted Git token in `localStorage`
  (Todos' `git-access.ts:85`), which contradicts "secrets stay in
  the CLI" until ADR-0546's credential helper replaces it.
- An agent with a terminal can run `epicenter app install --approve`. It could
  already write `approvals.json`; approval guards against remote code, not
  local processes (ADR-0540).
- A Linux machine without a Secret Service cannot keep a key or sign in until
  one runs.
- Windows release builds stop depending on the person's `PATH`.
- Rust keeps one HTTP client, for model downloads; nothing else in Rust makes
  a network request.

## Considered alternatives

- **Rust keeps `send`, the keychain, and an OAuth client.** Refresh in Rust for
  the app and in TypeScript for the terminal, and two keychain writers.
- **Model downloads move to the CLI.** Rust loads the models and already
  stages, checks, and renames a download into place (ADR-0022); moving the
  transfer alone would split one file's lifetime across two programs.
- **A generic exec command for pages.** Every CLI invocation becomes a page
  capability; fixed commands keep the surface reviewable.
- **A resident `epicenter` daemon for background sync.** A second long-lived
  process, which is what this removes.
- **Pages hold short-lived access tokens.** ADR-0549's desktop row says
  WebViews hold none, and every approved app shares the origin.
- **npm or pnpm as the build tool.** Needs Node too, and does not read
  `bun.lock`.
