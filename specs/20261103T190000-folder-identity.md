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

Decided by [ADR-0721](../docs/adr/0721-an-apps-folder-is-derived-never-stored.md),
[ADR-0722](../docs/adr/0722-an-apps-names-derive-from-its-sites-host.md),
[ADR-0725](../docs/adr/0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md)
and [ADR-0726](../docs/adr/0726-an-apps-path-is-its-claim.md): an app's
folder is `<root>/<name>` derived from its site; whatever is at that path is
the app's; the app creates it when nothing is there; the page reaches it by
root name and relative path, never by absolute path.

Out (later phases): `epicenter move`, the engine in `~/.epicenter`, machine
sign-in, the merge rule, Epicenter scanning the root, documents, Tabs.

## Work, in commit order

Revised after the wave A review: a folder moved behind a link must stay
syncable, and `clone` must join a folder an app already made, so both join
phase 1; the naming fixture comes before anything that depends on it.

| # | Commit | State |
| --- | --- | --- |
| 1 | The shell derives the data folder from the app's site | Done (`233d389069`) |
| 2 | No stored or chosen data-folder location | Done (`a33b60d698`) |
| 3 | Identity from the bundle identifier, the dead-link error | Done (`458ead40fd`) |
| 4 | Named roots; delete window binding, the scope, the path commands, persisted-scope; open-or-create; the build states its environment | Done (`08a3358c12`) |
| 5 | Wave A review fixes: Retry re-opens the folder; no blocking open at startup; watch changes as one app event; `open_root` answers the display path; audio and sync use Data only | In progress |
| 6 | The plain error screen ([Retry] [Show in Finder]) and the onboarding line | |
| 7 | The naming rule as one fixture Rust and TypeScript test against; the Epicenter app and the CLI pick roots by ADR-0728 | |
| 8 | The `AGENTS.md` note written at first open, keeping a person's own text; `epicenter check <dir>` reads its contract URL | |
| 9 | Linked folders sync: Epicenter accepts a folder link; `epicenter.synced` replaces the path-holding `epicenter.root` | |
| 10 | `epicenter clone` reads the cloned `AGENTS.md`, names the folder from the site, and joins an app folder already there | |
| 11 | A contract has no `name`; `openRemote` takes the repository name from the site | |
| 12 | Docs sweep, the wave B review, and deleting this spec | |

Each commit builds, passes its own tests, and leaves every app working.

## Done when

- A fresh Whispering creates `~/Epicenter/whispering/AGENTS.md`, and its AppData
  `settings.md` has no `folder` key.
- A dev build uses `~/Epicenter Dev/whispering`.
- A link at the path to an unplugged drive shows the plain error, not a new
  empty folder.
- The page holds no absolute path except the one it displays.
- `epicenter clone you/whispering` lands where Whispering looks.
- `bun run typecheck`, `bun test` in the touched packages, and `cargo test` in
  the touched crates pass.
