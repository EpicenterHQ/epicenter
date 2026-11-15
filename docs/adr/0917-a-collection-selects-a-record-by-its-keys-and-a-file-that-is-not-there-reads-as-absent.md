# 0917. A collection selects a record by its keys, and a file that is not there reads as absent

- **Status:** Proposed
- **Date:** 2026-11-15
- **Unbuilt:** all of it. The methods of `defineCollection` in `packages/app/src/collection.ts` still take `{ path }`, `pathOf` still rewrites its value, and `holds` and `other` are still there.

## Context

`defineCollection({ path: 'data/words/{word}.md', fields })` returns a handle
whose methods take a record's path: `words.get({ path })`,
`words.set({ path, ...fields })`. Code that knows a key turns it into a path
first, `words.get({ path: words.pathOf({ word }) })`. The apps under
`~/Epicenter/apps` call `pathOf` 22 times.

Four parts of that shape cost more than they give:

- **`pathOf` rewrites the value and `list` does not.** `pathOf` names the file
  by the value as NFC, trimmed, with each run of whitespace one space. `list`
  returns the name on disk. A file named `a  b.md` lists with the key `a  b`,
  and `pathOf` of that key names `a b.md`, a different file.
- **`set` and `edit` mix which record with what to change.** In
  `set({ path, meaning })` and `edit({ path, old, new })` one object holds
  both. `update({ path }, change)` already keeps them apart.
- **A path with no placeholder behaves differently.** `data/settings.md` gets
  a `SingleHandle`. Its `get()` returns the fields' defaults while there is no
  file, and its `set` makes the file. A many-file collection does neither.
  `defineCollection` refuses a required field with no default in a one-file
  collection because of it.
- **A file whose front matter cannot be read is treated as all body.** `set`
  refuses it and `edit` writes through it. A file that opens with `---` and
  never closes it reads as body with no problem at all.

## Decision

**Every method names a record by its keys, where it took a path.**

A key is a placeholder's value, named as the path names it: for
`data/words/{word}.md` the key is `word`, and for
`data/checks/{name}/{day}.md` the keys are `name` and `day`.

```ts
await words.get({ word });                          // which record
await words.delete({ word });
await words.set({ word }, { meaning });             // which record, then the change
await words.edit({ word }, { old, new });
await words.update({ word }, (now) => ({ meaning }));
await words.add({ word, meaning, body });           // the whole new record
await words.list();                                 // every record
await checks.list({ name });                        // the records with this key
words.pathOf({ word });                             // its path
```

- A method that reads or removes a record takes its keys.
- A method that changes a record takes its keys, then the change.
- `add` takes the whole new record, keys included, and fills `{time}` when
  the caller leaves it out, as it does today.
- `list` takes any subset of the keys and returns the records that have them.
- A collection with no placeholder has no keys to give, so its methods take
  only the change: `settings.get()`, `settings.set({ theme })`.

**A key is used exactly as given.**

`get`, `set`, `edit`, `update`, `delete`, and `pathOf` never rewrite a key, so
every name `list` returns finds its file. They refuse a key that is empty,
holds `/` or `\`, starts with `.`, or is over 200 bytes. `add` also refuses a
key whose canonical form (NFC, trimmed, each run of whitespace one space)
differs from the key given, and names the canonical form, so a new record is
never written under a name the caller did not give.

**A file that is not there reads as absent, in every collection.**

| The file | `get` | `add` | `set`, `edit` | `update(keys, change)` | `delete` |
| --- | --- | --- | --- | --- | --- |
| is absent | `undefined` | writes it | throws `ActionError.Missing` | calls `change(undefined)`; what it returns must be a whole record | `false` |
| fits | the record | refuses | writes | writes | `true` |
| has a field that does not fit | the record, with `problems` | refuses | checks only the fields given, and leaves the rest | the same | `true` |
| has front matter that cannot be read | throws `ActionError.Refused` | refuses | throws `ActionError.Refused` | throws `ActionError.Refused` | `true` |

A one-file collection follows the same table: no defaults while the file is
absent, and `set` does not make it. `SingleHandle` and `ManyHandle` remain as
two signatures and no longer differ in behavior. `update` is the one method
that may make or change a file, by the caller's own choice. A file that opens
with `---` and has no closing fence counts as front matter that cannot be
read. `list` returns such a file as a row with `problems` and no fields.

**A read gives `path`, each key, each field, `body`, and `problems`. It no longer gives `other`.**

Front matter no field declares is still kept on every write.

**The verbs `actions()` gives take keys in one flat input.**

`get`, `set`, `edit`, and `delete` take each key as an input field,
positional in path order, where they took `path`; `list` takes them as
optional flags; `add` is unchanged:
`epicenter vocab set serendipity --meaning "a lucky find"`. Rows and records
still carry `path`.

`holds` is removed. A field may still not share a name with a key, because a
row holds both.

## Consequences

- An app changes the calls that pass `path`: 22 `pathOf` calls disappear into
  the method that used them, and `set` and `edit` calls gain a first
  argument. About 59 `add` calls do not change.
- `packages/cli/src/bin.ts` supplies its own `@epicenter/app` to every
  `epicenter.ts` it loads, so an app has no version of its own to stay on:
  the apps under `~/Epicenter/apps` change in the same step as installing the
  command that carries this.
- A method and its verb no longer take the same object: the method separates
  the keys from the change, and the verb's input is flat because a command
  line and a JSON call are.
- The three `.local` one-file collections read as `undefined` before their
  first write: `(await google.get())?.refreshToken`. Their first write is an
  `update`.
- A UI that routes by a record's path (`#/data/tasks/<time>.md`) routes by its
  keys, which every row carries.
- One call site reads `other` today. Undeclared front matter is reported by
  `epicenter check` ([ADR-0920](0920-epicenter-check-reports-every-record-that-does-not-fit-its-collection.md)).
- A person or agent repairs unreadable front matter with a text editor or
  `folder.update(path, ...)`. The collection's own methods refuse it.

## Considered alternatives

- **`collection.at(keys)`, returning a record with `get`, `set`, and the
  rest.** It separates the keys from the change as this decision does, and
  adds a selector and a record type to do it. It came from a nested design
  where a page had to be selected before its contents could be reached; in a
  flat collection it has no other job. It would also rename `add` to `create`
  in about 59 places.
- **One flat object, `set({ word, meaning })`.** It keeps a method and its
  verb identical. It leaves a reader to work out which names say which record
  and which say what to change.
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
- **Keep defaults for an absent one-file collection.** `get()` would describe a
  file that `ls` does not show.
- **Rename `defineCollection` to `markdown`.** With one kind of declared file,
  the name would repeat `.md` in the path the way "collection" repeats
  `{word}`.
