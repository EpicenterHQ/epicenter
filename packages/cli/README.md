# The epicenter command

`epicenter` runs the apps in an Epicenter as commands and MCP tools. An Epicenter is a folder with `EPICENTER.md` ([ADR-0868](../../docs/adr/0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md)); its direct child folders with an `epicenter.ts` that default-exports `defineApp(...)` are apps, each with its collections and actions ([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md), [ADR-0857](../../docs/adr/0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md)).

The command uses the nearest Epicenter at or above the current directory. Otherwise it uses `EPICENTER_ROOT`, then `$HOME/Epicenter`. A chosen folder without `EPICENTER.md` needs `epicenter init <folder>`. The marker is a note for people whose front matter, read as an app's files are, may hold three fields: `port`, a whole number from 0 to 65535 that `serve` listens on, 4747 when absent; `owners`, a list of tailnet logins; and `public`, a Funnel port (443, 8443, or 10000). `owners` and `public` are for a public address ([ADR-0871](../../docs/adr/0871-a-public-address-signs-clients-in-with-better-auths-mcp-plugin-and-the-owner-approves-from-the-tailnet.md)), which `serve` does not offer yet, so they are checked and otherwise unused. Any other field, or a value that does not fit, is refused, one line per problem. An empty file is a valid marker. The folder's basename is its display name. A folder marked by `epicenter.root.json`, the marker before it, is refused with the step: write `EPICENTER.md` with its `port`, then delete `epicenter.root.json`. `epicenter init [<folder>] [--port <n>]` makes the folder, writes `EPICENTER.md` with the port, and adds starter `AGENTS.md` guidance if there is none. Epicenters cannot nest.

```sh
epicenter
epicenter reading
epicenter reading log 30 --book Dune
epicenter reading log 30 --json
epicenter reading log --help
epicenter reading books set books/dune.md --finished null
epicenter reading books set --input '{"path":"books/dune.md","finished":"2026-11-10"}'
epicenter init ~/Epicenter
epicenter new notes
epicenter new recipes --from https://github.com/someone/recipes
epicenter update
epicenter build
epicenter sync
epicenter sync reading
epicenter sync reading -m "Tidy the book notes"
epicenter history reading
epicenter undo reading
epicenter serve
epicenter serve --stdio
epicenter --version
```

The commands are `init`, `new`, `update`, `build`, `sync`, `history`, `undo`, and `serve`, each with its usage and help in one table (`src/commands.ts`); any other first word names an app. `--json` and `--help` (`-h`) go anywhere before `--`; `--version` is read only on its own. Each command parses its own flags with `node:util`'s `parseArgs`, strictly, so `--port=4800` and `--port 4800` both work; any misuse, an unknown flag, a flag without its value, or a wrong number of words, answers `Usage: <its usage line>` with `epicenter <command> --help` as the next step. `epicenter` lists the Epicenter folder, its apps, and problems in individual apps; an app with changes not yet in its history is marked, as `(3 changes not yet in history; 2 snapshots not backed up)`. Its JSON listing has an `epicenter` folder string. An empty Epicenter says `No apps yet. Run: epicenter new <name>`. `epicenter <app>` lists its actions, each with a short usage line, and `epicenter <app> <action> --help` explains every field. Words that name no action list the app's actions, exit 2. Above its actions, it says how many changes are not yet in the app's history and how many snapshots have not been backed up, with `Run: epicenter sync <app>`.

A flag's value is read as its field's type ([ADR-0867](../../docs/adr/0867-the-command-line-spells-an-actions-json-input-and-null-removes-a-field-there-as-everywhere.md)): a number for a number, `--done` or `--done=false` for a switch, every value of a repeated flag for a list, one of its choices for a choice (an error names them), and `null` for a field that takes `null`, which a collection's `set` reads as "remove it". `--no-done` is refused with `--done=false` as the way to say false. `--input <json>` gives the whole input as one JSON object instead, with positional fields inside it and nothing beside it; `--input -` reads it from stdin. The text `null` for a field that takes `null` is given this way. `epicenter --json` prints each app's name, description, folder, each collection's path and fields as JSON Schema, and each action as the MCP tool `serve` offers, with all four annotations explicit; `epicenter <app> --json` prints the same for one app. Each app's JSON adds `status` when anything is not yet in its history: `{ "pending": <n>, "unpushed"?: <n> }`, from `git status` and the difference from the existing `origin/<branch>` tracking ref. An app with no tracking ref has no `unpushed` count. A folder without `epicenter.ts` is not an app and is not listed.

`epicenter` supplies `@epicenter/app` to every `epicenter.ts` it loads, so a folder needs no `node_modules` to run. Listing and running an app only read it. Loading an app imports its `epicenter.ts`, whose `defineCollection`, `defineAction`, and `defineApp` calls check what they are given, then calls `defineApp` on the default export, which checks its whole shape. An app is listed under problems, and does not run, when its file throws while loading or its export fails that check, with each line as `epicenter.ts: <line>`, or when its default export is not an object, as `epicenter.ts does not export defineApp(...) by default`. One app's broken export never stops the others from being listed ([ADR-0857](../../docs/adr/0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md)).

## Each run is its own process

The `epicenter` you start only relays. It runs the action in a child `epicenter` whose stdout and stderr both go to your stderr, forwards SIGINT and SIGTERM, and reads the child's answer from a report file once the child exits. So nothing an action prints, through any `console` method or `process.stdout`, reaches the answer. A child that ends without an answer, killed or calling `process.exit`, answers that it threw, naming its exit code or signal; what it wrote stays pending for the next snapshot, which lists it as changed outside epicenter. After a run that is not read-only, the child's report names the app, the call, the paths written through `folder`, and whether it threw, and the parent, the `epicenter` you started or `serve`, commits those paths. A child whose parent dies finishes the run.

`epicenter serve` starts an HTTP server on `127.0.0.1` at the port in `EPICENTER.md`, or 4747 when the marker has none. `--host <address>` and `--port <n>` override those settings. It serves MCP at `POST /`, the launcher at `GET /`, and each app's UI at `/<app>/`: its built `.cache/ui/` ([ADR-0866](../../docs/adr/0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md)). The launcher links to apps with a UI; a `GET /` asking for an event stream gets 405, since the server keeps no MCP session. Any later path of the server's own starts with `.`, which no app name can. An Origin must match the request Host; requests without Origin are accepted. A reverse proxy such as `tailscale serve` can provide HTTPS.

Both HTTP and `serve --stdio` offer every app action as a tool and send the Epicenter's `AGENTS.md`, when present, as MCP server instructions. The server never imports an app. `tools/list` runs `epicenter <app> --json` for each app entry in its own child, so an app that fails to load loses only its own tools and says why on stderr. Each `tools/call` runs `epicenter <app> <words> --input <json>` in a fresh child from the Epicenter folder, so an edit between calls is seen by the next. `serve --stdio` uses stdin and stdout for MCP.

After each call that is not read-only, either transport commits the paths the call wrote before it answers, one commit at a time per app. A commit failure goes to stderr; the paths remain visible in status.

The HTTP server backs up on a clock: when it starts, every 5 minutes, and when it receives SIGINT or SIGTERM, it does for each app what `epicenter sync <app>` does. It snapshots what is pending as `<app>: changed outside epicenter` and pushes the branch to `origin` by name when the branch is ahead of its `origin` tracking ref or there is no tracking ref yet; it never pushes to `upstream`. So a call's commit reaches the backup within 5 minutes, not at once. A tick skips an app while a call to it runs, and a call waits for the app's snapshot already running before its run starts, so the call's one commit holds everything it wrote. A failure goes to stderr, once until it changes, and leaves the commits local. `serve` says it is serving as soon as it listens, while its first backup runs, and on a signal it waits at most 10 seconds for its last backup before it exits.

## Runs never commit; each writer commits its own boundary

A run changes files and commits nothing ([ADR-0850](../../docs/adr/0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md)). A write run reports its call as `<app>: <action words> [first positional value]` (one line, cut at 60 characters), the paths it wrote through `folder`, and whether it threw. Running an action needs nothing from Git; a folder outside a repository is never committed. Three kinds of writer commit, each with the boundary it knows (`src/snapshot.ts`):

- A call: the command line after a write run it ran itself, and `serve` after each write call, commit exactly the paths the run wrote that changed. One `git status` of those paths, each given literally, drops what is unchanged, ignored, or created and then deleted; `git add -A` and `git commit` of what is left leave every other pending or staged change as it was. The subject is the call, or `<call> (threw)`, with no body.
- An agent that edits an app's files itself: `epicenter sync <app> -m "<what it did>"` snapshots what is pending as `<app>: <what it did>` and backs it up. A plain `git commit` in the app's folder works too.
- Anything else, such as an editor: `epicenter sync`, the first step of `epicenter undo` and of `epicenter update`, and `serve`'s clock snapshot what is pending as `<app>: changed outside epicenter`.

A snapshot with no call runs `git add -A` and `git commit` from the app's folder with the pathspec `.`, so it takes everything changed in the folder that Git does not ignore, staged or not, and nothing outside it. Its message is the subject alone; `epicenter history` reads its paths from Git. An app inside a larger repository commits into that repository and leaves the rest of it alone.

Each app's `.gitignore` keeps `*.local` and `*.local.*` on this computer, as the template and starters write it. Before staging, a commit that would take such a file refuses with `<path> would be committed; add *.local and *.local.* to <app>/.gitignore`. Nothing changed makes no commit. Before staging, when the folder's `.gitattributes` mentions `filter=lfs` and `git config filter.lfs.process` is empty, it stops with `git lfs install` as the next step ([ADR-0856](../../docs/adr/0856-binary-files-go-through-git-lfs.md)), and while a merge, rebase, revert, or cherry-pick is underway it stops with `git -C <folder> status`. When another Git process holds `index.lock`, it retries for about 2 seconds. A failed commit is `{ message, next? }`. It changes no answer or exit code: after a call, stderr reads `<app>: not yet in history: <message>` and `Run: <next>`, or `Run: epicenter sync <app>` when the failure names no next step. The pending paths remain visible in status. A commit never pushes; only `sync` and `serve`'s clock do.

There is no lock: writes to one app run at once. Git's `index.lock` keeps commits apart, and `folder.update` keeps changes to one file apart: it writes only over the text its change read, so every collection write lands. `folder.write` is last-write-wins.

A read-only run, of an action with `readOnlyHint: true`, never commits. In it, `folder.write`, `folder.writeBytes`, `folder.update`, and `folder.delete` throw before doing anything, naming the action: `The action "<words>" is read-only, so it cannot write <path>`. A `.local` path is let through, since no commit takes it: an action that only reads may still refresh a token kept in `google.local.md` ([ADR-0870](../../docs/adr/0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md)). A raw `node:fs` write is not caught.

`folder` is a convenience, not a sandbox. Paths are normalized and `.git` is refused; writes replace a whole file at once, through a file beside it named `*.local`, which the app's `.gitignore` keeps out of every commit. A replaced file keeps its mode, and a new `.local` file is `0600`, since an app's secrets are `.local` files. `folder.path` is the folder, and an action may use `node:fs` too; what it writes that way is a change from outside epicenter.

## What a run answers

With `--json`, stdout is one JSON object, and MCP returns the same object as `structuredContent`, with `isError` when the exit code is 1 or 2:

```txt
{ "returned": <value> }                      exit 0
{ "threw": { "message", "thrown"? } }        exit 1, also when the run ended without an answer
{ "error": { "name", "message", "next"? } }  exit 2, nothing ran
```

An action that returns nothing answers `{ "returned": null }`. An action that throws a tagged error (`{ name, message, …fields }`) reports it whole as `thrown`. Without `--json`, stdout carries only the returned value, rendered by its structure, and stderr carries what the action threw, or why nothing ran followed by `Run: <next step>` when there is one. MCP's text for a thrown action is the same stderr. The returned value reads this way (`src/output.ts`):

- An object prints one `key: value` line per defined key, in order. A string with a newline prints as `key: |` followed by indented lines. Other strings print plainly unless empty, padded with spaces, starting with a quote or `|`, or shaped like JSON other than a plain word; those print as JSON strings. Numbers, booleans, null, arrays, and nested objects print as compact JSON values. A `problems` key stays on stdout like any other key.
- An array of objects without multiline strings prints one row per object, with `key: value` pairs separated by two spaces. If an object has a multiline string, each object prints on its own lines, with a blank line between objects.
- An empty array prints nothing. A string prints as is, with a final newline added if needed. Other arrays and scalars print as JSON.

```txt
$ epicenter tasks get tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md
path: tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md
time: 2026-11-10T09-30-00-000Z-k3x9a2f8
title: Email Sam the slides
done: false
due: 2026-11-12
body: |
  The deck is in Drive.
```

A placeholder such as `time` prints as a field: the command reads only the answer, which does not say which keys came from the path.

## Syncing

`epicenter sync [<app> [-m <message>]]` takes a snapshot and pushes to `origin`, the home's optional backup ([ADR-0851](../../docs/adr/0851-an-app-has-one-home-and-an-optional-push-only-backup.md)). For each app in the Epicenter, or the one named, one after another, it commits pending changes and then, when `origin` exists, runs `git push origin HEAD:<branch>` if the branch is ahead of its `origin` tracking ref or has none yet; `serve`'s clock follows the same rule. The snapshot reads `<app>: changed outside epicenter`, or with `-m` (`--message`), which needs an app, `<app>: <message>`; a message must be one line of text. It never fetches, pulls, rebases, stashes, or force pushes. An app without `origin` gets a local snapshot. Nothing goes to `upstream`, the starter an app came from, or to whatever the branch tracks.

A refused non-fast-forward push leaves both histories as they were. Sync says the backup at origin has changes this computer does not and nothing was overwritten. It suggests `git -C <folder> fetch origin && git -C <folder> log HEAD..origin/<branch>` to inspect those commits. The unpushed count remains in status; no push error file is stored. Other push failures leave the commit local. One app's failure never stops the others. An app inside a larger repository snapshots only its folder and pushes the whole repository's history.

```json
{
  "apps": [
    {
      "app": "reading",
      "folder": "/Users/you/Epicenter/reading",
      "committed": { "subject": "reading: changed outside epicenter", "files": 2 },
      "pushed": true,
      "origin": { "ahead": 0 }
    }
  ]
}
```

`committed` is the snapshot's subject and file count, or `null` when nothing was pending; `origin` is how many commits the branch is ahead of its locally known `origin` tracking ref, or `null` when there is none. Sync does not fetch, so it cannot say how far the backup is ahead. `error` is `{ message, next? }` when the app did not finish syncing. Without `--json`, stdout has one line per app, such as `reading: committed reading: changed outside epicenter; pushed; 0 ahead of origin`, and stderr has each error with its `Run:` line. Exit 0 when every app synced, 1 when any did not, 2 when the app named is not in the Epicenter.

## History and undo

`epicenter history <app> [--limit <n>]` lists the app's commits, newest first, 20 unless `--limit` gives another positive whole number (`src/history.ts`). It reads `git log --first-parent --name-only` of the app's own repository, so an update's merge is one entry whose paths are what it brought in; an app whose folder is not the root of its own repository is refused. Each line is the short commit, the local time, and the subject, with each path the commit changed beneath; an undo reads as `undid <subject>`.

```txt
$ epicenter history tasks
9c1e2f4  2026-11-11 09:41  undid tasks: add Water the plants
                           tasks/2026-11-11T09-30-00-000Z-p2m7c4d1.md
5b7a0d3  2026-11-11 09:30  tasks: add Water the plants
                           tasks/2026-11-11T09-30-00-000Z-p2m7c4d1.md
e02c9a1  2026-11-11 09:12  tasks: changed outside epicenter
                           tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md
```

With `--json` it answers an array of `{ commit, date, subject, changed, undid? }`: `date` is the author date in ISO 8601, `changed` every path the commit changed from its first parent, and `undid` the commit an undo reverts.

`epicenter undo <app> [<commit>]` reverts one commit as a new one, so nothing is lost:

1. It takes a snapshot of whatever is pending, so an edit not yet in history is kept there. Without `<commit>`, that snapshot is the one undone.
2. Without `<commit>`, it walks back from HEAD to the newest commit that is not an undo and has not been undone. An undo is a commit whose body has Git's line `This reverts commit <sha>.`; an undo that is itself undone no longer hides the commit it reverted. So `undo` again goes further back, and `undo <undo commit>` brings back what that undo removed.
3. It runs `git revert --no-commit` and commits as `<app>: undid <subject>`, keeping Git's `This reverts commit <sha>.` line. It never pushes; `sync` or `serve`'s clock backs the undo up.

It refuses, exit 2 with `{ "error": { "name": "Refused", "message", "next"? } }`, and leaves the folder's files as they were: a commit not in the app's history, a newest commit that is not a snapshot, since its subject does not start with `<app>: ` (the first commit, or one made with Git directly, which can still be named), a revert Git refuses, such as a merge's, with Git's message, a revert that conflicts (it is aborted, naming the conflicting files), a revert that changes nothing, such as one of a commit already undone, and a snapshot that fails, which includes an app in the middle of a merge, rebase, revert, or cherry-pick. A named commit is checked before the snapshot, so its refusal adds nothing to history. Without `--json`, stdout says what was undone, as `undid tasks: add Water the plants`; with it, `{ "undid": <commit>, "commit": <the undo's commit> }`.

## Adding apps

An app becomes one of yours when it is a direct child entry of the selected Epicenter:

- `epicenter new <name> --from <git url|path>` makes it from a starter, a repository with no data ([ADR-0866](../../docs/adr/0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md)).
- `epicenter new <name>` makes it there from the built-in template.
An entry may also be a symlink to an app elsewhere. The CLI follows the link when listing or running it.

`epicenter new <name> --from <git url|path>` clones the starter into `<Epicenter>/<name>`, renames the clone's remote to `upstream`, and leaves the branch tracking nothing, so no push reaches the starter. A path must be a repository's root, since Git clones only whole repositories. The clone must have an `epicenter.ts` that loads; otherwise it is removed. When the app has `ui/package.json`, it then builds the UI (below); a failed build leaves the app made and exits 1: stderr says `<name>: the UI did not build: <why>` and `Run: epicenter build <name>`, and `--json` adds `error: { message, next }` to `{ name, folder }`.

`epicenter new <name>` makes the folder from the built-in template: an `epicenter.ts` that default-exports `defineApp` with a description to fill in and no collections or actions, and a `.gitignore` of exactly `node_modules/`, `.cache/`, `*.local`, and `*.local.*` ([ADR-0858](../../docs/adr/0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md)). It runs `git init` and commits the template as `new <name>`. It writes no `.gitattributes`: an app that comes to hold binary files routes them through Git LFS in its own ([ADR-0856](../../docs/adr/0856-binary-files-go-through-git-lfs.md)).

Each prints the folder on stdout and `Run: epicenter <name>` on stderr. A name already in the Epicenter, ignoring case, is refused, as is a name that is one of the commands.

## Updating from a starter

`epicenter update [<app>]` brings a starter's changes into each app with an `upstream`, or the one named, one after another (`src/update.ts`). It snapshots what is pending as `<app>: changed outside epicenter`, as `undo` does, runs `git fetch upstream`, and merges the branch `upstream/HEAD` names as `<app>: update from upstream`. A merge that stops on a conflict is aborted, leaving the app as it was, and the next step is `git -C <folder> merge upstream/<branch>`. It then checks that the merged `epicenter.ts` loads and builds the UI. Git merges code and does not migrate data: a file that no longer fits its collection's fields says so in the `problems` of every read. An app without `upstream` is left alone. With `--json` it answers `{ "apps": [{ app, folder, upstream, merged, built, error? }] }`; it exits 0 when every app updated and 1 when any did not.

The UI is an app's `ui/`, a project of its own whose `build` script writes `../.cache/ui/`. Building it runs `bun install` and `bun --bun run build` in `ui/` with the Bun that runs `epicenter`; the compiled `epicenter` is Bun itself under `BUN_BE_BUN=1`, so a computer needs no other program. A build that fails, or writes no `.cache/ui/index.html`, puts the last built UI back.

`epicenter build [<app>]` builds every app's UI, or one app's. It reports `UI built`, `no ui/`, or a build error for each app. With `--json` it answers `{ "apps": [{ app, folder, built, error? }] }`. A build error exits 1; another app can still build.

What an app can rebuild lives in files it gitignores in its folder, such as `.cache/` ([ADR-0854](../../docs/adr/0854-an-apps-cache-is-the-files-it-gitignores.md)).

Compile the executable from the repository root:

```sh
bun run --cwd packages/cli compile
```

## Tests

Run `bun test <file>` in `packages/cli` one file per process when memory is short. `acceptance.*.test.ts` runs the real `epicenter` against a temporary `HOME`, one test per acceptance ID, with bare repositories in temporary folders standing in for remotes.
