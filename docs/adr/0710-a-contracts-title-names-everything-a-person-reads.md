# 0710. A contract's title names everything a person reads

- **Status:** Proposed
- **Date:** 2026-11-03
- **Amends:** [ADR-0701](0701-apps-run-as-separate-programs.md) at decision 96's source of the default folder's name: the default folder is `<root>/<title>` from the contract, and `productName` is set from the same title.
- **Unbuilt:** the contract key `title` (`CONTRACT_KEYS` in `packages/definition/src/contract/contract.ts` refuses it today); `defaultDataFolder` and `epicenter clone` reading the title; a check that each app's `productName` equals its contract's title.

## Context

An app has six names today, set in four places, and two of them disagree.

```txt
contract name           whispering                 packages/definition (APP_NAME, a lowercase slug)
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
The two code paths each compute a folder name with no shared source.

## Decision

**An app has two names, both in its contract: `name` for machines and `title` for people.**

```ts
defineContract({
	name: 'whispering',   // slug: lowercase letters, digits, "-"
	title: 'Whispering',  // what a person reads
	collections: { … },
});
```

**Every name a program reads derives from `name`.**

```txt
hosted repository or document   <account>/whispering
bundle and AppData identifier   so.epicenter.whispering   (development: so.epicenter.whispering.dev)
site                            https://whispering.epicenter.so   (packages/constants/src/apps.ts)
```

**Every name a person reads derives from `title`.** A development build
keeps the same folder label under its own root, `~/Epicenter Dev`; only its
productName carries "Dev", so the installed programs stay distinguishable.

```txt
default folder label   <root>/Whispering   (development: ~/Epicenter Dev/Whispering)
productName            Whispering          (development: Whispering Dev)
window title           Whispering
```

**`defaultDataFolder` and `epicenter clone` read the same title.** The desktop
default is `<root>/<title>`. `clone` with no target directory fetches the
contract the repository names ([ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md)) and clones into `<root>/<title>`. The
two paths compute one name from one source.

**A folder label is not identity.** A person may rename a folder, and may hold
two folders of one app (`Photos` and `Family Photos`, from two repositories).
What a folder is comes from its `AGENTS.md` contract link ([ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md)) and its
remote, never from its directory name. `clone` asks for another label when
`<root>/<title>` already holds a folder.

**A title may contain spaces.** `The Ark` is a folder label as written. Paths
inside a folder stay the contract's lowercase collection paths
(`journal_entries/{id}.md`).

## Consequences

- The `Whispering`/`whispering` split disappears: clone and the desktop app
  open one directory on every file system.
- A contract gains a `title` key. `compileContract` accepts it; a published `contract.json` carries it.
- `productName` in each `tauri.conf.json` duplicates the title. A test per
  app keeps them equal, since Tauri reads the configuration at build time and
  cannot import the contract.
- Shell commands and agents quote labels with spaces (`"~/Epicenter/The Ark"`).
  `~/Epicenter Dev` already has one.
- A slug cannot change after data exists without renaming the repository and
  the bundle identifier. A title can change freely; existing folders keep
  their old label, because the app remembers its folder ([ADR-0712](0712-an-apps-folder-path-resolves-against-one-movable-library-root.md)).

## Considered alternatives

- **Lowercase slug folders everywhere (`~/Epicenter/whispering`).** One name
  instead of two. Lost because a person browses `~/Epicenter` in Finder
  beside `Documents` and `Dropbox`, and the folder label is the only one of
  these names a person reads daily.
- **Keep `productName` as the folder source and change `clone` to match.**
  `clone` cannot read a Tauri configuration, and a repository cloned before the
  app is installed has no `productName` to read.
- **The folder name as the app's identity.** Fails with two folders of one
  app and with any rename.
