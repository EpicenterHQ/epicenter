# 0772. Each team has a root folder, found by the team inside it

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md) at one root of app folders on a computer: each team a person is in has its own; [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) at "An app's folder is always at its derived path": a team's root is found by what is inside it, and an app's folder is derived under that root; [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) at where a team's repositories sit on a computer.
- **Relates:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (a clone lives in a directory of any name), [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) (a repository is never renamed; a team is).
- **Unbuilt:** all of it: the `.epicenter/team` file, the scan, making a team's root when its first app folder is made, the shell granting an app the folder under its team's root, the "Rename the folder to match?" offer, and an app's team setting on the desktop.

## Context

Under ADR-0770 a team owns one repository per app, and inviting someone into
a team shares every app's data in it. Most people are in one team. A
computer had one root, `~/Epicenter`, with an app's folder derived from its
site (`~/Epicenter/<label>`, or `~/Epicenter/<owner>/<label>` for another
publisher's app), so a second team's folders had nowhere to go.

Nesting teams under `~/Epicenter` gives everyone an extra level for the
case most people never have, and team names would share that level with
app labels and publishers. A folder's name is not its identity: which
repository a clone syncs with is in its `.git` (ADR-0612). A team's name
changes, and two teams can share one.

## Decision

**Each team a person is in has its own root folder, beside the others.**
Their first team's root is `~/Epicenter`, as before. Another team's root is
made the first time one of its apps' folders is, named for the team then:
`~/Epicenter (Family)`, or `~/Epicenter (Family 2)` when that name is taken.
Inside any root, app folders sit as they always have: `<root>/<label>` and
`<root>/<owner>/<label>`. Everything in a team's root is shared with that
team, and nothing outside it is.

```txt
~/Epicenter/                 your first team
├── todos/
├── whispering/
└── acme/notes/              another publisher's app
~/Epicenter (Family)/        the Family team
├── todos/
└── vocab/
```

**A root is found by the team written inside it, not by its name.** When
Epicenter makes a root it writes the team's id to `.epicenter/team` there.
Epicenter and each app's shell find a team's root by reading that file in
the folders at the top of the home folder; no location is stored. An app's
folder is then derived under its team's root, as ADR-0721 derives it today.

**Renaming changes nothing on disk.** Renaming a team changes the name
shown; Epicenter offers to rename its root to match. A person may rename a
root, or put it elsewhere and leave a link at the top of the home folder
(ADR-0721), and everything keeps finding it.

**A desktop app uses one team,** its first team unless the person chose
another; the choice is a setting of the app's, never a location.

## Consequences

- One team, no change: `~/Epicenter` and the paths under it are as they are.
- What a team shares is one folder a person can see.
- Two teams with the same name, a renamed team, and a renamed folder all
  work without a rule for each.
- A root moved deeper than the top of the home folder without a link there
  is not found; Epicenter makes a fresh one and syncs it.
- Leaving a team leaves its root and files on the computer; sync stops.
- A development build's roots are `~/Epicenter Dev` and
  `~/Epicenter Dev (Family)`.
