# 0629. A local save refuses a file-directory replacement

- **Status:** Proposed
- **Date:** 2026-10-19
- **Amends:** [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) at "the change wins the path" for a local save, retaining that rule for synchronization; [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) at the exhaustive `SaveError` list, adding `Occupied`.
- **Unbuilt:** the public `@epicenter/data` opening API and applications presenting `Occupied`.

## Context

Saving a file named `notes` where `notes/` holds other files cannot preserve
both shapes in Git. The first local implementation removed the folder's
files. Those files might include another tab's acknowledged work that had
never reached Git history. The save's `from` described the one file being
edited and witnessed none of the removed files.

Tables share these paths. Creating row `123` needs the file `todos/123.md`;
a directory placed there through ordinary Git or `files` occupies it. Row
`one.md` also places its attachment folder at the filename of row `one`.
Generated ids avoid that second case, but the library accepts existing data.

On 2026-10-19 the owner chose to fail the save and preserve the occupied
path after reviewing the file-versus-folder example.

## Decision

**A local text save refuses to replace a directory, or to replace an ancestor
file with a directory.** `SaveError.Occupied` names the requested path and
the existing file or directory. The publication changes nothing. One check
under both `files` and tables owns this rule. A directory containing only
names the app cannot decode still occupies its path.

The app retains its draft and can offer another name. Reusing a path requires
an explicit witnessed deletion of the obstructing content. Deleting known
files and then reusing their now-vacant directory path works offline.

Field and paragraph merging stands. Synchronization still resolves Git
file-directory collisions by ADR-0622's change-wins rule. A row delete still
witnesses the row's Markdown source and removes that row and its folder
together; it does not gain a separate attachment-folder witness.

## Consequences

An app handles one more save failure. A local save cannot implicitly erase
an unrelated subtree. No alternate row-id format, conflict file, or
cross-tab owner is needed.
