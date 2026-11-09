# The epicenter command

`epicenter` runs the apps in `~/Epicenter` as commands and MCP tools. An app is a folder with an `epicenter.json`; its `epicenter.ts`, if present, defines its actions ([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md), [ADR-0857](../../docs/adr/0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md)).

```sh
epicenter
epicenter reading
epicenter reading log 30 --book Dune
epicenter reading log 30 --json
epicenter ./worktree log 30
epicenter reading log --help
epicenter serve --stdio
epicenter new notes
epicenter add ~/Code/vault --init
epicenter add https://github.com/someone/recipes
epicenter help
epicenter --version
```

`--json` and `--help` go anywhere before `--`; `--version` is read only on its own. The listing shows each app's actions and the problems in individual apps. `epicenter --json` prints the merged declaration: each app's name, description, folder, collections from both files as JSON Schema, and each action as the MCP tool `serve` offers, with all four annotations explicit. A folder with neither `epicenter.json` nor `epicenter.ts` is not an app and is not listed. `epicenter setup` is reserved and says it is not built yet.

`epicenter` supplies `@epicenter/app` to every `epicenter.ts` it loads, so a folder needs no `node_modules` to run. Listing and running an app only read it. An invalid `epicenter.json` is reported before any of the app's code is imported.

## Each run is its own process

The `epicenter` you start only relays. It runs the action in a child `epicenter` whose stdout and stderr both go to your stderr, forwards SIGINT and SIGTERM, and reads the child's answer from a report file once the child exits. So nothing an action prints, through any `console` method or `process.stdout`, reaches the answer. A child that dies after the run began answers "unknown", exit 3, with the branch head before and after, so you can see what landed.

`epicenter serve --stdio` serves your apps over MCP on stdin and stdout. It never imports an app. `tools/list` runs `epicenter <app> --json` for each home entry in its own child, so an app that fails to load loses only its own tools, and says why on stderr. Each `tools/call` decodes the tool name and runs `epicenter <app> <words> --input <json>` in a fresh child, so an edit between two calls is seen by the second. `--input` takes the action's input as one JSON object instead of flags.

## Writing and committing

Each app folder must be the top level of its own Git repository. Runs of one app take turns. An action writes as it runs, and whether it returns or throws, `epicenter` commits exactly what it wrote as one commit (ADR-0850):

- Immediately before each write lands, the path must have no uncommitted edits, or still hold what this run wrote to it; otherwise the write is refused and nothing is written there. A symbolic link is refused too.
- Each write is stored as a Git object, with the blob and mode the path had before. The commit is built from HEAD plus exactly those objects, keeping each file's mode, and the branch moves only if HEAD has not. An edit someone saves after the action wrote a path stays uncommitted and is named. A path a commit made during the run also changed is left out and named; nothing is merged.
- The subject is `<app> <action words>`, with ` (failed: <first line of the error>)` when it threw or a write was refused, cut to about 60 characters. The body is the input as JSON, without `writeOnly` inputs, then the full error.
- Gitignored paths are written and never committed. Nothing is undone; `git revert` undoes a commit.
- The limit: an editor save in the instant between the check and the write landing can be overwritten, and writes made through `folder.path` are not recorded or committed. While `epicenter` moves the branch and updates the index it holds Git's index lock, so an agent's `git add` or `git commit` at that moment fails and can be retried.

After each commit, `epicenter` pushes the branch fast-forward to the branch of the same name on `origin`, and only when that is the branch it tracks (ADR-0851). It pushes after the app's turn ends, so a slow push never holds up the next run. It never pulls or merges: when `origin` has commits this copy does not, the commit stays local, `epicenter` fetches so it knows, and says to pull. The listing shows how far each app is ahead of and behind `origin`. A worktree branch that tracks `origin/main` but is not `main` is never pushed.

## What a run answers

With `--json`, stdout is one JSON object, the run's report, and MCP returns the same object as `structuredContent`, with `isError` when the exit code is not 0:

```json
{
  "action": { "returned": 30 },
  "refused": [{ "path": "2026.csv", "reason": "uncommitted", "message": "…", "next": "…" }],
  "commit": { "sha": "…", "subject": "reading log", "paths": ["2026.csv"] },
  "paths": [{ "path": "2026.csv", "state": "committed" }],
  "push": { "pushed": true, "ahead": 0, "behind": 0 }
}
```

- `action` is `{ "returned" }` or `{ "threw": { "message", "thrown"? } }`. An action that throws a tagged error (`{ name, message, …fields }`) reports it whole as `thrown`.
- `commit` is the commit, `null` when nothing of the run's remained to commit, or `{ "failed": <message> }`.
- Each written path's `state` is `committed`, `already-in-history`, `changed-after`, `contested`, or `not-committed`.
- `push` is `null` when the branch does not track its own name on `origin`; otherwise it carries `reason` and `next` when it did not push.

A command that did not run answers `{ "error": { "name", "message", "next"? } }`. Without `--json`, stdout carries only the returned value, and stderr renders the rest for a person: `committed a1b2c3d reading log`, `left uncommitted: 2026.csv (changed after the action wrote it)`, refusals and errors, each followed by `Run: <next step>` when there is one.

Exit codes: 0 ran; 2 did not run; 3 ran and failed: it threw, a write was refused, the commit failed, or the run ended without a report.

## Adding apps

`epicenter new <name>`, `epicenter add <folder>`, and `epicenter add <git url>` make a folder one of your apps the same way (ADR-0852). Each writes whichever template files are missing (`epicenter.json` with its `$schema`, a `.gitignore` with `node_modules/` and `.cache/`, and a `.gitattributes` routing binary types through Git LFS), makes the folder a repository if it is not one, runs `git lfs install --local` when `git-lfs` is installed, and commits what that added. Each prints the folder on stdout and `Run: epicenter <name>` on stderr.

- `new <name>` starts from the built-in template.
- `add <folder>` links a folder with an `epicenter.json` into `~/Epicenter` under its declared name. A folder that is not yet a repository needs `--init`, which commits what is there.
- `add <git url>` clones the app into `~/Epicenter`, keeping its history and the source as the `upstream` remote and branch. The copy's own branch tracks nothing until you give it an `origin`.

What an app can rebuild lives in files it gitignores in its folder, such as `.cache/` (ADR-0854). A write to a path marked for Git LFS is refused when `git-lfs` is not on `PATH` or its filter is not set up, since Git would otherwise store the whole file (ADR-0856).

The home is `$HOME/Epicenter`; tests move it by setting `HOME`. Tests replace the Keychain with process-local stores through `EPICENTER_TEST_SECRETS`, JSON keyed by service, such as `{"epicenter.reading":{"token":"value"}}`, so they never reach the real one.

Compile the executable from the repository root:

```sh
bun run --cwd packages/cli compile
```

## Tests

Run `bun test` in `packages/cli` one file per process when memory is short. `acceptance.*.test.ts` runs the real `epicenter` against a temporary `HOME`, one test per acceptance ID. `bun scripts/race.ts --runs 1000 --concurrency 4` races runs against an agent committing in the same folder and reports anything lost or misfiled.
