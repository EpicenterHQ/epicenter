# 0679. The launcher groups folders by pin, library membership, then recency

- **Status:** Proposed
- **Date:** 2026-10-22
- **Amends:** [ADR-0671](0671-the-launcher-lists-directories-from-all-current-references.md) at its listing sources, ungrouped presentation, and Forget bookmark action; [ADR-0641](0641-epicenter-remembers-folders-as-machine-local-paths.md) at its single remembered-path list and explicit-add workflow.
- **Relates:** [ADR-0537](0537-epicenter-opens-to-your-folders-and-home-becomes-settings.md) retains the Folders launch window and separate Settings window. The [fixed-default policy draft](0672-native-app-defaults-are-fixed-reverse-dns-children-of-one-library.md) addresses allocation independently of this navigation proposal.

## Context

The earlier launcher remembered an outside folder after an accepted handoff
or an explicit `epicenter folders add`. Choose Folder opened without remembering.
The same bookmark list therefore mixed a deliberate shortcut with the history
of an opening. Asking everyone to pin a folder merely to find it again would
make navigation another task.

The launcher also discovers the library's direct children. That discovery
makes a default created by standalone Todos visible without registration.
Outside folders need saved references because their locations cannot be
derived from the library. These are different sources of information.

## Decision

**Start with a compact, single-column launcher and three folder groups.**

| Group, in display order | Membership |
| --- | --- |
| Pinned | Folders explicitly pinned by the person. |
| Epicenter | Remaining visible direct children of the library root. The heading follows the library's name, such as Epicenter or Epicenter Dev. |
| Recent | Remaining outside folders opened successfully, newest first. |

A folder appears once: Pinned takes precedence over library membership,
which takes precedence over Recent. References merge by resolved directory
and OS identity, retaining ADR-0671's derived row IDs and fresh membership
checks. Titles never identify folders. Listing allocates nothing.

**Pins target folders only.** A person may pin any listed folder, including
an app's default. Files are not pin targets. There is no separate container
entity or app-owned folder registry. Apps remain ways to open a folder; a
pin identifies the directory rather than a folder-and-app pair.

Pinning is optional and never a side effect of opening. Unpinning removes
only that preference; library discovery or retained recent history may still
show the folder. A pin does not grant filesystem access or choose a default.

**Successful openings record recency automatically.** Epicenter records a
folder after opening or revealing an app or editor window through an app
launch control, listed row, Choose Folder, or accepted handoff. Receiving a
handoff, listing, refused or failed openings, and edits within a window record
nothing. Recent history is bounded; older entries age out without affecting pins.

Remove from Recents removes only the history entry. Neither removal nor aging
out hides a library child or a pin. Missing pinned and recent folders remain
visible with an availability problem while retained, and remain removable.
Explicit row opening never recreates a missing directory. If recording fails,
the successful opening stays open, the failure is reported, and a temporary
row lasts for this run.

**Navigation preferences change no launch default or window binding.**
Opening `~/Code/different` with Todos places it in Recent. Normal Todos launch
continues to open `~/Epicenter/so.epicenter.todos`. Pinning, unpinning, and
history removal move no files and leave existing windows and drafts alone.
App launch controls remain available independently of the discovered folders.
Apps, folder editors, and Settings continue to use separate native windows.
This direction introduces no embedded app switcher or permanent inspector pane.

Pins and recent history are machine-local preferences shared by Epicenter and
its CLI. Library membership is read from disk. The existing bookmark array
does not prove pin intent and is not relabeled as pins. The breaking reset
removes obsolete `bookmarks.json` under its old save lock without parsing it,
following a symlink, or deleting a referenced folder. Pins and Recent start
empty. The shared replacement is `navigation.sqlite`, one host-owned database with
independently keyed `pins(path)` and `recent(path, sequence)` tables. Both
runtimes validate application ID `EPNV`, schema version 1, and the same strict
schema inside a transaction. The single database gives a consistent combined
read and serialized writes without snapshot replacement. Successful openings
advance a sequence and prune Recent to 20 in an immediate write transaction.
The CLI exposes `folders pin|unpin|list|remove-recent`. Both writers use a
10-second busy timeout and SQLite's DELETE rollback journal. They refuse
foreign, future, corrupt, and non-DELETE databases rather than migrating
them. Stray `navigation.json` files are ignored. The earlier `folders.json`
and app-scoped device storage remain separate and untouched.

## Consequences

Outside work can be found again without managing shortcuts. Pins express
lasting intent; recency records use; library membership reflects location.
Their display precedence prevents duplicates without making them the same fact.
The persistent information locates folders but does not register or own them.

## Considered alternatives

- **Require pinning to remember outside work:** adds a separate decision to every opening.
- **Recent history only:** important outside folders eventually age out.
- **Sidebar and inspector:** reserve permanent space for selection when the initial job is launching windows. Revisit if browsing or previewing earns that pane.
- **App-first navigation:** makes shared and plain folders harder to represent and suggests apps own their data locations.
- **File pins or a new container object:** add target types without serving this folder-opening workflow.
