# 0520. The CLI acts on a data folder by its path

- **Status:** Accepted
- **Date:** 2026-10-11
- **Relates:** [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) (a data folder is a directory with `epicenter.json`), [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md) (queries build transient projections), [ADR-0521](0521-a-data-folder-syncs-with-its-git-origin-through-a-provider.md) (the CLI keeps no account system)
- **Amended by:** [ADR-0527](0527-a-data-folder-may-keep-its-declaration-as-typescript.md) at running the folder's code: `epicenter generate` runs `epicenter.ts`; `check` and `query` still never do.
- **Amended:** 2026-10-14, `query` answers from the files that conform and names the rest (below).
- **Unbuilt:** running the CLI outside an Epicenter checkout.

## Context

The CLI's one command that reads a data folder, `epicenter validate <folder>`,
imports and runs `<folder>/epicenter.config.ts` to learn the declaration and
parses rows with a second Markdown parser from `@epicenter/app`. Uncommitted
local and account commands addressed managed folders by folder ID under
`~/Epicenter`.

Under ADR-0517 a data folder is any directory containing `epicenter.json`, in
any repository. Running a cloned repository's TypeScript to read its data is
unsafe there, and a folder ID cannot name a data folder inside a host
repository.

## Decision

**Every command that acts on a local data folder takes its path.** A folder ID
names a cloud copy and its default directory under `~/Epicenter`; it is not an
argument for local work.

**Two commands cover the file contract:**

```text
epicenter check <dir> [--json]
epicenter query <dir> [<sql>] [--json]
```

Both read the folder through `@epicenter/folder`'s `readFolder`, the same
reading apps use: `epicenter.json`, every declared table's `list()`, and
`kv.get()`. Nothing executable is read. Neither command writes a file, takes a
lock, reads Git, contacts a network, or requires an account. A folder or
declaration that cannot be used is a tool failure.

`check` prints one line per finding, compiler style. The message names its
field:

```text
posts/2026-10-20-launch.md:3: status does not conform: must be equal to one of the allowed values
```

`check` exits 0 when every file conforms, 1 when a file does not, and 2 when
a file cannot be read. `query` exits 0 when it answers. Both exit 2 when the
folder, the declaration, or a statement cannot be used. A row or
`kv.json` that does not conform, bytes that are not UTF-8, and a path the
folder cannot hold, such as a symbolic link, are files to fix. Nothing outside
the data folder is read.

**`query` answers from the files that conform, and names the rest.** A file
that does not conform, or cannot be read, is left out of every table whole:
no row is projected from part of a file. `query` prints the rows, then names
each file it left out on stderr with the `check` command that says why; with
`--json`, they are listed in `excluded`. Diagnostics still have one home:
`query` names a file, and `check` explains it.

This follows ADR-0503: a folder edited by people and agents is often briefly
broken somewhere, and one half-written file elsewhere should not stop every
question. The answer is partial only in the way it says it is.

`query` builds an in-memory SQLite database under ADR-0494 with one table per
declared table and nothing else. Each table has `stem` (the row's file is
`<table>/<stem>.md`), each declared field, and `body` (the Markdown after the
frontmatter). Declared fields keep their names and are quoted, because field
names may be SQL keywords. A null or absent value is `NULL`, a boolean is `0`
or `1`, a list or object is JSON text, and strings and numbers are stored as
they are. `query` refuses a declaration it cannot project: two fields in one
table that differ only by case, because SQLite compares column names without
case, or a field named `stem` or `body`.

The database is made read-only, and `query` runs exactly one statement, which
must start with `SELECT`, `WITH`, `VALUES`, or `EXPLAIN`. A read-only
connection still lets `ATTACH` and `VACUUM INTO` create files, so other
statements are refused, and so is any text after the first statement.

Without a statement, `query` describes the declaration: each table's
columns, allowed values, and reference targets. It ignores the rows, so it
works while files are being fixed.

**The CLI has no account or transfer commands.** Under ADR-0521, people and
agents use Git and the host's own tools for cloning, history, and transfer.

## Consequences

- `epicenter validate`, its `epicenter.config.ts` execution, and the CLI's use
  of `parseRowFile` are removed. The CLI and the apps read a folder through
  one pipeline, so `check` and the apps give the same verdict for every row
  file they both read.
- An agent's first call in an unfamiliar repository is `epicenter query <dir>`,
  which describes the data folder well enough to write SQL.
- An answer may come from part of the folder. A caller that needs the whole
  folder checks that `excluded` is empty, or runs `check` first.
- Every query reads the current working tree. Pulling newer commits is the
  caller's job; `query` never changes files.
- A statement that writes is refused, so no agent can believe an in-memory
  `UPDATE` changed a row, and no statement can create a file.
- Until the CLI is distributed, a caller outside the monorepo runs
  `scripts/epicenter.ts` from an Epicenter checkout.
- A declaration's `pattern` can backtrack catastrophically, so `check` or
  `query` on a repository someone else wrote can stall. When such repositories
  become a real use, the CLI runs itself as a child process under a wall-clock
  budget rather than restricting what a declaration may say.

## Considered alternatives

- **Separate nouns for data folders and synced repositories.** A synced
  repository is a data folder at a repository root with a pairing, so a second
  noun would split one concept across the surface.
- **Accepting a folder ID or a path.** Two address forms need an ambiguity
  rule for a saving of a few keystrokes.
- **A command local to one host repository.** The file contract belongs to
  every repository, not to one vault.
- **A persistent SQLite file.** It needs a location, ignore rules, and
  freshness checks; rebuilding per query is cheap at current sizes (ADR-0494).
- **`validate` with executable configuration.** It runs untrusted code to read
  data.
- **`sql` or a separate `describe` command.** `query` without a statement
  already describes the folder.
- **Answering only when every file conforms.** The original decision. One
  broken file anywhere stopped every question, including questions about
  tables it is not in, so a half-written journal entry blocked planning.
- **Refusing only when the statement reads a table with a broken file.**
  Narrower, but it still blocks on a file the answer may not involve, and it
  adds a second rule beside the exclusion that `--json` already reports.
- **Invalid rows or metadata in the database** (an `_invalid` table, an
  attached `epicenter` schema, `_path` and `_sha256` columns, `kv.json` as a
  table). Diagnostics belong to `check`, a row's path is `<table>/<stem>.md`,
  nothing writes from a query result, and `kv.json` is one small object with
  nothing to join.
- **Write commands such as `add` or `set`.** People and agents edit the
  Markdown directly; a second write path would duplicate it.
