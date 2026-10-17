# 0029. A matter.json marks a table; matter is a declared store, not a discovered lens

- **Status:** Superseded
- **Superseded by:** [ADR-0534](0534-data-folders-are-the-only-data-model.md), which deletes Matter.
- **Date:** 2026-06-19

## Context

matter classified folders by shape (a folder of files was a table, a folder of
folders was a vault), and a folder with no `matter.json` was a valid untyped
table. Every shape-based rule hit one irreducible ambiguity: a `.md` next to a
subfolder could be a data row or a document, and a subfolder could be a table or
an attachment bundle. Shape cannot tell them apart, so every variant either
silently dropped rows (the asset-folder bug, where `pages/` with image
subfolders vanished its `.md`) or turned a root `README.md` into a row.

## Decision

A folder is a table **if and only if it contains a `matter.json`.** The marker is
the declaration; matter never guesses a table from shape.

- A marked folder's `.md` files are its rows.
- An unmarked folder is not data. It is ignored (an attachment bundle, a junk
  dir, a purely organizational folder).
- Contract semantics (what the marker's contents say about typing):
  - `matter.json` with a non-empty `fields` map → a **typed** table;
  - `matter.json` that declares no fields (`{}`, `{"fields":{}}`, or any object
    without a non-empty `fields` map) → an **untyped** table (the raw grid,
    columns from frontmatter). `{}` is the canonical untyped-table marker. A
    table is typed only when it declares at least one field, so there is no
    strict zero-field table and no permissive-vs-strict flip on the `fields` key;
  - unparseable `matter.json` → a table whose contract is broken, surfaced as
    `invalid-contract` (still a claimed table, not "not a table");
  - no `matter.json` → **not a table.**

This redefines matter as a **declared store**, not a lens that auto-discovers
tables in arbitrary markdown. Whether a path is a single table or a container of
tables, and how references resolve across the loaded scope, are governed by
[ADR-0032](0032-a-folder-is-a-table-or-a-container-of-tables-never-both.md).

## Consequences

Dissolved, not relocated:

- the table-vs-vault shape guess;
- the "is this `.md` a row or a document" ambiguity;
- the "is this subfolder a table or an attachment" ambiguity;
- the silent `.md`-drop footgun class.

matter asks instead of guessing.

Cost:

- matter no longer auto-discovers tables in un-annotated markdown. Point it at an
  existing Obsidian vault or docs repo and it shows nothing until each folder is
  adopted (one `matter.json` apiece). This is the deliberate price of removing
  the ambiguity, mitigated by an "adopt folder as table" affordance that writes
  `{}`; untyped raw grids survive through that same `{}`.

Migration:

- existing untyped tables (no `matter.json`) must gain a `{}` marker. In-repo
  that is only the `missing-model` fixture; every example table already declares
  `fields`.

Reverses:

- the "altitude is pure shape" direction.

## Considered alternatives

- **Fix the classifier (a subfolder counts as a table only if it contains
  `.md`).** Keeps zero-ceremony discovery, but retains a narrow silent drop and
  cannot express intent. Rejected once matter became a declared store.
- **Full collapse (a folder is both a table and a vault, shape-driven).** Never
  drops a `.md`, but turns a root `README.md` into a row and shows attachment
  folders as empty tables. Rejected: relocates the ambiguity instead of removing
  it.
- **Dotfolders only (no model change).** Zero code, but the silent `.md`-drop
  persists for anyone who does not know the convention. Rejected.

Stop-and-confirm: this removes the "works on any folder of markdown" promise.
Confirmed by the user on 2026-06-19.
