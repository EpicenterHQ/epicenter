# The epicenter command

`epicenter` runs the apps in an Epicenter as commands and MCP tools. An
Epicenter is marked by `EPICENTER.md`. Its private root Git repository holds
all apps' code and records. Each folder in `apps/` is a stable app container:

```txt
<Epicenter>/
  .git/  EPICENTER.md  AGENTS.md  .gitignore  .gitattributes
  apps/<app>/
    code/                       one Bun project
      epicenter.ts  package.json  bun.lock  README.md
      node_modules/             ignored
      ui/                       source
        dist/                   ignored build
    data/                       records, settings, local credentials
```

[ADR-0910](../../docs/adr/0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md)
describes the current layout and history. Each personal or shared home has
its own private root repository, separate from this runtime source monorepo
and from code-only app publications. The one-time
`packages/cli/scripts/migrate-to-one-repository.ts` combined nested repositories
on 2026-11-14. The author's live home later moved onto a Vault-based `main`,
with that combined history kept as archive refs (ADR-0910). Ordinary commands
do not import or retire nested repositories.

## Install and try a writing inbox

Writing is an ordinary app whose code is shared through export. Save
thoughts, quotes, and links with their sources and projects, then search them
from the browser, terminal, or an assistant. It needs no AI account or provider
key. The executable supplies the runtime. `new --from` copies ordinary app files
from GitHub into your Epicenter. No app is bundled in the executable.

The release installer downloads a platform executable, verifies its SHA-256
checksum, checks that it runs, and installs it in `~/.local/bin`. It requires
Git, curl, and either shasum or sha256sum. Supported build targets are macOS and
Linux on arm64 and x64. Install the developer preview with:

```sh
curl -fsSL https://github.com/EpicenterHQ/epicenter/releases/download/epicenter-cli-v0.1.0/install.sh | sh
```

`EPICENTER_DOWNLOAD_BASE` overrides the asset URL, for example when
rehearsing downloads from a local HTTP server. `EPICENTER_INSTALL_DIR` overrides
the absolute install directory. The installer replaces an existing executable
only when it identifies itself as Epicenter. It refuses a symlink at that path.
It leaves your Epicenter, shell configuration, and login services alone. If the
directory is missing from PATH, its instructions use the executable's full path.

With `~/.local/bin` on PATH and Git's `user.name` and `user.email` configured, create an Epicenter:

```sh
epicenter init ~/Epicenter
cd ~/Epicenter
epicenter new writing --from 'https://github.com/EpicenterHQ/epicenter#examples/writing'
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
On macOS, `epicenter service install` is an optional, explicit step to keep the
server running at login. No login job is installed during onboarding.

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
accepts only `port`, an integer from 0 to 65535; the default is 4747. An empty
marker is valid. Epicenters cannot nest.

```sh
epicenter
epicenter reading
epicenter reading log '{"minutes":30,"book":"Dune"}'
epicenter reading log '{"minutes":30}' --json
epicenter reading books set '{"slug":"dune","finished":null}'
epicenter init <folder>
epicenter init --from <private-origin> <folder>
epicenter new notes
epicenter new writing --from 'https://github.com/EpicenterHQ/epicenter#examples/writing'
epicenter new recipes --from <path-or-url>
epicenter export tasks ~/Code/my-project/code
epicenter export --all ~/Code/shared-apps/apps
epicenter install
epicenter build
epicenter checkpoint
epicenter checkpoint -m "Repair the book fields"
epicenter serve
epicenter routines
epicenter routines run daily-task-review
epicenter --version
```

The commands are `init`, `new`, `export`, `install`, `build`, `checkpoint`,
`serve`, `service`, and `routines`. Their usage and help live in `src/commands.ts`.
Any other first word names an app. `--json` and `--help` (`-h`) go anywhere
before `--`; `--version` is read only on its own. Each command parses flags
strictly. A misuse returns its usage line and next help command.

## Discover and load an app

Discovery lists `apps/`, skips dot entries, and accepts a directory or a link
to one with `code/epicenter.ts`. The file must default-export `defineApp(...)`.
An entry with `epicenter.ts` at its top is listed with a problem asking to move
code into `code/`. An entry with `code/` or `data/` but no declaration is listed
with `code/epicenter.ts is missing`. Other folders are skipped.

An import or declaration failure is listed under that app's problems with a
`code/epicenter.ts:` prefix. A wrong default export is also a problem. One
broken app does not hide the others. Listings include container locations,
collections, schemas, actions, and linked targets. They carry no per-app Git
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

`code/package.json` may declare `engines.epicenter`, such as `>=0.0.2`.
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
each action as an MCP tool definition, with all four annotations explicit and
private-input metadata kept separately.

An action declares private input handling with `privateInput: true`. The flag
appears in JSON discovery as action metadata, separately from MCP annotations.
The CLI accepts it only as `epicenter <app> <action> -`, with the whole JSON
object piped on stdin. It offers no interactive secret prompt and refuses any
other argument before parsing it. The same action stays
available over HTTP and is neither listed nor callable over MCP. Its validation
refusals contain no supplied input values.
This is an input-handling policy: HTTP access follows the server's existing
rules, and the app owns what it returns, throws, yields, and stores.

## A call runs where it arrives

The CLI runs a call in its own process, and serve runs calls in its process.
Each load drops cached modules under `codePath`, dependencies included, then
imports `code/epicenter.ts`. The next call reads edits to code or its imports
without restarting serve. On the CLI, an action's prints go to stderr so
stdout contains only the answer.

An action shares its process with other calls. `process.exit` ends that
process; `process.chdir` or changes to `process.env` affect other apps too.
An action's writes remain on disk when it returns an Err, throws, or is interrupted. Actions
perform no Git work.

`epicenter service install` installs a macOS LaunchAgent for the current Epicenter, running the `epicenter` command found on `PATH` (or the compiled binary) at login. The job keeps the installing shell's `PATH` so actions can find the same programs. The person runs `install` and `uninstall`; agents may run `restart` and `status`. `status --json` reports whether it is installed and running, its pid when running, the serve port, and its log path.

`epicenter serve` starts an HTTP server on `127.0.0.1` at the port in `EPICENTER.md`, or 4747 when the marker has none. `--host <address>` and `--port <n>` override those settings. It serves MCP at `POST /`, the launcher at `GET /`, each app's actions to its UI as serve-owned runs, and each app's UI at `/<app>/`: its `code/ui/dist/` ([ADR-0860](../../docs/adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md)). The launcher links to apps with a UI; a `GET /` asking for an event stream gets 405, since the server keeps no MCP session. Any later path of the server's own starts with `.`, which no app name can. The listener answers only a `Host` that is `localhost` (or `*.localhost`), an IP address, or a `*.ts.net` name, so a DNS rebinding name gets 403; it also refuses, with 403, any request carrying `Tailscale-Funnel-Request` or `Cf-Connecting-IP`, which a Tailscale Funnel or Cloudflare Tunnel adds. An Origin must match the request Host; requests without Origin are accepted. A reverse proxy such as `tailscale serve` can provide HTTPS. `serve` signs no one in: it trusts this computer and the tailnet, and who reaches it is its host's decision ([ADR-0883](../../docs/adr/0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md)). A Funnel or Cloudflare Tunnel aimed at this port by mistake reaches only 403s: each sets its header on every request, and Funnel deletes a copy the client sent. `Host` is no defence there, since Funnel forwards the client's own. Another tunnel that adds no such header and forwards an allowed `Host` would reach `serve` with no sign-in, so never tunnel its port.

MCP offers every app action as a tool and sends the Epicenter's `AGENTS.md`, when present, as server instructions, read again on each initialize so an edit reaches the next client without a restart. `tools/list` loads each app as it is now; an app that fails to load loses only its own tools and says why on stderr. `tools/call` decodes the tool name and runs the action, so an edit between calls is seen by the next. What an action yields is not sent over MCP; a client gets its answer.

A page calls actions through `@epicenter/app/client`. Serve admits each call
at `POST /.runs/<app>/<action>/<id>` and streams its events. An unreloaded
page using the retired `POST /<app>/<action>` receives a reload message.

Serve runs a root checkpoint at startup, five minutes after each scheduled
pass completes, and when it receives SIGINT or SIGTERM. It uses the same
operation as the manual checkpoint command. A failure is logged once until
it changes and cleared after success. Serve begins listening while its first
checkpoint runs. Shutdown waits at most ten seconds for the final pass.
The clock stays in serve; the service job only keeps serve running.

## Daily routines

The home opts into recurring work with `routines/<name>.md`, outside `apps/`.
A routine is an instruction to this computer, so sharing an app schedules
nothing. `serve` checks on startup and once a minute, independently of backups:

```yaml
---
daily: "08:00"
run: ["epicenter", "my-app", "review"]
---
Prepare my morning review.
```

`daily` is a local calendar time. A first check with no state runs the latest
due occurrence; after several days offline it runs once, not once per missed
day. A success satisfies the slot captured when it started. Timing is approximate
while the service is awake and available. Clock gaps normalize forward, and a
repeated clock time uses its first occurrence. Changing the daily time can make
a new occurrence due on the same day.

`run` is executable and arguments, with no shell. The working directory is the
Epicenter folder. `epicenter` and `bun` use the running CLI and its runtime;
other executables use the service's PATH. `EPICENTER_COMMAND` holds the CLI argv
as JSON for scripts calling back into it, `EPICENTER_ROUTINE_SLOT` is the due
instant as UTC ISO, and `EPICENTER_ROUTINE_NAME` is the routine's name.
`EPICENTER_SERVICE_URL` names this serve listener's loopback URL, including an
overridden port. A script
calling that CLI argv clears `BUN_BE_BUN` first if it was launched as Bun.
Optional `paused: true` stops scheduled attempts. Optional `timeout: "30m"`
bounds each attempt; the default is 30 minutes, with seconds, minutes, or hours
accepted. Unknown fields and malformed declarations are refused.

`epicenter routines` lists declarations and last outcomes, even while the
server is stopped; `--json` includes completion, the last attempt, and its log.
`epicenter routines run <name>` explicitly runs one now, including while paused.
It also repairs failed or interrupted work and can repeat effects.

An app's explicit setup action can call `routines.set(name, { daily, action,
input, paused?, timeout? })` from `@epicenter/app`. The host resolves the action
against that app's current table, checks its JSON input, and saves the same
command-argv declaration. It preserves notes, runtime receipts, and unspecified
pause and timeout fields. The name is home-wide. An existing command for another
app, an ambiguous or unexposed action, private input, file input, and read-only
setup are refused. No new action registry or executable format is involved.

State is atomically replaced in `routines/<name>.local/state.json`. Output
appends to `routines/<name>.local/output.log`. Both stay local and owner-only.
The kernel lock on that folder covers the entire attempt, including foreground
runs. The command inherits the lock as fd 3, so a command that survives its
supervisor still prevents overlap. Commands must keep fd 3 open and remain in
their process group. Shutdown and timeout terminate that group, escalating to
SIGKILL after two seconds. This uses macOS/Linux facilities, not a sandbox.

Failures wait for the next daily slot or an explicit run. Interrupted work
blocks automatic execution until an explicit run: its effects may already have
happened. Inspect the state and log first. Corrupted state also blocks execution
without overwriting it. A failure to signal descendants records interruption
and the signalling error, so uncertain cleanup cannot advance completion.
Deleting runtime state makes the latest occurrence due
again. Commands must tolerate repetition; there is no exactly-once guarantee.

The [daily task review example](examples/daily-task-review.md) runs
[an ordinary script](examples/daily-task-review.ts) that reads `tasks list`
and groups open tasks into a dated draft under `drafts/`. It changes no tasks,
uses no model, and preserves an existing draft. Copy the declaration to
<!-- doc-path-check: ignore-next-line -->
`routines/daily-task-review.md` and the script to `scripts/daily-task-review.ts`
in the home. The home's repository backs up the declaration, script, and drafts.
See [ADR-0908](../../docs/adr/0908-serve-runs-the-homes-daily-routines.md).

## Serve-owned runs

Ordinary page calls and `runs.start(app.action, input)` share admission,
execution, and event replay. Both accept `Blob` or `File` inputs. The client
uploads files by PUT and passes the action temporary `UploadedFile` handles.
CLI, MCP, and routines refuse file inputs. All routes use the existing Host,
Origin, and tunnel guards. Action words are joined with dots.

| Method | Route | Response |
| --- | --- | --- |
| PUT | `/.runs/<app>/<action>/<id>/files/<field>` | 200 `{ reference }`; refusal 400, 404, 409, 411, 413, 415, or 507 |
| POST | `/.runs/<app>/<action>/<id>` | 200 NDJSON for a new run or identical join; refusal 400, 404, 409, 413, 429, 503, or 507 |
| GET | `/.runs/<app>/<action>/<id>/events?after=<seq>` | 200 NDJSON replay; 404 unknown; 429 observer limit |
| GET | `/.runs/<app>/<action>/<id>` | 200 state; 404 unknown |
| POST | `/.runs/<app>/<action>/<id>/cancel` | 202 requested; 200 already terminal; 404 unknown |
| POST | `/<app>/<action>` | 200 NDJSON reload message; executes nothing |

A definitive admission refusal has `admitted: false`. A join refused at the
observer limit has `admitted: true`: the run already exists. Without a marker,
4xx is a refusal; another failure after POST is uncertain. Observe that id
with GET instead of resending admission.

One host owns `~/.local/state/epicenter/prototype-runs/<hash>`, where `<hash>`
is the first 16 hex characters of SHA-256 of the root's real path.
`EPICENTER_RUNTIME_DIR` overrides it outside the Epicenter and all apps. The
runtime is owner-only; Time Machine exclusion is best effort. `runs.sqlite`
uses WAL and synchronous FULL. It deduplicates payloads by hash and compresses
when smaller. Startup imports the v1 directory records and marks unfinished
runs `interrupted`; it never reruns them.

The 512 MiB admission threshold counts uploads, the database, WAL, and SHM,
including in-flight upload reservations. Admission also reserves a 4 MiB
serialized event-log allowance per active run, including 1 KiB for its terminal
frame. This is a refusal threshold for new work, not a maximum disk footprint:
accepted runs may finish above it, and SQLite rows, indexes, and WAL add space
beyond serialized JSON. Disk-full errors can prevent a terminal commit. Limits are 32
active runs, 64 observers, 256 KiB per yield, 1 MiB admission JSON, and 15 MiB
per file. Accepted runs and published events remain for 24 hours after ending.
Successful finishes delete input bytes; other outcomes retain them until expiry.
Orphan uploads and partial files expire after one hour. Cleanup runs every ten
minutes and under budget pressure.

Observation can stop without cancelling execution. `run.cancel()` records a
request before aborting the cooperative `callSignal()`. It does not establish
rollback. `runs.start` stores `epicenter.run:<id>` per receipt and imports the
old `epicenter.runs.prototype.v1` array on read. Ordinary calls use no browser
storage. For `privateInput: true`, admission stores neither JSON input values
nor an input digest; file hashes and bytes follow ordinary retention.

Run the in-process workload with:

```sh
bun packages/cli/src/__benchmarks__/runs.bench.ts --polls 2000
```

See [ADR-0917](../../docs/adr/0917-a-pages-calls-are-serve-owned-runs-and-observing-is-not-cancelling.md).

## Coordinate writes

A call's first write or delete through `folder` takes a flock on the real app
container. It waits up to 30 seconds, then throws that the app is busy. The
lock stays held until the action returns, throws, or stops. There is no lock
file to clean up. A process exit closes the descriptor. A call that does not
write through `folder` takes no lock.

`folder.update` computes from the text read and retries when an outside writer
changes it before replacement. Every collection write uses it. Plain
`folder.write` is last-write-wins. Fetch or compute before the first write
to keep other writes from waiting on slow work.

Writes through `folder` stay under `data/` and reject `.git*` path segments.
The container remains `folder.path`. Reads may reach another app's records
at `../tasks/data/tasks/<time>.md`. Direct `node:fs` operations do not obtain
the call's lock; the app owns their coordination.

A read-only call takes no lock. Folder writes throw except on `.local` paths
under `data/`. These files have owner-only permissions when created through
folder methods. Atomic replacement files have local names too, so the root
ignore rules keep them out of checkpoints. `folder` is not a sandbox.

## What a run answers

With `--json`, stdout is one JSON object, and MCP returns the same object as `structuredContent`. MCP sets `isError: true` for an Err, a fault, or a refusal before execution. The CLI uses the following exit codes:

```txt
{ "result": { "data": <value>, "error": null } }            exit 0
{ "result": { "data": null, "error": { "name", "message", ... } } }  exit 1
{ "fault": { "message", "thrown"? } }                       exit 1
{ "error": { "name", "message", "next"? } }                 exit 2, nothing ran
```

`Ok(undefined)` arrives with null data. An action can decline with its own
tagged Err, or an unexpected throw can end the call with a fault. Human
output puts success data on stdout and failures on stderr. The HTTP event
stream carries the same answer inside `finished.answer`. A reconnect can
replay a saved run's earlier answer format without executing it again.

A collection's `set` makes a collection's one file when it is absent, so `epicenter vocab settings set '{"goal":20}'` works on a fresh install. The `set` verb's `was` guard is an object beside the fields, and `edit: { old, new }` replaces a passage of the body in the same write:

```txt
$ epicenter vocab set '{"word":"serendipity","meaning":"a lucky find","was":{"meaning":null}}'
$ epicenter vocab set '{"word":"serendipity","edit":{"old":"First seen.","new":"First seen in a novel."}}'
```

MCP text contains the JSON answer on success and the failure message on error.
The human CLI formats success data by its structure (`src/output.ts`):

- An object prints one `key: value` line per defined key, in order. A string with a newline prints as `key: |` followed by indented lines. Other strings print plainly unless empty, padded with spaces, starting with a quote or `|`, or readable as JSON, such as `"true"`, `"null"`, or `"12"`; those print as JSON strings. A nested object with a defined key, or a non-empty array of objects, prints by these same rules under `key:`, indented two spaces. Numbers, booleans, null, other arrays, and an empty object print as compact JSON values.
- An array of objects whose fields each fit on one line prints one row per object, with `key: value` pairs separated by two spaces. If a field takes more lines, a multiline string or a nested object, each object prints on its own lines, with a blank line between objects.
- An empty array prints nothing. A string prints as is, with a final newline added if needed. Other arrays and single values print as JSON.

```txt
$ epicenter tasks get '{"time":"2026-11-10T09-30-00-000Z-k3x9a2f8"}'
path: data/tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md
time: 2026-11-10T09-30-00-000Z-k3x9a2f8
title: Email Sam the slides
done: false
due: 2026-11-12
body: |
  The deck is in Drive.
```

A key such as `time` prints as a field: the command reads only the answer, which does not say which keys came from the path. A collection's `get`, `set`, and `delete` (given only when the app names it) take each key flat in the input object, where `add` takes the keys it does not make.

## Check records

`epicenter check [<app>]` reads every collection an app declares, or every
app's, and reports the files that do not fit their collection's fields. A
`get` returns a tagged `Misfit` for such a file. A generated `list` succeeds
with one Result per file, including the individual refusals. The check command
collects those diagnostics for the whole app so a person or agent can repair
the records or the declaration.

It reads each collection with its `check()` method in a read-only run of the
app's folder, as a read-only action's run is: it takes no write lock and the
folder refuses any write. A `.local` collection is checked too, and its
problem lines never quote a value.

For each collection the report gives its path template, the files it
matched, and how many have problems; then each kind of problem with the number
of files that have it, most frequent first; then each file's path and problem
lines. A kind is a problem line without the value it quotes, as `check()`
gives it, so `due: "next week"` and `due: "soon"` are one kind. When most files share one kind, the declaration is
often too narrow, and one change to `epicenter.ts` repairs them all. Front
matter no field declares is not a problem: a read does not give it, every
write keeps it, and the check does not report it. A collection that matches
no file says `0 files`.

```txt
$ epicenter check tasks
tasks
  items  data/items/{id}.md
    5 files, 3 with problems
    2  due is not a day like 2026-11-12
    1  title is missing
    data/items/a.md
      due: "next week" is not a day like 2026-11-12
    data/items/b.md
      due: "soon" is not a day like 2026-11-12
    data/items/c.md
      title is missing
  notes  data/notes/{slug}.md
    0 files
```

With `--json` it answers
`{ "apps": { <app>: { <collection>: { path, files, withProblems, kinds: [{ kind, count }], records: [{ path, problems }] } } }, "problems": [{ entry, folder, problems }] }`.
`records` holds only files with problems. Without an app named, an app that
does not load is listed under `problems`, as in the Epicenter listing, and the
other apps are still checked; a read that fails lists its app there too. A
named app that does not load did not run, exit 2. Otherwise the exit code is 0
when no file has a problem, and 1 when any does or an app could not be checked.

## Checkpoint the root

`epicenter checkpoint [-m <message>] [--json]` requires the selected Epicenter
to be the top of its repository. It serializes on the root directory lock,
waiting up to 30 seconds for another local snapshot. It releases the lock before
uploading the backup. That lock is independent of app write locks. A checkpoint can capture a partial agent edit or some of a
running action's writes; it does not establish transaction boundaries.

Before staging, it defers during a merge, rebase, revert, or cherry-pick.
An index-lock collision is retried for about two seconds, then deferred if
Git stays busy. It refuses included embedded repositories and gitlinks,
local credential paths Git would commit, and LFS paths without their filter.
For a tracked local credential it names `git rm --cached` as the next step.
Ignored cache/build directories are pruned and directory links are not followed.

The tracked ignore rules decide what a checkpoint records. A file under
`data/` that an ignore rule matches, such as a regenerable rendition, stays out
of the index and the commit and does not block included files. Scope each such
rule to the app and directory it means. The checkpoint never imports or
requires app code, so missing or broken code does not prevent data from being
recorded.

The operation runs `git add -A` and commits all included files together,
including what the person already staged. The default subject describes changed
app code, records, and root files, such as `checkpoint: mail code, vault records`.
Long subjects use a file count. `-m` preserves the supplied message unchanged.
It makes no commit when nothing changed. The shared branch
and index belong to every app; make a named commit before risky work.

The optional root origin receives an ordinary push of the exact saved commit
to its captured branch. Uploading holds no root lock, so another local snapshot
can proceed while the network is slow.
It stays private because it receives every app's records. Checkpoints never
pull, merge, rebase, or force-push. A non-fast-forward refusal leaves the remote
unchanged and suggests fetching and inspecting it by hand. Unpushed history
containing local credentials also refuses the push. A push has a ten-minute
process-group deadline. A later pass retries outstanding pushes without
requiring a new commit.

JSON reports `{ committed, pushed, origin, deferred?, failed?, pushFailed? }`.
`committed` is `{ commit, files }` or null. `origin` is `{ ahead }` for the saved
commit against local tracking refs, or null when no count is available. Problems carry
`{ message, next? }`. Exit 0 means no deferral or failure; otherwise exit 1.
Text output uses the same result. No fetch refreshes the ahead count.

## Initialize or restore an Epicenter

`epicenter init [<folder>] [--port <n>]` writes `EPICENTER.md`, writes starter
`AGENTS.md` only when absent, creates `apps/`, and makes the root a repository
if needed. It commits only files it wrote. Existing unrelated files and index
entries are left for another commit.

When absent, the root `.gitignore` excludes local files, node_modules,
`.DS_Store`, `/apps/*/code/ui/dist/` for build output, and
`/apps/*/.code-build-*/` for UI build and copy staging inside app containers.
When git-lfs is available, init installs its local filter and writes missing root attributes for common binary extensions.
These configuration files belong to the person after init.

`epicenter init --from <url|path> [<folder>]` requires a missing or empty
destination. It clones one root repository, requires `EPICENTER.md` at its top,
then installs each runnable app's real `code/` directory. JSON reports
`{ folder, installed, failed: [{ path, message }] }`. An install failure
returns exit 1; a rejected restore returns exit 2. Local credentials must be
recreated. This operation restores a combined root repository; it does not
combine old per-app histories.

## Add or copy an app

`epicenter new <name>` creates `apps/<name>/code/` with a declaration, an
engines-bearing package manifest, and an ignore file for node_modules and
ui/dist. It creates empty sibling `data/` and installs in `code/`. It makes no
repository or commit. Names are checked without regard to case and cannot
be CLI command names. JSON reports `{ name, folder }`, with the container as
folder. Text prints that path and `Run: epicenter <name>`.

Without `--from`, `new` makes a blank app. To start with a usable app, copy a
shared app with `--from`; the destination name can differ from the source's name.

`epicenter new <name> --from <path|url>[#folder]` copies committed code:

- A local path names a repository root or a subfolder inside one.
- A URL names a repository root, or selects a subfolder with `#folder`.
- An app container is accepted when its tracked `code/epicenter.ts` identifies
  the code subtree instead of a top-level declaration.

The copy uses the commit cloned from the source. Files visible in a local source
folder may differ from that commit. For local paths and non-bare `file://`
repositories, `new` reports the copied commit and warns about tracked, staged,
deleted, or untracked code it left out. It applies the same code filter as the
copy, excluding records, local files, dependencies, builds, and provenance.
The source is not changed or committed automatically.

The private development commit and the public publication commit are separate.
Export saves a local checkpoint of your Epicenter and writes code into the
publication folder. Commit those exported files
there before asking someone to copy that version with `new --from`. A refreshed
export that is not committed is still outside the publication's copied commit.

With `--json`, a copy adds `source: { commit, notCopied? }` to the result.
`notCopied` lists relative code paths: an empty array means the local source
was checked and matches; a missing key means no local working tree could be
compared, and `null` means comparison failed. A comparison failure is a warning,
not a failed copy. These differences are measured against the commit actually
copied, so the report also covers a source commit made during the copy.

The command uses a temporary shallow clone, then checks out selected committed
files into the new container's ignored `.code-build-copy-*` directory before
renaming them to `code/`. It excludes data/, local paths, node_modules at any
depth, ui/dist, and old SOURCE.md. It preserves modes and symlinks, refuses
gitlinks, materializes LFS content, and retains inherited LFS attributes that
the destination root does not already supply. No nested repository or remote
is created. Changes from the source are later work for the app's owner.

`code/SOURCE.md` records the source and commit. Local source paths are absolute;
HTTP credentials are removed. No command reads this provenance file. Copied
links remain links. A link such as
`code/ui/src/theme.css -> ../../../../../theme.css` needs the destination's
root theme. A dangling link produces a stderr line naming its stored target
and an optional JSON `links: [{ path, target }]`, with paths relative to code/.

Install failure leaves the created app for repair. Copy or load failure removes
only the container this command created. Opening a page triggers its first UI
build; new does not build it.

`new` creates a separate app with empty records; it never updates an existing
one. To take a later code change, inspect the source commit in `SOURCE.md`,
compare incoming code outside the live Epicenter, and adapt the existing
`code/` while preserving `data/` and local changes. Test with the existing
records before a named checkpoint. Committing a refreshed public export does
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
epicenter new tasks --from https://github.com/OWNER/shared-apps#apps/tasks
```

Replace `OWNER` with the collection owner's GitHub username.

To publish one app as its own project, keep its Git repository and publication
notes beside a generated `code/` directory:

```sh
epicenter export tasks ~/Code/my-project/code
```

The single-app form puts `epicenter.ts` directly in the exact directory you
name. `new --from` accepts a repository with this `code/` wrapper too.

Export first saves a local checkpoint of the whole private Epicenter, including
pending code, records, and staged files. It then reads that exact commit for
the invocation. You do not need to wait for the scheduled checkpoint or run one
manually. Export does not upload the private backup; the normal checkpoint
clock or a later `epicenter checkpoint` can upload it. A backup connection
problem does not block export.

If the local checkpoint fails or is deferred, export stops before changing the
output. It never falls back to older code. Destination checks happen before the
checkpoint, so a mistaken target does not create a private commit. Export never
imports apps or edits source working files. Concurrent edits after the snapshot
are left for the next export; pending source changes are reported. `--all`
reports on-disk apps whose code is excluded from the checkpoint.

The copy excludes `data/`, `.local` paths, `node_modules`, `ui/dist`, `.DS_Store`,
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

`--json` reports `{ commit, checkpoint, directory, apps, omitted }`. `checkpoint`
is `{ commit, files }` for a new local commit, or null when nothing changed.
`commit` always names the exported snapshot. Each app has `app`,
`materialized: [{ path, from }]`, and `uncommitted`. `omitted` lists on-disk
apps without a code tree in the saved snapshot. Exit 0 means the export
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
