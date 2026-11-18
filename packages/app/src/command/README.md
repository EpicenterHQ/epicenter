# The epicenter command

`epicenter` runs the apps in an Epicenter as commands and MCP tools. An
Epicenter is marked by `EPICENTER.md`. Its private root Git repository holds
all apps' code and records, and it is one Bun workspace: its `package.json`
names the version of Epicenter it runs. Each folder in `apps/` is a stable app
container:

```txt
<Epicenter>/
  .git/  EPICENTER.md  AGENTS.md  .gitignore  .gitattributes
  package.json                  the workspace, and the Epicenter version
  bun.lock                      committed
  node_modules/                 ignored; one install for the command and every app
  routines/  scripts/
  apps/<app>/
    code/                       one package of the workspace
      epicenter.ts  package.json  README.md
      ui/                       source
        dist/                   ignored build
    data/                       what you want back if this computer is lost: records, settings
    local/                      what this computer can rebuild or sign in again: sign-ins, caches
```

[ADR-0910](../../../../docs/adr/0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md)
describes the current layout and history. Each personal or shared Epicenter has
its own private root repository, separate from this runtime source monorepo
and from code-only app publications. No command imports or retires nested
repositories.

## An Epicenter is a Bun workspace

```json
{
  "private": true,
  "workspaces": ["apps/*/code"],
  "scripts": { "build": "bun run --filter '*' --if-present build" },
  "dependencies": { "@epicenter/app": "0.7.0" }
}
```

`bun install` at the top of the Epicenter installs everything: `@epicenter/app`,
which is both the library every `epicenter.ts` imports and the command, as
`node_modules/.bin/epicenter`; and each app's own packages. There is one
`bun.lock`, which is committed, and one `node_modules/`, which is not. The
version an Epicenter runs is one line in a file in Git
([ADR-0960](../../../../docs/adr/0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md)).

- Bun must be installed. The command is TypeScript that Bun runs; there is no
  separate program to download.
- Run the Epicenter's own command. Put `<folder>/node_modules/.bin` on `PATH`, or
  run `bun x epicenter` from inside the Epicenter.
- An app's `code/package.json` is named for the app and lists only what the
  app itself imports. It never lists `@epicenter/app`, which comes from the
  Epicenter. Add a package with `bun add <package>` in `code/`.
- `bun install` at the top of the Epicenter installs every app's packages and
  Epicenter. Epicenter has no install command, and calls and listings never
  install.
- Restart `serve` after changing packages: stop `epicenter serve` and start
  it again. An edit to an app's own files
  shows on the next call. A package lives in the Epicenter's top `node_modules/`,
  outside the app's folder, and `serve` keeps the packages it has loaded.
- To upgrade, edit the version in the Epicenter's `package.json`, then run
  `bun install && bun run build`, commit `package.json` and `bun.lock`, and
  restart `serve`. The build gives every UI the new client; reload open pages.
- Bun reads one `bunfig.toml`, at the top of the Epicenter. It ignores one inside
  an app, so a setting an app needs, such as `peer = false` under
  `[install]`, goes in the top file.
- A package nested inside an app, such as `apps/films/code/render/` with its
  own `package.json`, gets its packages only once its path is in the list:
  `"workspaces": ["apps/*/code", "apps/films/code/render"]`. Add it by hand;
  no command rewrites the list.

An entry in `apps/` may be a link; Epicenter treats it as the folder it leads
to. Bun finds packages from where a file really is, so a link to code outside
the Epicenter finds no `@epicenter/app`, and the listing gives Bun's reason. Keep
an app's code inside the Epicenter.

## Install and try a writing inbox

Writing is an ordinary app. Save thoughts, quotes, and links with their
sources and projects, then search them from the browser, terminal, or an
assistant. It needs no AI account or provider
key. Taking it copies ordinary app files from GitHub into your Epicenter.

You need Bun and Git, with Git's `user.name` and `user.email` configured.
Make `~/Epicenter` as [Make an Epicenter](#make-an-epicenter) says, then:

```sh
export PATH="$HOME/Epicenter/node_modules/.bin:$PATH"
cd ~/Epicenter
mkdir -p apps/writing/code
curl -L https://github.com/EpicenterHQ/epicenter/archive/main.tar.gz | tar -xz -C apps/writing/code --strip-components=3 epicenter-main/examples/writing
bun install && bun run build
epicenter serve
```

In another terminal:

```sh
epicenter writing add '{"body":"An observation I want to return to","source":"My notebook","project":"Essay"}'
epicenter writing search '{"query":"observation"}'
```

Open `http://127.0.0.1:4747/writing/`. Save a real note, search for it, and open
it to edit. Your notes are in `apps/writing/data/notes/`. Closing the terminal
stops the server; the files remain. Keep unsubmitted text open until saved.

To connect an assistant on this computer, add a Streamable HTTP MCP server at
`http://127.0.0.1:4747/`. Ask it to find saved notes with their sources. You can
also run a coding agent from this Epicenter and ask it to adapt
`apps/writing/code/`. The [writing app README](../../../../examples/writing/README.md)
explains one first change. Copied code belongs to you; later shared code
does not replace it.

Start on localhost. Add a private connection when another device needs access.
To keep the server running after you close the terminal, see
[Keep serve running](#keep-serve-running).

### When to ship a runtime version

Can the installed `epicenter` run the changed app, and does its UI build? If so,
ship the app commit and run its `bun run build` when the UI changed. For example, Tasks can
reread a task after an uncertain save with the `get` it already has. That uses
a capability already installed.

Test routine app changes on the current Epicenter release. For a shared app,
copy its published folder into a temporary Epicenter to check the copy people install.

`@epicenter/app` is one package: the library, the client and the command
ship together at one version. Commits can accumulate before a release. Ship separately when an installed consumer needs
the fix now or when the next change depends on readers having upgraded first.
Changes that can reach the same consumers together can share a release.

| Example | What to ship | Why |
| --- | --- | --- |
| `0.2.1` reads both host answer formats and still writes the old one | Ship the reader patch separately. Rebuild browser clients and update consumers that parse CLI or MCP output directly. | This provides a working combination while consumers upgrade. A tab that was already open needs to reload to get the new reader. |
| `0.3.0` starts writing the flat `{ data, error }` answer | Ship the writer after the readers. | A `0.2.0` reader could treat a successful flat answer as invalid. Changing both ends in one installation would still leave older readers in use. |
| `0.4.0` removes `after` from the public `run.events()` API | This shipped separately. Given the same choice again, batch it with the next planned runtime release. | None of the twelve apps in the owner's Epicenter passed that option. The client already managed reconnect offsets, so removing it gave the Epicenter no reason to upgrade immediately. |

During `0.x`, use a patch for a compatible runtime fix and bump the middle
number when an existing caller must change to keep working. Choose the
number for the whole batch when it ships. Once distributed, a version
identifies that build. The [Result cutover](../../../../docs/adr/0926-a-collections-methods-return-results-and-a-file-that-is-not-a-record-is-an-error.md#cutover)
records the wire behavior behind these examples.

### Release

One package is published: `@epicenter/app`, which ships its TypeScript
source and runs under Bun. It holds the library, the client a UI imports
from `@epicenter/app/client`, and the `epicenter` command. `@epicenter/cli`
is retired at its last published version; an Epicenter that names it drops that
line. An Epicenter upgrades by editing the one version in its `package.json`,
then running `bun install && bun run build`.

Nothing in this repository publishes by itself: no script or workflow runs
`bun publish`. The owner releases by hand, from the repository root. Set
`version` in `packages/app/package.json`, then pack:

```sh
bun run --cwd packages/app pack
```

`pack` writes the tarball, as a registry would receive it, into
`packages/app/dist/pack/<hash>/`, and prints its path. It publishes nothing.
`bun pm pack` rewrites `catalog:` to real versions, and the script refuses a
tarball where one is left. `--outdir` selects another folder.

Publish from that folder, with `--dry-run` before the real publish:

```sh
cd packages/app/dist/pack/<hash>
bun publish epicenter-app-0.7.0.tgz --dry-run
bun publish epicenter-app-0.7.0.tgz
```

### Try an unreleased change

Pack, then point the Epicenter's dependency at the tarball with `overrides` in
its `package.json`. `pack` prints these lines with their path:

```json
{
  "overrides": {
    "@epicenter/app": "file:/path/to/pack/<hash>/epicenter-app-0.7.0.tgz"
  }
}
```

Run `bun install` at the top of the Epicenter and restart `serve`. Bun caches a
tarball by its path, so a file changed in place keeps installing its old
content: the file's path must change when its content does. The `<hash>`
folder is named for the tarball's content, so each pack of changed source is
a new path. Rehearse on a clone of the Epicenter, not the Epicenter. Remove
`overrides` and install again to return to the released version.

## The commands

Your Epicenter lives on a computer you control and keep on. `epicenter serve`
offers its apps to devices on a private connection. An older laptop with
Tailscale is one setup. See [a computer that stays on](../../../../docs/vision.md#a-computer-that-stays-on).

A command acts on the Epicenter it runs in: the nearest folder at or above
the current one that holds `EPICENTER.md`, as Git finds the nearest `.git`.
Outside any Epicenter it refuses and says to `cd` into one. An agent working
in another repository changes folder first, for example
`(cd ~/Epicenter && epicenter reading log '{"minutes":30}')`
([ADR-0965](../../../../docs/adr/0965-the-command-finds-its-epicenter-by-walking-up-and-serve-starts-in-its-folder.md)).
The marker's optional front matter
accepts only `port`, an integer from 1 to 65535; the default is 4747. An empty
marker is valid. Nothing refuses an Epicenter inside another: a command uses
the nearest marked folder at or above where it runs.

```sh
epicenter
epicenter reading
epicenter reading log '{"minutes":30,"book":"Dune"}'
epicenter reading log '{"minutes":30}' --json
epicenter reading books patch '{"id":"dune","finished":null}'
epicenter check
epicenter serve
epicenter --version
```

The commands are `check` and `serve`. Their usage and help live in
`cli.ts`. No command makes an Epicenter, makes an app, or copies
one: [Make an Epicenter](#make-an-epicenter) and
[What an app holds](#what-an-app-holds) list the files
([ADR-0958](../../../../docs/adr/0958-no-command-makes-an-epicenter.md),
[ADR-0955](../../../../docs/adr/0955-no-command-makes-or-copies-an-app.md)).
`epicenter` on its own reports the Epicenter: the version serve runs, its apps,
and its routines. See
[The Epicenter's report](#the-epicenters-report).
Any other first word names an app. `--json` and `--help` (`-h`) go anywhere;
`--version` stands alone. No other word starts with `-`: names are lowercase,
and an input is `{...}` or `-` alone, so a command refuses any other flag,
`--` included. Every command answers one `{ data, error }`, as an action call does
(see [What a run answers](#what-a-run-answers)); a misuse answers `NotStarted`
with its usage line and its help command as the next step.

## Discover and load an app

Discovery lists `apps/`, skips dot entries, and accepts a directory or a link
to one with `code/epicenter.ts`. The file must default-export
`defineApp(({ folder }) => ...)`. The loader calls that function once with
`folderOnDisk(<container>)` and lists what it returns.
An entry with `code/` or `data/` but no declaration is listed with
`code/epicenter.ts is missing`. Other folders are skipped. Discovery reads
`apps/` only, never the `workspaces` list, so a package the owner added to
that list is not taken for an app.

An import or declaration failure is listed under that app's problems with a
`code/epicenter.ts:` prefix. A wrong default export is also a problem, and so
is a `local/` with no `.gitignore` (the app still runs). One broken app
does not hide the others. Listings include container locations, data keys,
schemas, and actions. The listing's `Version` is the one serve runs. They carry no per-app Git status. An
empty Epicenter says `No apps yet. An app is apps/<name>/code/epicenter.ts`.

The container's real path is `folder.path`. Contracts address `data/...`
from that container. A separate real `codePath` is used for module imports
and invalidation, and for UI builds and serving. Replacing `code/` leaves
record paths intact.

An action's input is one argument after its words, `epicenter <app> <action>
[<input>]` (ADR-0925): one JSON object as text, or `-` to read that text from
stdin. No input is `{}`. Stdin is read only for `-`, so a routine with stdin
closed and an agent whose shell holds it open both run. Text that is not a
JSON object, or more than one word, is refused with exit 2 and an example
object. Serve reads and checks the object, for the command line as for HTTP
and MCP, with the same messages: the command sends its words as typed and
reads `-` from its own stdin, sending the text in its place
([ADR-0961](../../../../docs/adr/0961-the-command-sends-an-actions-words-to-serve-and-serve-alone-reads-them.md)).
A key the action does not take is refused, naming the keys it does.
`null` removes a field that accepts it. For text a person wrote, `- <<'EOF'`
avoids shell quoting. `epicenter <app> <action> --help` lists the input's keys
and prints an example to copy. A listing or action help with `--json` exposes
each action as an MCP tool definition, with the annotations the action states.
Its `inputSchema` is the action's `input` unchanged: one JSON Schema object
whose `required` lists the keys a caller must give, `[]` when none is
(ADR-0953). The check a call's input passes, `--help`, and its example read the
same object, so they agree on what is required.
An action that declares `mcp: false` is left out of serve's MCP tools and a
`tools/call` for it is refused; a `--json` listing shows it with `mcp: false`,
and the plain listing adds `(not offered to agents)`.

## One serve runs every action

One serve per Epicenter. The port is its name and its lock. You start it and keep it
running; the command line never starts it or stands in for it.

`epicenter serve` is the only process that loads app code and runs an app's
actions. `epicenter <app> <action>` sends its words as typed to serve at the
port in `EPICENTER.md`, at `POST /<app>`. Serve finds the action, reads the
input, runs it, and answers "no such action" and "this input does not fit"
itself; the command prints the updates and the answer it reads back. Bare
`epicenter`, `epicenter <app>` and an action's `--help` print serve's one
listing, `GET /` as JSON, or ask it for one action. The command never loads
an app, so it and serve cannot disagree about one.

While serve is stopped, an action is refused with exit 2 and nothing runs. Its
answer is `NotStarted` with cause `unavailable`:

```txt
$ epicenter reading log '{"minutes":30}'
serve is not running; its output says why it stopped
Run: epicenter serve
```

Bare `epicenter`, `epicenter <app>` and an action's `--help` are refused the
same way. Only `check`, and `--help` or `--version` on their own, work while
serve is stopped: `check` loads each app as it is on disk, in its own
process, so it also tries changed code before a restart.

The port is the Epicenter's name. A command names its Epicenter on every request in
an `x-epicenter-root` header: its real path, sent only to `127.0.0.1`, so it
never leaves the computer. Serve refuses a request naming another root with
`409` and a body that does not name its own. Every answer to a request it
accepts, its `500` included, carries `x-epicenter: 1` and no path; a
tunnelled request's `403` carries nothing
([ADR-0961](../../../../docs/adr/0961-the-command-sends-an-actions-words-to-serve-and-serve-alone-reads-them.md)).
A command whose port answers for something else runs nothing:

```txt
Port 4747 answers for another Epicenter. Set a different `port` in EPICENTER.md.
```

It says `another program` when what answers is not an Epicenter's serve. Two
Epicenters on one computer each need their own `port`, a whole number from 1 to
65535.

The port is also the lock. A second `epicenter serve` for an Epicenter that is
already served exits 2 and changes nothing:

```txt
serve is already running for this Epicenter on port 4747.
```

When something else holds the port, it says who, asking as a command does:

```txt
Port 4747 is in use by another Epicenter's serve. Set a different `port` in EPICENTER.md.
Port 4747 is in use by another program. Set a different `port` in EPICENTER.md.
```

After an upgrade, the serve that was already running is still the old
version until you restart it. Nothing warns you: restart serve after every
upgrade.

An action runs in serve's environment: it does not see variables exported in
the caller's shell, and what it prints goes to serve's output, not to the
command. Each load drops cached modules under `codePath`, dependencies
included, then imports `code/epicenter.ts`. The next call reads edits to code
or its imports without restarting serve.

An action shares its process with other calls. `process.exit` ends serve:
every call then running is cut off, and a command that sent one answers
`Unreachable` with exit 1, since the action may have run. `process.chdir` or changes
to `process.env` affect other apps too.
An action's writes remain on disk when it returns an Err, throws, or is interrupted. Actions
perform no Git work.

`epicenter serve` starts an HTTP server on `127.0.0.1` at the port in `EPICENTER.md`, or 4747 when the marker has none. It takes no flags and listens nowhere else: another device reaches it through a private proxy on this computer, such as `tailscale serve --bg 4747`. It serves MCP at `POST /`, the launcher at `GET /`, the listing at `GET /` to a request that accepts `application/json`, the command's words at `POST /<app>`, each app's actions to its UI at `POST /<app>/<action>`, and each app's UI at `/<app>/`: its `code/ui/dist/` ([ADR-0860](../../../../docs/adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md)). The launcher links to apps with a UI; a `GET /` asking for an event stream gets 405, since the server keeps no MCP session. Any later path of the server's own starts with `.`, which no app name can. The listener answers only a `Host` that is `localhost` (or `*.localhost`), an IP address, or a `*.ts.net` name, so a DNS rebinding name gets 403; it also refuses, with 403, any request carrying `Tailscale-Funnel-Request` or `Cf-Connecting-IP`, which a Tailscale Funnel or Cloudflare Tunnel adds. An Origin must match the request Host; requests without Origin are accepted. A reverse proxy such as `tailscale serve` can provide HTTPS. `serve` signs no one in: it trusts this computer and the tailnet, and who reaches it is its host's decision ([ADR-0883](../../../../docs/adr/0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md)). A Funnel or Cloudflare Tunnel aimed at this port by mistake reaches only 403s: each sets its header on every request, and Funnel deletes a copy the client sent. `Host` is no defence there, since Funnel forwards the client's own. Another tunnel that adds no such header and forwards an allowed `Host` would reach `serve` with no sign-in, so never tunnel its port.

MCP offers every app action as a tool and sends the Epicenter's `AGENTS.md`, when present, as server instructions, read again on each initialize so an edit reaches the next client without a restart. `tools/list` offers the actions of serve's listing, which loads each app as it is now; an app that fails to load loses only its own tools and says why on stderr. `tools/call` decodes the tool name and runs the action, so an edit between calls is seen by the next. What an action yields is not sent over MCP; a client gets its answer.

A page calls actions through `@epicenter/app/client`, at
`POST /<app>/<action>`. See [A call over HTTP](#a-call-over-http).

Serve commits nothing. Git stores the Epicenter, and its owner commits and pushes
it with Git; nothing is committed or pushed on its own. On SIGINT or SIGTERM
serve stops its routine commands and exits.

## Keep serve running

`epicenter serve` is one process. If it stops, it stays stopped, and every
action is refused until something starts it again. Keep it running as you would
any program: a terminal, tmux, a systemd user unit, or a LaunchAgent. Serve
starts in the Epicenter's own folder, and refuses anywhere else, because Bun
reads `.env` from the folder a process starts in. A unit sets
`WorkingDirectory=` to that folder, and a LaunchAgent sets `WorkingDirectory`.
What such a tool runs is Bun and the Epicenter's own command,
`bun <folder>/node_modules/.bin/epicenter serve`, so after an upgrade a
restart runs the new version. Actions and routines run with that tool's environment,
including its `PATH` ([ADR-0941](../../../../docs/adr/0941-epicenter-serve-is-a-program-you-keep-running.md)).

## Routines

The Epicenter opts into recurring work with `routines/<name>.md`, outside `apps/`.
A routine is an instruction to this computer, so sharing an app schedules
nothing. Once a minute, `serve` reads `routines/` and starts each routine
whose schedule had an occurrence since its last check. It keeps that one
moment in memory, starting from when serve started, so nothing runs at
startup:

```yaml
---
cron: "0 8 * * *"
run: ["epicenter", "my-app", "review"]
---
Prepare my morning review.
```

`cron` is a five-field expression or nickname such as `@hourly`, read in the
computer's local time by `Bun.cron.parse`. A skipped clock time moves forward
through the gap. Occurrences missed while the computer sleeps run once on
wake. An occurrence that passes while `serve` is not running does not run; a
routine that must not miss a day uses a wider schedule, such as
`0 8-22 * * *`, and a command that exits when today's work is done.

`run` is a program and its arguments, with no shell. The program is text. An
argument is text or any other JSON value, which reaches the command as one
word of JSON text, so an action's input needs no escaping:

```yaml
run: ["epicenter", "flights", "daily", "run", {"recheck": false}]
```

The working directory is the Epicenter folder. A routine finds its program the
way a terminal in the Epicenter would after `bun install`: its `PATH` is serve's,
with the Epicenter's `node_modules/.bin` and the folder of the Bun running serve in
front. So `epicenter` and `bun` work in `run` and in any script a routine
starts. Unknown fields and malformed declarations are refused. To stop a
routine, remove its file; the Epicenter's history keeps it.

`epicenter` on its own lists each routine's schedule, next occurrence, and
command as one shell-quoted line to copy into a terminal, or why its file is
refused, whether or not `serve` is running.

A person or their agent writes the file. Installing or importing an app
schedules nothing.

`serve` records nothing about a routine. It starts the command and does not
wait for it, time it, stop it, or note how it ended. Runs may overlap. A
command that needs a deadline sets its own; one that must not overlap itself
takes a lock, for example with `/usr/bin/lockf -t 0 <file> <command>`. A
command's output goes where `serve`'s does, and its result is whatever it
leaves in the Epicenter. `serve` writes to its stderr only a routine file it cannot
read and a command it cannot start. Commands share `serve`'s process group, so
stopping that group (Ctrl-C in a terminal, or the job that runs serve) stops
them. Commands must tolerate repetition;
there is no exactly-once guarantee.

See [ADR-0908](../../../../docs/adr/0908-serve-runs-the-homes-daily-routines.md) and
[ADR-0937](../../../../docs/adr/0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md).

## A call over HTTP

`POST /<app>/<action>` runs one action. Action words are joined with dots
(`/flights/watches.search`). The body is the input as one JSON object, at
most 25 MiB. The route uses the existing Host, Origin, and tunnel guards.

| Outcome | Response |
| --- | --- |
| The action ran | 200, `application/x-ndjson`: `{"update": value}` for each update, then `{"answer": { data, error }}` |
| No such app or action, the app cannot load, or the input is not JSON, not an object, or does not fit | 400, `{ data: null, error: { name: "NotStarted", ... } }` as the body |
| The body is larger than 25 MiB | 413, with the same `NotStarted` body |

A stream that ends with no `answer` line was cut off, and its outcome is
unknown: the action may still be running or may have finished. A page and
the CLI read it as `Unreachable`, with one reader, `readAnswer` in
`@epicenter/app`. The caller rereads its records, or calls again with the
same id when the action takes one.

Serve keeps nothing about a call: no id, no log, no replay. It runs the
action to its end whether or not the caller stays. A caller that leaves
stops reading, and updates it has not read are dropped. Updates for a slow
caller wait in order. Nothing stops an action from outside.

The CLI makes this same call to serve and writes each update to stderr as one
line of JSON; stdout holds only the answer. MCP sends the tool
result alone.

## Coordinate writes

Nothing locks a call. Serve is the one process that runs actions, so two
actions never replace one file at the same moment, whether they came from a
page, an agent, or two commands started together.

`folder.edit` reads the text, computes from it, and replaces the file, with
no other write through the folder between. Every data write uses it. Plain
`folder.write` is last-write-wins. Neither guards against a writer outside Epicenter, such
as an editor or a `git pull`.

Writes through `folder` stay under `data/` and `local/`.
The container remains `folder.path`. Reads may reach another app's records
at `../tasks/data/tasks/<id>.md`.

An action's MCP annotations, `readOnlyHint` among them, are forwarded to MCP
clients and refuse nothing. `folder` is not a sandbox.

What is in an app's `local/` stays on this computer. When `folder` makes
`local/`, it writes `local/.gitignore` containing `*`, so Git ignores the
folder whatever the root `.gitignore` says. The root line `/apps/*/local/`
stays as a second guard, for a `local/` an app made itself with `node:fs`
or SQLite. Such a `local/` without its own `.gitignore` is listed as a
problem by the Epicenter listing, `epicenter check` and serve's start, with
the fix:

```txt
apps/notes/local has no .gitignore; run: echo '*' > apps/notes/local/.gitignore
```

Never `git add -f` a file there. A file made under `local/` through folder
methods is readable by its owner alone (`0600`), and a directory made there
is `0700`; one already there keeps its mode. An action keeps a token with
`folder.write('local/google.md', token)`. `local/` appears when an action
first writes there. A write replaces a file by writing `local/.tmp/<uuid>`
and renaming it over the target, so nothing unfinished is ever under `data/`.

## What a run answers

Every surface gives one answer, exactly `{ data, error }`
([ADR-0953](../../../../docs/adr/0953-an-actions-answer-is-data-or-error-and-its-input-is-one-json-schema.md)).
`error` is `null` or the error object itself. With `--json`, stdout is that
answer; MCP returns it as `structuredContent` and sets `isError: true` for
any error; HTTP sends it in the last line, `{"answer": ...}`.

```txt
{ "data": <value>, "error": null }                                  exit 0
{ "data": null, "error": { "name": "NoRoute", "message": ... } }    exit 1, the action's own error
{ "data": null, "error": { "name": "Threw", "message": ... } }      exit 1, the action began and threw
{ "data": null, "error": { "name": "Unreachable", "message": ... } } exit 1, the outcome is unknown
{ "data": null, "error": { "name": "NotStarted", "message": ..., "cause": "usage" } }  exit 2
```

The error's name says whether the action ran:

| Error | Did the action run? |
| --- | --- |
| `NotStarted` | no; it is safe to call again once its cause is fixed |
| an error about a record, `Missing`, `Changed` or `Misfit`, or the app's own, such as `Refused` | yes |
| `Problems` | yes; `report` is what it found, and the job is not clean |
| `Threw` | yes, partly |
| `Unreachable` | unknown; reread the records before calling again |

`NotStarted` carries `cause`: `usage` (the words or input do not fit),
`app-problems` (the app
cannot load, with its `app` and `problems`), `internal` (Epicenter failed
before it began), or `unavailable` (no serve for this Epicenter answers, or
another program holds its port). `usage` and `unavailable` have a `next` step
when there is one. `Threw` carries the thrown tagged value as `thrown` when
it survives JSON. An error carries no marker of who made it: the name says.

An action cannot answer `NotStarted` or `Unreachable`. One that returns
either name answers `Threw`, so a caller can
trust the name. Any other error an action returns passes through whole,
including one forwarded from another action.

`Ok(undefined)` arrives with null data. Human output puts success data on
stdout and an error's message, and `Run: <next>` when there is one, on
stderr. The CLI's own commands (`check`, the listings, `--version` and
`--help`) answer the same way: with `--json`,
stdout is their `{ data, error }`, and the exit code follows the same rule.
`serve` prints no answer while it serves; a serve that cannot start answers
`NotStarted`, and `serve --json` is refused.

A one-file data key's `patch` makes its file when it is absent, so `epicenter vocab settings patch '{"goal":20}'` works on a fresh install. A folder key's `patch` answers `Missing` for an absent record and never makes one. The `patch` verb takes the fields beside `id`, and `body` replaces the whole body. The `edit` verb takes `id`, `old`, and `new`, and replaces the one passage `old` of the body; it is not safe to repeat:

```txt
$ epicenter vocab patch '{"id":"serendipity","meaning":"a lucky find"}'
$ epicenter vocab edit '{"id":"serendipity","old":"First seen.","new":"First seen in a novel."}'
```

MCP text contains the JSON answer on success and the failure message on error.
The human CLI formats success data by its structure (`src/output.ts`):

- An object prints one `key: value` line per defined key, in order. A string with a newline prints as `key: |` followed by indented lines. Other strings print plainly unless empty, padded with spaces, starting with a quote or `|`, or readable as JSON, such as `"true"`, `"null"`, or `"12"`; those print as JSON strings. A nested object with a defined key, or a non-empty array of objects, prints by these same rules under `key:`, indented two spaces. Numbers, booleans, null, other arrays, and an empty object print as compact JSON values.
- An array of objects whose fields each fit on one line prints one row per object, with `key: value` pairs separated by two spaces. If a field takes more lines, a multiline string or a nested object, each object prints on its own lines, with a blank line between objects.
- An empty array prints nothing. A string prints as is, with a final newline added if needed. Other arrays and single values print as JSON.

```txt
$ epicenter tasks get '{"id":"2026-11-10T09-30-00-000Z-k3x9a2f8"}'
path: data/tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md
id: 2026-11-10T09-30-00-000Z-k3x9a2f8
title: Email Sam the slides
done: false
due: 2026-11-12
body: |
  The deck is in Drive.
```

`id` prints as a field: the command reads only the answer. A folder key's `get`, `create`, `patch`, `edit`, and `delete` take `id` flat in the input object, beside the fields. `create` without `id` names the record by the moment it is made and returns that id.

## Check records

`epicenter check [<app>]` reads every data key an app declares, or every
app's, and reports the files that do not fit their key's fields. A `get`
returns a tagged `Misfit` for such a file. A generated `list` succeeds with
one Result per file, including the individual refusals. The check command
collects those diagnostics for the whole app so a person or agent can repair
the records or the declaration.

It runs `checkData` from `@epicenter/app` in a run of the app's folder and
writes nothing. Besides files that do not fit, it reports a file in a folder
key whose name is not a record id, names that are one file on a disk that
ignores case, and a `field.ref` that names no file in its target key. Front
matter no field declares is not a problem: a read does not give it, every
write keeps it, and the check does not report it.

For each key the report gives how many files it holds and how many have
problems, or `fits` for a one-file key whose file fits or is absent; then
each file's path under `data/` and its problem lines.

```txt
$ epicenter check flights
flights
  watches  2 files, none with problems
  checks  3 files, 1 with problems
    checks/bad.md
      watch: 3 is not text
      day: "soon" is not a day like 2026-11-12
  settings.md  fits
```

With `--json` its `data` is
`{ "apps": { <app>: { <key>: { path, single, files, withProblems, kinds: [{ kind, count }], records: [{ path, problems }] } } }, "problems": [{ entry, folder, problems }] }`.
A kind is a problem line without the value it quotes, so `due: "next week"`
and `due: "soon"` are one kind; when most files share one kind, the
declaration is often too narrow, and one change to `epicenter.ts` repairs
them all. `records` holds only files with problems. Without an app named, an
app that does not load is listed under `problems`, as in the Epicenter
listing, and the other apps are still checked; a read that fails lists its
app there too, and so does an app whose `local/` has no `.gitignore`, with
the command that adds one. A named app that does not load did not run:
`NotStarted`, exit 2. A clean report is `data`, exit 0. When a file or an
app has a problem, the answer is `Problems`, exit 1, carrying the same
report as `error.report` and a one-line summary as its message. Without
`--json` the report prints on stdout either way, and the summary on stderr.

## The Epicenter's report

`epicenter` on its own prints serve's listing: the version serve runs, the
one its `packages/app/package.json` states. `--json` answers the report as
`data`, with that version as `version`. Then come the
apps serve loaded and any problems loading them, then
each routine with its cron and next occurrence or the reason its file is
refused. `--json` adds them as
`routines: [{ name, cron, next } | { name, problem }]`, and the Epicenter's
folder and each app's, which the command adds. The report reads only and
starts nothing; while serve is stopped it is refused as a call is. It exits
0 when it could report, even when an app or a routine file has a problem.

The report says nothing about the Epicenter's repository; Git does
([ADR-0956](../../../../docs/adr/0956-bare-epicenter-reports-apps-and-routines-and-git-reports-the-repository.md)).
At the top of the Epicenter:

```sh
git status -sb               # branch, commits ahead of origin, each uncommitted file
git log -1 --format=%cr      # how long ago the last commit was
```

A commit that is days old, or files that stay uncommitted, mean whatever
commits the Epicenter stopped. A routine's error is in serve's output.

## Git stores the Epicenter

Epicenter runs actions and serves pages. Git stores the Epicenter, and Epicenter
does not wrap Git: no `epicenter` command commits or pushes. Commit and push
with Git, by hand or from a [routine](#routines) that runs a script of your
own. A commit made while serve runs samples files, not intent: it can hold a
partial edit or part of a running action's writes. Keep origin private: it
receives every app's records. Git's ignore rules alone decide what is
committed. The only Git commands Epicenter runs are two questions about
`.env` when serve starts ([Make an Epicenter](#make-an-epicenter)).

## Make an Epicenter

No command makes one. An Epicenter is a folder that holds:

| Path | Holds |
| --- | --- |
| `EPICENTER.md` | The marker: empty, or front matter with `port` |
| `package.json` | The workspace in [An Epicenter is a Bun workspace](#an-epicenter-is-a-bun-workspace) |
| `.gitignore` | At least `/apps/*/local/`, `.env*`, `!.env.example` and `node_modules/` |
| `apps/` | One folder per app |

Then run `git init` and `bun install` at its top, and commit. Write the
`.gitignore` before the first commit: what `local/` and `.env` hold must
never reach origin. Serve refuses to start while a `.env` at the top would
reach Git, and prints the fix: `.env is not ignored by Git; add .env* to
.gitignore`, or `.env is tracked by Git; run git rm --cached .env`. A folder
that is not a Git repository has nothing to commit to, so serve starts. Ignoring `/apps/*/code/ui/dist/` keeps build output out
of commits.

To bring an Epicenter back on another computer:

```bash
git clone <private-origin> ~/Epicenter
cd ~/Epicenter && bun install
```

The clone carries every app's code and records, the Epicenter's `package.json` and
its `bun.lock`. `bun install` fetches what Git ignores and the lock can
rebuild: the one `node_modules/`, with the command, at the versions the lock
names. Then start `epicenter serve` however this computer keeps it
running. What
each app kept in `local/` is on no remote, so recreate it, for example by
signing in again.

## What an app holds

No command makes an app or copies one. An app is a folder `apps/<name>/`
that holds:

| Path | Holds |
| --- | --- |
| `code/epicenter.ts` | The declaration: its default export is `defineApp(({ folder }) => ...)` |
| `code/package.json` | `"name": "<name>"`, `"private": true`, and the packages the app itself imports, never `@epicenter/app` |
| `code/.gitignore` | `node_modules/` and `ui/dist/` |
| `data/` | What you would want back if this computer were lost: the app's records and settings. It may be absent until the first write |
| `local/` | What this computer can rebuild or sign in again, or must keep to itself: sign-ins, caches, databases. The root `.gitignore` keeps it out of Git |

`<name>` is lowercase letters, digits, and dashes, starts with a letter, and
is not `check` or `serve`. Two packages in one Bun workspace cannot share a
name, so `bun install` refuses a `package.json` whose name another app has.
After `package.json` changes, run `bun install` at the top of the Epicenter; after
`ui/` changes, `bun run build`. The bare `epicenter` lists an app that does
not load, with what is wrong with it.

## Recover selected paths

Inspect history before restoring:

```sh
git log --oneline -- apps/<app>/
git restore --source=<commit> -- apps/<app>/code/    # code only
git restore --source=<commit> -- apps/<app>/data/    # records only
git restore --source=<commit> -- apps/<app>/         # both
```

A whole-app restore reverts both and deletes tracked files added after that
commit. A commit imported from an old separate repository contains only code
or only records. Restoring the whole app from it deletes the absent sibling.
Select that commit's code or data prefix instead.

The live working tree is shared. Branch switches, stashes, and resets affect
all running apps' code and records. Keep experiments outside the live Epicenter.

## Build a UI

An app's UI is what its own build writes to `code/ui/dist/` ([ADR-0860](../../../../docs/adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md), [ADR-0880](../../../../docs/adr/0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md)). `serve` serves that folder as it is at `/<app>/` and never builds. The app's `code/package.json` has a `build` script, and `bun run build` in `code/` runs it. A plain page needs one line: `"build": "bun build ui/index.html --outdir ui/dist"`. A build writes relative URLs, so it works at whatever path `serve` serves it. A page load for an app with no `ui/dist/index.html` answers 404. `serve` never serves a path with a part starting with `.`.

A UI bundles `@epicenter/app/client` from the Epicenter's one install. After changing `ui/`, run `bun run build` in `code/`. After upgrading Epicenter, run `bun run build` at the top of the Epicenter: the Epicenter's `package.json` holds `"build": "bun run --filter '*' --if-present build"`, which runs every app's `build` and skips apps without one, so every UI is built against the client of the new `serve`. An app whose UI is a bare `ui/index.html` needs its own `build`.

Build output under `code/ui/dist/` is ignored by the root `.gitignore` and the app's own `.gitignore` ([ADR-0854](../../../../docs/adr/0854-an-apps-cache-is-the-files-it-gitignores.md)).

## Tests

Run `bun test <file>` in `packages/app` one file per process when memory is short. `acceptance.*.test.ts` runs the real `epicenter` against a temporary `HOME`, one test per acceptance ID.
