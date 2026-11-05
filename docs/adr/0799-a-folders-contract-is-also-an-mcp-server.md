# 0799. A folder's contract is also an MCP server

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Relates:** [ADR-0790](0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md) (`epicenter query`), [ADR-0798](0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md) (patch and write, a change is data), [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) (a folder names its contract in `AGENTS.md`), [ADR-0727](0727-json-schema-is-the-field-language.md) (fields are JSON Schema), [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (speak the standard).
- **Unbuilt:** all of it: `epicenter mcp`, its tools derived from each contract, and the line in the `AGENTS.md` Epicenter writes that names it.

## Context

Every folder names its contract in its `AGENTS.md`, and a contract is
collections whose fields are JSON Schema: already the input schema of a tool.
Agents edit folders as files, which works, and through `epicenter set` and
`epicenter query`, which an agent must learn. The Model Context Protocol is the
standard by which an agent imports typed tools.

## Decision

**`epicenter mcp [<dir> ... | --all]` serves each folder's contract as MCP
tools over standard input and output.** For each collection it derives, with no
code written for the app:

| Tool | Input | Does |
| --- | --- | --- |
| `<collection>_query` | `{ where }` | `select * from <collection> where …` (ADR-0790) |
| `<collection>_get` | `{ name }` | the note's fields and body |
| `<collection>_set` | `{ name, fields }`, typed by the contract | a `patch` |
| `<collection>_write` | `{ name, fields, body }` | a note created or replaced, by a `write` |
| `<collection>_delete` | `{ name }` | a delete, by a `write` |

Each tool goes through the same patch and write as the apps, checked against
the contract. Tools that act beyond the folder's data, such as transcribing a
recording, are not derived; a contract may declare them later.

## Consequences

- An agent gets typed, validated tools for every app's data from one command.
- A contract is the one declaration behind a folder's validation, the
  library's tables, the CLI, and an agent's tools.
- An app's actions with side effects stay the app's.
