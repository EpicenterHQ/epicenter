# 0908. Serve runs the home's daily routines

- **Status:** Accepted (2026-11-15)
- **Date:** 2026-11-14
- **Amends:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md), [ADR-0861](0861-whats-yours-is-everywhere-and-everything-else-is-used-where-it-is.md), [ADR-0878](0878-the-os-keeps-epicenter-serve-running-under-a-job-the-person-installs.md), [ADR-0883](0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md), and [ADR-0898](0898-what-arrives-is-cached-what-the-person-decides-is-kept-and-an-item-moves-by-transfer.md) at their refusal of recurring work and command supervision inside `serve`.
- **Relates:** [ADR-0878](0878-the-os-keeps-epicenter-serve-running-under-a-job-the-person-installs.md) (the OS keeps the service alive) and [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) (one private root history holds app code, records, and routine declarations).

## Context

ADR-0898 gave scheduling to launchd, cron, or an agent's routine. Each native
job would need its own installation, configuration, and explanation of missed
runs. The owner instead wants Epicenter to remember recurring work, catch up
when available, and expose interrupted attempts for inspection and repair.

The first job is a daily task review saved as a draft. After two days offline,
one current review is useful. Replaying every missed morning is not. Its time
is when it becomes due, rather than a deadline for starting. The owner accepts
approximate timing and explicitly authorizes the server-owned scheduler.

## Decision

**A home declares daily commands in `routines/`; `serve` checks for due work on
startup and once a minute. It attempts the latest due occurrence once.**

An ordinary Markdown file declares `daily: "08:00"` and `run`, an array of an
executable and its arguments. Optional `paused` stops scheduled attempts;
optional `timeout`, such as `"30m"`, bounds execution (30 minutes by default).
The body explains the person's intent. Declarations belong to the home's
repository, outside `apps/`. Installing an app schedules nothing.

The daily time is in the home computer's local time zone. A slot is the most
recent occurrence at or before the check, persisted as a UTC ISO timestamp.
Calendar arithmetic follows the local `Date` rules: a skipped clock time moves
forward through the gap; a repeated time uses its first occurrence. The check
interval is an implementation constant, not a person-facing setting. Commands
may start later while the home sleeps, the server is busy, or another attempt
holds the routine's lock.

The check runs independently of backups and never waits for a command to
finish. It starts a child process group, with no shell, in the home folder.
An `epicenter` target uses the running CLI's own entry point; a `bun` target
uses its Bun runtime. Other executables use the service's PATH. Each command
has its own process, so an action's exit or a hung agent cannot stop `serve`.
This is process isolation, not a permissions sandbox.

`routines/<name>.local/` holds an atomically replaced `state.json` and an
append-only `output.log`. The scheduler and foreground runner take the kernel
lock on that directory for the entire attempt. The command inherits the lock
as descriptor 3, so a surviving command still excludes a new attempt after
supervisor death. State records the last
successful slot and the most recent attempt, including its start, finish,
process-group leader, exit code, and outcome. Invalid declarations or state
are reported without guessing or overwriting them.

With no state, the latest occurrence is due: enabling a routine can run it at
the next check. Earlier missed occurrences are coalesced. Success satisfies
the captured slot, rather than whatever time it happens to finish. A failed
attempt is not automatically retried for that slot; the next day's slot can
run. An interrupted attempt blocks further automatic execution until the
person explicitly reruns it. This preserves uncertainty about effects already
performed. A process group that survived its supervisor also blocks reruns.
Recorded process identifiers are diagnostic; lock ownership decides liveness.

`epicenter routines` reads declarations and state even while `serve` is down.
`epicenter routines run <name>` runs in the foreground through the same runner,
including while paused. It is the repair operation for a failed or interrupted
attempt and can repeat effects. Shutdown and timeout terminate owned command
groups, escalating from SIGTERM to SIGKILL. Commands must keep descriptor 3
open and remain in their process group; intentionally closing it or
daemonizing out of the group is outside this contract.

The first routine reads `epicenter tasks list --json` and writes a dated draft
under the home's `drafts/`, grouping open tasks by due date. Atomic publication
refuses to replace an existing draft. A rerun preserves the person's edits.
It changes no tasks, uses no model, and sends nothing to another service.

## Typed setup and Flights, 2026-11-15

An app can explicitly save recurring work from a setup action:

```ts
await routines.set('flights-daily-research', {
  daily: '08:00',
  action: dailyRun,
  input: {},
  timeout: '20m',
});
```

The host infers the installed app and resolves the exact action reference in
the current load's action table. It refuses an unexposed or ambiguous action,
read-only setup, private input, and file input. It validates the JSON that will
be stored using the existing action schema. Omitted defaults remain omitted,
so a later invocation applies the current action's defaults.

The home-wide name identifies the existing Markdown file. The setter atomically
updates requested fields while retaining notes, unspecified pause and timeout,
and all local attempt state. It refuses to take over a command for another app.
It writes ordinary CLI argv, not a function or a second target registry. App
code lives under `apps/<app>/code/`; results stay beside it under `data/`.
Importing or copying code never activates a routine.

Flights setup targets `daily run`, which awaits the shared research worker and
its existing kernel lock. The UI's `daily begin` still acknowledges background
work. A scheduled child retains the routine's process group and inherited lock;
manual HTTP calls own an isolated cancellable group. The action throws for a
busy lock, stopped or failed work, and entirely failed searches. An empty due
queue completes normally. A 15-minute deadline can interrupt verification while
leaving earlier saved fares; that invocation fails. A simultaneous manual run
can make the scheduled invocation fail busy. The person inspects results before
repairing; no automatic retry or joining of another run is added.

An independent review with two Codex seats and one Claude seat supported
retaining `daily`. The real callers need one current daily pass. Cron adds
cadences and previous-occurrence rules without removing catch-up, exclusion,
process ownership, or repair. A real caller needing another cadence would
justify revisiting the representation. A CLI setter, overwrite modes, generic
duplicate-action refusal, and routing the UI through the home runner were
deferred because they add work outside these callers.

Signalling errors cannot disappear during cleanup. The runner records them as
interruption and does not advance completion when descendant cleanup is
unconfirmed. This retains an inspectable receipt even if the final group signal
fails after the direct child exits.

## Consequences

- The OS keeps one `serve` alive; per-routine launchd, systemd, and Task Scheduler
  installation is unnecessary. No new scheduled attempt starts while `serve`
  is unavailable.
- Definitions and drafts are backed up with the home. Runtime state and output
  remain local. Losing that state makes the latest slot due again; routines
  must tolerate repetition or produce inspectable drafts.
- There is no exactly-once promise across process death and external effects.
  Status and logs preserve what is known; explicit repair handles uncertainty.
- The runner currently uses the CLI's macOS/Linux process and lock facilities.
  Windows needs a corresponding execution and locking implementation.
- This adds daily commands, not cron expressions, per-period replay, workflows,
  event triggers, or a new app lifecycle.

## Considered alternatives

- **Install one native OS job per routine.** Mature schedulers can launch the
  commands, but the person would inspect configuration and missed work in a
  second system. The accepted availability-based promise fits `serve`.
- **An ordinary Routines app.** Apps expose collections and actions, not a
  resident lifecycle. The server would still need a special app protocol.
- **Run every action inside `serve`.** Reuses the HTTP execution path but shares
  exits, CPU stalls, and cancellation limits with the listener.
- **Replay every missed period.** Creates obsolete task reviews and requires a
  backlog. One current run serves the first job.
- **Retry every failure automatically.** A failed or interrupted command may
  already have performed an effect. An explicit rerun keeps that choice visible.
