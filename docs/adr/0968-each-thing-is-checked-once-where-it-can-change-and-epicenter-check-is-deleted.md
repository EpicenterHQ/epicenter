# 0968. Each thing is checked once, where it can change, and `epicenter check` is deleted

- **Status:** Proposed
- **Date:** 2026-11-18
- **Supersedes, on this point:** [ADR-0921](0921-epicenter-check-reports-every-record-that-does-not-fit-its-collection.md) (the command exists), [ADR-0933](0933-an-apps-data-is-top-level-folders-of-markdown-records-and-single-markdown-files.md), [ADR-0934](0934-code-reaches-a-record-by-its-keys-name-and-its-id.md) and [ADR-0935](0935-a-keys-generated-actions-are-its-handles-verbs-named-by-the-app.md) (where they name `epicenter check` as the place a ref or a misfit is reported), [ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md) ("`epicenter check` stays a platform command"), [ADR-0953](0953-an-actions-answer-is-data-or-error-and-its-input-is-one-json-schema.md) (`check` among the CLI's commands and the `report` an error carries) and [ADR-0963](0963-local-ignores-itself-and-serve-refuses-a-dotenv-that-git-would-commit.md) (check as a second place that names a `local/` without `.gitignore`). Their statuses are unchanged.
- **Relates:** [ADR-0959](0959-serve-loads-each-app-once-and-an-apps-code-changes-when-serve-restarts.md) (serve loads each app once, so it checks each app once).

## Context

`epicenter check [<app>]` loaded every app in its own process and read every
record of every data key. It reported files that did not fit their fields,
file names that were not ids, names that fold to one file on a disk that
ignores case, refs that named no file, and a `data/<key>.md` left from when
a key could be one file. It also repeated two problems serve already prints
at start: an app that does not load and a `local/` Git could reach.

It was a sweep: it checked everything again, on request, whether or not
anything had changed. With serve loading once (ADR-0959), it had become the
only caller of the app loader besides serve, and the only reason the
command kept a word for itself beside `serve`.

The owner decided to delete it: "Let's build C and then also let's delete
epicenter check for now just to see how the data keys list and how these
would be designed. Collapse things even more. Let's be aggressive if on the
deletions ... We can always re-add complexity later."

## Decision

**Each thing is checked once, where it can change. Epicenter has no sweep,
no re-check and no probe.**

- **An app's code** can change only when serve starts, so serve checks it
  then: an app that does not load, and a `local/` without its
  `.gitignore`, are problem lines serve prints at start and the listing
  carries.
- **A routine** is checked against the loaded apps when serve starts.
- **A record** is checked when it is read or written. A read of a file that
  does not fit is a `Misfit`; a key's `list` action answers one Result per
  file, so the files that do not fit show as refusals there.
- **A ref** is text, checked when an action follows it.
- **An old `data/<key>.md`** is moved by the 0.8.0 migration, not found by a
  standing check.

`epicenter check`, `checkData` and `strayData` are deleted. `check` is no
longer a command word: `epicenter check` is refused as an unknown app, and an
app may be named `check`.

## Consequences

- These problems are reported by nothing until something reads the file:
  - a record that does not fit its fields, until a `get` or `list` of it;
  - a file in a key's folder whose name is not an id, which `list` skips
    without a word;
  - two names that are one file on a disk that ignores case;
  - a ref that names no file, until an action follows it;
  - a `data/<key>.md` left from before keys were folders, which nothing
    reads.
- A person or agent asking "is my data sound?" calls each key's `list`
  action and reads the refusals. Nothing totals them across keys or apps.
- Trying changed code before a restart has no command. Restart serve.
- A command's error no longer carries a `report` the presenter prints.
  `ActionError.Problems` has no producer left in the command.

## Considered alternatives

- **Keep `epicenter check` for data only.** It answers "is my data sound?"
  in one command. It keeps a second loader caller and a sweep the owner
  wants to see the design without.
- **Report data problems in the listing.** Bare `epicenter` would read every
  record on each listing, which is the sweep again, paid on every call.
- **A check action per app.** Each app would carry the same code. It can be
  re-added as one generated action per key if the `list` refusals prove too
  thin.
