# The epicenter command

`epicenter` runs the apps in `~/Epicenter` as commands and MCP tools. Each app is a folder whose `epicenter.ts` defines its actions ([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md)).

```sh
epicenter
epicenter reading
epicenter reading log 30 --book Dune
epicenter reading log 30 --json
epicenter ./worktree log 30
epicenter new notes
epicenter sync
epicenter reading log --help
epicenter mcp [<app>…]
epicenter help
epicenter --version
```

Put global flags after the action words. The listing shows actions, usage, schemas with `--json`, and problems in individual apps. `add`, `update`, `serve`, and `open` are reserved for future commands.

Each app folder must be the top level of its own Git repository. An action takes its app's turn, then commits the paths it changed as one commit named `<app> <action>`. The commit body is the input as JSON. Paths with uncommitted changes before the action stay out of its commit; folder writes to them are refused. If an action throws, its changes to previously clean paths are undone. The value stays on stdout and commit or uncommitted-path notes go to stderr. MCP receives those notes as a second text block.

`epicenter sync` pulls and pushes each app with an upstream branch, including linked apps. It reports conflicts and uncommitted paths and never commits them. `epicenter sync --json` returns an `apps` array with each app's status. `epicenter new <name>` creates a Git repository with a starter `epicenter.ts`, package manifest, and `.gitignore`, installs dependencies, and makes its first commit.

Exit codes: 0 success; 1 a finding; 2 the action did not run; 3 the action started and threw.

Environment variables:

- `EPICENTER_HOME`: app home, default `~/Epicenter`.
- `EPICENTER_CACHE_HOME`: cache root, default `~/Library/Caches/so.epicenter.apps`.
- `EPICENTER_TEST_SECRETS`: JSON keyed by service, such as `{"epicenter.reading":{"token":"value"}}`. Replaces the keychain with process-local stores for tests.

Compile the executable from the repository root:

```sh
bun run --cwd packages/cli compile
```

## Tests

Run `bun test` in `packages/cli`. The new-app tests set `EPICENTER_SKIP_INSTALL=1` to skip `bun install`; the JSON answer then reports `installed: false`.
