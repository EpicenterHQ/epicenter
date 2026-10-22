# 0670. Native shells share explicit machine-local app homes

- **Status:** Accepted
- **Date:** 2026-10-22
- **Amended by:** [ADR-0672](0672-native-app-defaults-are-fixed-reverse-dns-children-of-one-library.md) replaces saved app-home selection with fixed reverse-DNS defaults in the current implementation.
- **Amends:** [ADR-0660](0660-native-apps-default-authored-work-to-the-epicenter-root.md)'s permanent default-child allocation and [ADR-0649](0649-folders-json-selects-this-machines-folder-locations.md)'s records-only selection.

## Context

Standalone Todos and Todos inside Epicenter must reopen the same work. A
shared initial root alone cannot remember a deliberate choice such as
`~/Code/different`. Independently remembering that choice in each shell
would recreate two defaults. Putting local paths in portable records would
also require finding those records before reading their own location.

## Decision

The folder plugin's shared native `DesktopPaths` resolves Epicenter's
machine-local configuration directory for either shell. Release uses the
`so.epicenter` scope and development uses `so.epicenter.dev`. A nonempty
absolute `EPICENTER_DATA_DIR` overrides that shared location. Standalone
Todos does not require Epicenter to be installed.

`folders.json` contains `homes`, a map from stable application keys to
absolute selected paths, and `folders`, the existing shortcut list. The
`epicenter` home locates portable records; `todos` locates Todos work. Both
follow the same allocation rule in `epicenter-folder-core::homes`:

1. Without a selection, ordinary launch suggests the app's durable child
   name under the authored root, creates it if missing, and saves its
   canonical path under the configuration lock.
2. With a selection, ordinary launch requires that directory to exist.
   Changing the authored root does not redirect selected homes.
3. Explicit home selection requires an existing directory. It changes
   future launches, moves no files, and changes no existing window binding.
4. A chosen one-time launch target does not change the home. Invalid or
   occupied non-directory targets fail without allocating another name.

The native **Home Folders** menu provides selection in both shells through
one picker and configuration operation for ordinary apps. Standalone startup
can recover a missing home by selecting an existing directory. Epicenter's
records are excluded from this menu: Settings keeps a lifetime binding while
CLI operations locate records afresh. Records relocation remains a quit-first
manual operation until those owners can change together.

The shared save lock covers read, selection, and atomic configuration
replacement. Concurrent launches choose one home. Shortcut writers preserve
every home. Previous shortcut arrays and the previous `epicenter` selection
are read without rewriting; a real change writes the new shape while
preserving the selected records path and shortcut spellings. The CLI
understands both formats and preserves the map.

Home allocation remains native shell policy. The page still calls
`openFolder({ tables })` over its window's lifetime directory, and receives
no root-selection API. Selected Epicenter records and their save staging
folder stay protected from ordinary app-home selection. Both an app's directory
and its sibling staging directory are checked against those locations and
machine application data. No authored window root may be a save staging
directory or its descendant: components matching `.*.epicenter-scratch` are
reserved, regardless of letter case.

Before a records selection exists, an existing conventional records directory
remains protected for older installations. A saved app home takes precedence
over that fallback, so changing the discovery root cannot manufacture a
records reservation inside existing work. Records allocation still refuses
actual conflicts with saved app homes.

## Consequences

There is one home per app per storage environment, regardless of which
shell opens it. The authored root supplies suggestions and discovery; it
does not own every possible data folder. Per-app AppData remains available
for private runtime state, while shared location choices live outside the
portable files they locate.

An existing directory at the suggested path is deliberately reused. Home
selection is not a command to create an independent dataset or to migrate
one. People move or copy their files explicitly before selecting that
directory. Homes can share an ordinary data directory, but app homes cannot
overlap Epicenter's protected records or application data, including through
the staging directories used for saves. A later discovery root does not veto
a saved home, even when it is inside that home. Actual home conflicts still
fail without changing configuration or files.
