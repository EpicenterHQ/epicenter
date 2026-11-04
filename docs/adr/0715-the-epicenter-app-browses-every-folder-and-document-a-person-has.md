# 0715. The Epicenter app browses every folder and document a person has

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Amends:** [ADR-0701](0701-apps-run-as-separate-programs.md) at decision 81 ("Epicenter learns of a folder only through Sync with Epicenter's deep link"): Epicenter also lists the library root's folders; and at the 2026-11-01 revision that deleted the folder editor window ("Epicenter opens no folder's files"): Epicenter shows a folder's or document's items again; [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) at deferring the desktop data browser.
- **Amended by:** [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) at `epicenter.root` marking a synced folder and at the deep link's `path` and `contract`: a folder at its derived path carrying `epicenter.synced` is synced, and both parameters follow from the app's site; [ADR-0736](0736-a-folder-outside-the-library-is-enrolled-through-a-link-the-person-names.md) at "'Add folder…' runs `epicenter link`": the person confirms the link's name, and the name has a space so no app could claim it.
- **Amended by:** [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) at the document store: the folder is the only kind of store.
- **Unbuilt:** the library-root scan that follows links; "Add folder…" running `epicenter link`; the account's repository and document lists in the Folders window; generic collection views from the field vocabulary; opening documents through `~/.epicenter/documents`; removing the line in `apps/epicenter/AGENTS.md` that conflicts ("Epicenter opens no folder's files").

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

The Folders window shows one list built from two sources. Each source is a
different fact, and neither is copied into the other:

| Source | Fact | Read from |
| --- | --- | --- |
| it is on this machine | a non-hidden child of `~/Epicenter`, followed when it is a link to a folder elsewhere ([ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md)); synced when it is a repository whose local configuration carries `epicenter.root`, otherwise "Not synced" | a directory listing, never stored |
| it is on the account | a repository or document the signed-in account can reach | the server's repository and document lists ([ADR-0708](0708-a-namespace-holds-documents-beside-repositories-under-one-resource-grant.md)) |

- **A folder under the root that is not synced shows as "Not synced".**
  Enrolling it takes the person's confirmation in Epicenter's consent screen.
  Listing makes no ownership claim.
- **"Add folder…" runs `epicenter link`,** which puts a link to a folder from
  anywhere inside the root; forgetting it removes the link and leaves the
  files. The `epicenter://init` link stays as an app's way to ask for a first
  sync.
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

No registry is stored. The window joins the directory listing and the
account's lists by name each time it lists.

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
  the directory listing and the account already hold, which drifts when a
  folder moves or an account changes.
- **No browser; each app shows only its own data.** Documents would have no
  view outside their app, and the account would have no single place to see
  what it holds.
