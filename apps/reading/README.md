# Reading

Books I mean to read, am reading, and have read, as an app in
`~/Epicenter/reading` (ADR-0864). This folder is the starter's source
(ADR-0866); `epicenter serve` serves its UI at `/reading/`.

## A book is a file

```md
---
author: "Frank Herbert"
started: "2026-11-02"
finished: "2026-11-20"
rating: 5
---
Fear is the mind-killer.
```

`data/books/<title>.md`, named by its title as typed (NFC, trimmed, single
spaces), such as `data/books/Dune.md`; that path is the book's address, and the
title comes from it. Every field may be absent. `started` and `finished` are
days; `rating` is a whole number from 1 to 5. The notes are the body, in
Markdown.

Where a book stands comes from its days, so nothing can disagree with them:
no `started` is a book I mean to read, `started` alone one I am reading, and
`finished` one I have read. A book finished without being logged first has
`finished` and no `started`.

## Actions

| Action | Does |
| --- | --- |
| `list`, `get`, `add`, `set`, `edit`, `delete` | the collection's verbs (`packages/app/README.md`); `add <title>` adds a book to read |
| `start <title> [--author <name>]` | starts it today, adding the book when it is not there; a book I am reading keeps its day, and one I finished starts again with its finished day cleared |
| `finish <title> [<rating>]` | finishes it today, adding the book when it is not there; a book already finished keeps its day, and a rating given replaces the old one |

```sh
epicenter reading add "Piranesi" --author "Susanna Clarke"
epicenter reading start "Project Hail Mary"
epicenter reading finish Dune 5
epicenter reading set data/books/Dune.md --rating null
```

`start` and `finish` take the title a person types and write today's day in
the time zone of the computer that runs `epicenter serve`. Starting a book
already being read changes nothing and commits nothing.

## The UI

`ui/`: the shelves (`#/`) with a quick add for a book to read, then Reading,
To read, and Read, each book with its author and its day; a book to read
starts with one tap, and one being read finishes with one. A book's page is
at its path (`#/data/books/Dune.md`): it edits the author, the two days, and the
rating, each saved when it changes, and the notes, saved with `edit` when
they lose focus or the page is hidden, quoting them as loaded, so notes an
agent changed meanwhile are not overwritten without asking. The list asks
again every 15 seconds while the page is visible and whenever it is shown.
