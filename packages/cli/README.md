# The epicenter command

`epicenter` runs the apps in `~/Epicenter` as commands and MCP tools. Each app is a folder whose `epicenter.ts` defines its actions ([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md)).

```sh
epicenter
epicenter reading
epicenter reading log 30 --book Dune
epicenter reading log 30 --json
epicenter ./worktree log 30
epicenter reading log --help
epicenter mcp [<app>…]
epicenter help
epicenter --version
```

Put global flags after the action words. The listing shows actions, usage, schemas with `--json`, and problems in individual apps. `new`, `add`, `update`, `sync`, `serve`, and `open` are reserved for future commands.

Exit codes: 0 success; 1 a finding; 2 the action did not run; 3 the action started and threw.

Environment variables:

- `EPICENTER_HOME`: app home, default `~/Epicenter`.
- `EPICENTER_CACHE_HOME`: cache root, default `~/Library/Caches/so.epicenter.apps`.
- `EPICENTER_TEST_SECRETS`: JSON keyed by service, such as `{"epicenter.reading":{"token":"value"}}`. Replaces the keychain with process-local stores for tests.

Compile the executable from the repository root:

```sh
bun run --cwd packages/cli compile
```
