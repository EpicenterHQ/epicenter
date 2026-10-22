# 0671. The launcher lists directories from all current references

- **Status:** Accepted
- **Date:** 2026-10-22
- **Amended by:** [ADR-0672](0672-native-app-defaults-are-fixed-reverse-dns-children-of-one-library.md) removes selected homes as a listing source while retaining library children and bookmarks in the current implementation.
- **Amends:** [ADR-0537](0537-epicenter-opens-to-your-folders-and-home-becomes-settings.md)'s root-only listing, [ADR-0641](0641-epicenter-remembers-folders-as-machine-local-paths.md)'s separate remembered-folder surface, and [ADR-0670](0670-native-shells-share-explicit-machine-local-app-homes.md)'s discovery experience.

## Context

A home selected outside the authored root opened correctly from an app's
Open button but did not appear among the launcher's root children. A
bookmark to the same directory appeared separately. The directory's source
determined how to find and open it, even though all these references locate
ordinary files.

## Decision

The launcher derives one list from root children, selected homes, bookmarks,
and this-run acceptances whose persistence failed. Resolved paths and OS
directory identity merge references to the same directory. Display titles
and leaf names do not identify a row. Each row shows the resolved path and
the apps whose home references it. Missing homes and bookmarks stay visible
with an availability problem and are never recreated by listing or opening.

A native row ID is a full SHA-256 digest of its representative resolved
path. It is derived for the response and stored nowhere. An opening passes
that ID; Rust rebuilds membership and checks the directory before binding
the editor or app window. Arbitrary paths, labels, and stale rows cannot
select another folder. The bound canonical directory must still produce
the same ID. Existing app-window identity and protected-record checks remain.

Forget bookmark removes the original bookmark spellings merged into the
row and matching temporary acceptances. Root discovery and home selections
are independent references, so the folder remains visible if either still
includes it. Open windows retain their directories and unfinished input.

Editor availability and protection from ordinary apps are separate facts.
Records and directories containing them remain editable, while ordinary apps
cannot open them. AppData remains unavailable to both, even if hand-edited
configuration calls it the records home. Both admissions include save staging
directories.

Root and configuration changes invalidate the combined listing.
Startup attempts to create and watch the discovery root, but a failure does
not prevent configuration watching or opening saved references elsewhere. Pending
handoffs remain a separate acceptance workflow; receiving or dismissing
one reads none of its folder's files. Accepting invalidates the list. Focus
refreshes metadata and availability for directories outside the root.

Home keys and folder-row IDs serve different purposes. The stable `todos`
home key identifies one built-in application across its standalone and
hosted shells. The closed bundled-app table must have unique home keys and
initial folder names, checked against Epicenter's reserved home key. Display
names need no global identity system. A third-party application registry
would require a separately designed publisher namespace; none is added here.

Selected homes remain anchored when the authored root changes. The list
follows those saved references and does not derive replacement homes under
the new root.

## Consequences

There is one listing, one editor-opening route, and one membership check for
all sources. The previous remembered-folder listing and reopening commands
are removed. No persisted folder catalog, copied home bookmarks, folder
UUIDs, or allocation ledger is needed. The remaining stored information is
the home choice or explicit bookmark that already carries user intent.
