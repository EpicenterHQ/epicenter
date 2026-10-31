# 0672. Native app defaults are fixed reverse-DNS children of one library

- **Status:** Proposed
- **Date:** 2026-10-22
- **Related proposal:** [Launcher grouping by pin, library membership, and recency](0679-the-launcher-groups-folders-by-pin-library-membership-then-recency.md) changes navigation preferences, leaving this allocation policy unchanged. Its pins and recents are unbuilt; the bookmark-based listing described here is the current implementation.
- **Amended by:** [ADR-0701](0701-apps-run-as-separate-programs.md) at standalone app defaults: an app on `epicenter-standalone` keeps its data in `~/Epicenter/<productName>`; the library's reverse-DNS defaults remain for Epicenter's records only, since Todos moved onto `epicenter-standalone` too.
- **Amends:** [ADR-0670](0670-native-shells-share-explicit-machine-local-app-homes.md) by replacing saved app-home selection with fixed defaults, and [ADR-0671](0671-the-launcher-lists-directories-from-all-current-references.md) by removing selected homes as a listing source.

## Context

Native shells shared `DesktopPaths` and stored per-app absolute paths in
`homes` in AppData's `folders.json`. The first ordinary launch saved its
selection, later launches remained anchored to it, and the Home Folders menu
changed that selection for both standalone and hosted Todos. These choices
supported launching Todos directly into an arbitrary directory such as
`~/Code/Todos`, but required selection, persistence, recovery, and relocation
rules for every app.

The simpler product gives each app a predictable default while retaining
explicit opening of other folders in Epicenter. Arbitrary directories remain
ordinary files that more than one app can use. A reverse-DNS default name
reduces clashes with user-created names without claiming exclusive ownership.

## Decision

**Every native app derives its ordinary launch directory from one library
root and its permanent reverse-DNS identifier.**

The release root is `~/Epicenter`; development uses `~/Epicenter Dev`.
`EPICENTER_FOLDER_DIR` remains a startup override for the complete library,
shared by the shell and its CLI. Changing it selects another library and
moves no files. The fixed children are:

```txt
<library>/
  so.epicenter/              Epicenter records
  so.epicenter.todos/        Todos
  so.epicenter.capture/      Capture
  so.epicenter.honeycrisp/   Honeycrisp
  so.epicenter.whispering/   Whispering
  so.epicenter.messages/     Messages
```

Standalone Todos and hosted Todos use the same shared native path policy:
one table of these six defaults serves both shells, and it enforces unique
identifiers. Display titles are independent of these identifiers and cannot
redirect storage. Managed default directory names are fixed; locating a
renamed default is not a launch feature.

**An ordinary launch creates a missing default directory and reuses an
existing directory without an ownership claim.**

Reusing a directory preserves unrelated files. Ordinary apps may deliberately
share a directory. A file at the destination fails through the existing
directory-opening error path; no numbered alternative, ownership manifest,
or collision registry is allocated. Real-directory admission, canonicalization,
protected Epicenter records and AppData, save-staging protections, and immutable
window-to-directory binding remain enforced by their existing native owners.

**AppData stores bookmarks, while app defaults are derived rather than saved.**

The `homes` map, first-use path persistence, Home Folders menu, and home-picker
startup recovery are removed. AppData's `bookmarks.json`, a JSON array of
paths that native shells and the CLI change under one shared lock, holds
bookmarks and nothing else. The launcher derives one deduplicated list from
library children, bookmarks, and accepted directories available only for the
current run; an existing default in it is labelled with its app's title.
Explicit folder opening changes the opened window's directory, never the
app's default. Epicenter's own records are always at `<library>/so.epicenter`.

Folder selection is an optional native shell capability, not an app contract.
Epicenter owns Choose Folder for hosted apps. Standalone Todos remains a
single-window app on its fixed default and requires no picker implementation.
Both shells bind the directory before loading the same app page. A future
standalone picker would be a separate product capability, not a requirement
imposed on every app.

**This is a clean break from saved homes.**

No launch or bookmark code reads AppData's `folders.json` or imports its
`homes` selections or shortcuts. Ordinary launch does not search earlier
locations such as `<library>/Todos` or a directory a saved home named. It
opens the fixed default, creating it empty when missing, even where earlier
work exists elsewhere. Existing data is never automatically moved, merged,
or deleted. Earlier work remains ordinary data: the launcher can discover it
as a library child, or open it when the person explicitly chooses its folder.

## Consequences

Normal launch has one shared path calculation and directory-opening rule,
without a per-app path selection or configuration write. Human-readable app
titles remain available in the interface while directory names stay stable.
Moving or deleting a managed default does not update the launch location;
a later ordinary launch creates the missing default again.

The capability withdrawn is remembering an arbitrary external directory as an
app's ordinary launch target. Such a directory can still be opened explicitly
and bookmarked in Epicenter. Standalone Todos opens its fixed default, and
when that fails it names the failure and offers only Quit.

Native shells and the CLI change together and share no configuration format
with earlier builds. Bookmarks saved by an earlier build are not carried
over. A person whose work is in an earlier location opens it explicitly or
moves it themselves; this record authorizes no data migration and no
compatibility reader, guard, or downgrade field.

## Considered alternatives

- **Human-readable default names:** Friendly titles already serve the interface;
  permanent reverse-DNS names provide a namespace without another registry.
- **Configurable homes or remembered-last-folder defaults:** Both retain a saved
  per-app location and the launch behavior this decision withdraws.
- **Exclusive directory ownership or numbered collision allocation:** Ordinary
  directories can be shared, so neither belongs in the allocation policy.
