# 0772. A folder says what it is in AGENTS.md, and this computer keeps the rest

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md) at "The CLI keeps the generated block current": Epicenter writes the note once and never again; [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) at "An app's folder is always at its derived path": a folder is found by its `AGENTS.md` under `~/Epicenter`, and its name is a label; [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) at an app's folder path: the label is the name Epicenter suggests; [ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md) at what sits under `~/Epicenter`: another team's apps sit in that team's folder; [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) at where a team's repositories sit on a computer; [ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md) at the library-root scan: it reads each folder's `AGENTS.md`.
- **Relates:** [ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md) (a folder has no history until it first syncs, which this holds the code to), [ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md) (the warning about a file-sync service), [ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) (plain Git), [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) (a folder's name is only a label).
- **Amended by:** [ADR-0787](0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md) at "Epicenter writes the note once": the one write carries the sync instruction.
- **Amended by:** [ADR-0791](0791-a-folders-first-sync-places-it-in-its-teams-folder.md) at a never-synced folder sitting at the top level and the note about where a folder sits: a first sync moves the folder into its team's folder.
- **Amended by:** [ADR-0802](0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) at a contract named by URL or path and an app's team as a setting: `contract.json` in the folder, and a space switcher.
- **Amended by:** [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) at `.git/` naming the repository and space: `.epicenter/synced.json` does, and a folder holds no `.git/`.
- **Unbuilt:** all of it: finding folders by `AGENTS.md` in the shell, the CLI, and the Epicenter app, with derived paths, the owner-level scan, the space rule for link names, and link-making deleted; team folders; `AGENTS.md` written once, with `refreshAgentsNote` deleted; `.epicenter/.gitignore` with the managed `.gitignore` block deleted; sync applying the Git LFS rule itself; no commit before the first sync, with the commit-subject matching in `foreign_commit` deleted; the duplicate and mismatch messages; the file-sync warning.

## Context

Under ADR-0770 a team owns one repository per app, and most people are in
one team. A computer had one root, `~/Epicenter`, and an app's folder was
always at a path derived from its site, so a second team's folders had
nowhere to go and a renamed folder was a missing one.

Two facts describe a folder, and each already has a home. What the data is
travels with it: the committed `AGENTS.md` names the app's contract
(ADR-0711), `epicenter check` and `epicenter clone` already read it, and it
is written on a folder's first open whether or not it ever syncs. Which
copy this computer uses, and which team it syncs with, belongs to the
computer: `.git` names the repository, and a repository's address is
`<team>/<name>`. A third file in `.epicenter/` would duplicate the first in
the one directory `git clean -X` deletes.

## Decision

**Everything is under `~/Epicenter`.** A person's first team's apps sit at
its top level. Another team is a folder there, and its apps' folders are
inside it.

```txt
~/Epicenter/
├── todos/                   AGENTS.md: contract: https://todos.epicenter.so/contract.json
│   ├── AGENTS.md            synced: what this data is
│   ├── .gitattributes       synced: the Git LFS rule, for plain Git and the server
│   ├── todos/<id>.md …      the data
│   ├── .git/                this computer: the repository, so the team (<team>/todos)
│   └── .epicenter/          this computer: unfinished writes; its own .gitignore says *
└── Family/                  a team folder: its team is its apps' repositories
    ├── todos/
    └── vocab/
```

**A folder says what it is in `AGENTS.md`.** An app's folder is one whose
`AGENTS.md` names a contract, by URL or by a path in the folder. Epicenter
writes the note once, when it makes the folder, and never rewrites it;
after that it is the person's. A team folder has no marker: Epicenter makes
it when it first clones one of that team's apps, and its team is the one
its apps' repositories name. A folder that has never synced sits at the top
level.

**Epicenter finds folders by what they say, never by their names.** The
shell, the CLI, and the Epicenter app read `AGENTS.md` in the folders of
`~/Epicenter` and of each team folder, following a link. No location is
stored and no path is derived. When Epicenter makes a folder it suggests the
app's label, adding " (2)" when it is taken. Any folder can be renamed,
moved and linked, and a renamed team offers to rename its folder.

**This computer's facts stay out of what syncs.** `.epicenter/` holds
unfinished writes and its own `.gitignore` of `*`, so no Git command commits
it; Epicenter writes no `.gitignore` block, and sync skips `.epicenter/` and
`.DS_Store` itself. Sync applies the Git LFS rule itself (a note is text,
every other file is LFS); the `.gitattributes` block stays so plain Git and
the server's first commit know it, and lines a person adds cannot narrow
it. A desktop app's team is a setting in its AppData.

**A folder has no history until its first sync** (ADR-0735). Nothing is
committed before it, so any history found at first contact is foreign, and
sync tells it apart without reading commit subjects.

**Epicenter shows what it sees and prevents little.** Two folders claiming
one app in one team are both shown, and neither syncs until the person
keeps one. A folder whose repository names another team than the folder it
sits in syncs with its repository, and Epicenter says where it sits.
Deleting notes syncs as deletion; `git revert` undoes it. Epicenter warns
once when `~/Epicenter` is inside Dropbox, iCloud Drive, or another
file-sync service. It never syncs the home folder, AppData, or the library
root.

## Consequences

- One team: `~/Epicenter` looks as it does today.
- A plain `git clone` or a download into `~/Epicenter` is a folder Epicenter
  recognizes, with no step of its own.
- Epicenter reads only inside `~/Epicenter`; nothing scans the home folder.
- Deleting or breaking `AGENTS.md` makes a folder plain; before making a
  fresh folder under the same name, Epicenter asks whether to use the one
  there.
- A folder moved out of `~/Epicenter` without a link there is not found.
- No undo before the first sync.
- A development build's root is `~/Epicenter Dev`.
