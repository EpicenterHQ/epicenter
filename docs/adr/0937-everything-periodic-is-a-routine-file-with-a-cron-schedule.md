# 0937. Everything periodic is a routine file with a cron schedule

- **Status:** Proposed
- **Date:** 2026-11-16
- **Amends:** [ADR-0908](0908-serve-runs-the-homes-daily-routines.md) on the schedule (`daily` becomes `cron`), what makes a routine due, interrupted attempts, `paused`, `timeout`, the routine lock and process-group supervision, local state and logs, `routines run`, and `routines.set`. Its folder and command argv stand. [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) on the checkpoint clock: `serve` keeps none, and a home checkpoints only if it has a routine that does.
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (actions make no commits).

## Context

`serve` keeps two clocks. One checkpoints the home at startup, five minutes
after each pass, and on stop. The other reads `routines/` once a minute and
runs what is due. Both answer "is it time to run this command?" in different
code with different rules.

ADR-0908 kept `daily` because no caller needed another cadence. A checkpoint
every five minutes is that caller. Bun 1.4.3 ships
`Bun.cron.parse(expression, from)`, which returns the next matching time in
local time and follows daylight-saving rules, so a cron expression costs no
parser and keeps catch-up.

ADR-0908 blocks automatic runs after an interrupted attempt until a person
reruns it. A routine running when `serve` restarts is interrupted, so a
checkpoint routine killed at shutdown would stop every later checkpoint
without anyone noticing. ADR-0908 already requires routines to tolerate
repetition, because lost state reruns the latest slot.

`routines.set` lets an app's setup action write a home routine. Its one
caller is the Flights setup action, and the file it wrote already exists.
The person's agent writes files in the home as a matter of course; a routine
is three lines it can write.

## Decision

**A file in `routines/` is the only way a home runs anything on a schedule.
The file existing is the switch. Epicenter writes none.**

```yaml
---
cron: "*/5 * * * *"
run: ["epicenter", "checkpoint"]
---
Commit everything pending and push to the backup.
```

`cron` is a five-field expression or nickname in the home computer's local
time, as `Bun.cron.parse` reads it. It replaces `daily`; `daily: "08:00"`
becomes `cron: "0 8 * * *"`. `run` is unchanged. `paused` and `timeout` are
removed: to stop a routine, remove its file. The home's history keeps it.

**`serve` keeps one moment in memory and writes nothing about routines.**
Once a minute it reads `routines/` and starts each routine whose schedule had
an occurrence since its previous check: `Bun.cron.parse(cron, previousCheck)`
is at or before now. Missed occurrences collapse into one run, and a
computer that slept runs them on wake. An occurrence that passes while
`serve` is not running does not run, because nothing remembers it; a routine
that must not miss a day widens its schedule and makes its command exit when
the day's work is done. There is no `.local` folder, state file, routine log,
or `epicenter routines run`: running a routine by hand is running its
command.

**`serve` starts commands and does not police or record them.** It does not
wait for a command, time it, stop it, or note how it ended. Runs may overlap,
as in cron. A command that must not overlap itself takes its own lock, for
example `/usr/bin/lockf -t 0 <file> <command>`. A command that needs a
deadline sets its own, as Flights' agent run does. This holds for actions
too. With `serve` running, `epicenter <app> <action>` hands the call to
`serve` (ADR-0936), and ending that command does not stop the action
(ADR-0930), so an action that can run long sets its own deadline. A
command's output goes where `serve`'s does, the service log, and its result
is what it leaves in the home. `serve` writes there only a routine file it
cannot read and a command it cannot start. Commands share `serve`'s process
group, so the service manager that stops `serve` stops them.
Bare `epicenter` lists each routine's schedule and next occurrence, or why
its file is refused
([ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md)).

`serve` keeps a one-minute timer that calls the routine check, and no
checkpoint clock. It runs no checkpoint at startup or on stop. A new
checkpoint routine first runs at its next occurrence.

A home with no checkpoint routine makes no commits except the ones a person
or agent names, and pushes nothing. `init` writes no routine. The
instructions `init` writes say so, and give the checkpoint routine above
for an agent to add when the person wants history and backup.

`routines.set` is removed. Installing or importing an app schedules nothing.

## Consequences

- One rule decides when anything periodic runs.
- Whether a routine succeeded is read from what it leaves: checkpoint's
  commits and push, a draft, a research file. A checkpoint that fails every
  five minutes shows only as its own errors in the service log.
- A home can run any checkpoint command. The one `init` writes is a short
  script of the home's own that calls Git (ADR-0940).
- A home whose agent never adds the routine has no record history, no undo
  for overwritten records, and no backup, and nothing announces it. This is
  accepted: the person decides through their agent, and the instructions
  name the consequence.
- Upgrading an existing home stops its checkpoints until the routine is
  added. Add it before upgrading.
- Up to five minutes of changes stay uncommitted when the computer stops.
  The next start commits them.
- A routine that cannot tolerate repetition takes its own id or lock.
- A run longer than its interval overlaps the next one. A hung command
  that runs every minute adds a process every minute until someone stops
  it; this is cron's behavior, and the command's deadline or lock prevents
  it.
- A daily occurrence passes unrun when the computer is off or logged out
  across it, or in the seconds a `serve` restart takes.
- A refused routine file is reported to the service log at every check
  until it is fixed.

## Considered alternatives

- **`init` writes the checkpoint routine; deleting it turns checkpoints off.**
  Safer for a home whose agent never reads its instructions, and it keeps
  history on by default. Refused: Epicenter would be writing the person's
  instructions for them, and a routine Epicenter installs is the special
  case this record removes.
- **`serve` warns at startup when no checkpoint routine exists.** Refused for
  the same reason: `serve` would know that one routine is special.
- **`epicenter routines check`, so launchd or cron can drive a home without
  `serve`.** No caller runs a home without `serve`. Add it when one does.
- **Keep `daily` beside `cron`, or keep `paused`.** A second schedule format
  and a second off switch for one rule.
- **In-process `Bun.cron(expression, handler)` per routine.** It must be
  registered again whenever a file changes and has no catch-up after sleep.
- **Keep a start time per routine, in `routines/<name>.local/`.** It catches
  up an occurrence missed while `serve` was down. Refused: it brings back a
  folder, a schema, atomic writes, and a corrupted-state path for a case the
  routine's own schedule can cover. A home-wide heartbeat file can be added
  later if missed days prove annoying.
- **Keep the kernel lock, passed to the command on fd 3.** It guards a
  `serve` restart during a run and a foreground run during a scheduled one.
  The service has restarted only on installs, and the due rule already waits
  for the next occurrence after a restart. A lock every command must keep
  open is a rule every command author must know.
- **Skip an occurrence while the last run is still going.** Its only
  record is the command `serve` started, which for an action is only the
  client that handed the call to `serve`, so it does not see the work.
  Whether a routine may overlap itself is the command's choice.
- **Keep a `timeout` that kills the command's process group.** The command
  knows its deadline and what to clean up; `serve` would only guess. Flights
  already stops its agent after fifteen minutes.
- **OS-level `Bun.cron` jobs per routine.** ADR-0908's reason stands: the
  person would inspect schedules in a second system.
- **A model writes every checkpoint message by default.** It sends diffs of
  private records out up to 288 times a day, reads mail bodies that can
  carry injected instructions, and stops backups when the model is
  unavailable. A home may still choose it.
