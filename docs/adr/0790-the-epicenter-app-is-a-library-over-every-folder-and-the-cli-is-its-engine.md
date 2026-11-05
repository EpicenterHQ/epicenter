# 0790. The Epicenter app is a library over every folder, and the CLI is its engine

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0751](0751-every-native-app-carries-one-sync-core.md) at "It runs rounds through the same core, not by starting the CLI": the Epicenter app runs the `epicenter` CLI for every operation, sync included; [ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md) at "generic collection views from the field vocabulary": each collection is a table queried by `select * from <collection> where …`, its cells drawn and edited by its fields' types.
- **Relates:** [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) (folders found by `AGENTS.md` under `~/Epicenter`), [ADR-0727](0727-json-schema-is-the-field-language.md) (fields are JSON Schema), [ADR-0459](0459-sqlite-is-a-local-capability-for-derived-or-transactional-state.md) (SQLite for derived state), [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (speak the standard), [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (no background service), [ADR-0788](0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md) and [ADR-0789](0789-a-conflict-is-a-mark-on-its-note-resolved-in-the-repair-editor.md) (the marks).
- **Unbuilt:** all of it: `epicenter query` with its scope, attached schemas, `invalid` tables, `--json` and `--watch`; `epicenter set`, `edit`, and `delete` with JSON; the library window, its query line, Show SQL, and header sorting; the field-to-component set in `packages/ui`; the health view (sync state, conflicts, notes that do not read, duplicate and mismatched folders); Sync all; installing the command and the browser extension's native host; deleting the Folders window's share, unshare, connect, and background sync, and the parked `dictation` feature.

## Context

Once every app syncs its own folder (ADR-0750, ADR-0751, ADR-0785) and
sharing is team membership (ADR-0770), the Epicenter app's Folders window
and background sync have no job left, and what remains is carrying the
`epicenter` CLI and the extension's native host. Each app shows its own
view of its data. Every folder says what it is: its `AGENTS.md` names a
contract, whose collections and JSON Schema fields describe every note, so
one generic program can open any folder, a third party's included, and know
its shape. The CLI already reads a folder's contract from its `AGENTS.md`
and checks its notes (`epicenter check`, over `@epicenter/folder/node`), and
Bun carries SQLite.

## Decision

**The Epicenter app is the library: it shows everything your apps keep, as
it really is, and lets you query and fix it.** Its window lists every folder
under `~/Epicenter` by team, shows each collection as a table, and gathers
what needs a look: each folder's sync state, conflicts (⚠), notes that do
not read, and duplicate or mismatched folders (ADR-0772). It offers Sync
all, and installs the `epicenter` command and the browser extension's
native host.

**The CLI is the engine, for people, agents, and the library alike.**

```sh
epicenter query "select * from todos where done = false"     # the folder you are in
epicenter query --all "select r.title, t.title from whispering.recordings r
                       join todos.todos t on t.source = r.name"
epicenter query --json --watch "select * from todos"
epicenter set todos todos call-dentist --json '{"done": true}'
```

- `epicenter query` runs on the folder it is in, found by walking up to an
  `AGENTS.md` that names a contract, as Git finds a repository; on the
  folders named by path; or with `--all`, on every folder under
  `~/Epicenter`.
- Each folder in scope is attached as a SQLite schema named by its folder,
  so one folder's tables are plain (`todos`) and several are qualified
  (`whispering.recordings`); joins across apps are SQLite's own.
- Each collection is a table: a column per field, plus the note's `name`
  and `body`. Lists and objects are JSON. Each folder's notes that do not
  read are its `invalid` table: path, collection, issues, and text.
- The tables are built in memory from the files on every run and never
  stored; `--watch` keeps one run's tables and answers again on each change.
- `epicenter set`, `edit`, and `delete` write through the folder engine, so
  a write is checked against the contract and settled as sync settles it.

The library runs these as child processes for as long as its window is open;
it holds no engine of its own, and runs `epicenter sync` as a terminal does.

**The library's query is `select * from <collection> where …`.** The person
fills in the blank, with field names and values suggested from the
contract; a column header sorts, adding `order by`; Show SQL reveals the
whole line. Every row is one note and every column one field, so every cell
is drawn by its field's type and edited in place: a checkbox, a date
picker, a select, a link to another note. A row opens in its app or a text
editor. A note that does not read shows Repair, and a conflict ⚠, both in
the repair editor. Joins, grouping, and computed columns are the CLI's.

## Consequences

- One query language, SQL, for people, agents, and scripts; a person writes
  only the condition.
- A new app gets a working table of its data, and every app can use the
  field components for its own forms.
- The library has no engine to keep in step with the CLI.
- A process boundary and JSON stand between the window and the data;
  tables are rebuilt on change, a few hundred milliseconds for thousands of
  notes.
- SQLite's loose types meet YAML values: lists are queried with `json_each`,
  and dates are ISO text.

## Considered alternatives

- **No Epicenter app; Finder is the library.** Nothing to double-click, and
  nowhere a person sees every app's data or what needs a look.
- **One app holding the others (reversing ADR-0701).** One sign-in and one
  core, and no app ships or fails alone.
- **The engine in the Rust core, linked into the library.** No process
  boundary, but contracts and validation would be needed in Rust as well.
- **A full query editor in the window, with joins and grouping.** Results
  whose rows are not notes cannot be edited, so the window would hold two
  kinds of table.
