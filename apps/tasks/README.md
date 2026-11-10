# Tasks

Things to do, as an app in `~/Epicenter/tasks` (ADR-0864). This folder is
the starter's source (ADR-0866); `epicenter serve` serves its UI at `/tasks/`.

## A task is a file

```md
---
title: "Email Sam the slides"
done: false
due: "2026-11-12"
---
The deck is in Drive.
```

`tasks/<time>.md`, named by the time it was added, such as
`tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md`; that path is the task's address.
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
| `list`, `get`, `set`, `edit`, `delete` | the collection's verbs, each taking a task's path (`packages/app/README.md`) |
| `add <title> [--due <day>] [--notes <text>]` | a new task named by the time; a title of several lines keeps its first line as the title and the rest as notes |

```sh
epicenter tasks add "Email Sam the slides" --due 2026-11-12
epicenter tasks set tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md --done
epicenter tasks set tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md --due null
```

`set` merges as JSON Merge Patch does, so `--due null`, or `due: null` over MCP
or from the UI, removes the line. `set` refuses a title of several lines or a
blank one, as `add` does.

## The UI

`ui/`: the list (`#/`) with a quick add, open tasks grouped as Overdue, Today,
Upcoming, and No date, and the done ones folded under Completed. A task's page
is at its path (`#/tasks/<time>.md`): it edits the title, done, due day, and
notes, and deletes the task after asking. A change saves after a short pause,
when its field loses focus, and when the page is left; the notes save with
`edit`, quoting them as loaded, so notes an agent changed meanwhile are not
overwritten without asking. A task whose file does not fit shows a small mark
in the list, and its page quotes the problems. A change saved to the file but
not recorded in history says so, with the `epicenter sync tasks` command that
records it. The list asks again every 15 seconds while the page is visible and
whenever it is shown, so tasks an agent adds appear.
