# 0855. Reminders are an app, and a screen runs what is due when it opens

- **Status:** Proposed
- **Date:** 2026-11-08
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md) (no schedules), [ADR-0850](0850-running-an-action-makes-one-commit-or-nothing.md) (claiming is a commit), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (collections and screens).
- **Unbuilt:** all of it: a date-time field, the Reminders app, a screen running what is due, and phone notifications.

## Context

ADR-0849 dropped schedules because their hard cases (catching up after sleep,
moving machines without sending twice, a timer nobody watches) all came from
runs nobody started. People still want reminders: a note at a time, and
sometimes an action to run then ("send Alex the draft at 9").

## Decision

**Reminders are an ordinary app**, added like any other
(`epicenter add <registry url>/reminders`). Its data is one collection:

```md
<!-- reminders/send-alex-draft.md -->
---
due: 2026-11-09T09:00
run: mail send --draft r-abc
---
Send Alex the proposal.
```

`due` is required; `run` (a command line, parsed as the CLI parses one) and
`repeat` (`daily`, `weekly`) are optional. A reminder without `run` is only
shown. The collection gives `list`, `show`, `save`, and `delete` (ADR-0853), and
the app writes two actions:

- `reminders due` (`readOnly`) lists the reminders whose time has passed.
- `reminders claim <stem>` takes one: it marks a one-off reminder done, or moves
  a repeating one's `due` to its next time after now. It refuses a reminder that
  is not due.

**A screen runs what is due when it opens.** The Epicenter app, on opening,
asks `reminders due`, shows each one, claims it, and then runs its `run` while
the person is looking. Nothing runs anywhere else, and your Epicenter still runs
nothing on its own.

**The clock is the phone's.** A native app hands each `due` time to the
operating system as a local notification; tapping it opens the app, which runs
what is due. A web screen shows what is due when it is opened.

## Consequences

- Claiming before running promises a `run` at most once: two screens opening
  together both claim, runs of one app take turns on your Epicenter, and the
  second claim is refused. A `run` that fails after its claim is shown to the
  person, who retries it.
- Missed repeats collapse: three mornings unopened become one run, because a
  claim moves `due` past now.
- A reminder runs when someone opens a screen after its time, not at its time.
  "Send at 9" sends at noon if nothing is opened before noon.
- Screens depend on an app named `reminders` with `due` and `claim`, not on
  anything in Epicenter itself; without the app, screens show no reminders.
- Fields gain a date-time type; `field.date` holds only a day.

## Considered alternatives

- **Schedules on your Epicenter (ADR-0846).** A timer and catch-up rules for
  runs nobody watches.
- **Reminders built into the Epicenter app.** A second home for data that is
  otherwise an app's files, and a feature no other client could reach.
- **Claiming after the run.** Two screens opening together would both run it.
  For an action like sending mail, at most once with the person watching is the
  right promise.
