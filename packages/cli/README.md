# @epicenter/cli

The `epicenter` command. Each command is a thin wrapper over a function in a
shared package; the CLI parses, prints, and picks the exit code, and holds no
logic of its own (ADR-0556). The command surface is ADR-0558's.

```sh
bun run epicenter check path/to/folder          # from the repository root
bun packages/cli/src/bin.ts query path/to/folder 'SELECT stem FROM posts'
```

The desktop app compiles the same `runCli` into the one binary it ships
(`apps/epicenter/src/epicenter-binary.ts`, built by `bun run --cwd
apps/epicenter build:sidecar`). That binary also has the Bun host as a hidden
`__host` mode and runs as `bun` with `BUN_BE_BUN=1`; see
[the epicenter binary](../../apps/epicenter/README.md#the-epicenter-binary).

## Commands

| Command | Status | Wraps |
| --- | --- | --- |
| `epicenter check <dir>` | built | `checkFolder` in `@epicenter/folder/bun` |
| `epicenter query <dir> [<sql>]` | built | `checkFolder`, `queryFolder`, `describeTables` |
| `epicenter generate <dir>` | built | `generateDeclaration` |
| `epicenter status <dir>` | not built | |
| `epicenter sync <dir> [--to <namespace>/<name>] [--resolve <choices.json>]` | not built | |
| `epicenter clone <namespace>/<name> \| <url> [<dir>]` | not built | |
| `epicenter repos` | not built | |
| `epicenter open <dir> [--app <id>]` | not built | |
| `epicenter app list` | not built | |
| `epicenter app install <url> [--folder <path>] [--approve]` | not built | |
| `epicenter app update <id> [--approve]` | not built | |
| `epicenter app remove <id>` | not built | |
| `epicenter auth login [--loopback]` | not built | |
| `epicenter auth logout` | not built | |
| `epicenter auth status` | not built | |
| `epicenter auth token [--resource <url>]` | not built | |
| `epicenter auth git-credential get \| store \| erase` | not built | |
| `epicenter send` | not built, hidden | |
| `epicenter install-command [--dry-run]` | built, hidden | `src/install-command.ts` |

A command not built yet parses its arguments, shows in `--help` marked
"not built yet", and exits 2 naming its ADR. `send`, `install-command`, and
`auth login --loopback` are left out of `--help`: the desktop app runs them.

`install-command` is not in ADR-0558. It links the compiled binary onto `PATH`
as `/usr/local/bin/epicenter` (ADR-0556's "Install the epicenter command"):
it makes or replaces a symbolic link and refuses a regular file. When the
directory is missing or not writable, it asks a person at a terminal before
running `sudo`; with `--json` or without a terminal it exits 1 and names the
`sudo` command. Run from source under `bun`, it refuses, since it would link
`bun` itself.

## Output and exit codes

Every command takes `--json`, and only `--json` switches the output: one JSON
value on one line of stdout, or, for `sync`, `clone`, `app install`, and
`app update`, NDJSON progress lines ending in one result line. Without it,
stdout is the answer and stderr is for people. A command that cannot do its
work prints `{"error": "..."}` on stdout with `--json`, and the message on
stderr without it.

Exit codes are ADR-0520's: 0 done, 1 a finding a person acts on (a file that
does not conform), 2 input the command cannot use (a folder that is not one,
a refused statement, an unknown option, a command not built yet).

Options are matched exactly, so a SQL statement that starts with `--` stays a
statement. A token shaped like an option the command does not take is
refused. After `--`, every token is a positional. The CLI never calls
`process.exit`, so stdout drains before the process ends.

## Layout

| Path | What it is |
| --- | --- |
| `src/bin.ts` | The command run from source. |
| `src/cli.ts` | `runCli`: help, version, and dispatch to the built commands. |
| `src/commands.ts` | Every command ADR-0558 names, with its usage and ADR. |
| `src/parse.ts` | The hand-written parser. |
| `src/folder-commands.ts` | `check`, `query`, and `generate`, printing what `@epicenter/folder/bun` returns. |
| `src/install-command.ts` | `install-command`. |
| `src/output.ts` | Stdout, stderr, `{"error"}`, and the exit codes. |

## Tests

```sh
bun test                       # from source
EPICENTER_BIN=../../apps/epicenter/src-tauri/binaries/epicenter-cli-<triple> bun test src/epicenter.test.ts
bun run typecheck
```

`src/epicenter.test.ts` runs every command in a fresh process against real
directories, so it can run against the compiled binary too.
