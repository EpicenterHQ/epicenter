# 0493. Whispering's only desktop shell is Epicenter

- **Status:** Superseded
- **Superseded by:** [ADR-0701](0701-apps-run-as-separate-programs.md): Whispering ships no desktop build until it has its own shell; Epicenter hosts no app.
- **Date:** 2026-10-15
- **Relates:** [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md), whose exclusion of a separately shipped Whispering desktop runtime this keeps; [ADR-0537](0537-epicenter-opens-to-your-folders-and-home-becomes-settings.md), whose Settings opens Whispering once local transcription is ready.
- **Built:** Whispering installed as an app opening `so.epicenter.whispering` (`f16c69134b49:apps/whispering/epicenter.app.json`, [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md)); its native commands granted to its windows by app id (`apps/epicenter/src-tauri/capabilities/installed-whispering-*.json`): the recorder, local transcription with the active model, and opening Settings; its two connections kept in Epicenter's AI connections, with keys in the keychain and requests sent through Epicenter's host, so the page needs no `__WHISPERING_BRIDGE__`; local transcription in the desktop workspace (`caf928c446fc:apps/whispering/src/lib/workspace/local-transcription.ts`); and the deletion of `apps/whispering/src-tauri/`, the Bun host in `apps/whispering/native/`, the bridge, `BuiltInApp::Whispering`, and `build:whispering`.
- **Unbuilt:** the terminal and Reveal folder in Epicenter (they ran in the deleted Bun host, and Whispering offers neither now); choosing local transcription in Whispering's Settings; a recording overlay and global shortcuts, which Whispering's page does not use, so Epicenter creates and grants neither.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

Whispering ships in two desktop containers. Epicenter builds it
(`build:whispering` in `apps/epicenter/package.json`), creates its window at
startup (`ensure_window` with `BuiltInApp::Whispering` in
`apps/epicenter/src-tauri/src/lib.rs`), and owns its recording overlay and
global shortcuts. `apps/whispering/src-tauri/` is a second Tauri shell with its
own installer.

Only the second one works. The page opens its folder only when
`window.__WHISPERING_BRIDGE__` exists (`caf928c446fc:apps/whispering/src/lib/workspace/index.ts`),
<!-- doc-path-check: ignore-next-line -->
and only the standalone shell injects it (`apps/whispering/src-tauri/src/lib.rs`).
Epicenter's `APPLICATION_FOLDERS` (`a3b5be346e96:apps/epicenter/src-tauri/src/data_folders.rs`)
registers Todos and Capture and no Whispering folder. Inside Epicenter the
window answers `HostMissing`. The services the bridge reaches are `createHost`
<!-- doc-path-check: ignore-next-line -->
in `apps/whispering/native/host.ts`: the terminal in the folder, transcription
and text requests over the device's two connections, and the chosen microphone.

A plan of 2026-10-03 kept three deployment forms, a standalone desktop shell
beside Epicenter and the browser, with every native service rewritten in Rust
so both shells could compile it. Two shells mean two installers, two signing
and permission identities, and parity work for every service.

## Decision

**Epicenter owns Whispering on the desktop, and `apps/whispering/src-tauri/` is
deleted**, with its installer and its injection of `__WHISPERING_BRIDGE__`.

**Whispering's folder is `~/Epicenter/so.epicenter.whispering`.** Whispering
is an installed app ([ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md)), and the shell grants that directory to its window
as it grants any installed app the folder it opens.

**Epicenter's Bun host serves Whispering's host functions.** The functions
`createHost` provides run in Epicenter's host for Whispering's window, and
the page reaches them without `__WHISPERING_BRIDGE__`. The recorder is
`tauri-plugin-epicenter-recorder`, registered by Epicenter
([ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)).

**The browser build stays.** In an ordinary browser Whispering keeps its own
origin and its folder in browser storage; inside Epicenter it never opens
browser storage.

**Until Whispering opens inside Epicenter, the Folders window's Apps list hides
it**, since its window opens to `HostMissing`.

## Consequences

- One desktop installer carries Whispering; a person installs Epicenter to use
  it on the desktop.
- Deleted: `apps/whispering/src-tauri/` and its release, and the plan to port
  each native service to Rust for a second shell.
- Model administration ([ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md))
  and Whispering share one process and one active model.
- A future standalone shell would be a thin Tauri app registering the same
  plugins (`tauri-plugin-epicenter-folder`, `tauri-plugin-epicenter-recorder`)
  over the same folder, with one function naming its machine-state path under
  Epicenter's app data. None is built.
- `apps/whispering/README.md` describes the folder at
  `~/Epicenter/local/so.epicenter.whispering` and a Whispering that needs no
  Epicenter desktop; both change, and its folder becomes
  `~/Epicenter/so.epicenter.whispering`.

## Considered alternatives

- **Three deployment forms, with Rust services both desktop shells compile.**
  Two shells to keep at parity for every service, two installers, and two
  operating-system permission identities.
- **The standalone shell wins and Epicenter does not host Whispering.**
  Epicenter's local transcription model and its global shortcuts would have no
  Whispering window, and Settings could not open it.
- **One shared native daemon both shells call.** Installation, discovery,
  authentication, and lifetime coordination for a process neither shell needs.
