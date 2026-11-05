# 0791. A folder's first sync places it in its team's folder

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) at "A folder that has never synced sits at the top level" and "A folder whose repository names another team than the folder it sits in syncs with its repository, and Epicenter says where it sits": a first sync moves the folder into its team's folder, so only a folder the person moved sits outside it.
- **Relates:** [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) (consent chooses a team), [ADR-0785](0785-a-desktop-app-signs-in-to-sync-its-own-folder.md) (a desktop app signs in to sync), [ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md) (first contact puts local files on top of the account's).
- **Unbuilt:** all of it: the core's first sync moving a never-synced folder into `~/Epicenter/<team>/`, making the team folder when it is missing, and putting the folder's files on top of the team's existing folder for the app when there is one.

## Context

A desktop app makes its folder before anyone signs in, and a folder that
has never synced sits at the top level of `~/Epicenter`, where a person's
first team's apps sit. When the person signs in and consent chooses another
team, the folder syncs with that team's repository but sits where the first
team's would. ADR-0772 then says where it sits, so the warning would follow
the first sign-in of anyone who picks a team other than their first.

## Decision

**A folder's first sync places it in its team's folder.** When consent
chooses the person's first team, the folder stays where it is. When it
chooses another, the first sync moves the folder into `~/Epicenter/<team>/`,
making that folder when it is missing, before it syncs. When the team's
folder already holds a folder for the app, the never-synced folder's files
go on top of that one, as a first sync puts local files on top of the
account's (ADR-0735), and the emptied folder goes.

Moving it is free: the folder has never synced, nothing stores its path,
and it is found by its `AGENTS.md` (ADR-0772).

## Consequences

- After a first sync every folder sits in its team's place, and ADR-0772's
  note about where a folder sits appears only for a folder the person moved.
- A person who picks another team sees their folder appear under that
  team's name in Finder.
