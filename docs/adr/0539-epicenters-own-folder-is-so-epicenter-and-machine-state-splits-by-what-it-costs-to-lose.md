# 0539. Epicenter's own folder is so.epicenter, and machine state splits by what it costs to lose

- **Status:** Proposed
- **Date:** 2026-10-15
- **Unbuilt:** the `so.epicenter` folder and its `apps` table and settings; `~/Epicenter/Apps/`; `approvals.json`; moving built bundles to Caches.

## Context

Epicenter keeps two roots, chosen in `apps/epicenter/src-tauri/src/app_data.rs`:
`folder_dir` (`~/Epicenter`, or `~/Epicenter Dev`), which holds data folders,
and `data_dir` (`~/Library/Application Support/so.epicenter`), which holds
device blobs under `apps/<app-id>/device/<owner>/blobs`, the AI model catalog
and downloaded models, and the parked installed-app bundles. Which apps exist is
compiled into Epicenter (`COMPILED_APPLICATIONS`, `BuiltInApp`). Settings live
in the host. Neither an agent nor a person can list, install, or configure apps
by editing files.

## Decision

**Whatever a person or an agent reads, edits, repairs, or versions as files
lives in a folder under the Epicenter root. Whatever only Epicenter writes, and
whatever this machine alone needs, lives in app data.**

**Epicenter's own folder is `~/Epicenter/so.epicenter`**, named by Epicenter's
id as every app's folder is named by its id. It is a data folder: a repository,
editable while Epicenter runs, synced only if it is connected.

```txt
~/Epicenter/                                  every folder here is a repository
  so.epicenter/
    epicenter.json                            declares the apps table and the settings
    kv.json                                   settings: default app per folder, model choices
    apps/<app-id>.md                          one row per installed app: title, the shape it
                                              opens, its source, the commit it runs
  so.epicenter.todos/                         an app's folder
  Apps/<app-id>/                              an app's source; each its own repository

~/Library/Application Support/so.epicenter/   written only by Epicenter
  approvals.json                              which commits may run on this machine
  models/<provider>/<model-id>/               downloaded weights
~/Library/Caches/so.epicenter/                disposable
  builds/<app-id>/<commit>/                   built bundles
Keychain                                      tokens and keys
```

**Built-in apps are not rows.** Epicenter ships their manifests read-only; the
`apps` table adds apps and overrides defaults. A fresh machine works before
anything syncs, and deleting a row cannot remove Todos.

**App source never sits inside `so.epicenter`.** A repository inside another is
what [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) refuses
for data folders; `Apps/` is beside it, and the folder listing skips it because
it holds no `epicenter.json`.

**There is no hidden `.epicenter` directory.**

## Consequences

- An agent installs, lists, or configures apps by editing `so.epicenter`, with
  history and without Epicenter running.
- Connecting `so.epicenter` makes a person's apps and settings follow them to
  another machine. Run approvals stay behind, because they are in app data.
- Models are not in Caches: macOS may purge Caches, and re-downloading
  gigabytes is not silent. A person deletes them in Settings.
- The per-app device blob directory has no successor here; blobs are files in
  their folder ([ADR-0544](0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md)).

## Considered alternatives

- **`~/Epicenter/.epicenter`, hidden.** A special case, and a hidden place
  agents can write but nobody looks at.
- **Registry and settings in app data.** Agents cannot edit them, and nothing
  is versioned.
- **App source inside `so.epicenter/apps/<app-id>/`.** Nested repositories.
