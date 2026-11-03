# 0710. An app's slug names everything a program reads

- **Status:** Proposed
- **Date:** 2026-11-03
- **Amends:** [ADR-0701](0701-apps-run-as-separate-programs.md) at decision 96's source of the default folder's name: the default folder is `<root>/<contract name>`, and `getName()` names only what a person reads.
- **Unbuilt:** `defaultDataFolder` reading the contract's `name` instead of `getName()`; `epicenter connect` defaulting the repository name to the slug; development builds of standalone apps using the root `~/Epicenter Dev`.

## Context

An app has six names today, set in four places, and two of them disagree.

```txt
contract name           whispering                 the contract's `name`, a lowercase slug
hosted repository       <account>/whispering       openRemote reaches <account>/<contract name> (ADR-0700)
clone target            ~/Epicenter/whispering     packages/cli/src/sync/commands.ts:142, join(folderDir, named.name)
productName             Whispering                 apps/whispering/src-tauri/tauri.conf.json
desktop default folder  ~/Epicenter/Whispering     packages/folder/src/desktop-folder.ts:93, getName()
bundle identifier       so.epicenter.whispering    apps/whispering/src-tauri/tauri.conf.json
```

`epicenter clone you/whispering` writes `~/Epicenter/whispering`, and the
desktop app then opens `~/Epicenter/Whispering`. On a default macOS volume,
which ignores case, both name one directory. On Linux or a case-sensitive
volume, a second computer's Whispering opens an empty folder beside the clone.
A development build opens `~/Epicenter/Whispering Dev`, inside the production
library.

Only the slug is known to every program that creates or finds the folder
without a lookup: the app has its contract, `clone` has the repository name,
Epicenter has the account's list, and an agent has the path. `productName` is
known only to the app's own bundle.

## Decision

**The contract's `name` (the slug) names the app wherever a program looks.**

```txt
                        production                          development
folder                  ~/Epicenter/whispering              ~/Epicenter Dev/whispering
AppData identifier      so.epicenter.whispering             so.epicenter.whispering.dev
repository or document  <account>/whispering                <account>/whispering on the dev server
site                    https://whispering.epicenter.so     the local dev URL
```

The site URL comes from `APPS` in `packages/constants/src/apps.ts`.

**`defaultDataFolder` returns `<root>/<contract name>`.** It reads the
contract's `name`, the same string `clone` already uses, so both open one
directory on every file system. `clone` needs no change.

**The environment changes roots, never names.** A development build keeps the
slug and uses the root `~/Epicenter Dev` ([ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md)).

**`productName` names what a person reads.** The window title, menus, and Dock
show `Whispering` (`Whispering Dev` for a development build) through Tauri's
`getName()`. No folder or repository name derives from it.

**The slug is a name, not the app's identity.** An app is identified by its
site's origin; a folder's `AGENTS.md` names the contract URL served from that
site
([ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md)), and which its site manifest describes ([ADR-0717](0717-an-epicenter-app-is-a-site-that-publishes-a-contract.md)). Two
third-party apps may share a slug; the second to open `<root>/<slug>` meets
the folder check ([ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md)) and is pointed at another folder. A person may
rename a folder or repository without changing what it is.

**`epicenter connect` defaults the repository name to the slug.** A
repository named otherwise is the person's explicit choice.

## Consequences

- The `Whispering`/`whispering` split disappears. Existing production folders
  named by `productName` open under the slug on a case-insensitive volume; on
  a case-sensitive one the person renames the folder once. No program looks
  up the old location.
- Folder names are lowercase and contain no spaces (`~/Epicenter/theark`),
  so shell commands and agents need no quoting.
- Development folders move from `~/Epicenter/<App> Dev` to
  `~/Epicenter Dev/<slug>`, and production Epicenter never lists them.
- A slug cannot change after data exists without renaming the repository, the
  folder, and the bundle identifier.

## Considered alternatives

- **A contract `title` naming the folder (`~/Epicenter/Whispering`).** `clone`
  and Epicenter would fetch every contract to learn a folder's name, and
  `productName` would duplicate the title with a test to keep them equal.
- **`productName` as the folder name, with `clone` changed to match.** `clone`
  cannot read a Tauri configuration, and a repository cloned before its app
  is installed has no `productName`.
- **Development folders inside `~/Epicenter` with a suffix
  (`~/Epicenter/whispering-dev`).** Production Epicenter lists them, agents
  working in the library meet test data, and the folder name stops being the
  slug.
- **The folder name as the app's identity.** Fails with two folders of one
  app, with a rename, and with two apps sharing a slug.
