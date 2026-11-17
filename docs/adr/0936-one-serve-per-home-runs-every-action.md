# 0936. One serve per home runs every action

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) on the app lock: nothing locks an app, and nothing locks the home to run an action. [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) on who runs a command's action: serve does.
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (`folder.update`), [ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md) (the call and its route), [ADR-0908](0908-serve-runs-the-homes-daily-routines.md) (routines run commands).

## Context

Three kinds of process run actions today. Serve runs a page's calls and MCP's.
`epicenter <app> <action>` runs its call in its own process. A routine starts
a command, and that command is often the CLI. They can all write one app's
files at once.

Every lock in the design answers that. A call flocks `apps/<app>` from its
first write until it ends (`run.ts`). An earlier draft of named locks took kernel
locks on files so work in one process could exclude work in another. Mail holds a
SQLite transaction, Flights runs `/usr/bin/lockf`, and Codex queues on
`globalThis`. Removing the app lock (ADR-0850) exposed one more: `edit` in
`packages/cli/src/disk.ts` reads a file and then renames over it, which is
safe inside one process and can lose a write between two.

One person owns the home, and serve is on whenever the computer is. A draft
of this record made the single process a rule with a `flock` on the home that
serve held and the CLI tried. A second draft had the CLI send its call to
serve and run the action itself when nothing answered. That left a moment,
while serve starts or with serve stopped, in which two processes write, so
"one writer" was true only most of the time.

Pages, MCP and routines already need serve. The CLI was the one caller that
pretended it did not.

## Decision

**One serve per home runs every action. The port is its name and its lock.
The operating system keeps it running, and the command line never starts it
or stands in for it.**

- **`epicenter <app> <action>` sends its call to serve.** It posts the input
  to `POST /<app>/<action>` at the port in `EPICENTER.md` and reads the same
  JSON lines a page does (ADR-0930). Updates go to stderr and the answer to
  stdout.
- **When nothing answers that port, the command says so and runs nothing.**
  It names `epicenter serve`; keeping serve up belongs to whoever starts it
  (ADR-0941).
- **At most one serve per home is the port.** A home's port is in
  `EPICENTER.md`, and the operating system refuses a second bind. A start
  that fails says which case it met: this home is already served, or the
  port belongs to something else. The marker cannot say port 0, since nobody
  could then find serve.
- **A call names its home, and an answer names its home and version.** The
  CLI sends the home's real path in an `x-epicenter-home` header, and serve
  refuses a path that is not its own, so a command in a second home on the
  same port cannot write into this one. Serve stamps each answer with its
  version, and a command that is newer says to restart serve.
- **A routine's command is a caller like any other.** `run: ["epicenter",
  "flights", "daily", "run"]` reaches serve through the CLI. The routine's
  timeout and signals act on that command, which only waits for the answer;
  the action runs on in serve. Killing a stuck routine therefore kills only
  the command. An action that can run long sets its own deadline.
- **Nothing locks a call.** The flock on `apps/<app>` is removed. No folder
  write takes a lock, and the home has none.

Epicenter has no daemon code of its own. Whoever starts serve
keeps it running (ADR-0941).

Commands that run no action do not need serve: `checkpoint`, `check`,
`export`, `init` and `new`. None takes a lock of its own; a commit takes
Git's index lock, as any commit does.

## Consequences

- Two actions never run in two processes, so a write cannot be lost between
  processes. This holds always, not only while serve is up.
- With serve stopped, an action command does nothing but say so. A fresh
  home needs `epicenter serve` running before its first action.
- After an upgrade, serve is the old version until it restarts. The command
  says so, and whoever runs serve restarts it.
- A test that runs a command starts a serve for its home first.
- A person editing a record while an action writes the same file is a race
  nothing guards. `folder.update` used to look at the file a second time and
  retry, which narrowed the race and did not close it; that second look is
  gone, and with it the `kept` reason of `Changed`.
- An action the CLI sends to serve runs in serve's environment. It does not
  see variables exported in the caller's shell, and what it prints goes to
  serve's log, not the caller's terminal.
- Long work started from the command line runs inside serve. An action that
  crashes the process takes serve down until something starts it again, as an
  action a page started already could. Heavy work belongs in a child process,
  as Flights' browser agent is.
- Deleted: the app lock in `run.ts` with its 30-second wait and `busy`
  refusal, the lock on each file drafted for `folder.update`, and the CLI's
  own run of an action.
- Epicenter takes no lock anywhere. The root lock, the export lock and the
  routine attempt lock went with
  [ADR-0937](0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md)
  and the change after it, and `lock.ts` with its `flock` call is deleted.

## Considered alternatives

- **A lock on the home that serve holds and the CLI tries.** A draft of this
  record. It turns one writer from a habit into a rule, at the cost of a
  `flock`, a retry, and two refusals (`already being served`, `busy`), to
  prevent two commands at once while serve is off.
- **The CLI runs the action itself when serve does not answer.** A draft of
  this record. It kept the first call after `init` and tests free of a
  server, and left one writer true only while serve was up.
- **A lone command holds the port for the length of its call.** The port
  bind would then be the only exclusion. A second command could post to a
  first that is about to exit, so the short serve needs a lifetime rule of
  its own.
- **The CLI starts serve when it is not running.** A background process the
  person did not start, in whichever shell's environment found it down.
  Routines need serve up when nobody types a command, so the operating
  system's job is needed anyway.
- **A lock on each file inside `folder.update`.** It closes the lost write
  one file at a time and leaves two processes interleaving a change across
  several files.
- **Keep the lock on `apps/<app>`.** A slow call blocks every other write to
  its app, and the lock never covered the person's editor.
