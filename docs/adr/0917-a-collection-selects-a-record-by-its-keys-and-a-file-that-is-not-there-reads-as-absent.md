# 0917. A collection selects a record by its keys, and a file that is not there reads as absent

- **Status:** Proposed
- **Date:** 2026-11-15
- **Unbuilt:** all of it. `defineCollection` in `packages/app/src/collection.ts` still returns a `ManyHandle` or a `SingleHandle`, addresses a record by `{ path }`, and has `pathOf`, `holds`, `add`, and `other`.

## Context

`defineCollection({ path: 'data/words/{word}.md', fields })` returns a handle
whose methods take a record's path: `words.get({ path })`,
`words.set({ path, ...fields })`. Code that knows a key turns it into a path
first, `words.get({ path: words.pathOf({ word }) })`. The 11 apps under
`~/Epicenter/apps` call `pathOf` 22 times.

Three parts of that shape cost more than they give:

- **`pathOf` rewrites the value and `list` does not.** `pathOf` names the file
  by the value as NFC, trimmed, with each run of whitespace one space. `list`
  returns the name on disk. A file named `a  b.md` lists with the key `a  b`,
  and `pathOf` of that key names `a b.md`, a different file.
- **A path with no placeholder is a second kind of handle.** `data/settings.md`
  gets a `SingleHandle`. Its `get()` returns the fields' defaults while there
  is no file, and its `set` makes the file. A many-file collection does
  neither. `defineCollection` refuses a required field with no default in a
  one-file collection because of it.
- **A file whose front matter cannot be read is treated as all body.** `set`
  refuses it and `edit` writes through it. A file that opens with `---` and
  never closes it reads as body with no problem at all.

## Decision

**`collection.at(keys)` selects records by key. It reads nothing, and it never rewrites a key.**

A key is a placeholder's value, as text. `at` takes any subset of the keys
still open and returns the collection with those keys closed:

```ts
const scripts = defineCollection({ path: 'data/pages/{page}/videos/{video}.md', fields: {} });

scripts.list();                                   // every script
scripts.at({ page: 'tools' }).list();             // this page's scripts
scripts.at({ page: 'tools', video: 'short' });    // one record
scripts.at({ page: 'tools' }).at({ video: 'short' });  // the same record
```

`at` refuses a key that is empty, holds `/` or `\`, starts with `.`, or is over
200 bytes, and accepts every name `list` returns.

**A collection with keys still open has `list()` and `at()`. With none open it is one record.**

A record has `path`, `get`, `create`, `set`, `edit`, `update`, and `delete`. A
path with no placeholder (`data/settings.md`) is a record as declared, so
`settings.get()` needs no `at`. `SingleHandle` and `ManyHandle` become one
type that depends only on which keys are open.

**`create` replaces `add`, and it refuses a name it would not have chosen.**

`record.create({ ...fields, body? })` validates the whole record and writes it.
It refuses when a file is already at the path. It also refuses a key whose
canonical form (NFC, trimmed, each run of whitespace one space) differs from
the key given, and names the canonical form, so a selected record is never
written somewhere other than its `path`.

A collection whose only open key is `{time}` also has `create(input)`: it is
`at({ time })` with the time `add` fills in today, then `create`.

**A file that is not there reads as absent, in every collection.**

| The file | `get` | `create` | `set`, `edit` | `update(change)` | `delete` |
| --- | --- | --- | --- | --- | --- |
| is absent | `undefined` | writes it | throws `ActionError.Missing` | calls `change(undefined)`; what it returns must be a whole record | `false` |
| fits | the record | refuses | writes | writes | `true` |
| has a field that does not fit | the record, with `problems` | refuses | checks only the fields given, and leaves the rest | the same | `true` |
| has front matter that cannot be read | throws `ActionError.Refused` | refuses | throws `ActionError.Refused` | throws `ActionError.Refused` | `true` |

A one-file collection follows the same table: no defaults while the file is
absent, and `set` does not make it. `update` is the one method that may make
or change a file, by the caller's own choice. A file that opens with `---` and
has no closing fence counts as front matter that cannot be read. `list`
returns such a file as a row with `problems` and no fields.

**A read gives `path`, each key, each field, `body`, and `problems`. It no longer gives `other`.**

Front matter no field declares is still kept on every write.

**The verbs `actions()` gives take keys.**

`list`, `get`, `create`, `set`, `edit`, and `delete` take each placeholder as
an input field, positional in path order:
`epicenter writing scripts get tools short`. `create` fills `{time}` when the
caller leaves it out. Rows and records still carry `path`.

`pathOf` and `holds` are removed: `at(keys).path` gives the path, and `at`
refuses what `holds` answered `false` for.

## Consequences

- Every app changes its call sites: 22 `pathOf` calls and about 59 `add`
  calls become `at` and `create`. `packages/cli/src/bin.ts` supplies its own
  `@epicenter/app` to every `epicenter.ts` it loads, so an app has no version
  of its own to stay on: the apps under `~/Epicenter/apps` change in the same
  step as installing the command that carries this.
- The three `.local` one-file collections read as `undefined` before their
  first write: `(await google.get())?.refreshToken`. Their first write is an
  `update`.
- A UI that routes by a record's path (`#/data/tasks/<time>.md`) routes by its
  keys, which every row carries.
- One call site reads `other` today. Undeclared front matter is reported by
  `epicenter check` ([ADR-0920](0920-epicenter-check-reports-every-record-that-does-not-fit-its-collection.md)).
- A person or agent repairs unreadable front matter with a text editor or
  `folder.update(record.path, ...)`. The collection's own methods refuse it.

## Considered alternatives

- **Nested declarations, `directory({ path, entries })`, bound by `defineApp`
  through an `actions` callback.** A nested declaration has a relative path, so
  it exists before it can act. Helpers in every multi-file app import a
  collection across modules (`codex/lib/suggest.ts` imports `drafts` from
  `replies.ts`), `routines.set` matches an action by identity, and
  `packages/cli/src/home.ts` calls `defineApp(exported)` again on load. Each
  would need a factory or a derived type.
- **A literal object tree whose keys are path segments.** It needs no binding
  step. Call sites then spell the layout, so moving a folder changes every
  caller, and reading one kind of file across folders needs a second way to
  walk.
- **Keep `{ path }` and add `at` beside it.** Two ways to name one record.
- **Keep defaults for an absent one-file collection.** `get()` would describe a
  file that `ls` does not show.
- **Rename `defineCollection` to `markdown`.** With one kind of declared file,
  the name would repeat `.md` in the path the way "collection" repeats
  `{word}`.
