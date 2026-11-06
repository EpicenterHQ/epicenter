# 0805. A folder is recognized by `epicenter.json`, which is its contract

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0802](0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) at "`AGENTS.md` names `contract.json` by path": the contract is `epicenter.json`, and `AGENTS.md` names nothing; [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) at "A folder says what it is in `AGENTS.md`": it says so in `epicenter.json`, and folders are found by that file; [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) at `.epicenter/sync.lock`: no lock guards a sync, and the manifest is written over the version the sync read; [ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md) at the note's `contract` key: `AGENTS.md` carries no front matter.
- **Relates:** [ADR-0797](0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md) (the front-matter grammar), [ADR-0799](0799-a-folders-contract-is-also-an-mcp-server.md) (tools derived from the contract).
- **Amended by:** [ADR-0810](0810-a-folder-needs-no-app-and-a-repository-is-a-spaces-named-folder.md) at the app writing `epicenter.json`: an app owns it when it names the app's contract; a person owns it otherwise.
- **Amended by:** [ADR-0811](0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) at `epicenter.json`'s fields: `$schema`, `$id` when an app owns it, and `collections`.
- **Unbuilt:** all of it: apps writing and updating `epicenter.json`; discovery, the CLI, the library, and `epicenter mcp` reading it; `AGENTS.md` written as prose with no front matter; the manifest written over the version a sync read.

## Context

A folder was recognized by its `AGENTS.md`, whose front matter named
`contract.json` by path: a pointer with only one value it would ever hold,
in a file people and agents edit as prose. The word contract means nothing to
a person who opens the folder. Tools name the file that marks their folders
after themselves (`package.json`, `tsconfig.json`, `deno.json`), so a person
reads it as the tool's and leaves it alone. ADR-0804 added a lock file whose
only job is to be locked, beside the manifest a sync updates anyway.

## Decision

**A folder is an Epicenter folder because it holds `epicenter.json`, and that
file is its contract**: the collections, their paths, and their JSON Schema
fields, with `$id` the contract's URL on the app's site. The app writes it and
keeps it current; it syncs with the data. Discovery, the CLI, the library, and
`epicenter mcp` find folders and learn their shape from it.

**`AGENTS.md` is prose for agents**, with no front matter: what the folder is,
the front-matter grammar, and how to change fields and sync. Epicenter writes
it once; it is the person's after that, and nothing depends on it.

**No lock guards a sync.** The manifest is a JSON file written over the
version the sync read, through the store's versioned write (ADR-0798), like
any file. Two syncs of one folder may run at once; every write they make is
guarded by its version, so a race answers `'stale'` and keeps the file, and the
sync whose manifest write answers `'stale'` runs again. A lock on the manifest
would not exclude anyone, since the manifest is replaced by a rename, and a
cross-platform lock from JavaScript needs code per operating system.

```txt
todos/
├── epicenter.json          the contract ($id = the app's URL)
├── AGENTS.md               prose for agents
├── todos/call-dentist.md   items
└── .epicenter/synced.json  this computer's manifest (JSON)
```

## Consequences

- One file, named for the tool, says what a folder is and what shape it has.
- Rewriting or deleting `AGENTS.md` breaks nothing.
- Nothing can leave a sync blocked, and two syncs at once cost only repeated
  work.

## Considered alternatives

- **A lock file, or an operating-system lock on the manifest:** a pid file can
  go stale, and a lock on a file replaced by rename excludes no one.
- **The manifest in SQLite:** cross-platform locking and partial updates, at
  the price of a database in the page's sync path and of lock and journal files
  that file-sync services such as iCloud Drive and Dropbox can corrupt.
