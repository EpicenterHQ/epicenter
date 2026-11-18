# 0959. Serve loads each app once, and an app's code changes when serve restarts

- **Status:** Proposed
- **Date:** 2026-11-18
- **Amends:** [ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md) at one consequence: an edit to an app's own code no longer shows on the next call. It shows after serve restarts, as a changed package already does. [ADR-0937](0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md) at how a routine command ends when serve stops: serve waits for it, and it no longer shares serve's process group.
- **Relates:** [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) (the re-import on each call, which goes), [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one serve runs every action), [ADR-0941](0941-epicenter-serve-is-a-program-you-keep-running.md) (the person keeps serve running), [ADR-0943](0943-epicenters-core-invariants.md) (rule 2 states the rule), [ADR-0945](0945-an-app-may-answer-http-and-websocket-requests-under-its-address.md) (each `fetch` and `websocket` call loads the app), [ADR-0949](0949-an-action-calls-a-model-with-plain-code-and-epicenter-adds-no-function-for-it.md) (a key is `process.env`, which Bun fills from `.env` when serve starts), [ADR-0960](0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md) (what an app is handed when it loads), [ADR-0961](0961-the-command-sends-an-actions-words-to-serve-and-serve-alone-reads-them.md) (the command stops loading apps).
- **Unbuilt:** All of it. Serve still re-imports an app on every call. The changed-code line in the listing, the wait on stop, the limit on that wait, the separate process group for routine commands and the time limit on an import do not exist. The changed-code line is built first: until it exists, serve keeps re-importing on each call.

## Context

Serve imports an app again on every call. `load` in
`packages/app/src/command/apps.ts` drops every module under the app's `code/` and
imports `epicenter.ts`, so an edit reaches the next call (ADR-0880). The
action runner, the MCP tool list and the launcher page each call it; one
`tools/list` request imports every app.

That rule has three costs:

- A call can land on code an agent is halfway through changing. A phone, a
  routine or a second agent then runs a half-written app.
- "When does my change take effect?" has two answers for code: the next call
  for an app's own files, and the next restart for its packages (ADR-0942).
- Each reload leaves memory behind. ADR-0880 measured 8 MB over 300 reloads.

The owner's agents are always present on the computer. They can stop and
start serve, so reloading on each call serves nobody who cannot restart.

Routine commands start with `Bun.spawn` in `packages/app/src/command/routines.ts`
and share serve's process group, so a Ctrl-C or a service manager's stop
signal reaches them with serve (`stop` in `packages/app/src/command/serve.ts`).
ADR-0937 accepted that because "the service has restarted only on installs".

## Decision

**Serve imports each app once, when it starts, and answers every call from
what it loaded. To run changed code, stop serve and start it again.**

- **Start.** Serve reads `apps/`, imports each `code/epicenter.ts` inside its
  own guard, and keeps the result. An app that throws while loading is listed
  with its problems, as today, and the other apps still load. Each import has
  a time limit, so one app that never finishes loading cannot hold the others.
- **Call.** A call looks up the app and action already loaded, checks the
  input, and runs it. Nothing is imported.
- **Restart is stop.** Serve has no reload command. On a stop signal it takes
  no new calls, starts no routine, waits for running calls and routine
  commands up to a limit, and exits. Whatever keeps serve running starts it
  again (ADR-0941).
- **One rule for when a change takes effect.** Code, packages and `.env` are
  read when serve starts. Bun fills `process.env` from `.env` at start
  (ADR-0949), so a changed key already needs a restart; code now shares that
  rule. Every other file is read when it is needed: records, `ui/dist/` and
  routine files.
- **Records are never held.** An action reads and writes files when it runs,
  so a record edited by hand, by an editor or by Git is what the next call
  sees. Serve keeps no copy and watches no file.

**The listing says when code changed since serve started, and names the
fix.** Without that line an agent edits an app, calls it, and tests the old
code with no sign that it did. Serve does not load once until the line
exists.

- When serve loads an app it keeps the newest modification time of the
  files under the app's `code/`, leaving out `code/node_modules/` and
  `code/ui/`. It also keeps the modification times of the root
  `package.json` and `bun.lock`, which change when packages do.
- Bare `epicenter` compares those times with the files now. An app whose code
  changed is listed with `code changed since serve started; restart serve`.
  When the root `package.json` or `bun.lock` changed, one line says
  `packages changed since serve started; restart serve`.
- `epicenter --json` carries the same facts as fields: `codeChanged: true`
  on the app, and `packagesChanged: true` at the top, each beside
  `next: "restart serve"`.

**Serve waits for routine commands as it waits for calls.** Each routine
command starts in its own process group (`detached: true` in the
`Bun.spawn` call in `routines.ts`), so a stop signal sent to serve's group
reaches serve alone. On stop, serve waits for running commands under the same
limit as calls, then sends `SIGTERM` to the group of each command still
running, and exits.

- Serve now restarts after every code edit, many times a day,
  where ADR-0937 assumed a restart only on installs. A checkpoint routine
  every five minutes would be cut often.
- Most routine commands are `epicenter <app> <action>`: a client that sends a
  call and prints its answer. The action finishes in serve whether or not the
  client lives, so killing the client loses only the answer and the exit
  code. Waiting keeps both.
- A routine that runs Git or a shell script is the case a cut harms: a
  commit stopped halfway leaves the next run to clean up. Waiting gives it
  the same chance to finish that a call has.

**The owner's restart command goes in the folder's `AGENTS.md`.** How serve
is kept running differs by owner: a terminal, a launchd job or a systemd
unit (ADR-0941), so Epicenter cannot name one command. Serve already sends
`AGENTS.md` to every MCP client at initialize (`rootInstructions` in
`packages/app/src/command/root.ts`), and reads it again on each initialize. The
command's README gives the line to add, for example
`Restart serve: launchctl kickstart -k gui/$(id -u)/<label>`, and the
changed-code line points there when it says `restart serve`.

## Consequences

- A half-finished edit never reaches a call. Serve runs the code it loaded
  until someone restarts it on purpose.
- An agent that edits code and does not restart sees the old behavior, and
  bare `epicenter` tells it so. `epicenter check` loads an app in its own
  process, so it is how an agent tries new code before a restart.
- A restart stops every app at once. Calls and routine commands still running
  at the limit are cut, and open sockets close.
- A routine command no longer ends when the terminal that runs serve gets
  Ctrl-C; serve ends it after the wait. A systemd unit that signals every
  process in it at once (the default `KillMode=control-group`) skips the
  wait; `KillMode=mixed` signals serve alone.
- An app may now keep a value in memory between calls. It is lost at every
  restart, so anything an app must remember still goes in a file (rule 3 of
  ADR-0943).
- Each bare `epicenter` reads the modification times of every app's code
  files. That is one directory walk per app.
- Deleted: `forgetModules` and the load on each call in `home.ts`, `run.ts`,
  `mcp.ts` and `http.ts`.
- Added: a count of running calls and routine commands for the wait on stop,
  the import time limit, the start times kept per app, and the two listing
  fields.
- ADR-0880 and ADR-0945 are `Proposed` and state the old rule. They are
  edited to match when this decision lands, not amended.

## Considered alternatives

- **Re-import on each call (ADR-0880).** An edit shows at once and a running
  call keeps its old code. It also exposes half-written code to every caller,
  and it is the reason code and packages have different rules.
- **Reload one app when its files change.** A watcher, or a check of file
  times on each call. It keeps the edit loop and adds the question of when a
  set of edits is complete, which only the agent making them knows.
- **Load once with no changed-code line.** One less walk per listing. An
  agent that forgets to restart then reports a fix it never ran.
- **Start routine commands in their own process group and leave them
  running.** No wait at stop. A command then outlives the serve that started
  it, nothing ends a hung one, and a Ctrl-C leaves processes behind with no
  owner.
- **Keep routine commands in serve's process group.** No change to
  `routines.ts`. Every code edit then risks cutting a routine, which ADR-0937
  accepted only because restarts were rare.
- **Hold records in memory.** Reads get faster. People, editors and Git write
  those files directly, so the copy goes stale without a watcher and becomes
  a second place where a record lives.
- **Refuse to start when any app fails to load.** One rule for startup. One
  broken app would then stop every other app.
- **Start a second serve, then hand over the port.** No call is cut. It needs
  two processes that both run actions for a moment, which ADR-0936 rules out.
- **Epicenter restarts serve itself.** An `epicenter restart` would have to
  know whether a terminal, launchd or systemd runs serve, which ADR-0941
  leaves to the owner.
