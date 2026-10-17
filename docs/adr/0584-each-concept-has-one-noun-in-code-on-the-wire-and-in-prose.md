# 0584. Each concept has one noun in code, on the wire, and in prose

- **Status:** Accepted
- **Date:** 2026-10-17
- **Unbuilt:** every rename below except the glossary in `docs/CONTEXT.md` and the per-rule `adr` field in `scripts/check-vocabulary.ts`; pull requests P1 to P10 build the rest in the order under Consequences.
- **Relates:** [ADR-0583](0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md) decided the opener (`openFolder`, `folder.own`, no `lens`); [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) is the one write; [ADR-0581](0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md) pins installed apps to the shell commands they were built against; [ADR-0457](0457-a-row-filename-is-its-exact-id-and-a-title-is-a-field.md) addresses a row by its stem.

## Context

One concept carried several names, and the names crossed layers. The contents
of `epicenter.json` were `DataSchema` in `@epicenter/definition`,
`FolderDefinition` in `@epicenter/folder`, "the declaration" in
`readDeclaration` and `DECLARATION_PATH`, and "the shape" in `ShapeMismatch`
and `shapeProblems`. A folder was a "data folder" in prose and Rust
(`list_data_folders`, `DataFolder`), and a `scope` in every shell command
argument and in `UnknownScope`. A version was `saveVersion` in apps, the query
layer, and the CLI-to-page JSON, `save_version` in the shell, `save-version` on
the command line, `log` for the list of them, and `'saved'` for a sync that
committed without pushing. A row's address was `Entry.id` in Vocab, `NoteId`
in Honeycrisp, `recordingId(at)` in Whispering, and `stem` in the table API.
Absence was `undefined` from `Table.get` and `null` in `table.write`. A failure
had a union per type rather than per verb: `FileError`, `RowReadError`,
`RowWriteError`, `WriteError`, and `OpenFolderError`.

A reader had to learn that these were the same things, and a grep for one name
missed the others.

## Decision

**Each concept below has one noun, and identifiers, wire names, CLI commands,
log sources, and prose use it.** What a person reads on screen keeps the word a
person already has: "Save version", "Rename", "folder".

| Noun | What it is | Code and wire |
| --- | --- | --- |
| App | an installed program, named by its reverse-domain id (`so.epicenter.todos`) | `app` (`openFolder({ app, definition })`, `WindowFolder.app`); `application` retires |
| Folder | a directory a person owns, named by its id, with or without `epicenter.json` | `Folder`, `folder.id`, `folder.isOwn` (was `folder.own`), `queries` for the query layer over it (was `folder$`/`folderOptions`); `folderId` on the wire (Rust `folder_id`); "data folder" and the folder sense of `scope` retire |
| Definition | what `epicenter.json` holds and `defineFolder` returns | `Definition`, `prepareDefinition`, `DEFINITION_PATH`, `InvalidDefinition`, `DefinitionMismatch`; folder-level "schema", "declaration", and "shape" retire |
| Table | a directory of rows a definition names | `TableDefinition` (from `defineTable`), `PreparedTable`, `Table<TFields>` (the handle) |
| Row, stem | one `<table>/<stem>.md`; the stem is its address | `stem`; `FieldsOf` (was `CreateRowOf`) |
| File, path | any file in a folder, at a folder-relative path | `folder.files`, `path`; a directory inside a folder is `directory` |
| Write | the one verb that changes files (ADR-0576) | `folder.write`, `folder.move`, `table.write`, `table.set`, `table.create`, `table.move`, `table.delete`; messages and the logger source (`folder/write`) say "write"; the write lock |
| Version, History | a version is a commit; history is the commits | `commit` (`folder.git.commit()`, wire op, shell command, `epicenter commit`), `folder.git.history(depth)`; the history lock |
| Sync, Remote | Sync commits, fetches, merges, and pushes; the remote is `remote.origin.url` | `folder.sync`, `folder$.sync.run`; `SyncOutcome` `'unpushed'` |

**A row is addressed by its stem, never by an id.** A stem changes when the row
moves, so it is not an identity. Vocab's `Entry.id` and `Chat.id`, Honeycrisp's
`NoteId` and `noteIdOf`, and Whispering's `recordingId(at)` and `active.id`
become stem forms. A persisted field that names another row is named for that
row's table in the singular, as Vocab's `messages.chat` already is:

```txt
Whispering  transcriptions.recordingId            -> recording
            transformation_runs.recordingId       -> recording
            transformation_runs.transcriptionId   -> transcription
            transformation_runs.transformationId  -> transformation
            text_runs.transformationId            -> transformation
Vocab       chats.focus[].entryId                 -> entry
```

Honeycrisp's note groups, the `folders` table and `notes.folderId`, collide
with Folder. They are not renamed here: a note group is likely to become a
real directory inside a nested table, which removes both the table and the
field, so that design decides them.

**Each verb has one error union.** Opening a folder fails with `OpenError`
(was `OpenFolderError`), reading with `ReadError` (was `RowReadError`), writing
with `WriteError` (absorbs `RowWriteError`), Git with `GitError`, committing
with `CommitError`, and syncing with `SyncError`. A narrower method returns a
subset of its verb's union: `folder.write` cannot fail `InvalidValues`, and
`files.read` cannot fail `InvalidRow`. `FileError` becomes the internal
`StorageError`. `InvalidDeclaration` merges into `InvalidDefinition { reason,
path? }`; `UnknownScope` becomes `UnknownFolder`; `NotDataFolder` becomes
`NoDefinition`; `SyncError.Publish` and `SyncError.Checkpoint` become
`SyncError.Write` and `SyncError.Commit`.

**`folder.git.commit()` returns a `Result`.** `Result<Commit, CommitError>`
replaces the seven-status `CommitOutcome`; `CommitError` is `BranchMoved`,
`Blocked`, `Failed`, `Unconfirmed`, or `Closed`. A folder's last commit is
`{ at, result }`.

**Absence is `null`; `undefined` means not given.** `Table.get` returns
`StoredRow | null`, in the engine, the query layer, and on the wire.

**The rest of the vocabulary:**

- `table.rename` is `table.move`; the query layer is `folder$.git.{status,
  history, commit}` and `folder$.sync.run`.
- The two locks are named by role: the write lock (was the save lock or files
  lock) and the history lock (was the Git lock).
- Git settings sit under one option on every opener, `git?: { author?,
  credentials?, httpFetch? }`; a Bun opener requires `git.author`; browser test
  injection is a top-level `opfs?`. `runHistory` takes `{ git, own? }`, and the
  CLI's `isApplicationFolder` is `isOwnFolder`: whether a folder is its app's
  own is the same question `folder.isOwn` answers.
- `storage.children()` answers `{ fileNames, directoryNames }`; `list()` keeps
  `{ files, directories }`.
- "Schema" keeps its field-level meaning: `TSchema`, `FieldMap`, `$schema`,
  `objectSchema`.
- "Publish" stays for `epicenter.json` (`publishDefinition`,
  `refs/epicenter/publishing`); `put` stays the storage port's verb.
- Source file names stay, and accepted records keep the names they were
  written with.

**Handle names.** The opened handle is `folder`. Its query layer, the cached
queries and the mutations that invalidate them, is `queries` (was `folder$`,
built by `folderOptions`): the `$` suffix borrowed an observable convention for
something that is not one. `folder.own` is `folder.isOwn`, a boolean read as
one. `isOwn` is publication eligibility (ADR-0583); once Todos' Connect works
per folder and Honeycrisp needs no own-folder setup, no app reads it and it
leaves the public handle.

**Two pairs stay separate.** The write lock and the history lock serialize
different work: a write holds the write lock for one checked change to one
file, and a commit or sync holds the history lock for a whole Git operation,
which can wait on a network. One lock would stall every write behind a fetch.
A stem and a path address different things: a table method takes a stem and
supplies its table's directory and `.md`; a `files` method takes any
folder-relative path.

## Consequences

- A reader learns one word per concept, and `scripts/check-vocabulary.ts`
  refuses a retired identifier once its rename lands, citing ADR-0584
  through the rule's `adr` field.
- The shell-to-page commands change: `save_version` is `commit`,
  `list_data_folders` is `list_folders`, every `scope` argument and the
  `put_folder_file` header are `folderId`, `FolderChanged.scope` and
  `WindowFolder.folder` are `folderId`, `GrantError` names `UnknownFolder`,
  `children` answers `fileNames` and `directoryNames`, and
  `epicenter://data-folders-changed` is `epicenter://folders-changed`. The CLI-to-page JSON ops are `commit` and
  `history`. The shell's CLI arguments `save-version` and
  `declare-epicenter-folder` are `commit` and `write-epicenter-definition`.
- Installed apps are pinned to the commit they were built from (ADR-0581), so
  P5a, P5b, and P10 ship in one desktop release, and each installed app runs
  `epicenter app update`.
- The logger source `folder/save` is `folder/write`, so durable logs change
  source name at that release.
- The CLI prints "Committed", "Nothing was committed", and "Merged at ...; not
  pushed yet" in place of its "Saved version" lines.
- Row files written before the field renames still hold `recordingId`,
  `entryId`, and the rest. No released build reads these folders, so nothing
  maps the old names: a development folder's old rows read as invalid rows, for
  repair (ADR-0503).
- Unchanged on disk: `epicenter.json` keys, commit trailers and subjects, refs,
  `.git/epicenter/`, the merge driver's name, `approvals.json`, manifests,
  window labels, and the OPFS directory. The lock files
  `.<name>.epicenter-save-lock` and `.<name>.epicenter-history-lock` and the
  Web Locks `epicenter-folder:<id>:open`, `:files`, and `:git` keep their old
  words until the locks move into `.git/epicenter/`.
- The AI connection's names (ADR-0557) wait for their own pull request, which
  also decides whether `sync.connect` is `sync.setRemote`. "Connection" also
  names a client's transport to a deployment in `docs/CONTEXT.md`; that pull
  request settles which sense keeps the word.
- The renames land in this order, each pull request passing alone:

  ```txt
  P1  Definition nouns            after the single opener
  P2  Table and row nouns         after P1
  P3  Version and history         beside P1 and P2; no wire change
  P4  Errors per verb, locks      after P1 and P2
  P5a History wire                after P3
  P5b Folder-address wire         after P4 and P5a
  P6  Option shapes               beside P5a
  P7  App row stems and fields    after the shared app component
  P9  Absence is null             after P2 and P7
  P10 commit() returns a Result   after P5a; ships with P5a and P5b
  ```

## Considered alternatives

- **Keep the persisted `...Id` fields and map them at the read boundary.** It
  keeps a name that says identity on a value that changes on move, and every
  app carries a mapping for folders no released build reads.
- **One lock for writes and history.** Writes would wait behind a fetch.
- **Rename the lock files and Web Lock names now.** A shell and a CLI from
  different builds would then hold different locks on one folder; the names
  change once, when the locks move into `.git/epicenter/`.
- **"Save" as the write verb.** The UI already uses "Save version" for a
  commit, so "save" would name both a file write and a commit.
