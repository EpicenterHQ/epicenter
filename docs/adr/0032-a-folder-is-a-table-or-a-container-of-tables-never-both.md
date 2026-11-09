# 0032. A folder is a table or a container of tables, never both

- **Status:** Superseded
- **Superseded by:** [ADR-0534](0534-data-folders-are-the-only-data-model.md), which deletes Matter.
- **Date:** 2026-06-19

## Context

[ADR-0029](0029-matter-json-marks-a-table.md) makes a `matter.json` the table
marker. An early draft of the marker model also made nesting first-class: a
marked folder would be both a table (its own rows) and a container of marked
child tables shown beside it, with reference resolution bounded to one level and
a descend-by-re-rooting UI to reach deeper tables.

But matter's reason to exist is **cross-table references** (`adaptations.page ->
pages`), and references need a **flat, co-resident, closed universe**: every
participating table loaded in one scope. Nesting works against that. Bounding
references to one level **fragments** the reference graph into islands that
cannot see each other, and reaching deeper tables needs a descend UI that is
pure chrome for a capability nothing uses. No real or example vault nests (every
one is an unmarked root of marked leaf tables), and the cases that motivated
nesting all resolve better flat: sibling tables with a foreign key
(`chapters.character -> characters`), co-located independent datasets (open each
as its own vault), or asset bundles (already handled by the marker rule ignoring
unmarked subfolders).

## Decision

A folder is a table **or** a container of tables, never both:

- a **marked** folder IS a single table; its `.md` files are rows and its
  subfolders are ignored (even when themselves marked);
- an **unmarked** folder is a container; its immediate marked child folders are
  the tables, and *their* subfolders are ignored.

Depth is reached by **re-opening the deeper folder**, never by loading two levels
into one scope. The loader and watcher return exactly one of these two sets:
`isMarked(path) ? [path] : [path's marked children]` (`loadPath` in
<!-- doc-path-check: ignore-next-line -->
`packages/matter-core/src/load/fs.ts`, `scan_vault` in
<!-- doc-path-check: ignore-next-line -->
`apps/matter/src-tauri/src/watch.rs`).

The vault view renders that scope as a **flat tab bar** of peer tables. There is
no subtable, no descend affordance, and no scope coordinate in the URL; opening a
different folder is the only way to change which closed universe is loaded.

### References resolve within the one loaded scope

A reference is a **bare table name** that must resolve inside the loaded scope,
which is exactly one of the two sets above:

- References stay bare names. With a single flat scope they are unambiguous and
  **the on-disk `.md` format does not change.**
- A reference whose target is not in the loaded scope is *unevaluable* when the
  scope is a lone table (no sibling tables loaded) and a *dangling-reference*
  failure when sibling tables are loaded (the scope is then the complete, closed
  universe). This reduces to `tables.length === 1` and is the honest replacement
  for the old `scope: 'table' | 'vault'` discriminant. The UI and the CLI use the
  same scope.

## Consequences

Dissolved:

- the "a folder is both a table and a container" case, and with it any descend or
  re-rooting UI;
- the only way a loaded scope could span more than one level, so every view is a
  clean flat reference universe by construction.

No durable content migration: a flat vault validates exactly as before (its root
has no rows; its marked children are the scope).

Cost (the one sharp edge):

- marking a **container** folder silently hides its child tables: matter then
  shows that folder as a single table, and the children must be opened
  individually. This is rare (you do not usually mark a container) and arguably
  correct ("you told me this folder is a table, so I show it as one"), but it is a
  real discontinuity at the marker.

Forecloses references spanning more than one level. If ever needed, that is a
**new ADR introducing path-qualified references** (`pages/intro`), a deliberate
durable-format change.

- **Trigger to revisit:** a real vault needs a row to reference a grandchild or
  cousin table and neither flattening nor opening that folder directly can
  express it.

## Considered alternatives

- **Keep nesting first-class.** Rejected: it fragments the reference graph that
  is matter's entire point, needs a descend UI to be usable, and no vault
  actually nests. The shipped loader was already ~95% the flat model; nesting
  only added the both-at-once case and an unbuilt descent.
- **Whole-subtree reference resolution.** Rejected: forces path-qualified
  references now, or leaves bare names ambiguous across levels. Defer the durable
  change until a real need triggers it.
- **Grouped or indented tabs, or a flat list across all levels.** Rejected: the
  first implies a hierarchy the scope does not have (the tables are reference
  peers); the second dissolves the closed universe, forcing cross-level
  resolution this ADR deliberately excludes. Moot once subtables are gone.
