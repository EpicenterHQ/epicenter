# 0715. The Epicenter app browses every folder and document a person has

- **Status:** Proposed
- **Date:** 2026-11-03
- **Amends:** [ADR-0701](0701-apps-run-as-separate-programs.md) at decision 81 ("Epicenter learns of a folder only through Sync with Epicenter's deep link"): Epicenter also lists the library root's folders; and at the 2026-11-01 revision that deleted the folder editor window ("Epicenter opens no folder's files"): Epicenter shows a folder's or document's items again; [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) at deferring the desktop data browser.
- **Unbuilt:** the library-root scan; adding a folder from anywhere; the account's repository and document lists in the Folders window; generic collection views from the field vocabulary; opening documents through `~/.epicenter/documents`; removing the line in `apps/epicenter/AGENTS.md` that conflicts ("Epicenter opens no folder's files").

## Context

The Folders window (`apps/epicenter/src/folders/`) lists what
`epicenter status --json` reports: the folders in the global Git config's
multi-valued `epicenter.folder`, which `epicenter init` adds with
`git config --global --add epicenter.folder <path>`
(`packages/cli/src/sync/setup.ts:289-297`). ADR-0701 decision 81 makes the
`epicenter://init` link the only way Epicenter learns of a folder, so data an
app wrote before Epicenter was installed stays invisible until the person
presses that app's sync button.

ADR-0701's 2026-11-01 revision deleted Epicenter's folder editor window (Files,
grid, board, SQL, saved views), because every app reaches its folder through its
own program. Documents ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)) have no folder on disk at all. Without a
browser in Epicenter, a person can see a document's data only in the app that
made it, and cannot see which folders exist under `~/Epicenter`.

## Decision

**The Epicenter app lists and opens every folder and document a person has.**

The Folders window shows one list built from three sources. Each source is a
different fact, and none is copied into another:

| Source | Fact | Read from |
| --- | --- | --- |
| it is under the library root | a non-hidden child directory of `~/Epicenter`; synced when it is a repository whose local configuration carries `epicenter.root`, otherwise "Not synced" | a directory listing, never stored |
| it is outside the root and this machine syncs it | an absolute path in `folders` | `~/.epicenter/settings.md` ([ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md)) |
| it is on the account | a repository or document the signed-in account can reach | the server's repository and document lists ([ADR-0708](0708-a-namespace-holds-documents-beside-repositories-under-one-resource-grant.md)) |

- **A folder under the root that is not synced shows as "Not synced".**
  Enrolling it takes the person's confirmation in Epicenter's consent screen.
  Listing makes no ownership claim.
- **The `epicenter://init` link stays** for an app whose folder is outside the
  root. "Add folder…" adds a folder from anywhere.
- **Opening a folder or document shows its collections and items.** The views
  come from the collection's fields in the shared field vocabulary ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)):
  a `select` shows as a single choice, a `multiSelect` as chips. A folder's
  views read and write its files through `openDevice`; a document's views read
  and write the document.
- **Epicenter opens a document through the machine's one local copy** at
  `~/.epicenter/documents/<namespace>/<name>/` ([ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md)), the copy the CLI and
  document apps also use. The copy can hold edits not yet sent, so it is a
  replica, not a cache: deleting it can lose data.
- **Epicenter's own synced settings get a folder only when they exist.** When
  Epicenter first has something that follows a person between machines, such
  as its own shortcuts, it keeps it in `~/Epicenter/epicenter`, a folder like
  any app's. Until then the folder does not exist.

No new registry is stored. The three lists stay where they are, and the window
joins them by path and by resource name each time it lists.

## Consequences

- Data an app wrote before Epicenter was installed shows up the first time
  Epicenter lists the root, without visiting the app.
- A person sees every document their account holds without opening each app.
- Epicenter again runs folder-reading code and holds files open, which the
  2026-11-01 revision removed. A window bound to a folder needs the folder grant
  and recovery that ADR-0701's apps have.
- Epicenter's AppData stays free of data, so deleting it still only resets
  Epicenter's windows.
- The generic views depend on the field vocabulary carrying display information
  for each field type; an app's own views stay richer.

## Considered alternatives

- **Keep the deep link as the only discovery path (decision 81).** Folders made
  before Epicenter was installed stay invisible.
- **List only folders whose names match a known app.** Epicenter would carry a
  table of app names, which ADR-0701 refuses ("Epicenter manages folders, not
  apps"), and folders under other names would never appear.
- **A stored registry of every folder and document.** A second copy of facts
  the three sources already hold, which drifts when a folder moves or an account
  changes.
- **No browser; each app shows only its own data.** Documents would have no
  view outside their app, and the account would have no single place to see
  what it holds.
