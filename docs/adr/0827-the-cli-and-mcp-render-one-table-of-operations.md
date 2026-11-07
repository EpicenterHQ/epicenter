# 0827. The CLI and MCP render one table of operations

- **Status:** Proposed
- **Date:** 2026-11-07
- **Amends:** [ADR-0817](0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md) at "a command here": an operation is a package function and one description, which the CLI and `epicenter mcp` both render; [ADR-0799](0799-a-folders-contract-is-also-an-mcp-server.md) at its tools: they are named `<folder>_<collection>_<verb>`, the verbs are `query`, `get`, `set`, and `write`, and a field that does not fit is refused before writing; [ADR-0805](0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md) at "Epicenter writes it once": Epicenter writes no `AGENTS.md`; [ADR-0822](0822-only-epicenter-syncs-on-a-computer-and-a-folder-holds-only-its-content.md) at "with a contract that fits the app": the directory's name counts alone where the app's view is unknown or the folder holds no `epicenter.json`; [ADR-0824](0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md) at "notes as blobs and other files as LFS objects": the folder's `epicenter.json` is a blob too (projection v2); [ADR-0826](0826-history-enters-and-leaves-epicenter-as-git.md) at an import that stops midway: it resumes, or is abandoned.
- **Relates:** [ADR-0800](0800-a-stores-wire-speaks-http-conditional-requests-and-apps-connect-agents-to-the-cli.md) (agents connect to the CLI), [ADR-0816](0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md) (`epicenter mcp --all`), [ADR-0819](0819-every-program-keeps-the-folders-it-has-open-in-sync-and-the-epicenter-app-has-them-all-open.md) (`epicenter mcp` keeps what it writes in sync), [ADR-0825](0825-the-epicenter-folder-contains-its-folders.md) (the folders it reaches are real directories).
- **Unbuilt:** `query`, `set`, and `delete` on the command line over a folder's collections; a `_delete` tool; "Connect your agents" in the Epicenter app; apps writing `epicenter.json`, so `--contract` stops being how an app's folder is checked.

## Context

The CLI hand-wrote each command three times: its grammar in
`packages/cli/src/commands.ts`, its handler in `cli.ts`, and its help text
beside them, with each handler printing as it went. An MCP server written
the same way would be a fourth copy, and the two surfaces would drift. A
desktop app wrote an `AGENTS.md` holding a `contract:` key and a generated
block, which `epicenter check` and the app-made test read, though ADR-0805
made `epicenter.json` the contract. The export wrote `epicenter.json` as a
Git LFS pointer, so a mirror's contract could not be read or diffed as text.

## Decision

**Each platform operation is a package function plus one description.**
`OPERATIONS` in `packages/cli/src/operations.ts` holds, for each, its
`name`, `args` (positionals by input key), `options`, `summary`, `details`,
and a TypeBox `input` and `output` schema; its code is an `Implementation`
with `run(input)`, which answers its output and prints nothing, and
`print(output)`, which is how a person reads it.

| Rendered by | From the description |
| --- | --- |
| `epicenter <name>` | the grammar, `--help`, the input checked against `input`, `--json` printing the output as it is |
| `epicenter --help --json` | each operation with its `input` and `output` schemas |
| `epicenter mcp` | a tool named `<name>`, `inputSchema` and `outputSchema` from the same schemas, the output as structured content |

`mcp`, `auth`, and `messages` are the CLI's own commands, not operations,
so not tools.

**`epicenter mcp [<dir> ...] | --all` adds tools from each folder's
`epicenter.json`.** For each collection of each folder it reaches:
`<folder>_<collection>_query` (`{ where?, limit? }`), and for a note
collection `_get`, `_set` (`fields`, `remove?`), and `_write` (`body`,
`fields?`). Each writes through `openFolder`, and a field the contract does
not accept is refused before anything is written. It keeps the folders it
writes in sync with `keepEverySynced` limited to them (`only`), after a
burst of its writes and as it ends.

**Epicenter writes no `AGENTS.md`.** A person's `AGENTS.md` is their
content. `epicenter check` and `format` read the folder's `epicenter.json`,
or an app's contract named by `--contract`. A folder counts as made by an
app when its directory has the name the app gives its folder (`name` of
`KnownApp`), unless the app's view is known and the folder's
`epicenter.json` does not fit it (`fitsView`).

**Projection v2 writes the text the platform reads as plain blobs.** In
`epicenter export --git`, a note (`*.md`, any case) and the folder's
`/epicenter.json` are blobs of their bytes, and every other file is a Git
LFS pointer. The `.gitattributes` the export writes is the projection's
signature; an export directory written in v1 is refused, not continued.

**An import that stops midway resumes or is abandoned.** It lands the
changes it finished and keeps `.epicenter/imports/<folder-id>.json` until
it closes. `epicenter import --resume` makes the source's changes again in
order and sends only those after the server's last; `--abandon <folder>`
deletes the folder through `POST …/import { abandon: true }`, which the
server does only while the folder still imports.

## Consequences

- A new operation is one description and one module; its command, help,
  and tool follow, and an agent and a terminal see the same input and
  output.
- Tests run the CLI with `EPICENTER_STRICT_OUTPUT=1`, so an output its
  schema does not describe fails them.
- `sync --all --json` prints one value, `{ every, warnings }`, not a line
  per folder.
- Rewriting or deleting `AGENTS.md` changes nothing Epicenter does.
- A folder named as an app names its folder syncs as that app's without a
  contract to fit, until apps write `epicenter.json`.
- A v1 export directory is exported again into a new directory.

## Considered alternatives

- **An MCP server written beside the CLI:** a second copy of every
  operation's input and output, which drifts from the first.
- **Tools taking `folder` and `collection` as arguments:** fewer tools, but
  no input schema typed by a contract's fields.
- **Resuming from progress kept on this computer alone:** a batch that
  landed while the answer was lost would be sent twice; the server's log is
  the record of what landed.
