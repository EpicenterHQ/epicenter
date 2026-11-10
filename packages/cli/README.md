# The epicenter command

`epicenter` runs the apps in an Epicenter as commands and MCP tools. An Epicenter is a folder with `EPICENTER.md`; its direct child folders with an `epicenter.ts` that default-exports `defineApp(...)` are apps, each with its collections and actions ([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md), [ADR-0857](../../docs/adr/0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md)).

The command uses the nearest Epicenter above the current directory. Otherwise
it uses `EPICENTER_ROOT`, then `$HOME/Epicenter`. A chosen folder without
`EPICENTER.md` needs `epicenter init <folder>`. A folder with the old
`epicenter.root.json` names the step to write `EPICENTER.md` with its port and
delete the old marker. The folder's basename is its display name.

The marker has optional front matter: `port` is an integer from 0 to 65535
and defaults to 4747; `public` is an HTTPS origin such as
`https://studio.example.ts.net:10000/`; `publicPort` is the port of the public
listener on `127.0.0.1`. `public` and `publicPort` must appear together, and
`publicPort` must differ from `port`. Unknown or invalid fields are refused.
`epicenter init [<folder>] [--port <n>]` makes the folder, writes the marker,
and adds starter `AGENTS.md` guidance if there is none. Epicenters cannot nest.

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
epicenter history reading
epicenter undo reading
epicenter serve
epicenter serve --stdio
epicenter access
epicenter access invite phone
epicenter access revoke claude.ai phone
epicenter access revoke claude.ai
epicenter access revoke phone
epicenter --version
```

The commands are `init`, `new`, `update`, `build`, `sync`, `history`, `undo`, `serve`, and `access`; any other first word names an app. `--json` and `--help` (`-h`) go anywhere before `--`; `--version` is read only on its own. `epicenter` lists the Epicenter folder, its apps, and problems in individual apps; an app with changes not yet in its history is marked, as `(3 changes not yet in history; 2 snapshots not backed up)`. Its JSON listing has an `epicenter` folder string. An empty Epicenter says `No apps yet. Run: epicenter new <name>`. `epicenter <app>` lists its actions, each with a short usage line, and `epicenter <app> <action> --help` explains every field. Above its actions, it says how many changes are not yet in the app's history and how many snapshots have not been backed up, with `Run: epicenter sync <app>`.

An app without `origin` says `not backed up` and gives `git -C <folder> remote add origin <url>, then epicenter sync <app>` as its next step. An app with `origin` but no `origin/<branch>` says `never backed up` and gives `epicenter sync <app>`. These messages appear in the Epicenter listing and above the app's actions.

A flag's value is read as its field's type ([ADR-0867](../../docs/adr/0867-the-command-line-spells-an-actions-json-input-and-null-removes-a-field-there-as-everywhere.md)): a number for a number, `--done` or `--done=false` for a switch, every value of a repeated flag for a list, one of its choices for a choice (an error names them), and `null` for a field that takes `null`, which a collection's `set` reads as "remove it". `--no-done` is refused with `--done=false` as the way to say false. `--input <json>` gives the whole input as one JSON object instead, with positional fields inside it and nothing beside it; `--input -` reads it from stdin. The text `null` for a field that takes `null` is given this way. `epicenter --json` prints each app's name, description, folder, each collection's path and fields as JSON Schema, and each action as the MCP tool `serve` offers, with all four annotations explicit; `epicenter <app> --json` prints the same for one app. Each app's JSON adds `status` when changes are pending, snapshots are unpushed, or a backup is missing: `{ "pending": <n>, "unpushed"?: <n>, "backup"?: "none" | "never" }`. `backup: "none"` means there is no `origin`; `backup: "never"` means `origin` has no tracking ref for the branch. A pushed app with no pending changes has no `status` object. A folder without `epicenter.ts` is not an app and is not listed.

`epicenter` supplies `@epicenter/app` to every `epicenter.ts` it loads, so a folder needs no `node_modules` to run. Listing and running an app only read it. Loading an app imports its `epicenter.ts`, whose `defineCollection`, `defineAction`, and `defineApp` calls check what they are given, then calls `defineApp` on the default export, which checks its whole shape. An app is listed under problems, and does not run, when its file throws while loading or its export fails that check, with each line as `epicenter.ts: <line>`, or when its default export is not an object, as `epicenter.ts does not export defineApp(...) by default`. One app's broken export never stops the others from being listed ([ADR-0857](../../docs/adr/0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md)).

## Each run is its own process

The `epicenter` you start only relays. It runs the action in a child `epicenter` whose stdout and stderr both go to your stderr, forwards SIGINT and SIGTERM, and reads the child's answer from a report file once the child exits. So nothing an action prints, through any `console` method or `process.stdout`, reaches the answer. A child that ends without an answer, killed or calling `process.exit`, answers that it threw, naming its exit code or signal; what it wrote stays pending for the next snapshot, which lists it as changed outside epicenter. After a run that is not read-only, the child's report names the app, call, and paths written through `folder`, and the parent, the `epicenter` you started or `serve`, takes the snapshot. A child whose parent dies finishes the run.

`epicenter serve` starts an HTTP server on `127.0.0.1` at the port in `EPICENTER.md`, or 4747 when the marker has none. `--host <address>` and `--port <n>` override those settings. It serves MCP at `POST /`, the launcher at `GET /`, and each app's UI at `/<app>/`: its built `ui/dist/` ([ADR-0866](../../docs/adr/0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md)). The launcher links to apps with a UI; a `GET /` asking for an event stream gets 405, since the server keeps no MCP session. Any later path of the server's own starts with `.`, which no app name can. The listener answers only a `Host` that is `localhost` (or `*.localhost`), an IP address, or a `*.ts.net` name, so a DNS rebinding name gets 403; it also refuses, with 403, any request carrying `Tailscale-Funnel-Request` or `Cf-Connecting-IP`, which a Tailscale Funnel or Cloudflare Tunnel adds. An Origin must match the request Host; requests without Origin are accepted. Every response carries `Epicenter-Listener: private`. A reverse proxy such as `tailscale serve` can provide HTTPS. This listener signs no one in; a `public` address adds a second listener that does (see below).

Both HTTP and `serve --stdio` offer every app action as a tool and send the Epicenter's `AGENTS.md`, when present, as MCP server instructions. The server never imports an app. `tools/list` runs `epicenter <app> --json` for each app entry in its own child, so an app that fails to load loses only its own tools and says why on stderr. Each `tools/call` runs `epicenter <app> <words> --input <json>` in a fresh child from the Epicenter folder, so an edit between calls is seen by the next. `serve --stdio` uses stdin and stdout for MCP.

After each call that is not read-only, either transport takes a snapshot of the app before it answers, one at a time per app. Every 60 seconds the HTTP server checks each app's pending paths, sizes, and modification times, and snapshots an app when those values are unchanged since the previous check. `EPICENTER_QUIET_CHECK_MS` is a test hook for this interval; values must be integers of at least 100 milliseconds. When a snapshot commits, the HTTP server pushes that app's branch to `origin` by name in the background, if the app has an `origin`; it never pushes to `upstream`. Push failures go to stderr and leave the commit local. A snapshot failure goes to stderr; the pending paths remain visible in status.

## The public address

When `EPICENTER.md` has `public` and `publicPort`, `serve` also listens on `127.0.0.1:<publicPort>` and prints `Serving <public> at http://127.0.0.1:<publicPort>: an HTTPS tunnel from that address must forward to this port.` Any HTTPS tunnel that forwards `public` to that port works, such as Tailscale Funnel or Cloudflare Tunnel; `serve` never starts or changes one ([ADR-0871](../../docs/adr/0871-a-public-address-signs-people-in-with-a-passkey-and-connectors-in-with-oauth.md)). The private listener still trusts every request it answers, and with `public` set, `serve` refuses a `--host` that is not a loopback address (`127.x.x.x`, `::1`, or `localhost`); the tailnet reaches it through a proxy such as `tailscale serve`. The public one serves a request only for a person's session or a connector's token, so the boundary is the socket a request arrives on, not a header.

At start and every 5 minutes, `serve` fetches `<public>/.well-known/oauth-protected-resource` and says on stderr when the answer changes. If the answer carries `Epicenter-Listener: private`, a tunnel reaches the private listener, so the private listener answers every request with 503 until `serve` restarts, and `serve` says to point the tunnel at `publicPort`. If nothing answers, or something other than this serve's own metadata does, `serve` says so and keeps both listeners. The check only probes `public`: a second tunnel at another address aimed at the private port, rewriting `Host` and adding no tunnel header, is not seen.

| Public path | Needs |
| --- | --- |
| `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-authorization-server/.auth` | nothing: OAuth metadata |
| `/.auth/oauth2/authorize`, `/.auth/oauth2/token`, `/.auth/oauth2/consent`, `/.auth/oauth2/revoke`, `/.auth/jwks`, `/.auth/passkey/*` | Better Auth; every other `/.auth/` path is 404 |
| `GET /.sign-in` | nothing: signs in with a passkey, or registers one from an invite |
| `GET /.allow` | a session: approves a connector |
| `POST /` | a bearer token, or a session with this address as `Origin`; MCP |
| `GET /`, `/<app>/...` | a session; without one, a redirect to `/.sign-in` |

Better Auth is the authorization server (`src/authorization-server.ts`). Its state is `access.local.sqlite` and its secret is `access.local.key`, both in the Epicenter's folder with mode 0600; as `.local` files, no snapshot commits them. A connector's access token is a 15-minute JWT whose audience is `public`, checked against the signing keys in that database, so a check never leaves the computer. After the signature, every MCP call also checks the database: the token's grant must still have a consent covering its scopes, its person a passkey, and it must have been issued in a later second than the grant's last revoke; otherwise it answers 401 `invalid_token`. The authorization server metadata names no introspection endpoint. `POST /.auth/oauth2/revoke` is a connector's disconnect: it revokes the refresh token presented, not the grant, and presenting one already revoked ends every refresh token of that grant. The `read` scope lists and calls only actions with `readOnlyHint: true`, in a child that refuses anything else; a call to another action answers 403 with an `insufficient_scope` challenge naming `write`. `write` allows every action. A person's session lasts 7 days and is not extended.

People sign in with passkeys, starting from an invite. `epicenter access invite [<name>]` prints a link to `/.sign-in?invite=<token>` that registers one passkey, once, within 15 minutes; `<name>` defaults to `device-<n>`. A device already signed in cannot use an invite. Connectors such as Claude and ChatGPT are added by pasting `public` as a custom connector. Each identifies itself by a client metadata document, which `serve` fetches only over HTTPS from a public IP address, without following redirects. Every authorization asks for a passkey and shows `/.allow`, whatever the connector asked: the router sets `prompt=login consent` and adds `offline_access` to the scopes, and refuses an approval without `offline_access` or from a connector whose document does not allow refreshing, so every grant's code exchange starts a refresh family. `/.allow` leads with the host serving the connector's client_id, shows the whole client_id, then the name its document gives itself, and says to allow it only for a connection the person just started. The person chooses between reading and changing, reading only, or not allowing it. Text from a metadata document is shown without control or bidirectional characters, there and in `epicenter access`.

`epicenter access` lists people, with when each was approved and last signed in, and each grant: a connector one person approved, with its host, full client_id, the name it gives itself, the person, its scope, when it was last approved, its last refresh, and its connections (live refresh families, one per code exchange), so a second connection under one approval shows. `--json` prints `{ "access": [...] }` with `kind` `person` or `grant`. `epicenter access revoke <connector> <person>` ends one grant; `revoke <connector>` ends every grant of it, naming it by client_id, host, or name; `revoke <person>` ends a person, by name or id. A word that names more than one is refused with the ids to use.

A revoke runs in one transaction. Each grant it ends gets a row in `grantRevocation`, and SQL triggers on Better Auth's tables, created after its migrations on every start, refuse what comes from before it: a refresh token inserts only under a consent and from an authorization code issued after the grant's last revoke (recorded in `codeIssued` by SQLite's clock), and a code inserts only under a consent. So a code exchange or a token rotation in flight across a revoke and a re-approval returns 400 `invalid_grant` and no token, and the grant's live access tokens fail their next call. The grant's consent, refresh tokens, access token records, and pending codes are deleted too. A person also loses their passkeys, sessions, any pending code, and their user row. Approving a grant again with narrower scopes deletes its refresh families that hold more. `access` opens the same database `serve` holds open, so it works while `serve` runs and a change takes effect at once. Without `public` in `EPICENTER.md`, it says to add `public` and `publicPort`.

## Runs never commit; history is snapshots

A run changes files and commits nothing ([ADR-0850](../../docs/adr/0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md)). A write run reports its call as `<app>: <action words> [first positional value]` (one line, cut at 60 characters) and the paths it wrote through `folder`, whether it returned or threw. The parent passes that report to `snapshot`. Running an action needs nothing from Git; a folder outside a repository is never snapshotted.

A snapshot commits everything pending in the app's folder (`src/snapshot.ts`). The command line takes one after each write run it ran itself, `serve` after each write call and for quiet outside edits, and `epicenter sync` before it pushes. It runs `git add -A` and `git commit` from the app's folder with the pathspec `.`, never `*.local` or `*.local.*`, so it takes everything changed in the folder, staged or not, and nothing outside it. With a call, the subject is that call; any other pending paths follow an `Also changed:` header, one per line. Without a call, the subject is `<app>: changed outside epicenter` and the paths follow `Changed:`. A path containing a newline is JSON-quoted on its line. Nothing pending makes no commit. An app inside a larger repository commits into that repository and leaves the rest of it alone. Before staging, when the folder's `.gitattributes` mentions `filter=lfs` and `git config filter.lfs.process` is empty, it stops with a message ending `run: git lfs install` ([ADR-0856](../../docs/adr/0856-binary-files-go-through-git-lfs.md)). When another Git process holds `index.lock`, it retries for about 2 seconds. A snapshot failure changes no answer or exit code: the caller prints why and `Run: epicenter sync <app>` on stderr. The pending paths remain visible in status. A snapshot never pushes.

There is no lock: writes to one app run at once. Git's `index.lock` keeps commits apart, and `folder.update` keeps changes to one file apart: it writes only over the text its change read, so every collection write lands. `folder.write` is last-write-wins.

A read-only run, of an action with `readOnlyHint: true`, is never snapshotted. It may write and delete `*.local` and `*.local.*` paths through `folder`; every other `folder` write throws before doing anything, naming the action: `The action "<words>" is read-only, so it cannot write <path>`. A raw `node:fs` write is not caught.

`folder` is a convenience, not a sandbox. Paths are normalized and `.git` is refused; writes replace a whole file at once, through a file beside it named `*.local` so a snapshot never takes it. `folder.path` is the folder, and an action may use `node:fs` too; what it writes that way is a change from outside epicenter.

## What a run answers

With `--json`, stdout is one JSON object, and MCP returns the same object as `structuredContent`, with `isError` when the exit code is 1 or 2:

```txt
{ "returned": <value> }                      exit 0
{ "threw": { "message", "thrown"? } }        exit 1, also when the run ended without an answer
{ "error": { "name", "message", "next"? } }  exit 2, nothing ran
```

An action that returns nothing answers `{ "returned": null }`. An action that throws a tagged error (`{ name, message, …fields }`) reports it whole as `thrown`. Without `--json`, stdout carries only the returned value, as a person reads it, and stderr carries what the action threw, or why nothing ran followed by `Run: <next step>` when there is one. MCP's text for a thrown action is the same stderr. The returned value reads this way (`src/output.ts`):

- A file, an object with `path` and `body` strings as a collection's `get` gives it, prints as the Markdown file it is: `---`, each field but `path` as `key: <JSON>` in its order, then each key of `other` as `# other: key: <JSON>`, then `---` and the body. Each of its `problems` goes to stderr as `! <problem>`.
- Rows, an array of objects each with a `path` string as `list` gives them, print one line each: the path, then each other field as `key: <JSON>`, two spaces apart. Each row's `problems` goes to stderr as `! <path>: <problem>`.
- Nothing (`null`) and an empty array print nothing; a string prints as it is; anything else prints as JSON.

```txt
$ epicenter tasks get tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md
---
time: "2026-11-10T09-30-00-000Z-k3x9a2f8"
title: "Email Sam the slides"
done: false
due: "2026-11-12"
---
The deck is in Drive.
```

A placeholder such as `time` prints as a field: the command reads only the answer, which does not say which keys came from the path.

## Syncing

`epicenter sync [<app>]` takes a snapshot and pushes to `origin`, the home's optional backup ([ADR-0851](../../docs/adr/0851-an-app-has-one-home-and-an-optional-push-only-backup.md)). For each app in the Epicenter, or the one named, one after another, it commits pending changes and then runs `git push origin HEAD:<branch>` when `origin` exists. It never fetches, pulls, rebases, stashes, or force pushes. An app without `origin` gets a local snapshot. Nothing goes to `upstream`, the starter an app came from, or to whatever the branch tracks.

A refused non-fast-forward push leaves both histories as they were. Sync says the backup at origin has changes this computer does not and nothing was overwritten. It suggests `git -C <folder> fetch origin && git -C <folder> log HEAD..origin/<branch>` to inspect those commits. The unpushed count remains in status; no push error file is stored. Other push failures leave the commit local. One app's failure never stops the others. An app inside a larger repository snapshots only its folder and pushes the whole repository's history.

```json
{
  "apps": [
    {
      "app": "reading",
      "folder": "/Users/you/Epicenter/reading",
      "committed": { "subject": "reading: changed outside epicenter", "files": 2 },
      "pushed": true,
      "origin": { "ahead": 0, "behind": 0 }
    }
  ]
}
```

`committed` is the snapshot's subject and file count, or `null` when nothing was pending; `origin` is how far the branch is from its locally known `origin` tracking ref, or `null` when there is none. Sync does not fetch, so this distance can be stale after a refused push. `error` is `{ message, next? }` when the app did not finish syncing. Without `--json`, stdout has one line per app, such as `reading: committed reading: changed outside epicenter; pushed; 0 ahead of origin, 0 behind`, and stderr has each error with its `Run:` line. Exit 0 when every app synced, 1 when any did not, 2 when the app named is not in the Epicenter.

## History and undo

`epicenter history <app> [--limit <n>]` lists the app's commits, newest first, 20 unless `--limit` gives a number from 1 to 1000 (`src/history.ts`). It reads `git log --first-parent` of the app's own repository, so an update's merge is one entry; an app whose folder is not the root of its own repository is refused. Each line is the short commit, the local time, and the subject, with the body's lines beneath; an undo reads as `undid <subject>`.

```txt
$ epicenter history tasks
9c1e2f4  2026-11-11 09:41  undid tasks: add Water the plants
5b7a0d3  2026-11-11 09:30  tasks: add Water the plants
                           Also changed:
                           notes.md
e02c9a1  2026-11-11 09:12  tasks: changed outside epicenter
                           Changed:
                           tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md
```

With `--json` it answers an array of `{ commit, date, subject, also, undid? }`: `date` is the author date in ISO 8601, `also` the paths beneath an `Also changed:` or `Changed:` body header, and `undid` the commit an undo reverts.

`epicenter undo <app> [<commit>]` reverts one commit as a new one, so nothing is lost:

1. It takes a snapshot of whatever is pending, so an edit not yet in history is kept there. Without `<commit>`, that snapshot is the one undone.
2. Without `<commit>`, it walks back from HEAD to the newest commit that is not an undo and has not been undone. An undo is a commit whose body has Git's line `This reverts commit <sha>.`; an undo that is itself undone no longer hides the commit it reverted. So `undo` again goes further back, and `undo <undo commit>` brings back what that undo removed.
3. It runs `git revert --no-commit` and commits as `<app>: undid <subject>`, keeping Git's `This reverts commit <sha>.` line.
4. When the app has an `origin`, it pushes the branch with `git push origin HEAD:<branch>`, as `sync` does. A push that fails prints what `sync` would (a backup with changes this computer lacks is never overwritten) and its next step on stderr; the undo stays, and the exit code is 0.

It refuses, exit 2 with `{ "error": { "name": "Refused", "message", "next"? } }`, and leaves the folder's files as they were: a merge, a commit not in the app's history, a commit already undone (the next step undoes its undo), a newest commit that is not a snapshot, since its subject does not start with `<app>: ` (the first commit, or one made with Git directly, which can still be named), a revert that conflicts (it is aborted, naming the conflicting files), a revert that changes nothing, an app in the middle of a merge, rebase, revert, or cherry-pick, and a snapshot that fails. A named commit is checked before the snapshot, so its refusal adds nothing to history. Without `--json`, stdout says what was undone, as `undid tasks: add Water the plants`; with it, `{ "undid": <commit>, "commit": <the undo's commit> }`.

## Adding apps

An app becomes one of yours when it is a direct child entry of the selected Epicenter:

- `epicenter new <name> --from <git url|path>` makes it from a starter, a repository with no data ([ADR-0866](../../docs/adr/0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md)).
- `epicenter new <name>` makes it there from the built-in template.
An entry may also be a symlink to an app elsewhere. The CLI follows the link when listing or running it.

`epicenter new <name> --from <git url|path>` clones the starter into `<Epicenter>/<name>`, renames the clone's remote to `upstream`, and leaves the branch tracking nothing, so no push reaches the starter. A path must be a repository's root, since Git clones only whole repositories. The clone must have an `epicenter.ts` that loads; otherwise it is removed. When the app has `ui/package.json`, it then builds the UI (below); a failed build leaves the app made, says why, and exits 1 with `epicenter update <name>` as the next step.

`epicenter new <name>` makes the folder from the built-in template: an `epicenter.ts` that default-exports `defineApp` with a description to fill in and no collections or actions, and a `.gitignore` of exactly `node_modules/`, `*.local`, and `*.local.*` ([ADR-0858](../../docs/adr/0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md)). It runs `git init` and commits the template as `new <name>`. It writes no `.gitattributes`: an app that comes to hold binary files routes them through Git LFS in its own ([ADR-0856](../../docs/adr/0856-binary-files-go-through-git-lfs.md)).

Each prints the folder on stdout and ends stderr with `not backed up` and `Run: git -C <folder> remote add origin <url>, then epicenter sync <name>`. A name already in the Epicenter, ignoring case, is refused, as is a name that is one of the commands.

## Updating from a starter

`epicenter update [<app>]` brings a starter's changes into each app with an `upstream`, or the one named, one after another (`src/update.ts`). It refuses an app with uncommitted changes (`epicenter sync <app>` snapshots them), runs `git fetch upstream`, and merges the branch `upstream/HEAD` names as `<app>: update from upstream`. A merge that stops on a conflict is aborted, leaving the app as it was, and the next step is `git -C <folder> merge upstream/<branch>`. It then lists each file of each collection that no longer fits the collection's fields, as `<path>: <what is wrong>`, since Git merges code and does not migrate data, and builds the UI. An app without `upstream` is left alone. With `--json` it answers `{ "apps": [{ app, folder, upstream, merged, built, misfits, error? }] }`; it exits 0 when every app updated and 1 when any did not.

An app's view is whatever is in `ui/dist/` ([ADR-0860](../../docs/adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md)). When `ui/package.json` has a `build` script, that script writes `ui/dist/`; otherwise `ui/dist/` holds files written by hand and there is nothing to build. Building runs `bun install` and `bun --bun run build` in `ui/` with the Bun that runs `epicenter`; the compiled `epicenter` is Bun itself under `BUN_BE_BUN=1`, so a computer needs no other program. A build that fails, or writes no `ui/dist/index.html`, puts the last built view back; the last view waits in a copy outside the app while it builds.

`epicenter build [<app>]` builds every app's UI, or one app's. It reports `UI built`, `nothing to build`, or a build error for each app. With `--json` it answers `{ "apps": [{ app, folder, built, error? }] }`. A build error exits 1; another app can still build.

The UI project's `.gitignore` excludes `node_modules/`, `.svelte-kit/`, `build/`, and the temporary `build.last/` used while Epicenter builds. The app's root `.gitignore` excludes its own `node_modules/` and local files.

Tests use a marked Epicenter under a temporary `HOME`. An app's secrets live
in `.local.md` collections in its folder. For example, `google.local.md` can
hold optional `account` and `refreshToken` fields. Calling its `actions()` is
refused, new files have mode `0600`, and snapshots never commit them.

Compile the executable from the repository root:

```sh
bun run --cwd packages/cli compile
```

## Tests

Run `bun test <file>` in `packages/cli` one file per process when memory is short. `acceptance.*.test.ts` runs the real `epicenter` against a temporary `HOME`, one test per acceptance ID, with bare repositories in temporary folders standing in for remotes.
