# 0539. Epicenter's own folder is so.epicenter, and machine state splits by what it costs to lose

- **Status:** Accepted
- **Date:** 2026-10-15
- **Amended by:** [ADR-0557](0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md) at "model choices" in `kv.json`: AI connections are rows of a `connections` table in `so.epicenter`, each naming its model, and which connection an app uses is the app's own setting in its own folder.
- **Amended by:** [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at the `apps` row's "the shape it opens": no shape leaves the app.
- **Amended by:** [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md) at the `apps` table, the `defaultApp` setting, "Every app is a row", and the consequences that an agent lists apps by editing `so.epicenter` and that connecting it carries a person's apps to another machine: `so.epicenter` keeps neither, and the installed apps are the clones in `Apps/` with `approvals.json`.
- **Amended by:** [ADR-0579](0579-epicenter-never-deletes-a-model-from-the-shared-hugging-face-cache.md) at `models/<provider>/<model-id>/` in app data and "A person deletes them in Settings": models stay in the shared Hugging Face cache, and Settings shows a model's folder instead of deleting it.
- **Amended by:** [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md) at "Epicenter's own folder is `~/Epicenter/so.epicenter`", its tree's `so.epicenter/` entries, and "App source never sits inside `so.epicenter`": Epicenter keeps no folder, and AI connections live in this machine's keychain.
- **Amended by:** [ADR-0586](0586-you-open-a-folder-never-an-app.md) at the tree's `so.epicenter.todos/` and `Apps/<app-id>/` and "`Apps/` is beside it": installed apps' clones live in `<data_dir>/apps/`.
- **Built:** the `so.epicenter` folder, registered for the Folders window and Settings, declared by the CLI at every launch (`packages/cli/src/epicenter-folder.ts`); `~/Epicenter/Apps/`; `approvals.json` in app data, written only by the shell; built bundles in Caches (`cache_dir` in `apps/epicenter/src-tauri/src/app_data.rs`, `EPICENTER_CACHE_DIR`).
- **Unbuilt:** Settings opening `so.epicenter` (its scope is registered for the `home` window, which holds no folder plugin grant yet).

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
                                              opens, its source, its folder, the commit it runs
  so.epicenter.todos/                         an app's folder
  Apps/<app-id>/                              an app's source; each its own repository

~/Library/Application Support/so.epicenter/   written only by Epicenter
  approvals.json                              which commits may run on this machine
  models/<provider>/<model-id>/               downloaded weights
~/Library/Caches/so.epicenter/                disposable
  builds/<app-id>/<commit>/                   built bundles
Keychain                                      tokens and keys
```

**Every app is a row.** Epicenter compiles in no app ([ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md)). The shell
lists apps from their clones in `Apps/`, so deleting a row does not remove an
app.

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
