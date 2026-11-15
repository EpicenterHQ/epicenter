# Tasks

Things to do, as an app in `~/Epicenter/apps/tasks`. This folder is its code;
`data/`, a Git repository of its own, holds the tasks. `epicenter serve`
serves its UI at `/tasks/`.

## A task is a file

```md
---
title: "Email Sam the slides"
done: false
due: "2026-11-12"
---
The deck is in Drive.
```

`data/tasks/<time>.md`, named by the time it was added, such as
`data/tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md`; that path is the task's address.
`title` is required and is one line, not blank. `done` is `false` unless set.
`due` is a day, absent when there is none. The notes are the body, in
Markdown. This is the earlier Todos app's shape (`todos/<id>.md` with `title`
and `done`) plus `due`, so its files move over by renaming the folder.

The title is a field, not the body's first line, because `tasks list` gives
every task's fields without its body: the list, and an agent asking what is
left to do, read titles from one call.

A file written by hand that does not fit reads as far as it can: a `due` that
is not a day is left out, a missing `done` reads as `false`, and the task
carries `problems` quoting what did not fit.

## Actions

| Action | Does |
| --- | --- |
| `list`, `get`, `set`, `edit`, `delete` | the collection's verbs, each taking a task's path (`@epicenter/app`'s README) |
| `note <path> --body <text>` | replace the notes on an existing task, preserving its fields |
| `add <title> [--due <day>] [--notes <text>]` | a new task named by the time; a title of several lines keeps its first line as the title and the rest as notes |

```sh
epicenter tasks add "Email Sam the slides" --due 2026-11-12
epicenter tasks set data/tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md --done
epicenter tasks set data/tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md --due null
```

`set` merges as JSON Merge Patch does, so `--due null`, or `due: null` over MCP
or from the UI, removes the line. `set` refuses a title of several lines or a
blank one, as `add` does.

## The UI

`ui/`: the list (`#/`) with a quick add and optional due date. Open tasks are
grouped as Overdue, Today, Upcoming, and No date. Done tasks fold under Completed.
A task's page is at its path (`#/data/tasks/<time>.md`): it edits the title,
done, due day, and notes, and deletes the task after asking.

Done, title, and due changes use ordinary TanStack mutations. Title saves when
its field changes; notes save whenever I leave their field. Until then, notes
live only in that browser field: navigation, reload, or closing before blur
can discard them, with no notes-specific leave warning. Failed notes writes
offer Retry with the submitted text; starting a newer save dismisses the older
retry. Notes wait for their own pending save and its refreshed reads, so a
click on a due-day button after leaving notes still counts. Reloading with an
unsaved title asks before leaving.

The UI assumes a single writer. Notes replace the body through `note`; the
latest save wins if another writer changed it. `edit` remains available to
agents that need a guarded text replacement. Every write refreshes the active
reads. Reads also refresh when the page becomes visible, with no polling.

A task whose file does not fit shows a mark in the list, and its page quotes
the problems. Navigation starts at the top, including Back and Forward.

A successful save puts its returned record into the query cache before reads
refresh. If a refresh fails, the saved record stays visible and a Refresh
action retries that read without repeating the write. Save errors still show
after leaving the page.

## Browser checks

Use a disposable Epicenter with synthetic tasks. Check title, notes, due-day
changes and completion across reload. Check Delete cancellation, disabled
controls while pending, failure and retry. Check quick add, phone and desktop
widths, encoded paths and malformed route encoding. Real `data/` is not test
input.

For save regressions, fail a write after navigating away and check that its
error is still shown. Fail only the follow-up read after a successful save:
the saved value must remain visible, and Refresh must make no second write.
Edit notes, leave their field, then reopen and reload the task: the saved text
must remain. Check clearing the notes, a failed save and Retry after leaving,
and a newer save dismissing an older Retry. Hold the follow-up read open:
notes must stay disabled until it finishes. Leaving notes to click Tomorrow
must save both changes on that first click. No notes draft is retained in
browser storage.
