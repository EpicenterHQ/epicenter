# 0959. Serve loads each app once, and an app's code changes when serve restarts

- **Status:** Proposed
- **Date:** 2026-11-18
- **Amended:** 2026-11-18: built without the changed-code line in the listing, by the owner's choice; his `AGENTS.md` carries his restart command instead. Routines became actions run inside serve ([ADR-0937](0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md)), so there is no routine command, process group or wait on stop. A stop cuts what is running.
- **Amends:** [ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md) at one consequence: an edit to an app's own code no longer shows on the next call. It shows after serve restarts, as a changed package already does.
- **Relates:** [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) (the re-import on each call, which goes), [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one serve runs every action), [ADR-0937](0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md) (routines), [ADR-0941](0941-epicenter-serve-is-a-program-you-keep-running.md) (the person keeps serve running), [ADR-0943](0943-epicenters-core-invariants.md) (rule 2 states the rule), [ADR-0945](0945-an-app-may-answer-web-requests-at-its-address-with-fetch.md) (`fetch` is the loaded app's), [ADR-0949](0949-an-action-calls-a-model-with-plain-code-and-epicenter-adds-no-function-for-it.md) (a key is `process.env`, which Bun fills from `.env` when serve starts), [ADR-0960](0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md) (what an app is handed when it loads), [ADR-0961](0961-the-command-sends-an-actions-input-to-serve-and-serve-alone-reads-it.md) (the command stops loading apps).
- **Unbuilt:** the time limit on an import. An app whose top-level code never finishes holds serve's start, and serve answers no call until it is fixed.

## Context

Serve imported an app again on every call. `load` dropped every module under
the app's `code/` and imported `epicenter.ts`, so an edit reached the next
call (ADR-0880). The action runner, the MCP tool list and the launcher page
each called it; one `tools/list` request imported every app.

That rule had three costs:

- A call can land on code an agent is halfway through changing. A phone, a
  routine or a second agent then runs a half-written app.
- "When does my change take effect?" had two answers for code: the next call
  for an app's own files, and the next restart for its packages (ADR-0942).
- Each reload leaves memory behind. ADR-0880 measured 8 MB over 300 reloads.

The owner's agents are always present on the computer. They can stop and
start serve, so reloading on each call serves nobody who cannot restart.

## Decision

**Serve imports each app once, when it starts, and answers every call from
what it loaded. To run changed code, stop serve and start it again.**

- **Start.** Serve reads `apps/`, imports each `code/epicenter.ts` inside its
  own guard, and keeps the result. An app that throws while loading is listed
  with its problems, and the other apps still load. Serve reads `AGENTS.md`
  and `routines/` in the same pass, then builds the listing, the MCP tools
  and the launcher from what it loaded.
- **Call.** A call looks up the app and action already loaded, checks the
  input, and runs it. Nothing is imported.
- **Restart is stop.** Serve has no reload command. On a stop signal it
  closes every connection and exits the process, even while an app's timer
  would hold it, so a restarted serve never runs beside the old one. A call
  or routine still running is cut. A write cut off leaves its target whole:
  the folder writes a temporary file and renames it over the target. Whatever keeps serve running starts it again (ADR-0941).
- **One rule for when a change takes effect.** Code, packages, `.env`,
  `AGENTS.md` and `routines/` are read when serve starts. Bun fills
  `process.env` from `.env` at start (ADR-0949), so a changed key already
  needed a restart; code now shares that rule. Records and `ui/dist/` are
  read when they are needed.
- **Records are never held.** An action reads and writes files when it runs,
  so a record edited by hand, by an editor or by Git is what the next call
  sees. Serve keeps no copy and watches no file.

**The owner's restart command goes in the folder's `AGENTS.md`.** How serve
is kept running differs by owner: a terminal, a launchd job or a systemd
unit (ADR-0941), so Epicenter cannot name one command. Serve sends
`AGENTS.md` to every MCP client at initialize. The command's README and the
`epicenter-app` skill say to restart serve after editing app code and give
the line to add, for example
`Restart serve: launchctl kickstart -k gui/$(id -u)/<label>`.

**No changed-code line.** This record first required the listing to say when
code had changed since serve started, and to load once only after that line
existed. The owner chose to build load-once without it: his agents restart
serve from the line in `AGENTS.md`, and a listing that walks every app's code
on each bare `epicenter` is a cost paid to catch a forgotten restart.

## Consequences

- A half-finished edit never reaches a call. Serve runs the code it loaded
  until someone restarts it on purpose.
- An agent that edits code and does not restart sees the old behavior, and
  nothing tells it so. Nothing tries new code before a restart: ADR-0968
  deleted `epicenter check`, which did.
- An app that failed to load stays failed until serve restarts, even once
  its file is fixed. Every path under its address answers 500 with its
  problems.
- A restart stops every app at once. Calls and routine runs still going are
  cut, and open sockets close.
- An app may now keep a value in memory between calls. It is lost at every
  restart, so anything an app must remember still goes in a file (rule 3 of
  ADR-0943).
- Deleted: `forgetModules`, the load on each call in the action runner, MCP
  and the launcher, and the `AGENTS.md` read on each MCP initialize.
- ADR-0880 and ADR-0945 are `Proposed` and stated the old rule. They are
  edited to match.

## Considered alternatives

- **Re-import on each call (ADR-0880).** An edit shows at once and a running
  call keeps its old code. It also exposes half-written code to every caller,
  and it is the reason code and packages had different rules.
- **Reload one app when its files change.** A watcher, or a check of file
  times on each call. It keeps the edit loop and adds the question of when a
  set of edits is complete, which only the agent making them knows.
- **Load once with a changed-code line in the listing.** The first form of
  this record. An agent that forgets to restart is told so, at one directory
  walk per app on each listing. Set aside by the owner in favor of the
  restart line in `AGENTS.md`; it can be added later without changing the
  rest.
- **Wait for running calls on stop, up to a limit.** A call near its end
  finishes. It needs a count of running calls and a limit to choose, and a
  hung action still holds the restart for the whole limit. Not built.
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
