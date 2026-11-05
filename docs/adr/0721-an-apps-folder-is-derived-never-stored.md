# 0721. An app's folder is derived, never stored

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Amends:** [ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md) at the remembered `folder` value, the other-name choice after a collision, and "Open existing folder…": no location is stored and apps choose none; [ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md) at "a person may change" a folder's name and the origin "survives a rename": renaming a folder disconnects its app; [ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md) at a repository carrying `epicenter.root` counting as synced, and at the deep link's `path` and `contract`; [ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md) at `~/.epicenter/settings.md`: the file is not made; [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at `epicenter init` recording `epicenter.root` and at `--enclosing-ok`: a folder is its own repository at its derived path; [ADR-0701](0701-apps-run-as-separate-programs.md) at what remained of decision 96's remembered folder.
- **Amended by:** [ADR-0772](0772-epicenter-finds-every-folder-by-what-it-says-inside.md) at "An app's folder is always at its derived path": a folder is found by what it says inside it, under `~/Epicenter`, and its name is a label.
- **Unbuilt:** `epicenter move`; the deep link without `path` and `contract`; one environment table read by both Rust and TypeScript.
- **Amended by:** [ADR-0725](0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md) at the shell resolving and granting the derived path: the operating system follows links, nothing is granted, and one refusal rule remains; [ADR-0726](0726-an-apps-path-is-its-claim.md) at first launch, the collision choice, and Locate: an app opens its path and creates the folder when nothing is there; [ADR-0728](0728-a-build-states-its-environment.md) at the environment read from the `.dev` suffix: the build's configuration states it; [ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md) at "Cloning where a folder already exists … joins it: fetch, then merge": the folder's files are added on top of the account's repository in one commit, and no two histories are merged; [ADR-0736](0736-a-folder-outside-the-library-is-enrolled-through-a-link-the-person-names.md) at the example `ln -s whispering ~/Epicenter/voice`: a person's own link takes a name with a space, which no app could claim.

## Context

[ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md)
fixed the library root and kept one piece of location state per app: a
`folder` value in the app's AppData `settings.md`, written after the first
open, naming the folder under the root (`whispering`, or another name a person
picked after a collision). Folders kept elsewhere became links inside the root.
With links doing that job, the stored name did two things: it told a first
launch apart from a folder that had moved away, and it let an app use a name
other than its own after a collision.

Location state lives in several places today:

```txt
<AppData>/so.epicenter.whispering/settings.md   folder: <canonical path>   (packages/folder/src/settings.ts)
<AppData>/…/.persisted-scope                    folders a picker granted   (tauri_plugin_persisted_scope, packages/tauri-epicenter-standalone/src/lib.rs:60)
<folder>/.git/config                            epicenter.root = <absolute repository path>   (packages/cli/src/sync/setup.ts:165)
~/.epicenter/settings.md                        account, server            (ADR-0718)
```

`epicenter.root` stores an absolute path. `sync` refuses a repository whose
`epicenter.root` differs from its location (`packages/cli/src/sync/sync.ts:161`,
`status.ts:66`), so moving a folder breaks its next sync. The keychain item
already records the signed-in account and its issuer
(`packages/cli/src/auth.ts:110-118`), which `~/.epicenter/settings.md` would
copy. Three functions compute the root: `resolve_folder_root`
(`apps/epicenter/src-tauri/src/desktop_paths.rs:91`), `resolveAppPaths`
(`packages/cli/src/app-paths.ts`), and `defaultDataFolder`
(`packages/folder/src/desktop-folder.ts`), which still names the folder by
`productName` and has no development root. `epicenter clone` names a folder
after the repository (`packages/cli/src/sync/commands.ts:142`).

## Decision

**An app's folder is always at its derived path.** The path follows from the
app's site by [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md): `~/Epicenter/<label>` for Epicenter's own apps and
`~/Epicenter/<owner>/<label>` for every other app, under `~/Epicenter Dev` for a
development build. No program stores an app's location:

| Deleted | Where |
| --- | --- |
| the `folder` key | an app's AppData `settings.md` (`settings.ts` in `packages/folder/src`, deleted by `a33b60d698`) |
| `pickDataFolder`, `rememberFolder`, `isDefaultFolder`, and `chooseFolder` for data folders | `packages/folder/src/desktop-folder.ts` |
| `tauri_plugin_persisted_scope` | `packages/tauri-epicenter-standalone/src/lib.rs`, `packages/tauri-plugin-epicenter-folder/Cargo.toml` |
| `epicenter.root` and `--enclosing-ok` | `packages/cli/src/sync/setup.ts`, `sync.ts`, `status.ts` |
| `~/.epicenter/settings.md` | not made; a machine setting gets a file when one exists |
| `path` and `contract` in `epicenter://init` | `packages/folder/src/epicenter-sync.ts` |

**The shell computes the derived path and grants it at every launch.** It
resolves a link at that path and grants the resolved folder. One environment
table holds the roots and the server per environment, and the environment
comes from the bundle identifier's `.dev` suffix; Rust and TypeScript read the
same table in place of the three root functions.

**A folder kept elsewhere is a link at its derived path.** Moving is one
operation for every folder:

```sh
epicenter move whispering /Volumes/Archive   # mv the folder, then link it back at ~/Epicenter/whispering
```

Epicenter's "Move…" runs the same command. An app never moves, picks, or
renames its folder.

**Only a first launch creates a folder.** A first launch is one where the app's
AppData directory did not exist when the app started. On any other launch a
missing folder shows:

```txt
Your Whispering folder is missing (~/Epicenter/whispering).
[Locate…]   [Start a new folder]
```

"Locate…" picks the moved folder and links it at the derived path. A link whose
target is gone shows "This folder is on a drive that isn't connected."

**A first launch asks before using files the app does not recognize.** When the
derived path holds files that do not fit the app's contract, the app shows
"[Show in Finder] [Use it anyway]". It never renames or suffixes a folder it
did not create.

**A folder is synced when it is its own repository at its derived path and its
local configuration carries `epicenter.synced = true`.** The bit records the
person's consent at the first sync. A subfolder of a larger repository is not
synced.

**`epicenter clone` puts a repository at the derived path of the app its
`AGENTS.md` names.** Cloning where a folder already exists, as when an app on a
second Mac made its folder first, joins it: fetch, then merge.

**Renaming a folder disconnects its app.** The app looks only at the derived
path and shows the missing-folder screen. A person who wants another name
links it (`ln -s whispering ~/Epicenter/voice`); the link is theirs and nothing
records it.

**Existing folders are not migrated.** A `folder` value is ignored, and
`~/Epicenter/<productName>` is not looked up. On a case-insensitive volume
`~/Epicenter/Whispering` is the same directory as `~/Epicenter/whispering`.

## Consequences

- An app's location state is zero values. The only stored per-folder state is
  `epicenter.synced`, and the only per-app fact the shell reads is whether
  AppData existed at startup.
- `epicenter move` keeps a folder synced: nothing stores the path it left.
- Deleting an app's AppData makes its next launch a first launch. If the folder
  was also moved, the app creates an empty folder at the derived path; the
  moved folder is untouched.
- Two apps whose sites derive the same path cannot both run on one machine.
  [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md)'s rule makes that path unique per site.
- A person who keeps an app's data inside a larger repository, such as a vault
  already under Git, links it out to its own repository first.

## Considered alternatives

- **Remember the folder's name after the first open** (the previous
  [ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md)).
  The value told a first launch apart from a moved folder, which AppData's
  presence already does, and allowed another name, which a link already does.
- **A registry of folders.** A stored list goes stale when a folder moves.
- **"Rename it to `whispering (old)`" on a collision.** Renaming a folder
  another program owns breaks that program, and the name is a suffix.
- **Keep `epicenter.root`.** It stores an absolute path that `epicenter move`
  invalidates.
- **Keep `~/.epicenter/settings.md` for the account and server.** It copies what
  the keychain item holds, and sign-out would have to keep the two in step.
