# The epicenter command

`epicenter` runs the apps in an Epicenter as commands and MCP tools. An Epicenter is a folder with `EPICENTER.md` ([ADR-0868](../../docs/adr/0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md)); its direct child folders with an `epicenter.ts` that default-exports `defineApp(...)` are apps, each with its collections and actions ([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md), [ADR-0857](../../docs/adr/0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md)).

The command uses the nearest Epicenter at or above the current directory. Otherwise it uses `EPICENTER_ROOT`, then `$HOME/Epicenter`. A chosen folder without `EPICENTER.md` needs `epicenter init <folder>`. The marker is a note for people whose front matter, read as an app's files are, may hold one field: `port`, a whole number from 0 to 65535 that `serve` listens on, 4747 when absent. Any other field, or a value that does not fit, is refused, one line per problem. An empty file is a valid marker. The folder's basename is its display name. `epicenter init [<folder>] [--port <n>]` makes the folder, writes `EPICENTER.md` with the port, adds starter `AGENTS.md` guidance if there is none, and makes the folder the Epicenter's own repository (see [The Epicenter's repository](#the-epicenters-repository)). Epicenters cannot nest.

```sh
epicenter
epicenter reading
epicenter reading log 30 --book Dune
epicenter reading log 30 --json
epicenter reading log --help
epicenter reading books set books/dune.md --finished null
epicenter reading books set --input '{"path":"books/dune.md","finished":"2026-11-10"}'
epicenter init ~/Epicenter
epicenter init --from https://github.com/you/epicenter ~/Epicenter
epicenter new notes
epicenter new recipes --from https://github.com/someone/recipes
epicenter new mail --from https://github.com/someone/apps#mail
epicenter new vocab --from ~/Code/apps/vocab
epicenter install
epicenter build
epicenter sync
epicenter sync reading
epicenter sync reading -m "Tidy the book notes"
epicenter history reading
epicenter undo reading
epicenter serve
epicenter --version
```

The commands are `init`, `new`, `install`, `build`, `sync`, `history`, `undo`, `serve`, and `service`, each with its usage and help in one table (`src/commands.ts`); any other first word names an app. `--json` and `--help` (`-h`) go anywhere before `--`; `--version` is read only on its own. Each command parses its own flags with `node:util`'s `parseArgs`, strictly, so `--port=4800` and `--port 4800` both work; any misuse, an unknown flag, a flag without its value, or a wrong number of words, answers `Usage: <its usage line>` with `epicenter <command> --help` as the next step. `epicenter` lists the Epicenter folder, its apps, and problems in individual apps; an app with changes not yet in its history is marked for its code and its data, as `(data: 3 changes not yet in history; code: 2 snapshots not backed up)`. Its JSON listing has an `epicenter` folder string. An empty Epicenter says `No apps yet. Run: epicenter new <name>`. `epicenter <app>` lists its actions, each with a short usage line, and `epicenter <app> <action> --help` explains every field. Words that name no action list the app's actions, exit 2. Above its actions, it says, for the code and the data, how many changes are not yet in history and how many snapshots have not been backed up, with `Run: epicenter sync <app>`.

A repository without `origin` says `code: not backed up` or `data: not backed up` and gives `git -C <folder> remote add origin <url>` (or `<folder>/data`), then `epicenter sync <app>`, as its next step. One with `origin` but no `origin/<branch>` says `never backed up` and gives `epicenter sync <app>`. Data whose newest commit names a code commit this code's history does not have, as after restoring the two from backups that do not match, says `data: written under code <sha>, which this code's history does not have`. These appear in the Epicenter listing and above the app's actions, and its JSON `status` carries them as `{ code?, data? }`, each with `backup: "none"` or `"never"`, and `data.otherCode`.

A flag's value is read as its field's type ([ADR-0867](../../docs/adr/0867-the-command-line-spells-an-actions-json-input-and-null-removes-a-field-there-as-everywhere.md)): a number for a number, `--done` or `--done=false` for a switch, every value of a repeated flag for a list, one of its choices for a choice (an error names them), and `null` for a field that takes `null`, which a collection's `set` reads as "remove it". `--no-done` is refused with `--done=false` as the way to say false. `--input <json>` gives the whole input as one JSON object instead, with positional fields inside it and nothing beside it; `--input -` reads it from stdin. The text `null` for a field that takes `null` is given this way. `epicenter --json` prints each app's name, description, folder, each collection's path and fields as JSON Schema, and each action as the MCP tool `serve` offers, with all four annotations explicit; `epicenter <app> --json` prints the same for one app. Each app's JSON adds `status` when anything is not yet in its history: `{ "code"?: { "pending": <n>, "unpushed"?: <n> }, "data"?: … }`, from `git status` and the difference from the existing `origin/<branch>` tracking ref in each repository. An app with no tracking ref has no `unpushed` count. A folder without `epicenter.ts` is not an app and is not listed.

`epicenter` supplies `@epicenter/app` through the link made by `new` or `install`. Listing and loading an app do not install its packages. An app may import anything its `package.json` names. Add a package with `bun add` in the app's folder, then run `epicenter install <app>` to restore the supplied link, which Bun can remove. `epicenter install [<app>]` installs each app's packages, or one app's, from its top-level `package.json` with `bun install` (`--frozen-lockfile` when `bun.lock` exists), then links `node_modules/@epicenter/app` to this command's own copy. No app lists `@epicenter/app`. `new` runs this install before loading the app; a call never installs. Loading an app imports its `epicenter.ts`, whose `defineCollection`, `defineAction`, and `defineApp` calls check what they are given, then calls `defineApp` on the default export, which checks its whole shape. An app's `package.json` may declare the oldest `epicenter` it runs on as `"engines": { "epicenter": ">=0.2.0" }`, which `new` writes with this command's version and npm and Bun ignore when installing ([ADR-0873](../../docs/adr/0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md)). An app whose range this version does not satisfy is listed under problems, does not run, and does not build, with `package.json asks for epicenter "<range>", and this is epicenter <version>; update epicenter` (`src/engines.ts`). An app is also listed under problems, and does not run, when its file throws while loading or its export fails that check, with each line as `epicenter.ts: <line>`, or when its default export is not an object, as `epicenter.ts does not export defineApp(...) by default`. One app's broken export never stops the others from being listed ([ADR-0857](../../docs/adr/0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md)).

## A call runs where it arrives

A call runs in the process that received it: the `epicenter` you started, or `serve`. Each load of an app first drops every module this process loaded from under the app's folder, its own `node_modules` included, so the app runs as its files are on disk when the call arrives, and an edit to `epicenter.ts`, or to a file it imports, reaches the next call without a restart ([ADR-0880](../../docs/adr/0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md)). On the command line, what an action prints through `console` or `process.stdout` goes to stderr while it runs, so stdout holds only the answer. The call takes the app's lock at its first write, runs the action, and, for a run that is not read-only, snapshots pending data as changed outside epicenter before that write, then commits everything pending in data before it answers.

Actions share the process they run in, so this is no sandbox. An action that calls `process.exit` ends the command, or `serve`, and an action that never returns holds its call open; one that changes the working directory or `process.env` changes it for every call in that process. A call cut short this way commits nothing; what it wrote stays pending, and the next snapshot lists it as changed outside epicenter.

`epicenter service install` installs a macOS LaunchAgent for the current Epicenter, running the `epicenter` command found on `PATH` (or the compiled binary) at login. The job keeps the installing shell's `PATH` so actions can find the same programs. The person runs `install` and `uninstall`; agents may run `restart` and `status`. `status --json` reports whether it is installed and running, its pid when running, the serve port, and its log path.

`epicenter serve` starts an HTTP server on `127.0.0.1` at the port in `EPICENTER.md`, or 4747 when the marker has none. `--host <address>` and `--port <n>` override those settings. It serves MCP at `POST /`, the launcher at `GET /`, each app's actions to its UI at `POST /<app>/<action>`, and each app's UI at `/<app>/`: its `ui/dist/` ([ADR-0860](../../docs/adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md)). The launcher links to apps with a UI; a `GET /` asking for an event stream gets 405, since the server keeps no MCP session. Any later path of the server's own starts with `.`, which no app name can. The listener answers only a `Host` that is `localhost` (or `*.localhost`), an IP address, or a `*.ts.net` name, so a DNS rebinding name gets 403; it also refuses, with 403, any request carrying `Tailscale-Funnel-Request` or `Cf-Connecting-IP`, which a Tailscale Funnel or Cloudflare Tunnel adds. An Origin must match the request Host; requests without Origin are accepted. A reverse proxy such as `tailscale serve` can provide HTTPS. `serve` signs no one in: it trusts this computer and the tailnet, and who reaches it is its host's decision ([ADR-0883](../../docs/adr/0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md)). A Funnel or Cloudflare Tunnel aimed at this port by mistake reaches only 403s: each sets its header on every request, and Funnel deletes a copy the client sent. `Host` is no defence there, since Funnel forwards the client's own. Another tunnel that adds no such header and forwards an allowed `Host` would reach `serve` with no sign-in, so never tunnel its port.

MCP offers every app action as a tool and sends the Epicenter's `AGENTS.md`, when present, as server instructions, read again on each initialize so an edit reaches the next client without a restart. `tools/list` loads each app as it is now; an app that fails to load loses only its own tools and says why on stderr. `tools/call` decodes the tool name and runs the action, so an edit between calls is seen by the next. What an action yields is not sent over MCP; a client gets its answer.

An app's UI runs an action at `POST /<app>/<action>`, its words joined by `.` (`/vocab/words.add`), with the whole input as the JSON body. The response is JSON lines ([ADR-0879](../../docs/adr/0879-an-action-may-yield-values-while-it-runs-and-only-its-return-is-the-answer.md)): `{"yielded": <value>}` for each value the action yields, as it yields it, then `{"answer": <answer>}`, the same answer `--json` prints. A caller that stops reading stops the action at its next yield, which runs the action's `finally` blocks; the call answers that it threw, and what it wrote is committed. `@epicenter/app/client` speaks this for a UI.

Both answer a call that is not read-only after it has committed everything pending in data. A commit failure goes to stderr; the paths remain visible in status.

The HTTP server backs up on a clock: when it starts, every 5 minutes, and when it receives SIGINT or SIGTERM, it does for each app what `epicenter sync <app>` does. It snapshots what is pending as `<app>: changed outside epicenter` and pushes the branch to `origin` by name when the branch is ahead of its `origin` tracking ref or there is no tracking ref yet; it never pushes to any other remote. So a call's commit reaches the backup within 5 minutes, not at once. A tick skips an app with nothing pending and nothing waiting for its origin. It never waits for a call: it skips an app while a call to it runs, from any process, and the call's own commit or a later tick takes what the call wrote. A failure goes to stderr, once until it changes, and leaves the commits local. `serve` says it is serving as soon as it listens, while its first backup runs, and on a signal it waits at most 10 seconds for its last backup before it exits; a host that stops `serve` allows it that long ([ADR-0883](../../docs/adr/0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md)).

## Each writer commits its own boundary

An app is two repositories ([ADR-0877](../../docs/adr/0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md)): the app's folder holds its code, and `data/` inside it holds its data, a repository of its own that the code's `.gitignore` leaves out (`src/data.ts`). Writes through `folder` stay under `data/` ([ADR-0876](../../docs/adr/0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md)), so a call's commit goes to the data repository; `epicenter` makes that repository, with a `.gitignore` of `*.local` files and a copy of the app's `.gitattributes`, the first time it commits there, and `new` makes it at once. A record's path is the same everywhere, `data/tasks/<time>.md`: only Git calls made inside the data repository use the path inside it.

A call's first write through `folder` or a collection takes the app's lock and snapshots pending data as `<app>: changed outside epicenter` ([ADR-0880](../../docs/adr/0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md)). Later writes may go through `folder`, `node:fs`, or a library. When the action ends, the call commits everything pending in `data/` that Git does not ignore, named `<app>: <action words> [first positional value]` (one line, cut at 60 characters), and `(threw)` when it threw. If the opening snapshot failed, the call leaves everything pending and reports that failure without changing the answer. A call that never writes through `folder` takes no lock and commits nothing.

Before it loads `epicenter.ts`, a call reads the code repository's HEAD and whether it has uncommitted changes. The call's data commit carries `Code-Commit: <sha>` for that captured HEAD and `Code-Dirty: true` when the captured code was dirty. With no code HEAD it carries neither trailer. Other data snapshots name the current HEAD. Three kinds of writer commit (`src/snapshot.ts`):

- A call, before it answers, however it arrived: everything pending in data after its first write, with earlier pending edits snapshotted separately.
- An agent that edits an app's code or data itself: `epicenter sync <app> -m "<what it did>"` snapshots what is pending in both as `<app>: <what it did>` and backs each up. A plain `git commit` in either repository works too.
- Anything else, such as an editor: `epicenter sync`, the first step of `epicenter undo`, and `serve`'s clock snapshot what is pending as `<app>: changed outside epicenter`.

A snapshot with no call commits the code, then the data, so the data's commit names the code commit just made. In each it runs `git add -A` and `git commit` with the pathspec `.`, taking everything changed that Git does not ignore, staged or not. Its message is the subject alone; `epicenter history` reads its paths from Git. The code is committed only when the app's folder is the top of its own repository, and refuses while its `.gitignore` does not list `data/`, naming the line to add. A data commit refuses when `data/` has a `.git` that is not a repository of its own.

The data's `.gitignore` keeps `*.local` and `*.local.*` on this computer ([ADR-0870](../../docs/adr/0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md)). Before staging, a commit that would take such a file refuses with `<path> would be committed; add *.local and *.local.* to <app>/data/.gitignore` (or `<app>/.gitignore` for the code), or, when Git already tracks it, names `git -C <folder> rm --cached -- <path>` and a commit of that removal as the next step. Nothing changed makes no commit. Before staging, when the folder's `.gitattributes` mentions `filter=lfs` and `git config filter.lfs.process` is empty, it stops with `git lfs install` as the next step ([ADR-0856](../../docs/adr/0856-binary-files-go-through-git-lfs.md)), and while a merge, rebase, revert, or cherry-pick is underway it stops with `git -C <folder> status`. When another Git process holds `index.lock`, it retries for about 2 seconds. A failed commit is `{ message, next? }`. It changes no answer or exit code: after a call, stderr reads `<app>: not yet in history: <message>` and `Run: <next>`, or `Run: epicenter sync <app>` when the failure names no next step. The pending paths remain visible in status. A commit never pushes; only `sync` and `serve`'s clock do.

Each app has one lock: the kernel's `flock` on the app's folder itself, so there is no lock file (`src/lock.ts`). A call takes it at its first write through `folder`, snapshots pending data, and holds it until its commit has finished, whether it came from the command line or `serve`; a call that never writes through `folder` never takes it, so reads never wait. Two calls that write one app take turns, from each one's first write to its commit. A snapshot with no call is made holding the lock, so it never commits part of a running call's writes as changed outside epicenter. `sync` holds it while it snapshots, not while it pushes; `undo` from its snapshot until its revert is committed. Each waits up to 30 seconds, then refuses, saying a call is still writing it (`sync --json` marks that error `busy: true`), and `serve`'s clock skips the app. A call's first write also waits up to 30 seconds, then throws `<app> is busy`. The kernel releases the lock when the process holding it ends, so a crash never leaves it held. `folder.update` writes only over the text its change read, so every collection write lands, an editor's write among them. `folder.write` is last-write-wins.

A read-only run, of an action with `readOnlyHint: true`, never commits. In it, `folder.write`, `folder.writeBytes`, `folder.update`, and `folder.delete` throw before doing anything, naming the action: `The action "<words>" is read-only, so it cannot write <path>`. A `.local` path is let through without taking the lock, since no commit takes it: an action that only reads may still refresh a token kept in `google.local.md` ([ADR-0870](../../docs/adr/0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md)). A raw `node:fs` write is not caught.

`folder` is a convenience, not a sandbox. Paths are normalized and `.git` is refused; writes replace a whole file at once, through a file beside it named `*.local`, which the app's `.gitignore` keeps out of every commit. A replaced file keeps its mode, a new `.local` file is `0600`, and a new directory on a `.local` path is `0700`, since an app's secrets are `.local` files. `folder.path` is the folder, and an action may use `node:fs` too; what it writes that way after its first `folder` write is in the call's commit. Without a `folder` write, it stays pending for a later snapshot.

## What a run answers

With `--json`, stdout is one JSON object, and MCP returns the same object as `structuredContent`, with `isError` when the exit code is 1 or 2:

```txt
{ "returned": <value> }                      exit 0
{ "threw": { "message", "thrown"? } }        exit 1, also when the run ended without an answer
{ "error": { "name", "message", "next"? } }  exit 2, nothing ran
```

An action that returns nothing answers `{ "returned": null }`. An action that throws a tagged error (`{ name, message, …fields }`) reports it whole as `thrown`. Without `--json`, stdout carries only the returned value, rendered by its structure, and stderr carries what the action threw, or why nothing ran followed by `Run: <next step>` when there is one. MCP's text for a thrown action is the same stderr. The returned value reads this way (`src/output.ts`):

- An object prints one `key: value` line per defined key, in order. A string with a newline prints as `key: |` followed by indented lines. Other strings print plainly unless empty, padded with spaces, starting with a quote or `|`, or readable as JSON, such as `"true"`, `"null"`, or `"12"`; those print as JSON strings. A nested object with a defined key, or a non-empty array of objects, prints by these same rules under `key:`, indented two spaces. Numbers, booleans, null, other arrays, and an empty object print as compact JSON values. A `problems` key stays on stdout like any other key.
- An array of objects whose fields each fit on one line prints one row per object, with `key: value` pairs separated by two spaces. If a field takes more lines, a multiline string or a nested object, each object prints on its own lines, with a blank line between objects.
- An empty array prints nothing. A string prints as is, with a final newline added if needed. Other arrays and single values print as JSON.

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

`epicenter sync [<app> [-m <message>]]` snapshots both of an app's repositories and pushes each to its own `origin`, a private backup ([ADR-0851](../../docs/adr/0851-an-app-has-one-home-and-an-optional-push-only-backup.md), [ADR-0877](../../docs/adr/0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md)). For each app in the Epicenter, or the one named, one after another, it commits pending changes and then, in each repository with `origin`, runs `git push origin HEAD:<branch>` if the branch is ahead of its `origin` tracking ref or has none yet; `serve`'s clock follows the same rule. The snapshot reads `<app>: changed outside epicenter`, or with `-m` (`--message`), which needs an app, `<app>: <message>`; a message must be one line of text. It never fetches, pulls, rebases, stashes, or force pushes. A repository without `origin` gets a local snapshot. Nothing goes to any other remote: sharing an app is pushing its code to a remote its author chooses, with `git push`.

A refused non-fast-forward push leaves both histories as they were. Sync says the backup at origin has changes this computer does not and nothing was overwritten. It suggests `git -C <folder> fetch origin && git -C <folder> log HEAD..origin/<branch>` to inspect those commits. The unpushed count remains in status; no push error file is stored. Other push failures leave the commit local. One app's failure never stops the others.

```json
{
  "apps": [
    {
      "app": "reading",
      "folder": "/Users/you/Epicenter/reading",
      "code": { "committed": null, "pushed": false, "origin": { "ahead": 0 } },
      "data": {
        "committed": { "subject": "reading: changed outside epicenter", "files": 2 },
        "pushed": true,
        "origin": { "ahead": 0 }
      }
    }
  ]
}
```

`code` and `data` are `null` for a repository the app does not have. In each, `committed` is the snapshot's subject and file count, or `null` when nothing was pending; `origin` is how many commits the branch is ahead of its locally known `origin` tracking ref, or `null` when there is none; `error` is `{ message, next? }` when that repository did not finish syncing, its message starting `<app>:` or `<app>/data:`. `busy: true` says a call was still writing the app, so nothing was snapshotted or pushed. Sync does not fetch, so it cannot say how far a backup is ahead. Without `--json`, stdout has one line per repository, such as `reading/data: committed reading: changed outside epicenter; pushed; 0 ahead of origin`, and stderr has each error with its `Run:` line. Exit 0 when every app synced, 1 when any did not, 2 when the app named is not in the Epicenter.

With no app named, sync then does the same for the Epicenter's own repository, and its JSON adds `epicenter`, one repository's result in the same shape, with messages starting with the Epicenter's name.

## The Epicenter's repository

The Epicenter's folder is a repository of its own ([ADR-0884](../../docs/adr/0884-an-epicenter-is-a-repository-that-lists-the-repositories-inside-it-and-init-from-rebuilds-it.md)). Its apps live in `apps/` ([ADR-0885](../../docs/adr/0885-an-epicenters-apps-live-in-apps-which-its-repository-ignores-with-one-line.md)). It tracks everything else, such as `EPICENTER.md`, `AGENTS.md`, and a folder that is not an app; the `.gitignore` `init` writes leaves out `apps/`, `*.local`, `*.local.*`, `node_modules/`, and `.DS_Store`, and is the person's after that. `repositories.json` lists every repository in `apps/`, an app's code and its data, by its path, such as `apps/vocab/data`, with its `origin`, or `null` when it has none; an http(s) origin is recorded without a user or password written into its URL. A walk of the folder writes it before each snapshot, never following a link or entering `node_modules`, so the list is current after every backup.

`serve`'s clock and `epicenter sync` snapshot it after the apps, as `<Epicenter>: changed outside epicenter`, and push it to its `origin` by the same rule. The snapshot refuses while the `.gitignore` does not ignore `apps/`, naming the line to add; while a repository sits outside `apps/`, with moving it into `apps/` as the step; and while Git's index holds a repository inside as one, which a plain `git add` there records and a clone cannot fill in, with `git -C <folder> rm --cached -- <path>` as the step. An Epicenter that is not a repository of its own is skipped. `init` makes the repository and commits what it wrote as `<Epicenter>: start the Epicenter`; where `git-lfs` is installed, it installs LFS in the repository and writes a `.gitattributes` that routes audio, images, video, and PDFs through it.

`epicenter init --from <url> [<folder>]` rebuilds an Epicenter in a folder that is missing or empty. It clones the Epicenter's repository, refuses one with no `EPICENTER.md` at its top, then clones each listed repository into its place, parents first, leaving one already there as it is, and installs each app in `apps/`. It reports each repository listed with no origin and each clone or install that failed, and reminds that `.local` files stay on the computer that made them. `--json` prints `{ folder, cloned, kept, unbacked, failed }`. Exit 0 when nothing failed, 1 when a clone or an install did, 2 when nothing ran.

## History and undo

`epicenter history <app> [--limit <n>]` lists the app's commits in its code and its data together, newest first, 20 unless `--limit` gives another positive whole number (`src/history.ts`). It reads `git log --first-parent --name-only` of each repository whose top is its own folder, so an update's merge is one entry whose paths are what it brought in; an app with neither is refused. Each line is the short commit, the local time, `code` or `data`, and the subject, with each path the commit changed beneath, from the app's folder; an undo reads as `undid <subject>`.

```txt
$ epicenter history tasks
9c1e2f4  2026-11-11 09:41  data  undid tasks: add Water the plants
                                 data/tasks/2026-11-11T09-30-00-000Z-p2m7c4d1.md
5b7a0d3  2026-11-11 09:30  data  tasks: add Water the plants
                                 data/tasks/2026-11-11T09-30-00-000Z-p2m7c4d1.md
e02c9a1  2026-11-11 09:12  code  tasks: changed outside epicenter
                                 epicenter.ts
```

With `--json` it answers an array of `{ repository, commit, date, subject, changed, code?, undid? }`: `repository` is `code` or `data`, `date` the author date in ISO 8601, `changed` every path the commit changed from its first parent, `code` the code commit a data commit was written under, and `undid` the commit an undo reverts.

`epicenter undo <app> [<commit>]` reverts one data commit as a new one, so nothing is lost. Code is reverted with Git (`git -C <folder> revert <commit>`); naming a code commit is refused with that as the next step.

1. It takes a snapshot of whatever is pending in the code and the data, so an edit not yet in history is kept there. Without `<commit>`, that snapshot is the one undone.
2. Without `<commit>`, it walks back from the data's HEAD to the newest commit that is not an undo and has not been undone. An undo is a commit whose body has Git's line `This reverts commit <sha>.`; an undo that is itself undone no longer hides the commit it reverted. So `undo` again goes further back, and `undo <undo commit>` brings back what that undo removed.
3. It runs `git revert --no-commit` and commits as `<app>: undid <subject>`, keeping Git's `This reverts commit <sha>.` line. It never pushes; `sync` or `serve`'s clock backs the undo up.

It refuses, exit 2 with `{ "error": { "name": "Refused", "message", "next"? } }`, and leaves the folder's files as they were: a commit not in the app's history, a newest commit that is not a snapshot, since its subject does not start with `<app>: ` (the first commit, or one made with Git directly, which can still be named), a revert Git refuses with Git's message, such as a merge's, naming `git -C <folder> revert -m 1 <commit>` as the next step, a revert that conflicts (it is aborted, naming the conflicting files), a revert that changes nothing, such as one of a commit already undone, and a snapshot that fails, which includes an app in the middle of a merge, rebase, revert, or cherry-pick. A named commit is checked before the snapshot, so its refusal adds nothing to history. Without `--json`, stdout says what was undone, as `undid tasks: add Water the plants`; with it, `{ "undid": <commit>, "commit": <the undo's commit>, "codeSince"? }`. When the commit undone was written under code other than the code's HEAD, the undo lists the code commits made since (`codeSince`, each `{ commit, subject }`, newest first), and the text says the data may not fit the code: a field renamed since then leaves the restored files with keys no field declares, which reads as `other`, not as a problem.

## Adding apps

An app becomes one of yours when it is an entry in the selected Epicenter's `apps/` ([ADR-0885](../../docs/adr/0885-an-epicenters-apps-live-in-apps-which-its-repository-ignores-with-one-line.md)):

- `epicenter new <name> --from <git url>[#<folder>]`, or `--from <path>`, makes it as a copy of another app's code ([ADR-0904](../../docs/adr/0904-copying-is-the-only-way-to-take-an-apps-code.md)).
- `epicenter new <name>` makes it there from the built-in template.
An entry may also be a symlink to an app elsewhere. The CLI follows the link when listing or running it.

`epicenter new <name> --from` copies another app's code into `<Epicenter>/apps/<name>`: the files Git tracks in one folder of a repository, at the commit the repository's `HEAD` names. What follows `--from` is a Git URL or a path:

- `<git url>` takes the root of that repository, and `<git url>#<folder>` takes a folder inside it, written from the root.
- `<path>` is the folder that holds the app's `epicenter.ts`, such as `~/Code/apps/vocab`. It may be a repository's root or any folder inside one, and it takes no `#`. It must be inside a Git repository, since only what Git tracks is copied.

So one repository can hold one app or several. The copy becomes the one commit of a new repository, `new <name>`, whose message ends with two trailers: `Source:`, the `--from` argument, and `Source-Commit:`, the commit copied. No command reads them; they tell the person and their agent where the code came from. The new repository has none of the other repository's history and no remote, so nothing is ever pushed or merged between the two. `new --from` then makes an empty data repository, and adds `data/` and `node_modules/` to the copy's `.gitignore` when either line is missing.

It refuses a folder that tracks no `epicenter.ts`, and one that tracks anything under `data/`, since an app's data is never copied. It reads the copy from Git and never from the folder on disk, so a path's uncommitted changes, `data/`, `node_modules/`, and builds do not come along. The copied `epicenter.ts` must load; otherwise the new app is removed. It builds nothing itself: `serve` builds the UI when it is first opened (below).

`epicenter new <name>` makes the folder from the built-in template: an `epicenter.ts` that default-exports `defineApp` with a description to fill in and no collections or actions, and a `.gitignore` of exactly `data/` and `node_modules/`. It runs `git init`, commits the template as `new <name>`, and makes the data repository, whose first commit, `<name>: start its data`, holds its `.gitignore` of `*.local` and `*.local.*`. It writes no `.gitattributes`: an app that comes to hold binary files routes them through Git LFS in its own ([ADR-0856](../../docs/adr/0856-binary-files-go-through-git-lfs.md)).

Each prints the folder on stdout, and on stderr `Run: epicenter <name>`, then `not backed up` and `Run: git -C <folder> remote add origin <url> and git -C <folder>/data remote add origin <url>, each a private repository, then epicenter sync <name>`. A name already in the Epicenter, ignoring case, is refused, as is a name that is one of the commands.

## Taking later changes

No command brings later changes from where an app's code was copied. There is no `epicenter update`, and `new --from` adds no `upstream` remote ([ADR-0904](../../docs/adr/0904-copying-is-the-only-way-to-take-an-apps-code.md)). The person's agent does it, by the procedure in the `epicenter-app` skill: read `Source` and `Source-Commit` from the app's first commit (`git -C <folder> log --reverse --format=%B | head`), fetch that repository into a temporary directory outside the Epicenter, and compare `epicenter.ts` first. A changed collection may need the existing records migrated, which no merge ever did. Then it takes the UI changes wanted, by replacing `ui/` whole in one commit or by porting pieces, and runs the app's typecheck and tests. An app made before this, whose code still has an `upstream` remote and shares its history, keeps both: no command uses the remote, and `git merge` by hand still works there.

## An app's UI

An app's UI is what its `ui/` builds to in `ui/dist/` ([ADR-0860](../../docs/adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md), [ADR-0880](../../docs/adr/0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md)). A UI runs as it sits on disk, as actions do: `ui/dist/` is a cache of `ui/`'s sources, stamped in `ui/dist/.epicenter-build` with their fingerprint, the path, size and modified time of every file under `ui/` (but `ui/dist/`, `node_modules/`, and names starting with `.`), with the app's `package.json` and `bun.lock`, the `epicenter` version, and where the command's own `@epicenter/app` is with the path, size and modified time of each file in its `src/` (`src/ui.ts`), so a `serve` run from another checkout or a newer `epicenter` rebuilds every UI against its own client. When `serve` starts, it links `node_modules/@epicenter/app` in every installed app to its own copy. When a page load at `/<app>/` finds the fingerprint changed, `serve` builds in the background, one build per app at a time, and serves the last good build until it is done, so an edit shows on the next page load after its build, committed or not. A UI that has never built has no last build, so its page load waits for the first one, up to a minute, rather than answering 404. Sources whose build fails are not built again until they change; the failure is written to stderr once, with `Run: epicenter build <app>`. An app is one Bun project, so the build runs in the app's folder. When the app's `package.json` has a `build` script, `bun --bun run build` runs with `EPICENTER_OUT` naming the folder to write, which must hold an `index.html`. Otherwise, when `ui/index.html` exists, Bun's bundler bundles it, so one `index.html` and the files beside it are a UI with no `package.json`. With neither, or no `ui/`, there is nothing to build. Either way a build writes relative URLs and is never told where it is served, and runs with the Bun that runs `epicenter`; the compiled `epicenter` is Bun itself under `BUN_BE_BUN=1`. A build never installs: an app whose `package.json` names packages and has no `node_modules/` is skipped, with `Run: epicenter install <app>`, and nothing is remembered against it. Before every build, `node_modules/@epicenter/app` links to the command's own copy (`src/app-package.ts`): this repository's `packages/app`, or for the compiled `epicenter`, the package it carries, written once per build to `$XDG_DATA_HOME/epicenter/app/<version>-<hash>` (`~/.local/share` by default) with the packages it imports. The finished build replaces `ui/dist/` by rename, so `serve` never answers from half a build, and a failed build leaves the last one in place. `serve` never serves a path with a part starting with `.`.

`epicenter build [<app>]` builds every app's UI from its sources now, or one app's, and shows the build's errors. It reports `UI built`, `nothing to build`, or a build error for each app. With `--json` it answers `{ "apps": [{ app, folder, built, error? }] }`, `built` saying whether there was a UI to build. A build error exits 1; another app can still build.

What an app can rebuild lives in files it gitignores in its folder, such as `ui/dist/`, ignored by `ui/.gitignore` ([ADR-0854](../../docs/adr/0854-an-apps-cache-is-the-files-it-gitignores.md)).

Compile the executable from the repository root:

```sh
bun run --cwd packages/cli compile
```

## Tests

Run `bun test <file>` in `packages/cli` one file per process when memory is short. `acceptance.*.test.ts` runs the real `epicenter` against a temporary `HOME`, one test per acceptance ID, with bare repositories in temporary folders standing in for remotes.
