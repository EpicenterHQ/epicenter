# 0876. An app's records live under `data/`, and everything else in it is code

- **Status:** Proposed
- **Date:** 2026-11-11
- **Unbuilt:** all of it: collection paths sit at the app's top (`tasks/{time}.md`), `folder` writes anywhere in the app, and the Studio's apps keep their records at the top.
- **Relates:** [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md) (collections and `folder`), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (where a file lives decides what happens to it), [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (starters hold no data), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`*.local`), [ADR-0877](0877-a-starter-is-published-from-its-app-as-the-apps-files-outside-data.md) (publishing a starter).

## Context

An app folder holds two kinds of file with different owners: the code its
author wrote (`epicenter.ts`, `ui/`, a README) and the records its person and
agents keep. Today they share the top of the folder, and only the collections'
path templates say which files are records. Everything that has to tell them
apart reads those templates and guesses at the rest: ADR-0866 refuses a
collection path under `ui/` or named `epicenter.*`, a starter must hold no
file a template matches, and a starter made from an app would have to refuse
any file that is neither, such as a hand-made `settings.md` no collection
declares.

## Decision

**Every app has the same layout: its code at the top, its records under
`data/`.**

```txt
~/Epicenter/tasks/
  epicenter.ts  README.md  package.json  .gitignore      code
  ui/                                                    code: the UI's source
  data/                                                  records
    tasks/<time>.md
```

- **A collection's path starts with `data/`.** `defineCollection` refuses one
  that does not, naming the path it would accept.
- **A record's path is the same everywhere:** the file's path from the app's
  folder (`data/tasks/<time>.md`), in what actions return, on the command line,
  over MCP, and in a UI's routes.
- **A run writes only under `data/` or to a `*.local` file.** `folder.write`,
  `writeBytes`, `update`, and `delete` throw for any other path, naming the
  action and the path. A run cannot change its own app's code.
- **Everything tracked outside `data/` is code.** That is what a starter holds
  (ADR-0877) and what `update` merges (ADR-0866). `*.local` files are never
  tracked (ADR-0870), wherever they sit.

## Consequences

- Telling records from code is a path check, not a reading of the templates:
  ADR-0866's refusal of collection paths under `ui/` or named `epicenter.*`
  goes, and a starter cannot hold a record by construction.
- An agent looks in one place for records, and a person browsing in Finder
  sees `data/` beside the app's code, one folder deeper than today.
- An action that wrote a file beside its code (an export, a report) writes it
  under `data/` instead, where it is a record like any other.
- Each existing app moves its records once, a `git mv` into `data/`, and
  prefixes each collection's path. A UI's hash routes gain the prefix
  (`#/data/tasks/<time>.md`).

## Considered alternatives

- **A layout per app, with records told apart by their templates.** Each tool
  that needs the split reads the templates, and a file no template matches
  needs a rule of its own in each.
- **Records at the top, code under one folder (`app/`).** Records stay one
  level shallower, but an Epicenter finds an app by its `epicenter.ts`
  (ADR-0868), and every tool expects `package.json` at a project's root.
- **Record paths relative to `data/` (`tasks/<time>.md`).** Shorter, but a
  file would have two names: the one an action returns and the one an agent
  opens.
</content>
</invoke>
