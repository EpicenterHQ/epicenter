# 0718. Epicenter's machinery on a machine lives in a hidden home every program reads

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Amends:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at `epicenter init` registering a folder for sync: the folders under the library root need no registration, a folder elsewhere is a link inside the root, and nothing is listed in the global Git configuration; [ADR-0642](0642-each-desktop-app-selects-its-cli-independently-of-the-terminal.md) at the public command `~/.local/bin/epicenter` and `install-command`: the engine is `~/.epicenter/bin/epicenter`.
- **Unbuilt:** all of it: `~/.epicenter` and `~/.epicenter-dev`; `settings.md` with the account, the server, and engine settings; `session.lock`; the root scan that finds synced folders by `epicenter.root`; `bin/` holding the engine and `git-lfs`; `documents/`; `logs/`; moving `epicenter.folder` out of the global Git configuration; retiring `install-command`.

## Context

Three pieces of machine state have no shared home today.

- **The list of folders a machine syncs** is the multi-valued `epicenter.folder`
  in the person's global Git configuration. `epicenter init` adds an entry with
  `git config --global --add epicenter.folder <path>`, `forget` removes it, and
  `epicenter sync` with no path reads the whole list
  (`packages/cli/src/sync/setup.ts:15-17`, `:76`, `:289-297`, `:316-323`). Many
  people keep `~/.gitconfig` in a dotfiles repository, so the list's machine
  paths leak to other machines: every `init` writes this machine's absolute
  paths into a file that is committed and copied elsewhere, where the paths
  are wrong. A standalone app cannot read the list without running `git`, which
  prompts for Apple's developer tools on a stock Mac.
- **The engine's location.** [ADR-0642](0642-each-desktop-app-selects-its-cli-independently-of-the-terminal.md) has each app run a private copy from its
  own bundle and installs the public command by repointing the symlink
  `~/.local/bin/epicenter` (`install-command`). [ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md) replaces the private
  copies with one engine per machine, which every app must be able to find.
- **Local copies of documents** ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)). A copy inside Epicenter's AppData
  (`so.epicenter`) is private to one program, while the CLI ([ADR-0716](0716-agents-edit-a-document-through-one-shot-cli-commands.md)) and
  document apps need the same copy.

Epicenter's AppData is the wrong home for all three: it belongs to one bundle,
and other programs reach it only by knowing that bundle's identifier.

## Decision

**Epicenter's machinery on a machine lives in `~/.epicenter`, which every
Epicenter program reads.** It is hidden and never synced. `~/Epicenter` holds
the person's data; `~/.epicenter` holds what Epicenter needs to run on this
machine. Development builds use `~/.epicenter-dev`, as their data uses
`~/Epicenter Dev`.

```txt
~/.epicenter/
  settings.md                    front matter: the account and server this machine is
                                 signed in as (ADR-0720), and engine settings
  session.lock                   held while the sign-in refreshes
  bin/epicenter                  the engine (ADR-0713)
  bin/git-lfs                    the copy the engine runs
  documents/<namespace>/<name>/  the one local copy of each document on this machine
  logs/                          sync logs
```

Secrets stay in the keychain.

**No list of folders exists.** The engine finds the folders it syncs by
scanning the root's children, following links ([ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md)), for a repository
whose local configuration carries `epicenter.root`, which `epicenter init`
already writes. A folder stored on another drive is a link inside the root, so
the same scan finds it.

**Every program finds the engine at `~/.epicenter/bin/epicenter`.** An app
calls that path; a terminal user adds `~/.epicenter/bin` to `PATH`.
`install-command` and the `~/.local/bin/epicenter` symlink retire.

**A machine keeps one local copy of each document**, at
`~/.epicenter/documents/<namespace>/<name>/`. Epicenter, the CLI, and a document
app open the same copy and append to it under one lock ([ADR-0716](0716-agents-edit-a-document-through-one-shot-cli-commands.md)).

**Epicenter's AppData keeps only Epicenter's own window state.** A data
folder's hidden `.epicenter/` ([ADR-0702](0702-a-data-folders-unfinished-writes-wait-in-epicenter-outside-its-data.md)) keeps its meaning: Epicenter's machinery,
not data.

## Consequences

- Machine paths leave the global Git configuration, so a dotfiles repository
  holding `~/.gitconfig` never carries them.
- An app reads machine state with a file read of `~/.epicenter/settings.md`,
  with no `git` and no knowledge of Epicenter's bundle identifier.
- `settings.md` holds no folder paths, so nothing in it goes stale when a
  folder moves.
- `epicenter sync` with no path scans the root's children each run: one
  directory listing and one configuration read per child.
- Uninstalling Epicenter leaves `~/.epicenter` behind.
- An app sandboxed for the Mac App Store cannot read `~/.epicenter`.
- `~/.epicenter/documents/` holds edits not yet sent, so deleting
  `~/.epicenter` can lose data.

## Considered alternatives

- **The global Git configuration (today).** Leaks machine paths into dotfiles
  repositories, and apps must run `git` to read it.
- **Epicenter's AppData (`so.epicenter/settings.md`).** Private to one bundle;
  every app and the CLI would need Epicenter's identifier, and a document copy
  there belongs to Epicenter alone.
- **A pointer file naming a movable root, as Dropbox's `~/.dropbox/info.json`
  names its folder.** The library root is fixed ([ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md)), so there is no root
  to point at.
- **`~/.config/epicenter` (XDG).** Splits machinery across `~/.config`,
  `~/.local/share`, and `~/.local/bin` on Linux, and is unconventional on a
  Mac; one dot-folder is one place to look, as `~/.bun`, `~/.cargo`, and
  `~/.dropbox` are.
