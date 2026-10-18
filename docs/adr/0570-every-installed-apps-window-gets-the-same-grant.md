# 0570. Every installed app's window gets the same grant

- **Status:** Superseded
- **Date:** 2026-10-16
- **Superseded by:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md): the desktop app host; the desktop app hosts, installs, builds, and approves no app and gives a website no native capability, and survives only as a data browser over clones on disk.
- **Amends:** [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md) at "granted by app id" and at "Each app is granted in one file, `installed-<app>.json`": every installed app's window is granted by one file, `installed-app.json`, whose `windows` is `app:*`.
- **Amends:** [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md) at "Each app has one file": there is one capability file per kind of window, `folders.json`, `home.json`, and `installed-app.json`.
- **Amends:** [ADR-0564](0564-an-ai-connections-endpoint-is-stored-with-its-key-not-in-its-row.md) at `AI_CONNECTION_APPS`: every installed app's window is permitted into `so.epicenter`, and the list is deleted.
- **Amended by:** [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md) at "Opening any installed app permits its window into `so.epicenter`": an app window reaches only the folder it was handed.
- **Amended by:** [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md) at "an app window reaches only the folder it was handed", as ADR-0587 restated it: an app window reaches every data folder.
- **Relates:** [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) (approving an app trusts it fully), [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md) and [ADR-0334](0334-a-deployed-app-is-a-trusted-app-because-deploying-it-was-the-consent.md) (a capability file is not a sandbox), [ADR-0557](0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md) (AI connections).
- **Built:** `apps/epicenter/src-tauri/capabilities/installed-app.json`, selecting `app:*` with the union of what Todos and Whispering called; `open_installed_window` in `apps/epicenter/src-tauri/src/lib.rs` permitting every installed app's window into `so.epicenter`.

## Context

An installed app's window is labelled `app:<id with _ for .>`, or
`app:<id>:<folder in hex>` when it opens a folder (`installed_window_label`
in `apps/epicenter/src-tauri/src/lib.rs`). Three capability files selected
those labels, each in a development and a production twin:
`installed-app-windows-*` granted every `app:*` window the folder plugin and
its history, `installed-todos-*` granted Todos' labels `account_send`,
`auth_status`, and `open_home`, and `installed-whispering-*` granted
Whispering's labels the recorder, local transcription, the AI commands, and
`auth_status`. The shell also let only the ids in `AI_CONNECTION_APPS`
(`["so.epicenter.whispering"]`) into `so.epicenter`, whose `connections` table
the AI commands name.

[ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md)
trusts an approved app fully: its build ran on this machine with the
person's account, and its page shares the one origin with every other app
([ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md)).
A per-app grant therefore protects nothing. What it did do was keep every app
but Todos and Whispering from the recorder, transcription, AI connections, and
the account, and require a Rust change, a capability file, and a release
before a third-party app could use any of them.

## Decision

**Every installed app's window gets the same grant: one capability file,
`installed-app.json`, whose `windows` is `app:*`.** It grants the union of
what any installed app's page calls today: the folder plugin and its change
event, the folder's history through the CLI, the recorder, local
transcription and its readiness, opening Settings, the AI commands, who the
app is signed in as, and its account request. Opening any installed app
permits its window into `so.epicenter`.

The capability is wiring, not a sandbox. Adding a native feature an app may
use is one line in that file, and it reaches every app at once.

**Three capability files remain, though none of them is a sandbox.**
`installed-app.json` is the public API of Epicenter's app platform: every
permission in it is a promise to every third-party app that the command
exists and keeps working, so adding or removing a line is an API change and
is reviewed as one. `folders.json` and `home.json` record two different jobs,
the Folders window's (listing folders, installing and opening apps) and
Settings' (the local model, signing in and out). One file for every window
would erase that record without protecting anything more.

## Consequences

- A third-party app can now record into its folder, transcribe with the
  local model, set or remove an AI connection's key, send over an AI
  connection, and send account requests with Epicenter's sign-in, with no
  change to Epicenter.
- An app reads `so.epicenter`'s `connections` rows. They hold a kind, a
  title, and a model; the endpoint and key stay in the keychain
  ([ADR-0564](0564-an-ai-connections-endpoint-is-stored-with-its-key-not-in-its-row.md)),
  and a page never reads a key.
- The grant cannot express that one app may do something another may not.
  Under ADR-0540 that distinction did not exist.
- Model administration, signing in and out, and installing and opening apps
  stay with Settings and the Folders window, whose files a test checks
  against `installed-app.json`.

## Considered alternatives

- **One file per app, keyed by app id, as ADR-0555 wrote.** Protects nothing
  under ADR-0540 and keeps every app Epicenter did not name from native
  features.
- **Per-app files generated from each app's manifest.** Capabilities are
  compiled into the build, and an app is installed after it; the manifest
  would also become a permission request ADR-0540 refused.
