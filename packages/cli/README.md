# The epicenter command

`epicenter` runs the apps in `~/Epicenter` as commands and MCP tools. An app is a folder with an `epicenter.json`; its `epicenter.ts`, if present, defines its actions ([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md), [ADR-0857](../../docs/adr/0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md)).

```sh
epicenter
epicenter reading
epicenter reading log 30 --book Dune
epicenter reading log 30 --json
epicenter ./worktree log 30
epicenter reading log --help
epicenter reading books set dune --rating null
epicenter reading books set --input '{"id":"dune","rating":5}'
epicenter new notes
epicenter new recipes --from https://github.com/someone/recipes
epicenter update
epicenter link ~/Code/vault
epicenter sync
epicenter sync reading
epicenter serve
epicenter serve --stdio
epicenter --version
```

The commands are `new`, `update`, `link`, `sync`, and `serve`; any other first word names an app. `--json` and `--help` (`-h`) go anywhere before `--`; `--version` is read only on its own. `epicenter` lists your apps, one line each, and the problems in individual apps; `epicenter <app>` lists its actions, each with a short usage line, and `epicenter <app> <action> --help` explains every field.

A flag's value is read as its field's type ([ADR-0867](../../docs/adr/0867-the-command-line-spells-an-actions-json-input-and-null-removes-a-field-there-as-everywhere.md)): a number for a number, `--done` or `--done=false` for a switch, every value of a repeated flag for a list, one of its choices for a choice (an error names them), and `null` for a field that takes `null`, which a collection's `set` reads as "remove it". `--no-done` is refused with `--done=false` as the way to say false. `--input <json>` gives the whole input as one JSON object instead, with positional fields inside it and nothing beside it; `--input -` reads it from stdin. The text `null` for a field that takes `null` is given this way. `epicenter --json` prints each app's declaration: its name, description, folder, the collections from its `epicenter.json`, and each action as the MCP tool `serve` offers, with all four annotations explicit. The listing reads nothing from Git. A folder with neither `epicenter.json` nor `epicenter.ts` is not an app and is not listed.

`epicenter` supplies `@epicenter/app` to every `epicenter.ts` it loads, so a folder needs no `node_modules` to run. Listing and running an app only read it. An invalid `epicenter.json` is reported before any of the app's code is imported.

## Each run is its own process

The `epicenter` you start only relays. It runs the action in a child `epicenter` whose stdout and stderr both go to your stderr, forwards SIGINT and SIGTERM, and reads the child's answer from a report file once the child exits. So nothing an action prints, through any `console` method or `process.stdout`, reaches the answer. A child that ends without an answer, killed or calling `process.exit`, answers that it threw, naming its exit code or signal. A child whose parent dies finishes the run.

`epicenter serve` starts an HTTP server on `127.0.0.1:4747`. `--host <address>` and `--port <n>` change where it listens. It serves MCP at `POST /`, the launcher at `GET /`, and each app's UI at `/<app>/`: its built `.cache/ui/` ([ADR-0866](../../docs/adr/0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md)). The launcher links to apps with a UI; a `GET /` asking for an event stream gets 405, since the server keeps no MCP session. Any later path of the server's own starts with `.`, which no app name can. An Origin must match the request Host; requests without Origin are accepted. A reverse proxy such as `tailscale serve` can provide HTTPS.

Both HTTP and `serve --stdio` offer every app action as a tool. The server never imports an app. `tools/list` runs `epicenter <app> --json` for each home entry in its own child, so an app that fails to load loses only its own tools and says why on stderr. Each `tools/call` runs `epicenter <app> <words> --input <json>` in a fresh child, so an edit between calls is seen by the next. `serve --stdio` uses stdin and stdout for MCP.

When a call's answer says it committed, the HTTP server pushes that app's branch to `origin` by name in the background, if the app has an `origin`; it never pushes to `upstream`. Push failures go to stderr and leave the commit local.

## A write is one commit

Every write commits itself, from the command line, `serve --stdio`, or HTTP alike ([ADR-0850](../../docs/adr/0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md)). When an action that is not read-only returns, the run commits what changed in the app's folder as `<app>: <action words> [first positional value]` (one line, cut at 60 characters) and answers `committed` with the commit. A thrown action, a read-only one, a write that changed nothing, and a folder in no repository make no commit; running an action needs nothing from Git. When the commit fails, the answer keeps `returned` and adds `uncommitted` with why and `epicenter sync <app>` as the next step.

Writes to one app take turns: each holds the app's lock, a file under the temporary folder named for the app's path, from before it runs until its commit, so a write that reads, changes, and writes back a file never loses another's change. A lock whose process died is taken over; a write that waits 30 seconds throws. Read-only runs take no lock.

The commit runs `git add -A -- .` and then `git commit -m <subject> -- .` from the app's folder, so it takes everything changed in the folder, staged or not, and nothing outside it. An app inside a larger repository commits into that repository and leaves the rest of it alone. Before staging, when the folder's `.gitattributes` mentions `filter=lfs` and `git config filter.lfs.process` is empty, it stops with a message ending `run: git lfs install`, since Git without the filter would store the whole file ([ADR-0856](../../docs/adr/0856-binary-files-go-through-git-lfs.md)). When another Git process holds `index.lock`, it retries for about 2 seconds. Either way the write stays, uncommitted. It never pushes.

`folder` is a convenience, not a sandbox. Paths are normalized and `.git` is refused; writes replace a whole file at once and are recorded nowhere. `folder.path` is the folder, and an action may use `node:fs` too. An action never commits.

## What a run answers

With `--json`, stdout is one JSON object, and MCP returns the same object as `structuredContent`, with `isError` when the exit code is 1 or 2:

```txt
{ "returned": <value>, "committed"?: <sha> }  exit 0
{ "threw": { "message", "thrown"? } }         exit 1, also when the run ended without an answer
{ "error": { "name", "message", "next"? } }   exit 2, nothing ran
{ "returned": <value>, "uncommitted": { "message", "next" } }  exit 3: it ran, and the commit failed
```

Exit 3 is not an error over MCP: the action ran, and a client that retried it would run it twice.

An action that returns nothing answers `{ "returned": null }`. An action that throws a tagged error (`{ name, message, …fields }`) reports it whole as `thrown`. Without `--json`, stdout carries only the returned value (a string as is, anything else as JSON), and stderr carries what the action threw, or why nothing ran followed by `Run: <next step>` when there is one.

## Syncing

`epicenter sync [<app>]` commits what is left, pulls from `origin`, and pushes to it ([ADR-0851](../../docs/adr/0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md)). For each app in the home, or the one named, one after another, from its folder:

1. `git add -A -- .`, and when anything changed, a commit `sync: <app> (<n> files)` of the folder only, with the same LFS check as a write's commit.
2. When the app has an `origin`: `git fetch origin`, a rebase onto `origin`'s copy of the branch when there is one (with `--autostash`), then `git push origin HEAD:<branch>`. An app without `origin` is committed and not pushed. Nothing goes to `upstream`, the starter an app came from, or to whatever the branch tracks.

An app inside a larger repository commits only its own folder but pulls and pushes the whole repository, so other uncommitted files there are set aside and put back by `--autostash`; when they cannot be put back, Git keeps them in its stash and sync says so. A rebase that stops on a conflict is aborted with `git rebase --abort`, so the folder is never left mid-rebase; the commits stay local and the next step is `git -C <folder> pull --rebase origin <branch>`. A pull or push that fails, offline for instance, leaves the commit local and says it was not pushed. A folder that is not a repository reports Git's error. One app's failure never stops the others.

```json
{
  "apps": [
    {
      "app": "reading",
      "folder": "/Users/you/Epicenter/reading",
      "committed": { "subject": "sync: reading (2 files)", "files": 2 },
      "pushed": true,
      "origin": { "ahead": 0, "behind": 0 }
    }
  ]
}
```

`committed` is `null` when nothing was left; `origin` is how far the branch is from `origin`'s copy of it afterwards, or `null` when there is none; `error` is `{ message, next? }` when the app did not finish syncing. Without `--json`, stdout has one line per app, such as `reading: committed sync: reading (2 files); pushed; 0 ahead of origin, 0 behind`, and stderr has each error with its `Run:` line. Exit 0 when every app synced, 1 when any did not, 2 when the app named is not in the home.

## Adding apps

An app becomes one of yours in one of three ways, and its name is its entry in `~/Epicenter`:

- `epicenter new <name> --from <git url|path>` makes it from a starter, a repository with no data ([ADR-0866](../../docs/adr/0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md)).
- `epicenter new <name>` makes it there from the built-in template.
- `epicenter link <folder> [<name>]` links a folder with an `epicenter.json` into `~/Epicenter` where it lives, whatever it is: a repository, a folder inside one, or neither. It commits and moves nothing ([ADR-0852](../../docs/adr/0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md)). Without `<name>` it takes the folder's own name.

`epicenter new <name> --from <git url|path>` clones the starter into `~/Epicenter/<name>`, renames the clone's remote to `upstream`, and leaves the branch tracking nothing, so no push reaches the starter. A path must be a repository's root, since Git clones only whole repositories. The clone must have a valid `epicenter.json`; otherwise it is removed. When the app has `ui/package.json`, it then builds the UI (below); a failed build leaves the app made, says why, and exits 1 with `epicenter update <name>` as the next step.

`epicenter new <name>` makes the folder from the built-in template: `epicenter.json` with its `$schema`, and a `.gitignore` of exactly `node_modules/`, `.cache/`, `*.local`, and `*.local.*` ([ADR-0858](../../docs/adr/0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md)). It runs `git init` and commits the template as `new <name>`. It writes no `.gitattributes`: an app that comes to hold binary files routes them through Git LFS in its own ([ADR-0856](../../docs/adr/0856-binary-files-go-through-git-lfs.md)).

Each prints the folder on stdout and `Run: epicenter <name>` on stderr. A name already in the home, ignoring case, is refused, as is a name that is one of the commands.

## Updating from a starter

`epicenter update [<app>]` brings a starter's changes into each app with an `upstream`, or the one named, one after another (`src/update.ts`). Holding the app's write lock, so no action writes meanwhile, it refuses an app with uncommitted changes (`epicenter sync <app>` commits them), runs `git fetch upstream`, and merges the branch `upstream/HEAD` names as `<app>: update from upstream`. A merge that stops on a conflict is aborted, leaving the app as it was, and the next step is `git -C <folder> merge upstream/<branch>`. It then lists each file of each collection that no longer fits `epicenter.json`, as `<path>: <what is wrong>`, since Git merges code and does not migrate data, and builds the UI. An app without `upstream` is left alone. With `--json` it answers `{ "apps": [{ app, folder, upstream, merged, built, misfits, error? }] }`; it exits 0 when every app updated and 1 when any did not.

The UI is an app's `ui/`, a project of its own whose `build` script writes `../.cache/ui/`. Building it runs `bun install` and `bun --bun run build` in `ui/` with the Bun that runs `epicenter`; the compiled `epicenter` is Bun itself under `BUN_BE_BUN=1`, so a computer needs no other program. A build that fails, or writes no `.cache/ui/index.html`, puts the last built UI back.

What an app can rebuild lives in files it gitignores in its folder, such as `.cache/` ([ADR-0854](../../docs/adr/0854-an-apps-cache-is-the-files-it-gitignores.md)).

The home is `$HOME/Epicenter`; tests move it by setting `HOME`. Tests replace the Keychain with process-local stores through `EPICENTER_TEST_SECRETS`, JSON keyed by service, such as `{"epicenter.reading":{"token":"value"}}`, so they never reach the real one.

Compile the executable from the repository root:

```sh
bun run --cwd packages/cli compile
```

## Tests

Run `bun test <file>` in `packages/cli` one file per process when memory is short. `acceptance.*.test.ts` runs the real `epicenter` against a temporary `HOME`, one test per acceptance ID, with bare repositories in temporary folders standing in for remotes.
