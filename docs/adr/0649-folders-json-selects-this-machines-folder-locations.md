# 0649. Folders.json selects this machine's folder locations

- **Status:** Proposed
- **Date:** 2026-10-20
- **Amends:** [ADR-0641](0641-epicenter-remembers-folders-as-machine-local-paths.md) at the array format and list-only purpose of `folders.json`; [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) at identifying Epicenter's portable records by the fixed directory name `so.epicenter`; [ADR-0647](0647-a-native-window-edits-one-directory-bound-before-it-exists.md) at Settings' fixed records path and name-based descriptions of protected roots. Window binding and admission checks remain.
- **Unbuilt:** a UI for choosing or relocating Epicenter's records folder and coordinated changes of that selection while Settings is open.

## Context

The desktop stored an array of added paths in AppData's `folders.json`.
Settings and connection commands separately constructed
`<folder root>/so.epicenter`. The launcher identified that folder by name,
and Git's nested-repository exception used the same naming convention.

Epicenter's records are ordinary portable files. Their directory name must
not determine their role. This machine needs one address for those files,
alongside the paths it already remembers for opening.

## Decision

**AppData's `folders.json` contains `epicenter` and `folders`.**

```json
{
  "epicenter": "/Users/braden/Epicenter/My setup",
  "folders": ["/Users/braden/Code/vault"]
}
```

`epicenter` is an absolute directory path, or `null` before this installation
has selected its records folder. `folders` is the ordered list of added
paths. Neither field contains an app ID, portable folder ID, remote URL,
or filesystem permission. Direct children of the authored folder root are
discovered by scanning; adding them to this file is unnecessary.

**The desktop and CLI edit the same file under the same save lock.**
Both resolve AppData through `EPICENTER_DATA_DIR`, with their existing
platform default when unset. Read/change/replace holds the exclusive SQLite
transaction on `.folders.json.epicenter-save-lock` beside the file. Writers
read after taking the lock and replace the file through a staged rename.
An absent configuration reads as `{"epicenter": null, "folders": []}`
without writing anything. Malformed or unsupported content stays intact
and produces a repairable error.

`epicenter folders add <directory>` checks an existing directory and adds
its absolute path once. Relative input resolves against the command's
working directory. `list` reports added paths and their availability;
`--json` also includes the selected `epicenter` path. `forget <directory>`
removes the matching shortcut, even when it is missing or malformed.
Forgetting changes neither the selection nor any files, Git configuration,
or open editor. A folder beneath the scanned root remains discoverable
after its shortcut is forgotten.

The launcher observes external changes to the file. Successfully persisted
shortcuts have no second in-memory list. Only an accepted opening whose
persistence failed retains a temporary shortcut for this run.

**A selected records directory has its role independently of its name.**
Settings opens `epicenter`, connection commands read and write there, and
the launcher and native opening rules identify that directory by location.
The Git exception for Epicenter's records follows the same location.

Before selection, the initial default remains `<folder root>/so.epicenter`
to preserve existing records. First opening Settings or saving a connection
creates that default if needed and stores its selection under the config
lock. Adding or listing a shortcut selects nothing. Once a selection is
stored, a missing directory is reported and never replaced with a fresh
default. Its source path remains editable in `folders.json`.

Until a selection UI exists, changing the records location requires quitting
Epicenter, moving or locating the records as needed, editing `epicenter`,
and reopening. Existing window bindings do not retarget when the file is
edited. An unusable configuration does not block access to unrelated data
folders; the configuration error stays visible and Settings cannot open a
substitute location.

**The configuration stays on this machine.**
The selected folder holds portable records and can use its own Git remote.
Each computer records the path of its own checkout. Credentials, caches,
model files, and unrelated device settings keep their existing owners.

## Consequences

- One existing local file gains one pointer. No folder registry, profile
  object, per-folder role marker, or separate pointer file is introduced.
- Existing desktop path arrays remain readable without modification. The
  next real update converts them to the object shape while preserving every
  path. Older clients refuse the object instead of overwriting it.
- `so.epicenter` remains a default spelling, so existing files do not move.
  A folder with that name loses special treatment when another location is
  selected.
- CLI and native writers take turns without a daemon. A missing shortcut
  can be removed without resolving or recreating its target.
- An out-of-app move requires repairing this computer's selected path.
  The other devices' paths and the Git remote remain unchanged.

## Considered alternatives

- **Reserve `so.epicenter` forever.** Couples automatic discovery and native
  opening policy to a directory name that a person can change externally.
- **One entry with an Epicenter-role flag in the path list.** Adds a record
  shape and an exactly-one-role rule to every remembered path.
- **Synchronize `folders.json`.** Copies one machine's absolute paths onto
  machines where those directories may not exist.
- **Put all device state in this file.** Couples folder selection to
  unrelated credential, model, cache, and window lifetimes.
