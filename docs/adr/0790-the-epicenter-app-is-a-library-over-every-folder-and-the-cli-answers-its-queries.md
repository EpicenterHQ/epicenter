# 0790. The Epicenter app is a library over every folder, and the CLI answers its queries

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md) at "generic collection views from the field vocabulary": each collection is a table filtered by `select * from <collection> where …`, its cells drawn and edited by its fields' types.
- **Relates:** [ADR-0751](0751-every-native-app-carries-one-sync-core.md) (the library links the core like every app), [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) (folders found by `AGENTS.md` under `~/Epicenter`), [ADR-0727](0727-json-schema-is-the-field-language.md) (fields are JSON Schema), [ADR-0459](0459-sqlite-is-a-local-capability-for-derived-or-transactional-state.md) (SQLite for derived state), [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (speak the standard), [ADR-0778](0778-a-page-connects-once-and-then-reads-synchronously.md) (a page's folder), [ADR-0788](0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md) and [ADR-0789](0789-a-conflict-is-a-mark-on-its-note-resolved-in-the-repair-editor.md) (the marks).
- **Amended by:** [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) at the library asking `epicenter query` for names: it builds the same tables in its own page and neither runs nor carries the CLI.
- **Amended by:** [ADR-0801](0801-records-from-0763-to-0800-agree-on-the-merge-rust-patching-marks-and-agents.md) at `epicenter set` writing through the folder engine: it is a patch.
- **Amended by:** [ADR-0815](0815-the-platform-gives-a-window-its-folder-and-every-app-the-same-home.md) at the library as an app of its own: it is the platform's home with a lens over any folder.
- **Amended by:** [ADR-0816](0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md) at "the library": the app is called Epicenter.
- **Unbuilt:** all of it: `epicenter query` with its scope, attached schemas, `invalid` tables, `--json` and `--watch`; `epicenter set`, `edit`, and `delete` with JSON; the library opening a folder with a contract read from its `AGENTS.md`; its query line, Show SQL, and header sorting; the field-to-component set in `packages/ui`; the health view (sync state, conflicts, notes that do not read, duplicate and mismatched folders); Sync all; installing the command and the browser extension's native host; deleting the Folders window's share, unshare, connect, and background sync, and the parked `dictation` feature.

## Context

Once every app syncs its own folder (ADR-0750, ADR-0751, ADR-0785) and
sharing is team membership (ADR-0770), the Epicenter app's Folders window
and background sync have no job left, and what remains is carrying the
`epicenter` CLI and the extension's native host. Each app shows its own
view of its data. Every folder says what it is: its `AGENTS.md` names a
contract, whose collections and JSON Schema fields describe every note, so
one generic program can open any folder, a third party's included, and know
its shape. The CLI already reads a folder's contract from its `AGENTS.md`
and checks its notes (`epicenter check`), and Bun carries SQLite. Every app
already shows and edits notes in its page through `@epicenter/folder`, with
a replica, ordered writes, `invalid()`, and `NoteRepair`, and every desktop
app links the sync core through its shell.

## Decision

**The Epicenter app is the library: it shows everything your apps keep, as
it really is, and lets you query and fix it.** Its window lists every folder
under `~/Epicenter` by team, shows each collection as a table, and gathers
what needs a look: each folder's sync state, conflicts (⚠), notes that do
not read, and duplicate or mismatched folders (ADR-0772). It offers Sync
all, and installs the `epicenter` command and the browser extension's
native host.

**The library is an app built like the others.** Its page opens a folder
with `@epicenter/folder`, over a contract read from the folder's
`AGENTS.md`, and shows and edits its notes through that folder: edits land
at once, notes that do not read show Repair, and conflicts show ⚠, both in
the repair editor. Its shell links the sync core and syncs every folder at
the moments every app does (ADR-0750).

**The CLI answers queries, for people, agents, and the library.**

```sh
epicenter query "select * from todos where done = false"     # the folder you are in
epicenter query --all "select r.title, t.title from whispering.recordings r
                       join todos.todos t on t.source = r.name"
epicenter query --json --watch "select name from todos where due < date('now')"
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
  an agent's write is checked against the contract and settled as sync
  settles it.

**The library's query is `select * from <collection> where …`.** The person
fills in the blank, with field names and values suggested from the
contract; a column header sorts, adding `order by`; Show SQL reveals the
whole line. The library asks `epicenter query --json --watch` for the names
the condition matches and shows those notes from its folder, so every row
is one note and every column one field, every cell is drawn by its field's
type and edited in place: a checkbox, a date picker, a select, a link to
another note. A row opens in its app or a text editor. Joins, grouping, and
computed columns are the CLI's.

## Consequences

- One query language, SQL, for people, agents, and scripts; a person writes
  only the condition.
- The library shares the folder engine and the sync core with every app, so
  it has no engine of its own to keep in step; the CLI holds the only query
  implementation.
- A new app gets a working table of its data, and every app can use the
  field components for its own forms.
- A filter waits on a process answering over JSON; an edit does not. Tables
  are rebuilt on change, a few hundred milliseconds for thousands of notes.
- SQLite's loose types meet YAML values: lists are queried with `json_each`,
  and dates are ISO text.

## Considered alternatives

- **No Epicenter app; Finder is the library.** Nothing to double-click, and
  nowhere a person sees every app's data or what needs a look.
- **One app holding the others (reversing ADR-0701).** One sign-in and one
  core, and no app ships or fails alone.
- **The CLI for every library operation, sync and edits included.** One path
  for the window, but each edit waits on a process, the library needs its own
  layer to show an edit at once, and sync runs a second way beside the core
  every other app links.
- **The query engine in the Rust core.** No process boundary, but contracts
  and validation would be needed in Rust as well.
- **A full query editor in the window, with joins and grouping.** Results
  whose rows are not notes cannot be edited, so the window would hold two
  kinds of table.
