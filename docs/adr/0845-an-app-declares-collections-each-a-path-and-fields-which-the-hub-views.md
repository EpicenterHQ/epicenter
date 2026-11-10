# 0845. An app declares collections, each a path and fields, which the hub views

- **Status:** Accepted (2026-11-08)
- **Date:** 2026-11-08
- **Amends:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md): `defineApp` takes `collections` beside `actions`.
- **Amended by:** [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md): a collection's path is a template with placeholders, and its fields are the `field` helpers' JSON Schema.
- **Relates:** [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) (the hub's data view).
- **Unbuilt:** all of it: `collections` in `@epicenter/app`, the conformance check, and the hub that shows them.

## Context

The hub's data view should show an app's files the way a person thinks of
them: a set of words as a table, a settings file as a form. To do that it has
to know which files belong together and what their front matter holds. The
folder sync product answered with contracts that validated every write; an app
here is edited by hand and by agents as often as by its own actions, so a
contract that refuses writes would fight the person.

## Decision

**A collection is a path and fields, both always present.**

```ts
collections: {
  words:    { path: 'words/{stem}.md',          fields: { stage: field.select(['new', 'known']) } },
  journal:  { path: 'journal/{year}/{stem}.md', fields: { mood: field.text({ optional: true }) } },
  settings: { path: 'settings.md',              fields: { voice: field.text(), dailyGoal: field.number() } },
}
```

**The path is a template, read both ways.** Each `{name}` matches one path
segment. Replacing them with `*` gives the files to list; filling them gives a
new file's path. A path with placeholders is many files, each a row; a path
without any is one file. Placeholder values belong to the row (`stem` is its
name, `year` a column) and are never also fields. A collection has one path.

**Fields are the same helpers an action's input uses** (`field.text`,
`select`, and the rest). For a Markdown file they describe its front matter, and
its body is the Markdown below it; for a JSON file, its keys. `fields: {}`
declares a collection whose files are only bodies.

**Fields describe; they do not refuse.** The hub shows each file against them:
it fits, it is missing a required field, a value is not one the field allows.
Nothing stops a write that does not fit, because the person and their agents
edit by hand. The CLI can list the files that do not fit, as a finding.

## Considered alternatives

- **A glob.** It finds files but cannot name a new one, and its wildcards carry
  no names to become columns.
- **Several paths per collection** (`['archive/{year}/{stem}.md', 'old/{stem}.md']`).
  Files in two layouts are either two collections or one waiting to be moved.
- **Fields optional.** A collection without them could not draw a table beyond
  file names, which the plain file view already shows.
- **Tables only from read-only actions that return lists.** Browsing would
  require writing an action for every view. Those actions still render as
  tables in the action view.
- **Validating contracts, as the folder sync product had.** A refused write is
  a fight with the person; a view that shows what does not fit lets them repair
  it by hand or ask an agent.
