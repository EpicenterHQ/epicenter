# 0538. An app opens any folder whose declaration contains its shape

- **Status:** Accepted
- **Date:** 2026-10-15
- **Amended by:** [ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md) at the consequence that the Folders window derives "Open in" from the shapes of installed apps: it offers every installed app on every folder, and the app's lens refuses one that does not fit.
- **Built:** the `lens` option of `openDataFolder` in every entry, refused with `ShapeMismatch` and its problems when the folder's declaration does not contain it; the containment check (`shapeProblems` and `schemaContainment` in `@epicenter/definition`); a lens table's `canCreate` and `CannotCreate`; installed apps ([ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md)) offered on every folder (`apps/epicenter/src/folders/openers.ts`), each handed that folder at launch as `?folder=<scope>`, Todos, Capture, Honeycrisp, and Whispering refusing through their lens a folder that does not contain their shape, naming the folder and what is missing ([ADR-0560](0560-an-apps-manifest-only-names-it-and-every-installed-app-is-offered-on-every-folder.md)).
- **Unbuilt:** showing an app that cannot add rows as able to edit only.

## Context

A folder's `epicenter.json` declares its tables and settings
([ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md)). Today the
only link between an app and a folder is a name: the folder
`so.epicenter.todos` belongs to the app whose id is `so.epicenter.todos`, and
Epicenter hard-codes that pairing for Todos and Capture in `APPLICATION_FOLDERS`
(`apps/epicenter/src-tauri/src/data_folders.rs`). An app that opens a folder
with `openFolder({ id, definition })` publishes its definition to that folder's
`epicenter.json`, so a second app opening the same folder that way would replace
the first app's schema with its own.

## Decision

**A folder names no app.** Nothing in `epicenter.json` refers to an app, and a
folder stays readable and editable after every app that wrote to it is gone.

**An app declares the shape it opens: the tables and fields it reads.** The
shape is a folder definition, the same thing `defineFolder` makes.

**An app can open a folder when the folder's declaration contains the app's
shape.** For every table in the shape, the folder declares a table of that name;
for every field the shape reads, the folder declares that field with a schema
the shape's field accepts. The folder may declare more tables and more fields;
the app does not see them and keeps them on write, as `Row` keeps unknown keys
today. An app whose shape names only `title: string` opens nearly every folder,
and that is intended.

**An app may add rows only when it also knows every field the folder requires.**
Otherwise it edits existing rows and the Folders window shows it as able to
edit, not to add.

**The app that creates a folder owns its schema; every other app opens it with
a lens.**

| Opener | Who calls it | Publishes `epicenter.json` |
| --- | --- | --- |
| `openFolder({ id, definition })` | The app whose folder this is, creating it on first write | Yes, when its bytes differ |
| `openDataFolder({ id, lens: definition })` | Any other app whose shape the folder contains | Never |
| `openDataFolder({ id })` | A view that reads the schema it finds (the Folders window) | Never |

`openDataFolder({ id, lens })` refuses a folder whose declaration does not
contain the lens, and otherwise returns tables typed by the lens.

## Consequences

- Apps compose without knowing about each other: a board that reads `title` and
  `status` opens Todos's folder and any other folder of that shape.
- No registry of which app owns which folder is needed for opening. The Folders
  window derives "Open in" from the shapes of installed apps
  ([ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md)).
- Containment is checked per field schema. Two schemas that mean the same thing
  but are written differently can fail to match; the app widens its shape.

## Considered alternatives

- **Match by id**, the folder tagged with what it is and apps listing tags they
  open. Exact, but closed: an app opens only what someone tagged in advance. A
  tag used only for ranking was also rejected; matching by shape alone is
  enough.
- **Match by a hash of `epicenter.json`.** One added field breaks every match.
- **A byte-identical typed lens**, as ADR-0535 first deferred it. It refuses
  every app whose shape is smaller than the folder's, which is the case
  composition exists for.
