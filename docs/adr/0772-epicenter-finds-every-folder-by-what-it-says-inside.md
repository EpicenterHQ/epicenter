# 0772. Epicenter finds every folder by what it says inside

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) at "An app's folder is always at its derived path": a folder is found by what it says inside it, under `~/Epicenter`, and its name is a label; [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) at an app's folder path (`~/Epicenter/<label>`, `~/Epicenter/<owner>/<label>`): the label is the name Epicenter suggests; [ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md) at what sits under `~/Epicenter`: a team's folder holds its apps' folders; [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) at where a team's repositories sit on a computer; [ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md) at the library-root scan: it reads what each folder says.
- **Relates:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (a clone lives in a directory of any name), [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) (a repository is never renamed; a folder is only a label).
- **Unbuilt:** all of it: `.epicenter/folder`; finding folders by it in the shell, the CLI, and the Epicenter app; making a team's folder; the suggested names; "Rename the folder to match?"; an app's team setting on the desktop.

## Context

Under ADR-0770 a team owns one repository per app, and most people are in
one team. A computer had one root, `~/Epicenter`, and an app's folder was
always at a path derived from its site (`~/Epicenter/<label>`, or
`~/Epicenter/<owner>/<label>` for another publisher), so a second team's
folders had nowhere to go, and a renamed folder was a missing one.

A folder's name is not its identity, and its Git remote is not enough: a
remote says what a clone syncs with, not that Epicenter manages it (a
developer's other clone of the same repository has the same remote), and a
folder that has never synced has none. Every folder Epicenter manages
already has a `.epicenter/` directory that is never synced.

## Decision

**Every folder Epicenter manages says what it is in `.epicenter/folder`.**
An app's folder names its app's site; a team's folder names the team:

```txt
.epicenter/folder    app: https://todos.epicenter.so
.epicenter/folder    team: k3x9m2p7q1zt
```

`.epicenter/` holds Epicenter's own files for a folder on this computer:
this, and unfinished writes. It is never synced.

**Everything is under `~/Epicenter`.** The apps of a person's first team
sit at its top level, as before. Another team is a folder there, and its
apps' folders are inside it. An app from another publisher is a folder like
any other; no publisher directory is needed.

```txt
~/Epicenter/
├── todos/               app: https://todos.epicenter.so
├── whispering/
├── Notes/               app: https://notes.acme.dev
└── Family/              team: k3x9m2p7q1zt
    ├── todos/
    └── vocab/
```

Everything in a team's folder is shared with that team, and the top level
with the person's first team.

**Epicenter finds a folder by what it says, never by its name.** The shell,
the CLI, and the Epicenter app read `.epicenter/folder` in the folders of
`~/Epicenter` and of each team folder there, following a link. No location
is stored and no path is derived. When Epicenter makes a folder it suggests
a name, the app's label or the team's name, adding " (2)" when it is taken.

**Any folder can be renamed.** Renaming a team changes the name shown, and
Epicenter offers to rename its folder to match. A person may rename any
folder, or keep it elsewhere and leave a link to it in `~/Epicenter`.

**A desktop app uses one team,** the person's first unless they chose
another; the choice is a setting of the app's, never a location.

## Consequences

- One team: `~/Epicenter` looks as it does today.
- Epicenter only ever reads inside `~/Epicenter`, the one folder to back up;
  nothing scans the home folder.
- Two teams with the same name, an app label that matches a team's name, and
  a renamed folder all work with no rule of their own.
- A folder moved out of `~/Epicenter` without a link there is not found;
  Epicenter makes a fresh one and syncs it.
- Leaving a team leaves its folder and files on the computer; sync stops.
- A development build's root is `~/Epicenter Dev`.
