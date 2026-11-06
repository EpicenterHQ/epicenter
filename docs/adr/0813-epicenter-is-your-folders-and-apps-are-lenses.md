# 0813. Epicenter is your folders, and apps are lenses

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0805](0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md) at "A folder is an Epicenter folder because it holds `epicenter.json`": every directory directly inside `~/Epicenter` is an Epicenter folder, and `epicenter.json` is optional; [ADR-0811](0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) at `epicenter init` making a folder: it adds a contract to one; [ADR-0763](0763-epicenters-doctrine-is-three-roots-and-one-rule-for-apps.md) at its rule for apps: an app is a lens on folders.
- **Relates:** [ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md) and [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) (everything under `~/Epicenter`), [ADR-0812](0812-an-apps-schema-is-a-view-that-must-fit-a-folders-contract.md) (an app's schema is a view), [ADR-0790](0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md) (the library).
- **Unbuilt:** all of it: discovery listing `~/Epicenter`'s directories; the library showing a folder not yet synced and offering to sync it; `epicenter init` adding a contract; the build order below.

## Context

Whispering began as an app that kept its data, and later learned to keep it in
a folder: an app reaching down to a folder. The records since ADR-0802 run the
other way: a folder exists first, holds a person's things, syncs, keeps
history, and is shared, and any app that understands part of it may open it
(ADR-0812). Each question that kept reopening, who owns a folder's contract and
whether an app owns a folder, sat between those two directions. Without spaces,
`~/Epicenter` holds a person's folders and the folders shared with them side by
side, one level deep.

## Decision

**Epicenter is your folders, and apps are lenses.** A folder holds things,
syncs, keeps history, and is shared with people. A lens (an app, the library,
the command line, an agent through `epicenter mcp`) shows and changes the part
of a folder it understands. Lenses come and go; the folder stays.

**Every directory directly inside `~/Epicenter` is an Epicenter folder.** A
person makes one by making a directory there. `epicenter.json` is optional: it
adds a title and a contract when a person wants them, and `epicenter init`
adds a contract to a folder, proposing collections from the files in it.

**A lens remembers a folder by its identity, never its name.** An app's first
run lists the folders whose contract fits its view, and offers to use one or to
make one; making one suggests a name and takes a free one ("Recordings 2") when
it is taken. The app keeps the folder it was given in its own settings, by the
folder's id once it has synced and by its directory's identity before, so a
renamed or moved directory is still found, and no app reserves a name. A
folder with no contract gets one when an app is attached, as the additions the
person accepts (ADR-0812).

**Nothing syncs until a person chooses.** The library shows a folder that has
never synced as such, and its first sync is a person's action, which asks
whether it is a new folder or one they already have.

**Folders are built before lenses.** Folders work end to end with no app first
(syncing, history, sharing, the command line, `epicenter mcp`, and the library
listing them), and apps are then made lenses, Whispering first.

## Consequences

- Making a folder needs no command.
- A folder outside `~/Epicenter` is not an Epicenter folder.
- An app never owns a folder; removing an app leaves its folders as they are.
- The command line and agents are useful on folders before any app is rebuilt.
