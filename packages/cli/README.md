# The epicenter command

`epicenter` runs the apps in `~/Epicenter` as commands and MCP tools. An app is a folder with an `epicenter.json`; its `epicenter.ts`, if present, defines its actions ([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md), [ADR-0857](../../docs/adr/0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md)).

```sh
epicenter
epicenter reading
epicenter reading log 30 --book Dune
epicenter reading log 30 --json
epicenter ./worktree log 30
epicenter reading log --help
epicenter types
epicenter serve --stdio
epicenter new notes
epicenter add ~/Code/vault --init
epicenter add https://github.com/someone/recipes
epicenter help
epicenter --version
```

Put global flags after the action words. The listing shows each app's actions and the problems in individual apps. `epicenter --json` prints the merged declaration: each app's name, description, folder, collections from both files as JSON Schema, and each action as the MCP tool `serve` offers, with all four annotations explicit. A folder with neither `epicenter.json` nor `epicenter.ts` is not an app and is not listed.

`epicenter` supplies `@epicenter/app` to every `epicenter.ts` it loads, so a folder needs no `node_modules` to run. Listing and running an app only read it. `epicenter types [<app> | <path>]` writes its `epicenter.d.json.ts`, for the current folder by default, and the listing notes when that file is missing or stale. An invalid `epicenter.json` is reported before any of the app's code is imported.

`epicenter serve --stdio` serves every healthy app in the home over MCP on stdin and stdout. It never imports an app: `tools/list` runs `epicenter --json`, and each `tools/call` runs `epicenter <app> <words> --input <json> --json` in a fresh process, so an edit between two calls is seen by the second. `--input` takes the action's input as one JSON object instead of flags. `add`, `update`, `open`, and `serve` over the network are reserved for future commands.

Each app folder must be the top level of its own Git repository. Runs of one app take turns. An action writes as it runs, and whether it returns or throws, `epicenter` commits exactly what it wrote as one commit (ADR-0850):

- Immediately before each write lands, the path must have no uncommitted edits, or still hold what this run wrote to it; otherwise the write is refused and nothing is written there.
- Each write is stored as a Git object. The commit is built from HEAD plus exactly those objects and the branch moves only if HEAD has not, so an edit someone saves after the action wrote a path stays uncommitted and is named. A path a commit made during the run also changed is left out and named; nothing is merged.
- The subject is `<app> <action words>`, with ` (failed: <first line of the error>)` when it threw, cut to about 60 characters. The body is the input as JSON, without `writeOnly` inputs, then the full error.
- Gitignored paths are written and never committed. Nothing is undone; `git revert` undoes a commit.
- The limit: an editor save in the instant between the check and the write landing can be overwritten, and writes made through `folder.path` are not recorded or committed. While `epicenter` commits it holds Git's index lock, so an agent's `git add` or `git commit` at that moment fails and is retried.

stdout carries only the answer: the returned value, or with `--json` one object, `{ "result", "commit": { "sha", "subject", "paths" } | null, "uncommitted": [paths] }` or `{ "error": { "name", "message", … } }`. While an action runs, its `console.log` and `console.info` go to stderr. stderr carries notes for a person: `committed a1b2c3d reading log`, `left uncommitted: 2026.csv (changed during the run)`, and errors, each followed by `Run: <next step>` when there is one. An action that throws a tagged error (`{ name, message, …fields }`) reports it whole as the error's `thrown`. MCP returns the same object as `structuredContent`, with `isError` on failure.

After each commit, `epicenter` pushes fast-forward only to `origin`, and only when the branch tracks a branch there (ADR-0851). It never pulls or merges: when `origin` has commits this copy does not, the commit stays local, `epicenter` fetches so it knows, and stderr says to pull. The listing shows how far each app is ahead of and behind `origin`. A worktree branch that tracks nothing is never pushed.

`epicenter new <name>` creates a repository from the built-in template: `epicenter.json` with its `$schema`, a `.gitignore` with `node_modules/`, `.cache/`, and `epicenter.d.json.ts`, and a `.gitattributes` routing binary types through Git LFS, and makes its first commit. `epicenter add <folder>` links a folder with an `epicenter.json` into `~/Epicenter` under its declared name; a folder that is not yet a repository needs `--init`, which commits what is there. `epicenter add <git url>` copies an app into a new repository, keeping the source as the `upstream` remote and branch; the copy's own branch tracks nothing until you give it an `origin` (ADR-0852).

What an app can rebuild lives in files it gitignores in its folder, such as `.cache/` (ADR-0854). A write to a path marked for Git LFS is refused when `git-lfs` is not on `PATH` or its filter is not set up, since Git would otherwise store the whole file (ADR-0856).

Exit codes: 0 success; 1 a finding; 2 the action did not run; 3 the action started and threw.

The home is `$HOME/Epicenter`; tests move it by setting `HOME`. One environment variable remains:

- `EPICENTER_TEST_SECRETS`: JSON keyed by service, such as `{"epicenter.reading":{"token":"value"}}`. Replaces the Keychain with process-local stores, so tests never reach the real one.

Compile the executable from the repository root:

```sh
bun run --cwd packages/cli compile
```

## Tests

Run `bun test` in `packages/cli`, a file at a time when memory is short. `acceptance.*.test.ts` runs the real `epicenter` against a temporary `HOME`, one test per acceptance ID. `bun scripts/race.ts --runs 1000 --concurrency 4` races runs against an agent committing in the same folder and reports anything lost or misfiled.
