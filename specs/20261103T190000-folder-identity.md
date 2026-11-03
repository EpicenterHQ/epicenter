# Folder identity: every app's folder derived from its site

**Date**: 2026-11-03
**Status**: Draft
**Owner**: Epicenter

## One sentence

A desktop app opens the folder its site's address names, `~/Epicenter/whispering`
or `~/Epicenter/bradenwong.com/zhongwen`, computed once by the shell, never
stored, and never silently replaced.

The decisions are [ADR-0721](../docs/adr/0721-an-apps-folder-is-derived-never-stored.md)
(no stored location) and
[ADR-0722](../docs/adr/0722-an-apps-names-derive-from-its-sites-host.md)
(names from the host). The direction is [the vision](../docs/vision.md).

## Why now

Today the folder is computed twice, from `productName`, in Rust
(`default_folder`, `packages/tauri-epicenter-standalone/src/lib.rs:84`) and in
TypeScript (`defaultDataFolder`, `packages/folder/src/desktop-folder.ts:93`),
while `epicenter clone` lands at the repository name
(`packages/cli/src/sync/commands.ts:142`). On a case-sensitive volume a second
machine opens an empty `Whispering` beside the cloned `whispering`. A folder
the person picked is stored as an absolute path, and a moved default is
recreated empty.

## Scope

In:

1. **One environment table.** Roots per environment (`~/Epicenter`,
   `~/Epicenter Dev`) read by Rust and TypeScript; the environment comes from
   the bundle identifier's `.dev` suffix; `EPICENTER_FOLDER_DIR` overrides for
   tests only.
2. **The shell derives and grants the folder.** `StandaloneApp` names the
   app's declared site; the shell computes the path by ADR-0722's rule,
   resolves a link, and grants that one canonical path. The page asks the
   shell for it instead of computing it.
3. **No stored location.** Delete the `folder` key from AppData `settings.md`,
   `pickDataFolder`, `rememberFolder`, `isDefaultFolder`, the data-folder use of
   `chooseFolder`, "Choose data folder…", and `tauri-plugin-persisted-scope`.
4. **First launch and missing folders.** First launch is the app's AppData
   directory not existing at startup. Only then may the app create its
   folder. A folder holding files the contract does not recognize offers
   [Show in Finder] [Use it anyway]. Later, a missing folder offers [Locate…]
   (pick, then link at the derived path) or [Start a new folder]; a dead link
   says "This folder is on a drive that isn't connected."
5. **The `AGENTS.md` note.** Written at first open when missing: front matter
   `contract: <site>/contract.json`, a generated block between
   `<!-- BEGIN epicenter -->` markers.
6. **Onboarding line.** "Your recordings are files in `~/Epicenter/whispering`.
   [Show in Finder]" on first launch and in settings.
7. **`epicenter clone`** names the folder by ADR-0722's rule from the site,
   not from the repository name.
8. **Docs that change with the code.** `apps/epicenter/AGENTS.md` lines 17 and
   27, `apps/README.md`, the folder, svelte, and standalone READMEs, and the
   app READMEs that mention "Choose data folder…".

Out (later phases): `epicenter move`, the `epicenter.synced` flag replacing
`epicenter.root`, the engine in `~/.epicenter`, machine sign-in, the merge rule,
Epicenter scanning the root, documents, Tabs.

## Work, in commit order

| # | Commit | Main files |
| --- | --- | --- |
| 1 | The environment table and the derived folder in Rust | `packages/tauri-epicenter-standalone/src/lib.rs`, each app's `src-tauri/src/main.rs` |
| 2 | The page asks the shell for its folder; the stored location goes | `packages/folder/src/desktop-folder.ts`, `settings.ts`, `tauri.ts`, `native/bindings.gen.ts` |
| 3 | First launch, Locate, and the unrecognized-folder choice | `packages/svelte/src/desktop-startup.svelte`, `recovery.svelte`, a pure contract-fit check in `@epicenter/definition` |
| 4 | Drop persisted-scope and the data-folder picker | standalone `Cargo.toml`, folder plugin `Cargo.toml`, capabilities, `folder-sync.svelte.ts` |
| 5 | The `AGENTS.md` note and the onboarding line | `@epicenter/folder`, each app's startup |
| 6 | `clone` names the folder from the site | `packages/cli/src/sync/commands.ts`, `clone.ts` |
| 7 | Docs | READMEs and `apps/epicenter/AGENTS.md` |

Each commit builds and passes its own tests.

## Done when

- A fresh Whispering creates `~/Epicenter/whispering/AGENTS.md`, and its AppData
  `settings.md` has no `folder` key.
- A dev build uses `~/Epicenter Dev/whispering`.
- Renaming the folder shows [Locate…] and [Start a new folder], never an
  empty app.
- An unrecognized non-empty folder at the derived path shows the choice.
- `epicenter clone you/whispering` lands where Whispering looks.
- `bun run typecheck`, `bun test` in the touched packages, and `cargo test` in
  the touched crates pass.

## Open

- Whether the contract keeps `name`, or the name is derived only from the
  site (ADR-0722 currently requires them to be equal).
