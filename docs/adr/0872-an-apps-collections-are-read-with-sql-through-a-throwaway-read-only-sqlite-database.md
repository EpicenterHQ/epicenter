# 0872. An app's collections are read with SQL through a throwaway read-only SQLite database

- **Status:** Accepted
- **Date:** 2026-11-11
- **Relates:** [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md) defines collections and actions; [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) keeps `.local` files on their computer.

## Context

Collections expose `list()` and `get()` over Markdown files. An app action that
needs a join or a filter reads collections and computes it itself. Agents need
the same reads without adding an action for each question. The files already
have one projection: fitting fields, defaults, problems, undeclared front
matter, and body. SQL needs that projection without a second interpreter or a
second durable store.

## Decision

**Each collection is a SQL table named by its key in the app's collections.**
Every matching existing Markdown file is one row. Its app-relative `path` is
the primary key; tables have no hidden rowid. A missing singleton has zero
rows, even though `get()` gives defaults. Empty tables retain their columns.

```txt
path, placeholders in template order, fields in declared order, body, problems, other
```

**SQL uses the existing collection projection and excludes `.local` collections.**
Placeholders stay text. Fields use their fitting value, else default, else
NULL. Strings and selects are text, integers and numbers are numeric, booleans
are INTEGER 0/1, and arrays and objects are JSON text. Problems and other are
JSON text, NULL when empty. A collision between column names ignoring ASCII
case throws and asks for a rename. Non-local templates continue to exclude
`.local` files.

**Every query builds one in-memory database from the files and discards it.**
`query` reads through the current run; `queryTables` describes definitions
without file reads. `epicenter query` lists tables without SQL or reads rows
with SQL, in the epicenter process, without a lock or a commit.

**SQL only reads through a read-only deserialized database with query_only enabled.**
A supplementary lexer admits one SELECT, WITH, or VALUES statement. It keeps
out PRAGMA because preparation alone can change process state, and rejects a
second statement because Bun silently ignores statement tails. It is not the
write protection. Prepared statements must return distinct column names.
`QueryError.Refused` names refused SQL or results; `QueryError.Failed` carries
SQLite failures. CLI errors map these to Refused and Usage, respectively.
A query with parameters must be given every value.

## Consequences

Each query rereads every file of every table, so file reads grow with the app's
collections even when a filter returns one row. There is no persistent index,
cache invalidation, or atomic snapshot of a folder changing during reads.
SQL cannot write back to Markdown. `query` becomes a reserved app name.

The environment is trusted and local. This is not a sandbox for hostile SQL:
SQLite builds expose capabilities beyond collection reads, such as the
`fts3_tokenizer` function enabled on this macOS build.

## Considered alternatives

A persistent cache or indexer avoids repeated reads but adds invalidation and
a second state whose agreement with files must be maintained.

SQL writeback requires rules for turning arbitrary statements into Markdown
edits, preserving unknown front matter, and handling concurrent file changes.
Collection methods already own those writes.

Regex-only validation cannot distinguish statement boundaries from quoted
strings, identifiers, and comments, and cannot enforce read-only execution.

A Bun FFI authorizer would control SQLite operations directly, but `bun:sqlite`
exposes no authorizer. FFI binds the implementation to a platform's SQLite
library and its connection internals.
