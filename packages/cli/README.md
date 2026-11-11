# The epicenter command

`epicenter` runs the apps in an Epicenter as commands and MCP tools. An Epicenter is a folder with `EPICENTER.md` ([ADR-0868](../../docs/adr/0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md)); its direct child folders with an `epicenter.ts` that default-exports `defineApp(...)` are apps, each with its collections and actions ([ADR-0841](../../docs/adr/0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md), [ADR-0857](../../docs/adr/0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md)).

The command uses the nearest Epicenter at or above the current directory. Otherwise it uses `EPICENTER_ROOT`, then `$HOME/Epicenter`. A chosen folder without `EPICENTER.md` needs `epicenter init <folder>`. The marker is a note for people whose front matter, read as an app's files are, may hold three fields: `port`, a whole number from 0 to 65535 that `serve` listens on, 4747 when absent; and `public` and `publicPort`, which come together: the Epicenter's public https origin, such as `https://host:10000`, and the port on `127.0.0.1`, other than `port`, that a tunnel to it targets ([ADR-0871](../../docs/adr/0871-a-public-address-signs-people-in-with-a-passkey-and-connectors-in-with-oauth.md)). Any other field, or a value that does not fit, is refused, one line per problem. An empty file is a valid marker. The folder's basename is its display name. `epicenter init [<folder>] [--port <n>]` makes the folder, writes `EPICENTER.md` with the port, and adds starter `AGENTS.md` guidance if there is none. Epicenters cannot nest.

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
epicenter access
epicenter access invite phone
epicenter access revoke claude.ai phone
epicenter access revoke claude.ai
epicenter access revoke phone
epicenter --version
```

The commands are `init`, `new`, `update`, `build`, `sync`, `history`, `undo`, `serve`, `service`, and `access`, each with its usage and help in one table (`src/commands.ts`); any other first word names an app. `--json` and `--help` (`-h`) go anywhere before `--`; `--version` is read only on its own. Each command parses its own flags with `node:util`'s `parseArgs`, strictly, so `--port=4800` and `--port 4800` both work; any misuse, an unknown flag, a flag without its value, or a wrong number of words, answers `Usage: <its usage line>` with `epicenter <command> --help` as the next step. `epicenter` lists the Epicenter folder, its apps, and problems in individual apps; an app with changes not yet in its history is marked for its code and its data, as `(data: 3 changes not yet in history; code: 2 snapshots not backed up)`. Its JSON listing has an `epicenter` folder string. An empty Epicenter says `No apps yet. Run: epicenter new <name>`. `epicenter <app>` lists its actions, each with a short usage line, and `epicenter <app> <action> --help` explains every field. Words that name no action list the app's actions, exit 2. Above its actions, it says, for the code and the data, how many changes are not yet in history and how many snapshots have not been backed up, with `Run: epicenter sync <app>`.

A repository without `origin` says `code: not backed up` or `data: not backed up` and gives `git -C <folder> remote add origin <url>` (or `<folder>/data`), then `epicenter sync <app>`, as its next step. One with `origin` but no `origin/<branch>` says `never backed up` and gives `epicenter sync <app>`. Data whose newest commit names a code commit this code's history does not have, as after restoring the two from backups that do not match, says `data: written under code <sha>, which this code's history does not have`. These appear in the Epicenter listing and above the app's actions, and its JSON `status` carries them as `{ code?, data? }`, each with `backup: "none"` or `"never"`, and `data.otherCode`.

A flag's value is read as its field's type ([ADR-0867](../../docs/adr/0867-the-command-line-spells-an-actions-json-input-and-null-removes-a-field-there-as-everywhere.md)): a number for a number, `--done` or `--done=false` for a switch, every value of a repeated flag for a list, one of its choices for a choice (an error names them), and `null` for a field that takes `null`, which a collection's `set` reads as "remove it". `--no-done` is refused with `--done=false` as the way to say false. `--input <json>` gives the whole input as one JSON object instead, with positional fields inside it and nothing beside it; `--input -` reads it from stdin. The text `null` for a field that takes `null` is given this way. `epicenter --json` prints each app's name, description, folder, each collection's path and fields as JSON Schema, and each action as the MCP tool `serve` offers, with all four annotations explicit; `epicenter <app> --json` prints the same for one app. Each app's JSON adds `status` when anything is not yet in its history: `{ "code"?: { "pending": <n>, "unpushed"?: <n> }, "data"?: … }`, from `git status` and the difference from the existing `origin/<branch>` tracking ref in each repository. An app with no tracking ref has no `unpushed` count. A folder without `epicenter.ts` is not an app and is not listed.

`epicenter` supplies `@epicenter/app` to every `epicenter.ts` it loads, so a folder needs no `node_modules` to run. Listing and running an app only read it. Loading an app imports its `epicenter.ts`, whose `defineCollection`, `defineAction`, and `defineApp` calls check what they are given, then calls `defineApp` on the default export, which checks its whole shape. An app is listed under problems, and does not run, when its file throws while loading or its export fails that check, with each line as `epicenter.ts: <line>`, or when its default export is not an object, as `epicenter.ts does not export defineApp(...) by default`. One app's broken export never stops the others from being listed ([ADR-0857](../../docs/adr/0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md)).

## Each run is its own process

The `epicenter` you start only relays. It runs the action in a child `epicenter` whose stdout and stderr both go to your stderr, forwards SIGINT and SIGTERM, and reads the child's answer from a report file once the child exits. So nothing an action prints, through any `console` method or `process.stdout`, reaches the answer. A child that ends without an answer, killed or calling `process.exit`, answers that it threw, naming its exit code or signal; what it wrote stays pending for the next snapshot, which lists it as changed outside epicenter. The child owns the whole call: it takes the app's lock at its first write, runs the action, and, for a run that is not read-only, commits the paths it wrote through `folder` before it reports. So a child whose parent dies finishes the call, commit and all. A parent that wants an action's yields ([ADR-0879](../../docs/adr/0879-an-action-may-yield-values-while-it-runs-and-only-its-return-is-the-answer.md)) opens Bun's IPC channel to the child, which sends each yield over it as it runs; the answer still comes from the report file, after every yield. Only `serve` opens it, for a call that asked.

`epicenter service install` installs a macOS LaunchAgent for the current Epicenter, running the `epicenter` command found on `PATH` (or the compiled binary) at login. The job keeps the installing shell's `PATH` so actions can find the same programs. The person runs `install` and `uninstall`; agents may run `restart` and `status`. `status --json` reports whether it is installed and running, its pid when running, the serve port, and its log path.

`epicenter serve` starts an HTTP server on `127.0.0.1` at the port in `EPICENTER.md`, or 4747 when the marker has none. `--host <address>` and `--port <n>` override those settings. It serves MCP at `POST /`, the launcher at `GET /`, and each app's view at `/<app>/`: its `ui/dist/` ([ADR-0860](../../docs/adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md)). The launcher links to apps with a UI; a `GET /` asking for an event stream gets 405, since the server keeps no MCP session. Any later path of the server's own starts with `.`, which no app name can. The listener answers only a `Host` that is `localhost` (or `*.localhost`), an IP address, or a `*.ts.net` name, so a DNS rebinding name gets 403; it also refuses, with 403, any request carrying `Tailscale-Funnel-Request` or `Cf-Connecting-IP`, which a Tailscale Funnel or Cloudflare Tunnel adds. An Origin must match the request Host; requests without Origin are accepted. A reverse proxy such as `tailscale serve` can provide HTTPS. This listener signs no one in; a `public` address adds a second listener that does (see [The public address](#the-public-address)).

Both HTTP and `serve --stdio` offer every app action as a tool and send the Epicenter's `AGENTS.md`, when present, as MCP server instructions, read again on each initialize so an edit reaches the next client without a restart. The server never imports an app. `tools/list` runs `epicenter <app> --json` for each app entry in its own child, so an app that fails to load loses only its own tools and says why on stderr. Each `tools/call` runs `epicenter <app> <words> --input <json>` in a fresh child from the Epicenter folder, so an edit between calls is seen by the next. `serve --stdio` uses stdin and stdout for MCP. A `tools/call` whose `_meta` sets `"epicenter/yields": true` and gives a `progressToken`, as the view client's does when it passes `onYield`, is also sent each value its action yields as a progress notification, with the value in `_meta["epicenter/yield"]`; over HTTP that one call is answered with an event stream, and when its reader goes away `serve` stops the child with SIGTERM. Every other request gets one JSON body, a connector's included.

Either transport answers a call that is not read-only after its child has committed the paths it wrote. A commit failure goes to stderr; the paths remain visible in status.

The HTTP server backs up on a clock: when it starts, every 5 minutes, and when it receives SIGINT or SIGTERM, it does for each app what `epicenter sync <app>` does. It snapshots what is pending as `<app>: changed outside epicenter` and pushes the branch to `origin` by name when the branch is ahead of its `origin` tracking ref or there is no tracking ref yet; it never pushes to `upstream`. So a call's commit reaches the backup within 5 minutes, not at once. A tick never waits for a call: it skips an app while a call to it runs, from any process, and the call's own commit or a later tick takes what the call wrote. A failure goes to stderr, once until it changes, and leaves the commits local. `serve` says it is serving as soon as it listens, while its first backup runs, and on a signal it waits at most 10 seconds for its last backup before it exits.

## The public address

When `EPICENTER.md` has `public` and `publicPort`, `serve` also listens on `127.0.0.1:<publicPort>` and prints `Serving <public> at http://127.0.0.1:<publicPort>: an HTTPS tunnel from that address must forward to this port.` Any HTTPS tunnel that forwards `public` to that port works, such as Tailscale Funnel or Cloudflare Tunnel; `serve` never starts or changes one ([ADR-0871](../../docs/adr/0871-a-public-address-signs-people-in-with-a-passkey-and-connectors-in-with-oauth.md)). The private listener still trusts every request it answers, and with `public` set, `serve` refuses a `--host` that is not a loopback address (`127.x.x.x`, `::1`, or `localhost`); the tailnet reaches it through a proxy such as `tailscale serve`. The public one serves a request only for a person's session or a connector's token, so the boundary is the socket a request arrives on, not a header. Both listeners serve the same site, and the backup clock is the same one.

A Funnel or Cloudflare Tunnel aimed at the private port by mistake reaches only 403s: each sets its header on every request, and Funnel deletes a copy the client sent. `Host` is no defence there, since Funnel forwards the client's own. Another tunnel that adds no such header and forwards an allowed `Host` would reach the private listener with no sign-in, so never tunnel the private port.

| Public path | Needs |
| --- | --- |
| `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-authorization-server/.auth` | nothing: OAuth metadata |
| `/.auth/oauth2/authorize`, `/.auth/oauth2/token`, `/.auth/oauth2/consent`, `/.auth/oauth2/revoke`, `/.auth/jwks`, `/.auth/passkey/*` | Better Auth; every other `/.auth/` path is 404 |
| `GET /.sign-in` | nothing: signs in with a passkey, or registers one from an invite |
| `GET /.allow` | a session: approves a connector |
| `POST /` | a bearer token, or a session with this address as `Origin`; MCP |
| `GET /`, `/<app>/...` | a session; without one, a redirect to `/.sign-in` |

Better Auth is the authorization server (`src/authorization-server.ts`). Its state is `access.local.sqlite` and its secret is `access.local.key`, both in the Epicenter's folder with mode 0600; as `.local` files outside every app, nothing commits them, and no app's lock covers them. A connector's access token is a 15-minute JWT whose audience is `public`, checked against the signing keys in that database, so a check never leaves the computer. After the signature, every MCP call also checks the database: the token's grant must still have a consent covering its scopes, its person a passkey, and it must have been issued in a later second than the grant's last revoke; otherwise it answers 401 `invalid_token`. The authorization server metadata names no introspection endpoint. `POST /.auth/oauth2/revoke` is a connector's disconnect: it revokes the refresh token presented, not the grant, and presenting one already revoked ends every refresh token of that grant. The `read` scope lists and calls only actions with `readOnlyHint: true`, and each call runs in a child that refuses any other action and every command, which a call to another action gets as a tool error. A token without `read` gets 403 with an `insufficient_scope` challenge. A read-only call commits nothing; it takes the app's lock only to write a `.local` file, as any write does. `write` allows every action. A person's session lasts 7 days and is not extended.

People sign in with passkeys, starting from an invite. `epicenter access invite [<name>]` prints a link to `/.sign-in?invite=<token>` that registers one passkey, once, within 15 minutes; `<name>` defaults to `device-<n>`. A device already signed in cannot use an invite. Connectors such as Claude and ChatGPT are added by pasting `public` as a custom connector. Each identifies itself by a client metadata document, which `serve` fetches only over HTTPS from a public IP address, without following redirects. Every authorization asks for a passkey and shows `/.allow`, whatever the connector asked: the router sets `prompt=login consent` and adds `offline_access` to the scopes, and refuses an approval without `offline_access`, so every grant's code exchange starts a refresh family (Better Auth lets any connector allowed the authorization code grant refresh, whatever its document lists). `/.allow` leads with the host serving the connector's client_id, shows the whole client_id, then the name its document gives itself, and says to allow it only for a connection the person just started. The person chooses between reading and changing, reading only, or not allowing it. Text from a metadata document is shown without control or bidirectional characters, there and in `epicenter access`.

`epicenter access` lists people, with when each was approved and last signed in, and each grant: a connector one person approved, with its host, full client_id, the name it gives itself, the person, its scope, when it was last approved, its last refresh, and its connections (live refresh families, one per code exchange), so a second connection under one approval shows. `--json` prints `{ "access": [...] }` with `kind` `person` or `grant`. `epicenter access revoke <connector> <person>` ends one grant; `revoke <connector>` ends every grant of it, naming it by client_id, host, or name; `revoke <person>` ends a person, by name or id. A word that names more than one is refused with the ids to use.

A revoke runs in one transaction. Each grant it ends gets a row in `grantRevocation`, and SQL triggers on Better Auth's tables, recreated after its migrations on every start, refuse what comes from before it: a refresh token inserts only under a consent and from an authorization code issued after the grant's last revoke (recorded in `codeIssued` by SQLite's clock), and a code inserts only under a consent. So a code exchange or a token rotation in flight across a revoke and a re-approval returns 400 `invalid_grant` and no token, and the grant's live access tokens fail their next call. The grant's consent, refresh tokens, access token records, and pending codes are deleted too. A person also loses their passkeys, sessions, any pending code, and their user row. Approving a grant again with narrower scopes deletes its refresh families that hold more. `access` opens the same database `serve` holds open, so it works while `serve` runs and a change takes effect at once. Without `public` in `EPICENTER.md`, it says to add `public` and `publicPort`.

## Each writer commits its own boundary

An app is two repositories ([ADR-0877](../../docs/adr/0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md)): the app's folder holds its code, and `data/` inside it holds its data, a repository of its own that the code's `.gitignore` leaves out (`src/data.ts`). An action writes only under `data/` ([ADR-0876](../../docs/adr/0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md)), so a call's commit goes to the data repository; `epicenter` makes that repository, with a `.gitignore` of `*.local` files and a copy of the app's `.gitattributes`, the first time it commits there, and `new` makes it at once. A record's path is the same everywhere, `data/tasks/<time>.md`: only Git calls made inside the data repository use the path inside it.

A call changes files and commits exactly the paths it wrote ([ADR-0850](../../docs/adr/0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md)), named `<app>: <action words> [first positional value]` (one line, cut at 60 characters), and `(threw)` when it threw. Every data commit carries the trailer `Code-Commit: <sha>`, the code's `HEAD` when it was made, so the data says which code it was written for. Three kinds of writer commit, each with the boundary it knows (`src/snapshot.ts`):

- A call, in its own process before it answers, however it arrived: exactly the paths it wrote that changed. One `git status` of those paths, each given literally, drops what is unchanged, ignored, or created and then deleted; `git add -A` and `git commit` of what is left leave every other pending or staged change as it was. The subject is the call, or `<call> (threw)`, with no body.
- An agent that edits an app's code or data itself: `epicenter sync <app> -m "<what it did>"` snapshots what is pending in both as `<app>: <what it did>` and backs each up. A plain `git commit` in either repository works too.
- Anything else, such as an editor: `epicenter sync`, the first step of `epicenter undo` and of `epicenter update`, and `serve`'s clock snapshot what is pending as `<app>: changed outside epicenter`.

A snapshot with no call commits the code, then the data, so the data's commit names the code commit just made. In each it runs `git add -A` and `git commit` with the pathspec `.`, taking everything changed that Git does not ignore, staged or not. Its message is the subject alone; `epicenter history` reads its paths from Git. The code is committed only when the app's folder is the top of its own repository, and refuses while its `.gitignore` does not list `data/`, naming the line to add. A data commit refuses when `data/` has a `.git` that is not a repository of its own.

The data's `.gitignore` keeps `*.local` and `*.local.*` on this computer ([ADR-0870](../../docs/adr/0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md)). Before staging, a commit that would take such a file refuses with `<path> would be committed; add *.local and *.local.* to <app>/data/.gitignore` (or `<app>/.gitignore` for the code), or, when Git already tracks it, names `git -C <folder> rm --cached -- <path>` and a commit of that removal as the next step. Nothing changed makes no commit. Before staging, when the folder's `.gitattributes` mentions `filter=lfs` and `git config filter.lfs.process` is empty, it stops with `git lfs install` as the next step ([ADR-0856](../../docs/adr/0856-binary-files-go-through-git-lfs.md)), and while a merge, rebase, revert, or cherry-pick is underway it stops with `git -C <folder> status`. When another Git process holds `index.lock`, it retries for about 2 seconds. A failed commit is `{ message, next? }`. It changes no answer or exit code: after a call, stderr reads `<app>: not yet in history: <message>` and `Run: <next>`, or `Run: epicenter sync <app>` when the failure names no next step. The pending paths remain visible in status. A commit never pushes; only `sync` and `serve`'s clock do.

Each app has one lock: the kernel's `flock` on the app's folder itself, so there is no lock file (`src/lock.ts`). A call takes it at its first write and holds it until its commit has finished, whether it came from the command line, `serve`, or `serve --stdio`; a call that writes nothing never takes it, so reads never wait. Two calls that write one app take turns, from each one's first write to its commit. A snapshot with no call is made holding the lock, so it never commits part of a running call's writes as changed outside epicenter. `sync` holds it while it snapshots, not while it pushes; `undo` from its snapshot until its revert is committed; `update`, after its fetch, while it snapshots and merges. Each waits up to 30 seconds, then refuses, saying a call is still writing it (`sync --json` marks that error `busy: true`), and `serve`'s clock skips the app. A call's first write also waits up to 30 seconds, then throws `<app> is busy`. The kernel releases the lock when the process holding it ends, so a crash never leaves it held. `folder.update` writes only over the text its change read, so every collection write lands, an editor's write among them. `folder.write` is last-write-wins.

A read-only run, of an action with `readOnlyHint: true`, never commits. In it, `folder.write`, `folder.writeBytes`, `folder.update`, and `folder.delete` throw before doing anything, naming the action: `The action "<words>" is read-only, so it cannot write <path>`. A `.local` path is let through, since no commit takes it: an action that only reads may still refresh a token kept in `google.local.md` ([ADR-0870](../../docs/adr/0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md)). A raw `node:fs` write is not caught.

`folder` is a convenience, not a sandbox. Paths are normalized and `.git` is refused; writes replace a whole file at once, through a file beside it named `*.local`, which the app's `.gitignore` keeps out of every commit. A replaced file keeps its mode, a new `.local` file is `0600`, and a new directory on a `.local` path is `0700`, since an app's secrets are `.local` files. `folder.path` is the folder, and an action may use `node:fs` too; what it writes that way is a change from outside epicenter.

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

`epicenter sync [<app> [-m <message>]]` snapshots both of an app's repositories and pushes each to its own `origin`, a private backup ([ADR-0851](../../docs/adr/0851-an-app-has-one-home-and-an-optional-push-only-backup.md), [ADR-0877](../../docs/adr/0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md)). For each app in the Epicenter, or the one named, one after another, it commits pending changes and then, in each repository with `origin`, runs `git push origin HEAD:<branch>` if the branch is ahead of its `origin` tracking ref or has none yet; `serve`'s clock follows the same rule. The snapshot reads `<app>: changed outside epicenter`, or with `-m` (`--message`), which needs an app, `<app>: <message>`; a message must be one line of text. It never fetches, pulls, rebases, stashes, or force pushes. A repository without `origin` gets a local snapshot. Nothing goes to `upstream`, the starter an app came from, or to any other remote: sharing an app is pushing its code to a remote its author chooses, with `git push`.

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

It refuses, exit 2 with `{ "error": { "name": "Refused", "message", "next"? } }`, and leaves the folder's files as they were: a commit not in the app's history, a newest commit that is not a snapshot, since its subject does not start with `<app>: ` (the first commit, or one made with Git directly, which can still be named), a revert Git refuses with Git's message, such as a merge's, naming `git -C <folder> revert -m 1 <commit>` as the next step, a revert that conflicts (it is aborted, naming the conflicting files), a revert that changes nothing, such as one of a commit already undone, and a snapshot that fails, which includes an app in the middle of a merge, rebase, revert, or cherry-pick. A named commit is checked before the snapshot, so its refusal adds nothing to history. An update's merge reverted that way stays reverted: Git counts its commits as merged, so the next `epicenter update` brings none of its changes back until that revert is undone. Without `--json`, stdout says what was undone, as `undid tasks: add Water the plants`; with it, `{ "undid": <commit>, "commit": <the undo's commit>, "codeSince"? }`. When the commit undone was written under code other than the code's HEAD, the undo lists the code commits made since (`codeSince`, each `{ commit, subject }`, newest first), and the text says the data may not fit the code: a field renamed since then leaves the restored files with keys no field declares, which reads as `other`, not as a problem.

## Adding apps

An app becomes one of yours when it is a direct child entry of the selected Epicenter:

- `epicenter new <name> --from <git url|path>` makes it from a starter, another app's code repository ([ADR-0866](../../docs/adr/0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md)).
- `epicenter new <name>` makes it there from the built-in template.
An entry may also be a symlink to an app elsewhere. The CLI follows the link when listing or running it.

`epicenter new <name> --from <git url|path>` clones the starter into `<Epicenter>/<name>`, renames the clone's remote to `upstream`, leaves the branch tracking nothing, so no push reaches the starter, and makes an empty data repository. A path must be a repository's root, since Git clones only whole repositories. The clone must have an `epicenter.ts` that loads; otherwise it is removed. It builds nothing itself: `serve` builds the view when it is first opened (below).

`epicenter new <name>` makes the folder from the built-in template: an `epicenter.ts` that default-exports `defineApp` with a description to fill in and no collections or actions, and a `.gitignore` of exactly `data/` and `node_modules/`. It runs `git init`, commits the template as `new <name>`, and makes the data repository, whose first commit, `<name>: start its data`, holds its `.gitignore` of `*.local` and `*.local.*`. It writes no `.gitattributes`: an app that comes to hold binary files routes them through Git LFS in its own ([ADR-0856](../../docs/adr/0856-binary-files-go-through-git-lfs.md)).

Each prints the folder on stdout, and on stderr `Run: epicenter <name>`, then `not backed up` and `Run: git -C <folder> remote add origin <url> and git -C <folder>/data remote add origin <url>, each a private repository, then epicenter sync <name>`. A name already in the Epicenter, ignoring case, is refused, as is a name that is one of the commands.

## Updating from a starter

`epicenter update [<app> [<remote>]]` brings a starter's changes into each app's code with an `upstream`, or the one named, one after another, from `upstream` or the remote named (`src/update.ts`). An author takes back a change someone made in their copy the same way: `git -C <folder> remote add brother <url>`, then `epicenter update <app> brother`. It fetches the remote, learns its default branch when Git does not know it, snapshots what is pending in the code and the data as `<app>: changed outside epicenter`, as `undo` does, and merges the branch `<remote>/HEAD` names as `<app>: update from <remote>`. A merge that stops on a conflict is aborted, leaving the app as it was, and the next step is `git -C <folder> merge <remote>/<branch>`. It then checks that the merged `epicenter.ts` loads; `serve` rebuilds the view from the merged code. The data is never merged, and Git does not migrate it: a field the merge renames is repaired in the data by an action or an agent. An app without the remote is left alone. With `--json` it answers `{ "apps": [{ app, folder, remote, found, merged, error? }] }`; it exits 0 when every app updated and 1 when any did not.

An app's view is what its `ui/` builds to in `ui/dist/` ([ADR-0860](../../docs/adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md)), and `ui/dist/` is a cache of the code repository's `HEAD`, stamped with the commit it was built from in `ui/dist/.epicenter-build` (`src/ui.ts`). When a page load at `/<app>/` or `serve`'s clock finds the stamp names another commit, `serve` builds `HEAD` in the background, one build per app at a time, and serves the last view until it is done. A commit whose build fails is not retried; its failure is written to stderr once, with `Run: epicenter build <app>`. So a change to the view shows once it is committed, by whoever made it or by `serve`'s snapshot, and never from a half-edited working tree. A build checks out `HEAD` into a detached worktree beside the app, `.<app>-build-*`, so Git LFS files arrive as files. When that commit's `ui/package.json` has a `build` script, it runs `bun install` (frozen to `ui/bun.lock` when there is one) and `bun --bun run build` in its `ui/` with `EPICENTER_BASE=/<app>`, the path the view is served at, which a build that names its assets absolutely uses as its base (the starters' SvelteKit does). It must write `ui/dist/`. Otherwise, when `ui/index.html` exists, Bun's bundler bundles it with relative paths, and `epicenter` supplies `@epicenter/app/client`, so one `index.html` and the files beside it are a view with no `package.json`. With neither there is nothing to build, and nothing is checked out to find that out. Either way the build runs with the Bun that runs `epicenter`; the compiled `epicenter` is Bun itself under `BUN_BE_BUN=1`. The finished `dist/` replaces `ui/dist/` by rename, so `serve` never answers from half a build, and a failed build leaves the last view in place. `serve` never serves a path with a part starting with `.`.

`epicenter build [<app>]` builds every app's view from its `HEAD` now, or one app's, and shows the build's errors. It reports `view built from <commit>`, `nothing to build`, or a build error for each app. With `--json` it answers `{ "apps": [{ app, folder, built, error? }] }`, `built` being the commit or `null`. A build error exits 1; another app can still build.

What an app can rebuild lives in files it gitignores in its folder, such as `ui/dist/`, ignored by `ui/.gitignore` ([ADR-0854](../../docs/adr/0854-an-apps-cache-is-the-files-it-gitignores.md)).

Compile the executable from the repository root:

```sh
bun run --cwd packages/cli compile
```

## Tests

Run `bun test <file>` in `packages/cli` one file per process when memory is short. `acceptance.*.test.ts` runs the real `epicenter` against a temporary `HOME`, one test per acceptance ID, with bare repositories in temporary folders standing in for remotes.
