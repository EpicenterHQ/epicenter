# Tasks

Things to do, as an app in `~/Epicenter/tasks` (ADR-0864). `bun epicenter install apps/tasks`
installs it; `epicenter serve` serves its view at `/tasks/`.

## A task is a file

```md
---
title: "Email Sam the slides"
done: false
due: "2026-11-12"
---
The deck is in Drive.
```

`tasks/<id>.md`, its id made from the time it was added. `title` and `done`
are required; `due` is a day, absent when there is none. The
notes are the body, in Markdown. This is the earlier Todos app's shape
(`todos/<id>.md` with `title` and `done`) plus `due`, so its files move over by
renaming the folder.

The title is a field, not the body's first line, because `tasks list` gives
every task's fields without its body: the list, and an agent asking what is
left to do, read titles from one call.

`tasks set <id> --due 2026-11-12` sets a day. `tasks set` merges as JSON Merge
Patch does, so `due: null`, over MCP or from the view, removes the line.

## Actions

| Action | Does |
| --- | --- |
| `tasks list`, `get`, `set`, `delete` | the collection's four (`packages/app/src/collection.ts`) |
| `add <title> [--due <day>] [--notes <text>]` | a new task with a time id; a title of several lines keeps its first line as the title and the rest as notes |

`tasks set <id> --done` checks one off.

## The view

`src/`: the list (`#/`) with a quick add, open tasks grouped as Overdue,
Today, Upcoming, and No date, and the done ones folded under Completed; and a
task's page (`#/t/<id>`) to edit its title, due day, and notes, which saves as
you type, and to delete it. The list asks again every 15 seconds while the page
is visible and whenever it is shown, so tasks an agent adds appear.
