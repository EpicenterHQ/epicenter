# The epicenter command

`epicenter` runs the apps in an Epicenter as commands and MCP tools. An
Epicenter is marked by `EPICENTER.md`. Its private root Git repository holds
all apps' code and records. Each folder in `apps/` is a stable app container:

```txt
<Epicenter>/
  .git/  EPICENTER.md  AGENTS.md  theme.css  .gitignore  .gitattributes
  apps/<app>/
    code/                       one Bun project
      epicenter.ts  package.json  bun.lock  README.md
      node_modules/             ignored
      ui/                       source
        dist/                   ignored build
    data/                       records and settings
    local/                      stays on this computer: tokens, caches, databases
```

[ADR-0910](../../docs/adr/0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md)
describes the current layout and history. Each personal or shared home has
its own private root repository, separate from this runtime source monorepo
and from code-only app publications. Ordinary commands do not import or retire
nested repositories.

## Install and try a writing inbox

Writing is an ordinary app whose code is shared through export. Save
thoughts, quotes, and links with their sources and projects, then search them
from the browser, terminal, or an assistant. It needs no AI account or provider
key. The executable supplies the runtime. `new --from` copies ordinary app files
from GitHub into your Epicenter. No app is bundled in the executable.

The release installer downloads a platform executable, verifies its SHA-256
checksum, checks that it runs, and installs it in `~/.local/bin`. It requires
Git, curl, and either shasum or sha256sum. Supported build targets are macOS and
Linux on arm64 and x64. For a new home, install the
[latest Epicenter CLI](https://github.com/EpicenterHQ/epicenter/releases?q=Epicenter+CLI)
with the command below. Existing homes can run Writing and Tasks on Epicenter
0.2.0 or later.

```sh
curl -fsSL https://github.com/EpicenterHQ/epicenter/releases/download/epicenter-cli-v0.4.1/install.sh | sh
```

`EPICENTER_DOWNLOAD_BASE` overrides the asset URL, for example when
rehearsing downloads from a local HTTP server. `EPICENTER_INSTALL_DIR` overrides
the absolute install directory. The installer replaces an existing executable
only when it identifies itself as Epicenter. It refuses a symlink at that path.
It leaves your Epicenter, shell configuration, and login jobs alone. If the
directory is missing from PATH, its instructions use the executable's full path.

To update an existing home, run the installer above on the computer that runs
`epicenter serve`. Check `epicenter --version`. Restart `epicenter serve`: stop
it in its terminal and start it again, or restart the job that runs it (see
[Keep serve running](#keep-serve-running)). Reload open app pages to use the new client.

For a first install, with `~/.local/bin` on PATH and Git's `user.name` and `user.email` configured, create an Epicenter:

```sh
epicenter init ~/Epicenter
cd ~/Epicenter
epicenter new writing --from EpicenterHQ/epicenter/examples/writing
epicenter writing add '{"body":"An observation I want to return to","source":"My notebook","project":"Essay"}'
epicenter writing search '{"query":"observation"}'
epicenter serve
```

Open `http://127.0.0.1:4747/writing/`. Save a real note, search for it, and open
it to edit. Your notes are in `apps/writing/data/notes/`. Closing the terminal
stops the server; the files remain. Keep unsubmitted text open until saved.

To connect an assistant on this computer, add a Streamable HTTP MCP server at
`http://127.0.0.1:4747/`. Ask it to find saved notes with their sources. You can
also run a coding agent from this Epicenter and ask it to adapt
`apps/writing/code/`. The [writing app README](../../examples/writing/README.md)
explains one first change. Copied code belongs to you; later shared code
does not replace it.

Start on localhost. Add a private connection when another device needs access.
To keep the server running after you close the terminal, see
[Keep serve running](#keep-serve-running). Onboarding installs no login job.

### When to ship a runtime version

Can the installed `epicenter` run the changed app and build its UI? If so,
ship the app commit and rebuild its UI when needed. For example, Tasks can
reread a task after an uncertain save, and Flights can follow a search by
its existing run ID. Both use capabilities already installed. Raise an
app's `engines.epicenter` minimum only when it starts relying on behavior
an older runtime cannot supply.

Test routine app changes on the current Epicenter release. Recheck the
minimum when you change `engines.epicenter`, use a runtime feature that
might be newer, or investigate a failure on an older release. On the
declared minimum, exercise the affected action or UI. For a shared app,
use `epicenter new <app> --from <source>` to check the copy people install.

When a change needs a different executable or bundled `@epicenter/app`,
ship those together under one new version. Commits can accumulate before
that release. Ship separately when an installed consumer needs the fix now
or when the next change depends on readers having upgraded first. Changes
that can reach the same consumers together can share a release.

| Example | What to ship | Why |
| --- | --- | --- |
| `0.2.1` reads both host answer formats and still writes the old one | Ship the reader patch separately. Rebuild browser clients and update consumers that parse CLI or MCP output directly. | This provides a working combination while consumers upgrade. A tab that was already open needs to reload to get the new reader. |
| `0.3.0` starts writing the flat `{ data, error }` answer | Ship the writer after the readers. Keep reading saved runs in their original format. | A `0.2.0` reader could treat a successful flat answer as invalid. Changing both ends in one installation would still leave older readers in use. |
| `0.4.0` removes `after` from the public `run.events()` API | This shipped separately. Given the same choice again, batch it with the next planned runtime release. | None of the twelve home apps passed that option. The client already managed reconnect offsets, so removing it gave the home no reason to upgrade immediately. |

During `0.x`, use a patch for a compatible runtime fix and bump the middle
number when an existing caller must change to keep working. Choose the
number for the whole batch when it ships. Once distributed, a version
identifies that build. The [Result cutover](../../docs/adr/0926-a-collections-methods-return-results-and-a-file-that-is-not-a-record-is-an-error.md#cutover)
records the wire behavior behind these examples.

### Prepare release assets

From the repository root, with dependencies installed:

```sh
bun run --cwd packages/cli release
```

This writes a native executable, its `.sha256` file, and a versioned `install.sh`
under `packages/cli/dist/release/`. The installer points to the intended GitHub
tag `epicenter-cli-v<VERSION>`. That URL works only after the assets are published.
To prepare another target, pass `--target darwin-arm64`, `darwin-x64`,
`linux-arm64`, or `linux-x64`. `--outdir` selects the artifact directory.
Build and verify each platform before publishing its executable.

The [CLI release workflow](../../.github/workflows/release.cli.yml) builds each
target on a matching native runner. It installs downloads over HTTP in a fresh
home, copies the exported writing app, saves a note, builds the UI, and
finds the note over MCP, with Bun absent from PATH. A manual workflow run only
uploads build artifacts. After publication, enable its `verify-published` input
to repeat all four trials against the public installer without credentials. Pushing an `epicenter-cli-v<VERSION>` tag creates a
prerelease draft after all four platforms pass, with Latest explicitly disabled.
It never publishes automatically and does not reuse desktop app tags or the
monorepo's global latest-release URL. Whispering uses that global address for
updates; keep the CLI marked as a prerelease and leave Latest disabled when
publishing it.

To prepare a public release:

1. Commit the intended CLI and runtime source. Publish `examples/writing/` on
   the default branch before releasing; the workflow exercises a public Git
   copy before creating the draft.
2. Review the committed source, then tag that commit to match the CLI's version.
   Push the tag to run the release workflow.
3. Review the four native onboarding runs, assets, and draft's install instructions.
4. Publish the draft as a prerelease with Latest disabled, then try its exact
   install command without GitHub credentials.

A local build from a dirty checkout is a rehearsal artifact. Do not upload it
as a release of a different source commit. Each app's `engines.epicenter`
declares its minimum runtime; keep the default branch compatible with the
public CLI release. Copied apps record their source commit in `SOURCE.md`.

Your Epicenter lives on a computer you control and keep on. `epicenter serve`
offers its apps to devices on a private connection. An older laptop with
Tailscale is one setup. See [a computer that stays on](../../docs/vision.md#a-computer-that-stays-on).

The command selects the nearest marked ancestor of the current directory,
then `EPICENTER_ROOT`, then `$HOME/Epicenter`. A chosen folder without the
marker needs `epicenter init <folder>`. The marker's optional front matter
accepts only `port`, an integer from 1 to 65535; the default is 4747. An empty
marker is valid. Epicenters cannot nest.

```sh
epicenter
epicenter reading
epicenter reading log '{"minutes":30,"book":"Dune"}'
epicenter reading log '{"minutes":30}' --json
epicenter reading books set '{"id":"dune","finished":null}'
epicenter init <folder>
epicenter new notes
epicenter new writing --from EpicenterHQ/epicenter/examples/writing
epicenter new recipes --from <folder or owner/repo/folder#ref>
epicenter export tasks ~/Code/my-project/code
epicenter export --all ~/Code/shared-apps/apps
epicenter install
epicenter build
epicenter check
epicenter serve
epicenter --version
```

The commands are `init`, `new`, `export`, `install`, `build`, `check`,
`serve`, and `service`. Their usage and help live in `src/commands.ts`.
`epicenter` on its own reports the home: its apps, its routines, and one line
about its repository. See [The home's report](#the-homes-report).
Any other first word names an app. `--json` and `--help` (`-h`) go anywhere
before `--`; `--version` is read only on its own. Each command parses flags
strictly. A misuse returns its usage line and next help command.

## Discover and load an app

Discovery lists `apps/`, skips dot entries, and accepts a directory or a link
to one with `code/epicenter.ts`. The file must default-export `defineApp(...)`.
An entry with `code/` or `data/` but no declaration is listed with
`code/epicenter.ts is missing`. Other folders are skipped.

An import or declaration failure is listed under that app's problems with a
`code/epicenter.ts:` prefix. A wrong default export is also a problem. One
broken app does not hide the others. Listings include container locations,
data keys, schemas, actions, and linked targets. They carry no per-app Git
status. An empty Epicenter says `No apps yet. Run: epicenter new <name>`.

The container's real path stays in `context.folder` and `folder.path`.
Contracts address `data/...` from that container. A separate real `codePath`
is used for module imports and invalidation, the engines check, package
installation, the supplied `@epicenter/app` link, and UI builds and serving.
Replacing `code/` leaves the container lock and record paths intact.

`epicenter install [<app>]` installs `code/package.json` with Bun, using
`--frozen-lockfile` when `code/bun.lock` exists. It links
`code/node_modules/@epicenter/app` to this command's package. An app lists
only its own dependencies. After `bun add` in `code/`, run install again if
Bun removed that link. Calls and listings never install dependencies.

`code/package.json` may declare `engines.epicenter`. The shared Writing and
Tasks examples both declare `>=0.2.0`.
An unmet range is a listed problem and prevents running or building that app.
Install and build report malformed layout entries without stopping other apps.

An action's input is one argument after its words, `epicenter <app> <action>
[<input>]` (ADR-0925): one JSON object as text, or `-` to read that text from
stdin. No input is `{}`. Stdin is read only for `-`, so a routine with stdin
closed and an agent whose shell holds it open both run. Text that is not a
JSON object, or more than one word, is refused with exit 2 and an example
object. The command line checks the object as HTTP and MCP do, with the same
messages; a key the action does not take is refused, naming the keys it does.
`null` removes a field that accepts it. For text a person wrote, `- <<'EOF'`
avoids shell quoting. `epicenter <app> <action> --help` lists the input's keys
and prints an example to copy. A listing or action help with `--json` exposes
each action as an MCP tool definition, with the annotations the action states.
An action that declares `mcp: false` is left out of serve's MCP tools and a
`tools/call` for it is refused; a `--json` listing shows it with `mcp: false`,
and the plain listing adds `(not offered to agents)`.

## One serve runs every action

One serve per home. The port is its name and its lock. Whoever starts it keeps
it running, and the command line never starts it or stands in for it.

`epicenter serve` is the only process that runs an app's actions.
`epicenter <app> <action>` checks its words and input, then sends the call to
serve at the port in `EPICENTER.md`, the same `POST /<app>/<action>` a page
makes, and prints the updates and the answer it reads back. It never runs the
action itself.

While serve is stopped, an action is refused with exit 2 and nothing runs:

```txt
$ epicenter reading log '{"minutes":30}'
Epicenter is not running for this home. Start it with `epicenter serve`.
```

Listings, `--help`, `check`, `build`, and the other commands in
`src/commands.ts` do not need serve.

The port is the home's name. Serve puts the home in an `x-epicenter-home`
header on every answer, and a call says which home it is for, so serve
refuses a call meant for another home. A command whose port answers for
something else runs nothing:

```txt
Port 4747 answers for another Epicenter. Set a different `port` in EPICENTER.md.
```

It says `another program` when what answers is not an Epicenter. Two homes on
one computer each need their own `port`, a whole number from 1 to 65535.

The port is also the lock. A second `epicenter serve` for a home that is
already served exits 2 and changes nothing:

```txt
Epicenter is already serving this home on port 4747.
```

When something else holds the port, it says so instead:

```txt
Port 4747 is in use by another program or another Epicenter. Set a different `port` in EPICENTER.md.
```

Serve states its version in an `x-epicenter-version` header. After an
upgrade, the serve that was already running is still the old version until it
restarts. A command sent to it uses the answer, because the action ran, and
adds one line to stderr:

```txt
Epicenter is running version 0.4.0 and this command is version 0.4.1. Stop `epicenter serve` and start it again.
```

An action runs in serve's environment: it does not see variables exported in
the caller's shell, and what it prints goes to serve's output, not to the
command. Each load drops cached modules under `codePath`, dependencies
included, then imports `code/epicenter.ts`. The next call reads edits to code
or its imports without restarting serve.

An action shares its process with other calls. `process.exit` ends serve:
every call then running is cut off, and a command that sent one answers a
fault with exit 1, since the action may have run. `process.chdir` or changes
to `process.env` affect other apps too.
An action's writes remain on disk when it returns an Err, throws, or is interrupted. Actions
perform no Git work.

`epicenter serve` starts an HTTP server on `127.0.0.1` at the port in `EPICENTER.md`, or 4747 when the marker has none. It takes no flags and listens nowhere else: another device reaches it through a private proxy on this computer, such as `tailscale serve --bg 4747`. It serves MCP at `POST /`, the launcher at `GET /`, each app's actions to its UI as serve-owned runs, and each app's UI at `/<app>/`: its `code/ui/dist/` ([ADR-0860](../../docs/adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md)). The launcher links to apps with a UI; a `GET /` asking for an event stream gets 405, since the server keeps no MCP session. Any later path of the server's own starts with `.`, which no app name can. The listener answers only a `Host` that is `localhost` (or `*.localhost`), an IP address, or a `*.ts.net` name, so a DNS rebinding name gets 403; it also refuses, with 403, any request carrying `Tailscale-Funnel-Request` or `Cf-Connecting-IP`, which a Tailscale Funnel or Cloudflare Tunnel adds. An Origin must match the request Host; requests without Origin are accepted. A reverse proxy such as `tailscale serve` can provide HTTPS. `serve` signs no one in: it trusts this computer and the tailnet, and who reaches it is its host's decision ([ADR-0883](../../docs/adr/0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md)). A Funnel or Cloudflare Tunnel aimed at this port by mistake reaches only 403s: each sets its header on every request, and Funnel deletes a copy the client sent. `Host` is no defence there, since Funnel forwards the client's own. Another tunnel that adds no such header and forwards an allowed `Host` would reach `serve` with no sign-in, so never tunnel its port.

MCP offers every app action as a tool and sends the Epicenter's `AGENTS.md`, when present, as server instructions, read again on each initialize so an edit reaches the next client without a restart. `tools/list` loads each app as it is now; an app that fails to load loses only its own tools and says why on stderr. `tools/call` decodes the tool name and runs the action, so an edit between calls is seen by the next. What an action yields is not sent over MCP; a client gets its answer.

A page calls actions through `@epicenter/app/client`, at
`POST /<app>/<action>`. See [A call over HTTP](#a-call-over-http).

Serve commits nothing. Git stores the home, and a home commits itself through
a routine that runs its own script: see
[The home commits itself](#the-home-commits-itself). Without that routine,
nothing is committed or pushed on its own. On SIGINT or SIGTERM
serve stops its routine commands and exits.

## Keep serve running

`epicenter serve` is one process. If it crashes, it stays stopped, and every
action is refused with `Epicenter is not running for this home` until something
starts it again. Whoever starts serve keeps it running. The Epicenter desktop
app will do this for people who use it. On a computer without it, use the
operating system's own job manager, from the home's folder ([ADR-0941](../../docs/adr/0941-whoever-starts-serve-keeps-it-running.md)).

On Linux, a systemd user unit at `~/.config/systemd/user/epicenter.service`:

```ini
[Unit]
Description=epicenter serve

[Service]
WorkingDirectory=%h/Epicenter
ExecStart=%h/.local/bin/epicenter serve
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now epicenter
```

On a headless machine, `loginctl enable-linger $USER` starts the unit at boot
instead of at your first login. Output goes to `journalctl --user -u epicenter`.

On macOS, a LaunchAgent at `~/Library/LaunchAgents/so.epicenter.serve.plist`,
loaded with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/so.epicenter.serve.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>so.epicenter.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.local/bin/epicenter</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/Epicenter</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/Users/you/.local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/epicenter-serve.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/epicenter-serve.log</string>
</dict>
</plist>
```

Actions and routines run with the job's `PATH`, not your shell's, so list the
directories their programs live in.

## Routines

The home opts into recurring work with `routines/<name>.md`, outside `apps/`.
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

The working directory is the
Epicenter folder. `epicenter` and `bun` use the running CLI and its runtime;
other executables use serve's `PATH`. `EPICENTER_COMMAND` holds the CLI argv
as JSON for scripts calling back into it. A script
calling that CLI argv clears `BUN_BE_BUN` first if it was launched as Bun.
Unknown fields and malformed declarations are refused. To stop a
routine, remove its file; the home's history keeps it.

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
leaves in the home. `serve` writes to its stderr only a routine file it cannot
read and a command it cannot start. Commands share `serve`'s process group, so
stopping that group (Ctrl-C in a terminal, or the job that runs serve) stops
them. Commands must tolerate repetition;
there is no exactly-once guarantee.

The [daily task review example](examples/daily-task-review.md) runs
[an ordinary script](examples/daily-task-review.ts) that reads `tasks list`
and groups open tasks into a dated draft under `drafts/`. It changes no tasks,
uses no model, and preserves an existing draft, so it can run more than once a
day. Copy the declaration to
<!-- doc-path-check: ignore-next-line -->
`routines/daily-task-review.md` and the script to `scripts/daily-task-review.ts`
in the home. The home's repository backs up the declaration, script, and drafts.
See [ADR-0908](../../docs/adr/0908-serve-runs-the-homes-daily-routines.md) and
[ADR-0937](../../docs/adr/0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md).

## A call over HTTP

`POST /<app>/<action>` runs one action. Action words are joined with dots
(`/flights/watches.search`). The body is the input as one JSON object, at
most 25 MiB. The route uses the existing Host, Origin, and tunnel guards.

| Outcome | Response |
| --- | --- |
| The action ran | 200, `application/x-ndjson`: `{"update": value}` for each update, then `{"answer": { data, error }}` |
| No such app or action, or the input is not JSON, not an object, or does not fit | 400, the refusal `{ data: null, error: { kind: "refused", reason } }` as the body |
| The body is too large | 413 |

A stream that ends with no `answer` line was cut off, and its outcome is
unknown: the action may still be running or may have finished. The caller
rereads its records, or calls again with the same id when the action takes
one.

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

`folder.update` reads the text, computes from it, and replaces the file, with
no other update between. Every data write uses it. Plain `folder.write`
is last-write-wins. Neither guards against a writer outside Epicenter, such
as an editor or a `git pull`.

Writes through `folder` stay under `data/` and `local/`.
The container remains `folder.path`. Reads may reach another app's records
at `../tasks/data/tasks/<id>.md`.

An action's MCP annotations, `readOnlyHint` among them, are forwarded to MCP
clients and refuse nothing. `folder` is not a sandbox.

What is in an app's `local/` stays on this computer: the root `.gitignore`
names `/apps/*/local/`, which covers every app whoever makes the folder.
Git's ignore rules are the only guard: nothing else refuses a commit of a
file there, so keep that line and never `git add -f` such a file. A file made under `local/` through folder methods is readable by its
owner alone (`0600`), and a directory made there is `0700`; one already there
keeps its mode. An action keeps a token with
`folder.write('local/google.md', token)`. `local/` appears when an action
first writes there. A write replaces a file by writing `local/.tmp/<uuid>`
and renaming it over the target, so nothing unfinished is ever under `data/`.

## What a run answers

With `--json`, stdout is one JSON object, and MCP returns the same object as `structuredContent`. MCP sets `isError: true` for an Err, a fault, or a refusal before execution. The CLI uses the following exit codes:

```txt
{ "data": <value>, "error": null }                                 exit 0
{ "data": null, "error": { "kind": "returned", "reason": <error> } }  exit 1
{ "data": null, "error": { "kind": "fault", "message": <text> } }     exit 1
{ "data": null, "error": { "kind": "refused", "reason": <error> } }   exit 2
```

`Ok(undefined)` arrives with null data. An action can decline with its own
tagged Err, or an unexpected throw can end the call with a fault. A fault may include a tagged exception in `thrown`. The host assigns
`kind` for this invocation. An action that saved a draft and forwarded a
child’s refusal has kind `returned`. Invalid input refused before the action
ran has kind `refused`. Human output puts success data on stdout and failures on stderr. The HTTP event
stream carries the same answer inside `finished.answer`. A reconnect can
replay a saved run's earlier answer format without executing it again.

A one-file data key's `set` makes its file when it is absent, so `epicenter vocab settings set '{"goal":20}'` works on a fresh install. The `set` verb takes the fields beside `id`, and `edit: { old, new }` replaces a passage of the body in the same write:

```txt
$ epicenter vocab set '{"id":"serendipity","meaning":"a lucky find"}'
$ epicenter vocab set '{"id":"serendipity","edit":{"old":"First seen.","new":"First seen in a novel."}}'
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

`id` prints as a field: the command reads only the answer. A folder key's `get`, `set`, `add`, and `delete` take `id` flat in the input object, beside the fields. `add` without `id` names the record by the moment it is made and returns that id.

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
      watch: 3 is not a record id: non-empty NFC text of at most 200 UTF-8 bytes, without slashes, control characters, a leading dot, or boundary spaces
      day: "soon" is not a day like 2026-11-12
  settings.md  fits
```

With `--json` it answers
`{ "apps": { <app>: { <key>: { path, single, files, withProblems, kinds: [{ kind, count }], records: [{ path, problems }] } } }, "problems": [{ entry, folder, problems }] }`.
A kind is a problem line without the value it quotes, so `due: "next week"`
and `due: "soon"` are one kind; when most files share one kind, the
declaration is often too narrow, and one change to `epicenter.ts` repairs
them all. `records` holds only files with problems. Without an app named, an
app that does not load is listed under `problems`, as in the Epicenter
listing, and the other apps are still checked; a read that fails lists its
app there too. A named app that does not load did not run, exit 2. Otherwise
the exit code is 0 when no file has a problem, and 1 when any does or an app
could not be checked.

## The home's report

`epicenter` on its own prints the apps and any problems loading them, then
each routine with its cron and next occurrence or the reason its file is
refused, then one line about the repository:

```txt
Git: last commit 3 days ago; 212 files uncommitted; 41 commits not on origin
```

The line says `no origin` when there is none, and names any Git repository
nested under `apps/`, because the home's commits hold only a pointer to a
nested repository and not its files. `--json` adds the same facts as
`routines: [{ name, cron, next } | { name, problem }]` and
`repository: { lastCommit, uncommitted, origin, nested }`: `origin` is null or
`{ branch, ahead? }`, and `repository` is null when the home is not a Git
repository. The report reads only. It starts nothing, fetches nothing, so the
count against origin is as of the last push or fetch, and it works while serve
is stopped. It exits 0 when it could report, even when an app or a routine
file has a problem.

## The home commits itself

Epicenter runs actions and serves pages. Git stores the home, and Epicenter
does not wrap Git: no `epicenter` command commits or pushes. `init` gives a
new home two files of its own, which the owner may change. An older home adds
them by hand.

`routines/checkpoint.md` runs the script every five minutes while serve runs,
one run at a time:

```yaml
---
cron: "*/5 * * * *"
run: ["/usr/bin/lockf", "-t", "0", ".git/checkpoint.lock", "sh", "scripts/checkpoint.sh"]
---
Commit everything pending and push to the backup.
```

<!-- doc-path-check: ignore-next-line -->
`scripts/checkpoint.sh`, mode `755`:

```sh
#!/bin/sh
set -eu
for s in MERGE_HEAD REVERT_HEAD rebase-merge rebase-apply CHERRY_PICK_HEAD; do
  [ -e ".git/$s" ] && { echo "merge or rebase underway" >&2; exit 0; }
done
git add -A
if git ls-files -s | grep -q '^160000'; then
  echo "a nested Git repository is staged; remove its .git" >&2; exit 1
fi
git diff --cached --quiet || git commit -qm "${1:-checkpoint}"
git remote get-url origin >/dev/null 2>&1 || exit 0
GIT_TERMINAL_PROMPT=0 git push -q origin HEAD
```

The script commits everything pending as one commit named `checkpoint`,
including what is already staged, and pushes when there is an origin. It
waits out a merge, rebase, revert or cherry-pick. It refuses while a nested
Git repository is staged, because the commit would hold only a pointer to it.
`/usr/bin/lockf` is macOS; on Linux the routine's `run` starts with
`"flock", "-n", ".git/checkpoint.lock"` instead.

A commit made this way samples files, not intent: it can hold a partial edit
or part of a running action's writes. The branch and index belong to every
app, so make a named commit with Git before risky work. Keep origin private:
it receives every app's records. Git's ignore rules alone decide what is
committed.

## Initialize an Epicenter

`epicenter init [<folder>] [--port <n>]` writes `EPICENTER.md`, seeds missing
`theme.css` (the plain Graphite + blue palette), starter `AGENTS.md`,
<!-- doc-path-check: ignore-next-line -->
`routines/checkpoint.md` and an executable `scripts/checkpoint.sh`, creates
`apps/`, and makes the root a repository if needed. It commits only files it wrote. Existing unrelated files and index
entries are left for another commit.

When absent, the root `.gitignore` excludes local files, node_modules,
`.DS_Store`, `/apps/*/code/ui/dist/` for build output, and
`/apps/*/.code-build-*/` for UI build and copy staging inside app containers.
When git-lfs is available, init installs its local filter and writes missing root attributes for common binary extensions.
These configuration files belong to the person after init.

To bring a home back on another computer:

```bash
git clone <private-origin> ~/Epicenter
cd ~/Epicenter && epicenter install
```

The clone carries every app's code and records. `epicenter install` fetches
what Git ignores and a lock file can rebuild: each app's `node_modules`. What
each app kept in `local/` is on no remote, so recreate it, for example by
signing in again.

## Add or copy an app

`epicenter new <name>` creates `apps/<name>/code/` with a declaration, an
engines-bearing package manifest, and an ignore file for node_modules and
ui/dist. It creates empty sibling `data/` and installs in `code/`. It makes no
repository or commit. Names are checked without regard to case and cannot
be CLI command names. JSON reports `{ name, folder }`, with the container as
folder. Text prints that path and `Run: epicenter <name>`.

Without `--from`, `new` makes a blank app. To start with a usable app, copy a
shared app with `--from`; the destination name can differ from the source's name.

`epicenter new <name> --from <source>` copies committed code. Git moves code
between computers; `new` copies one committed folder into this Epicenter
([ADR-0928](../../docs/adr/0929-new-copies-an-apps-code-from-a-folder-in-git-or-a-folder-on-github.md)).
A source is one of two things:

- A folder on disk, written as a path that starts with `/`, `./`, `../`, or
  `~/`. It is a repository root or a folder inside one, and its current commit
  is copied. To copy from GitLab or any other host, clone the repository
  first, check out the version you want, and pass the app's folder.
- A folder on GitHub, written `owner/repo[/folder][#ref]`. `ref` is a branch,
  a tag, or a full commit; without it, the default branch is copied. Only that
  folder's files are downloaded.

```sh
epicenter new writing --from EpicenterHQ/epicenter/examples/writing
epicenter new tasks --from someone/shared-apps/apps/tasks#v2
epicenter new notes --from ~/Code/shared-apps/apps/notes
```

An app container is accepted when its tracked `code/epicenter.ts` identifies
the code subtree instead of a top-level declaration. A folder that holds
several apps is refused with their names and the `--from` for one of them.
Anything else, such as a Git URL or a bare word, is refused with a hint.

The copy uses the source's commit. Files visible in a local source folder may
differ from that commit. For a folder on disk, `new` reports the copied commit
and warns about tracked, staged, deleted, or untracked code it left out. It
applies the same code filter as the copy, excluding records, local files,
dependencies, builds, and provenance. The source is not changed or committed
automatically.

The private development commit and the public publication commit are separate.
Export writes your Epicenter's committed code into the publication folder. Commit those exported files
there before asking someone to copy that version with `new --from`. A refreshed
export that is not committed is still outside the publication's copied commit.

With `--json`, a copy adds `source: { commit, notCopied? }` to the result.
`notCopied` lists relative code paths: an empty array means the local source
was checked and matches; a missing key means no local working tree could be
compared, as for a GitHub folder, and `null` means comparison failed. A comparison failure is a warning,
not a failed copy. These differences are measured against the commit actually
copied, so the report also covers a source commit made during the copy.

The command uses a temporary clone, then checks out selected committed
files into the new container's ignored `.code-build-copy-*` directory before
renaming them to `code/`. It excludes data/, local paths, node_modules at any
depth, ui/dist, and old SOURCE.md. It preserves modes and symlinks, refuses
gitlinks, materializes LFS content, and retains inherited LFS attributes that
the destination root does not already supply. No nested repository or remote
is created. Changes from the source are later work for the app's owner.

`code/SOURCE.md` records where the code came from, one field per line:
`Repository` (the GitHub address, or a local checkout's `origin` with HTTP
credentials removed, else its absolute path), `Folder`, `Ref` when one was
named, and `Commit`. No command reads this provenance file. Copied
links remain links. A link such as
`code/ui/src/theme.css -> ../../../../../theme.css` needs the destination's
root theme. A dangling link produces a stderr line naming its stored target
and an optional JSON `links: [{ path, target }]`, with paths relative to code/.

When the app has a browser UI, `new` prints how to start `serve` and open the app.
For an action-only app it prints the command that lists its actions.

Install failure leaves the created app for repair. Copy or load failure removes
only the container this command created. Opening a page triggers its first UI
build; new does not build it.

`new` creates a separate app with empty records; it never updates an existing
one. To take a later code change, inspect the source commit in `SOURCE.md`,
compare incoming code outside the live Epicenter, and adapt the existing
`code/` while preserving `data/` and local changes. Test with the existing
records before a named commit. Committing a refreshed public export does
not update apps people have already copied.

## Export app code

Work in your live Epicenter and regenerate a separate collection when you want
to share its code. Export owns the destination directory and replaces everything
inside it. Keep the publication's Git repository and handwritten files outside
that directory ([ADR-0911](../../docs/adr/0911-export-copies-an-apps-committed-code-into-a-refreshable-directory.md)).

```sh
epicenter export --all ~/Code/shared-apps/apps
```

```text
shared-apps/
  .git/                     publication history
  README.md                 your notes
  apps/                     generated by export
    .epicenter-export.json
    tasks/epicenter.ts
    reading/epicenter.ts
```

`--all` generates one child per committed app, including future apps. Removed
apps disappear on refresh. Each child has `epicenter.ts` at its root and no
private `data/`. Recipients can copy one app:

```sh
epicenter new tasks --from OWNER/shared-apps/apps/tasks
```

Replace `OWNER` with the collection owner's GitHub username.

To publish one app as its own project, keep its Git repository and publication
notes beside a generated `code/` directory:

```sh
epicenter export tasks ~/Code/my-project/code
```

The single-app form puts `epicenter.ts` directly in the exact directory you
name. `new --from` accepts a repository with this `code/` wrapper too.

Export is read-only in the private Epicenter. It reads the commit `HEAD`
names and never commits, stages or pushes. When `git status` shows anything
under an app's `code/`, export refuses and names it:

```txt
apps/tasks/code has uncommitted changes; commit them, then export.
```

Commit with Git, or wait for the home's own checkpoint routine, then export
again. With `--all`, one such app refuses the whole export, and an on-disk app
with no committed code is reported and left out. Records and other apps'
pending files do not matter to it.

A refusal happens before the output changes. Export never falls back to older
code, never imports apps and never edits source working files. It takes no
lock: two exports into one directory at once can mix their output.

The copy excludes `data/`, `node_modules`, `ui/dist`, `.DS_Store`,
`SOURCE.md`, and export markers, even if tracked. It preserves binary bytes and
executable modes, and materializes Git LFS files. Internal symbolic links keep
their targets when the targets are included. A relative link to a committed
regular shared file outside `apps/`, such as the root `theme.css`, becomes a
regular file in the exported app. Export refuses links into another app,
records, local files, missing files, shared directories, or outside the
Epicenter. It does not rewrite imports or discover arbitrary dependencies
outside `code/`.

A destination must be missing, empty apart from Finder metadata, or carry a
matching `.epicenter-export.json` ownership marker. The marker records the
export kind and, for a single app, its name. It contains no content digest,
private commit identity, or local path. Collection children have no individual
markers: refresh the collection with `--all`. The command refuses Git metadata
at any depth, symlinked destinations, and destinations overlapping the private
Epicenter. It locks the destination itself while filling it.

Every refresh overwrites edits and removes extra files inside the generated
directory. Move contributions into the live app before refreshing. Review,
commit, and push the outer repository with ordinary Git.

Export prepares and validates all code before changing the destination. If an
app cannot be prepared, the previous output stays untouched. Filling the
directory is not atomic: an interruption or write failure can leave incomplete
output. Its ownership marker remains, so rerun the same command before
reviewing or committing. Export keeps no rollback copies of generated files.

`--json` reports `{ commit, directory, apps, omitted }`. `commit` names the
exported commit. Each app has `app`, `materialized: [{ path, from }]`, and
`uncommitted`, which is true when a shared file it links to has changes the
export left out. `omitted` lists on-disk apps without a code tree in that
commit. Exit 0 means the export
completed; exit 1 means omitted apps need attention; exit 2 means a failure or
refusal. Refusals and failures use the CLI's error envelope.

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
Publishing uses the exported code's separate history. The CLI exports local
files; you review, commit, and push them with Git.

## Build a UI

Paths in the build description below are relative to `code/`, unless prefixed
with `code/`.

An app's UI is what its `code/ui/` builds to in `code/ui/dist/` ([ADR-0860](../../docs/adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md), [ADR-0880](../../docs/adr/0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md)). A UI runs as it sits on disk, as actions do: `ui/dist/` is a cache of `ui/`'s sources, stamped in `ui/dist/.epicenter-build` with their fingerprint, the path, size and modified time of every file under `ui/` (but `ui/dist/`, `node_modules/`, and names starting with `.`), with the app's `code/package.json` and `bun.lock`, the `epicenter` version, and where the command's own `@epicenter/app` is with the path, size and modified time of each file in its `src/` (`src/ui.ts`), so a `serve` run from another checkout or a newer `epicenter` rebuilds every UI against its own client. When `serve` starts, it links `code/node_modules/@epicenter/app` in every installed app to its own copy. When a page load at `/<app>/` finds the fingerprint changed, `serve` builds in the background, one build per app at a time, and serves the last good build until it is done, so an edit shows on the next page load after its build, committed or not. A UI that has never built has no last build, so its page load waits for the first one, up to a minute, rather than answering 404. Sources whose build fails are not built again until they change; the failure is written to stderr once, with `Run: epicenter build <app>`. An app's code/ is one Bun project, so the build runs in code/. When the app's `code/package.json` has a `build` script, `bun --bun run build` runs with `EPICENTER_OUT` naming the folder to write, which must hold an `index.html`. Otherwise, when `ui/index.html` exists, Bun's bundler bundles it, so one `index.html` and the files beside it are a UI with no `package.json`. With neither, or no `ui/`, there is nothing to build. Either way a build writes relative URLs and is never told where it is served, and runs with the Bun that runs `epicenter`; the compiled `epicenter` is Bun itself under `BUN_BE_BUN=1`. A build never installs: an app whose `package.json` names packages and has no `node_modules/` is skipped, with `Run: epicenter install <app>`, and nothing is remembered against it. Before every build, `code/node_modules/@epicenter/app` links to the command's own copy (`src/app-package.ts`): this repository's `packages/app`, or for the compiled `epicenter`, the package it carries, written once per build to `$XDG_DATA_HOME/epicenter/app/<version>-<hash>` (`~/.local/share` by default) with the packages it imports. The finished build replaces `ui/dist/` by rename, so `serve` never answers from half a build, and a failed build leaves the last one in place. `serve` never serves a path with a part starting with `.`.

`epicenter build [<app>]` builds every app's UI from its sources now, or one app's, and shows the build's errors. It reports `UI built`, `nothing to build`, or a build error for each app. With `--json` it answers `{ "apps": [{ app, folder, built, error? }] }`, `built` saying whether there was a UI to build. A build error exits 1; another app can still build.

Build output under `code/ui/dist/` is ignored by the root `.gitignore` and the blank app's `.gitignore` ([ADR-0854](../../docs/adr/0854-an-apps-cache-is-the-files-it-gitignores.md)).

Compile the executable from the repository root:

```sh
bun run --cwd packages/cli compile
```

## Tests

Run `bun test <file>` in `packages/cli` one file per process when memory is short. `acceptance.*.test.ts` runs the real `epicenter` against a temporary `HOME`, one test per acceptance ID, with bare repositories in temporary folders standing in for remotes.
