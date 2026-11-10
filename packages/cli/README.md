# The epicenter command

`epicenter` runs the apps in `~/Epicenter` as commands and MCP tools. An app is a folder with an `epicenter.json`; its `epicenter.ts`, if present, defines its actions ([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md), [ADR-0857](../../docs/adr/0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md)).

```sh
epicenter
epicenter reading
epicenter reading log 30 --book Dune
epicenter reading log 30 --json
epicenter ./worktree log 30
epicenter reading log --help
epicenter new notes
epicenter link ~/Code/vault
epicenter install https://github.com/someone/recipes
epicenter sync
epicenter sync reading
epicenter serve
epicenter serve --stdio
epicenter --version
```

The commands are `new`, `link`, `install`, `sync`, and `serve`; any other first word names an app. `--json` and `--help` (`-h`) go anywhere before `--`; `--version` is read only on its own. The listing shows each app's actions and the problems in individual apps. `epicenter --json` prints each app's declaration: its name, description, folder, the collections from its `epicenter.json`, and each action as the MCP tool `serve` offers, with all four annotations explicit. The listing reads nothing from Git. A folder with neither `epicenter.json` nor `epicenter.ts` is not an app and is not listed.

`epicenter` supplies `@epicenter/app` to every `epicenter.ts` it loads, so a folder needs no `node_modules` to run. Listing and running an app only read it. An invalid `epicenter.json` is reported before any of the app's code is imported.

## Each run is its own process

The `epicenter` you start only relays. It runs the action in a child `epicenter` whose stdout and stderr both go to your stderr, forwards SIGINT and SIGTERM, and reads the child's answer from a report file once the child exits. So nothing an action prints, through any `console` method or `process.stdout`, reaches the answer. A child that ends without an answer, killed or calling `process.exit`, answers that it threw, naming its exit code or signal. A child whose parent dies finishes the run.

`epicenter serve` starts an HTTP server on `127.0.0.1:4747`. `--host <address>` and `--port <n>` change where it listens. It serves MCP at `POST /`, the launcher at `GET /`, `connect` from `@epicenter/app/client` as plain JavaScript at `/.client.js`, and each app's view at `/<app>/`: its `.cache/view/` when there is one, else its `view/`. The launcher links to apps with a view; a `GET /` asking for an event stream gets 405, since the server keeps no MCP session. The server's own paths start with `.`, which no app name can. An Origin must match the request Host; requests without Origin are accepted. A reverse proxy such as `tailscale serve` can provide HTTPS.

Both HTTP and `serve --stdio` offer every app action as a tool. The server never imports an app. `tools/list` runs `epicenter <app> --json` for each home entry in its own child, so an app that fails to load loses only its own tools and says why on stderr. Each `tools/call` runs `epicenter <app> <words> --input <json>` in a fresh child, so an edit between calls is seen by the next. `--input` takes the action's input as one JSON object instead of flags. `serve --stdio` uses stdin and stdout for MCP.

When a call's answer says it committed, the HTTP server pushes that app in the background if its branch has an upstream. Push failures go to stderr and leave the commit local.

## A write is one commit

Every write commits itself, from the command line, `serve --stdio`, or HTTP alike ([ADR-0850](../../docs/adr/0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md)). When an action that is not read-only returns, the run commits what changed in the app's folder as `<app>: <action words> [first positional value]` (one line, cut at 60 characters) and answers `committed` with the commit. A thrown action, a read-only one, a write that changed nothing, and a folder in no repository make no commit; running an action needs nothing from Git. When the commit fails, the answer keeps `returned` and adds `uncommitted` with why and `epicenter sync <app>` as the next step.

Writes to one app take turns: each holds the app's lock, a file under the temporary folder named for the app's path, from before it runs until its commit, so a write that reads, changes, and writes back a file never loses another's change. A lock whose process died is taken over; a write that waits 30 seconds throws. Read-only runs take no lock.

`folder` is a convenience, not a sandbox. Paths are normalized and `.git` is refused; writes replace a whole file at once and are recorded nowhere. `folder.path` is the folder, and an action may use `node:fs` too. An action may commit sooner, under its own message:

```ts
await folder.commit('Add 12 words');
```

`folder.commit(message)` runs `git add -A -- .` and then `git commit -m <message> -- .` from the app's folder, so it commits everything changed in the folder, staged or not, and nothing outside it. An app inside a larger repository commits into that repository and leaves the rest of it alone. With nothing changed it does nothing. It throws Git's own error when the folder is in no repository. Before staging, when the folder's `.gitattributes` mentions `filter=lfs` and `git config filter.lfs.process` is empty, it throws a message ending `run: git lfs install`, since Git without the filter would store the whole file ([ADR-0856](../../docs/adr/0856-binary-files-go-through-git-lfs.md)). When another Git process holds `index.lock`, it retries for about 2 seconds, then throws Git's message. It never pushes.

## What a run answers

With `--json`, stdout is one JSON object, and MCP returns the same object as `structuredContent`, with `isError` when the exit code is not 0:

```txt
{ "returned": <value>, "committed"?: <sha> }  exit 0
{ "returned": <value>, "uncommitted": { "message", "next" } }  exit 0, the commit failed
{ "threw": { "message", "thrown"? } }         exit 1, also when the run ended without an answer
{ "error": { "name", "message", "next"? } }   exit 2, nothing ran
```

An action that returns nothing answers `{ "returned": null }`. An action that throws a tagged error (`{ name, message, …fields }`) reports it whole as `thrown`. Without `--json`, stdout carries only the returned value (a string as is, anything else as JSON), and stderr carries what the action threw, or why nothing ran followed by `Run: <next step>` when there is one.

## Syncing

`epicenter sync [<app>]` commits what is left and pulls before pushing ([ADR-0851](../../docs/adr/0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md)). For each app in the home, or the one named, one after another, from its folder:

1. `git add -A -- .`, and when anything changed, a commit `sync: <app> (<n> files)` of the folder only, with the same LFS check as `folder.commit`.
2. When the branch has an upstream, `git pull --rebase --autostash`, then `git push`. Which branch is Git's: the upstream and `push.default` the clone already has. A branch that tracks nothing is committed and not pushed.

An app inside a larger repository commits only its own folder but pulls and pushes the whole repository, so other uncommitted files there are set aside and put back by `--autostash`; when they cannot be put back, Git keeps them in its stash and sync says so. A pull that stops on a conflict is aborted with `git rebase --abort`, so the folder is never left mid-rebase; the commits stay local and the next step is `git -C <folder> pull --rebase`. A pull or push that fails, offline for instance, leaves the commit local and says it was not pushed. A folder that is not a repository reports Git's error. One app's failure never stops the others.

```json
{
  "apps": [
    {
      "app": "reading",
      "folder": "/Users/you/Epicenter/reading",
      "committed": { "subject": "sync: reading (2 files)", "files": 2 },
      "pushed": true,
      "upstream": { "ahead": 0, "behind": 0 }
    }
  ]
}
```

`committed` is `null` when nothing was left; `upstream` is how far the branch is from its upstream afterwards, or `null` when it tracks none; `error` is `{ message, next? }` when the app did not finish syncing. Without `--json`, stdout has one line per app, such as `reading: committed sync: reading (2 files); pushed; 0 ahead, 0 behind`, and stderr has each error with its `Run:` line. Exit 0 when every app synced, 1 when any did not, 2 when the app named is not in the home.

## Adding apps

An app becomes one of yours in one of three ways, and its name is its entry in `~/Epicenter`:

- `epicenter new <name>` makes it there from the built-in template.
- `epicenter link <folder> [<name>]` links a folder with an `epicenter.json` into `~/Epicenter` where it lives, whatever it is: a repository, a folder inside one, or neither. It commits and moves nothing ([ADR-0852](../../docs/adr/0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md)). Without `<name>` it takes the folder's own name.
- `epicenter install <source>` puts an app's code there from a source kept apart from its data (below).

`epicenter new <name>` makes the folder from the built-in template: `epicenter.json` with its `$schema`, and a `.gitignore` of exactly `node_modules/`, `.cache/`, `*.local`, and `*.local.*` ([ADR-0858](../../docs/adr/0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md)). It runs `git init` and commits the template as `new <name>`. It writes no `.gitattributes`: an app that comes to hold binary files routes them through Git LFS in its own ([ADR-0856](../../docs/adr/0856-binary-files-go-through-git-lfs.md)).

`epicenter install <path|git url> [<name>]` puts an app's code into `~/Epicenter/<name>` from its source, a folder or a repository kept apart from the app's data (`src/install.ts`). The first install makes the app as `new` does. Each install copies the app's code, `epicenter.json`, `epicenter.ts`, and `view/`, removing what the source no longer has, and commits it as `install <name>` with `Source:` and `Source-Commit:` trailers, overwriting an edit made to it in place (its commit keeps it). When the source's `package.json` has a `build` script, it runs it with `VIEW_BASE=/<name>` and puts its `build/` in the app's `.cache/view/`, which Git ignores. It never touches the app's data. An install that changes no code commits nothing, unless its source differs from the one recorded, which it records in an empty commit. `epicenter install <app>` installs again from the recorded source. A source is a URL or a path holding a `/` or starting with `.` or `~`; a bare word is an installed app.

Each prints the folder on stdout and `Run: epicenter <name>` on stderr. A name already in the home, ignoring case, is refused, as is a name that is one of the commands.

What an app can rebuild lives in files it gitignores in its folder, such as `.cache/` ([ADR-0854](../../docs/adr/0854-an-apps-cache-is-the-files-it-gitignores.md)).

The home is `$HOME/Epicenter`; tests move it by setting `HOME`. Tests replace the Keychain with process-local stores through `EPICENTER_TEST_SECRETS`, JSON keyed by service, such as `{"epicenter.reading":{"token":"value"}}`, so they never reach the real one.

Compile the executable from the repository root:

```sh
bun run --cwd packages/cli compile
```

## Tests

Run `bun test <file>` in `packages/cli` one file per process when memory is short. `acceptance.*.test.ts` runs the real `epicenter` against a temporary `HOME`, one test per acceptance ID, with bare repositories in temporary folders standing in for remotes.
