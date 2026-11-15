# 0917. A collection selects a record by its keys, and a file that is not there reads as absent

- **Status:** Proposed
- **Date:** 2026-11-15
- **Unbuilt:** all of it. The methods of `defineCollection` in `packages/app/src/collection.ts` still take `{ path }`, a one-file collection still has its own methods and defaults, and `holds` and `other` are still there.

## Context

`defineCollection({ path: 'data/words/{word}.md', fields })` returns a handle
whose methods take a record's path: `words.get({ path })`,
`words.set({ path, ...fields })`. Four parts of that shape cost more than they
give:

- **Code that knows a key converts it to a path first.**
  `words.get({ path: words.pathOf({ word }) })`. The apps under
  `~/Epicenter/apps` call `pathOf` 22 times, nearly all to feed another
  method.
- **`set` and `edit` put two roles in one object.** In `set({ path, meaning })`
  and `edit({ path, old, new })` one object says which record and what to
  change, and the method splits it apart again. `update({ path }, change)`
  already keeps them apart.
- **A path with no placeholder behaves differently.** `data/settings.md` gets
  a `SingleHandle`: no `add`, `delete`, or `list`, a `get()` that returns the
  fields' defaults while there is no file, and a `set` that makes the file.
  `defineCollection` refuses a required field with no default in a one-file
  collection because of it.
- **A file whose front matter cannot be read is treated as all body.** `set`
  refuses it and `edit` writes through it. A file that opens with `---` and
  never closes it reads as body with no problem at all.

## Decision

**A record is one flat thing, and a method's arguments are separated by role.**

A record holds its `path`, its keys, its fields, and its `body` side by side.
`get` returns one and `add` takes one. A method that changes a record takes
two arguments, because which record and what to change are two roles.

A key is a placeholder's value, named as the path names it: for
`data/words/{word}.md` the key is `word`, and for
`data/checks/{name}/{day}.md` the keys are `name` and `day`.

```ts
await words.list();                                   // every record
await words.get({ word });                            // one record, or undefined
await words.add({ word, meaning, body });             // the whole new record
await words.set({ word }, { meaning });               // which record, then the change
await words.set({ word }, (now) => ({ due: next(now) }));
await words.edit({ word }, { old, new });
await words.update({ word }, (now) => ({ meaning }));
await words.delete({ word });
await checks.get(check);                              // a row names its own record
words.pathOf({ word });
```

- `get`, `delete`, and `pathOf` take the keys.
- `set`, `edit`, and `update` take the keys, then the change.
- `add` takes the whole new record, keys included, and fills `{time}` when
  the caller leaves it out, as it does today.
- `list` takes nothing. A caller that wants some of the records filters the
  rows.
- Only the placeholder names are read from the keys, so a row or a record can
  be passed as it is.
- A collection with no placeholder has the same methods without the keys
  argument: `settings.get()`, `settings.add({ theme })`,
  `settings.set({ theme })`.

**Each writer is defined by one condition on the file.**

| Writer | The file must | The change is |
| --- | --- | --- |
| `add(record)` | not exist | a whole record |
| `set(keys, change)` | exist | the fields to change, or a function of the record that returns them |
| `edit(keys, { old, new })` | exist, and hold `old` once in its body | one passage |
| `update(keys, change)` | either | a function of the record, or of `undefined` |

`set` and `edit` throw `ActionError.Missing` themselves when the file is not
there. `update` is the one writer that may make a file.

**A key names its file as `pathOf` does today.**

Every method fills the path with the key as NFC, trimmed, with each run of
whitespace one space, so `"Tokyo "` finds `Tokyo.md` and a new record is
always written under that form. A key that is then empty, holds `/` or `\`,
starts with `.`, or is over 200 bytes is refused. A file a person named
otherwise is still listed, under the name on disk, with a problem line saying
its name is not the one its key makes.

**A file that is not there reads as absent, in every collection.**

| The file | `get` | `add` | `set`, `edit` | `update` | `delete` |
| --- | --- | --- | --- | --- | --- |
| is absent | `undefined` | writes it | throws `ActionError.Missing` | calls `change(undefined)`; what it returns must be a whole record | `false` |
| fits | the record | refuses | writes | writes | `true` |
| has a field that does not fit | the record, with `problems` | refuses | checks only the fields given, and leaves the rest | the same | `true` |
| has front matter that cannot be read | throws `ActionError.Refused` | refuses | throws `ActionError.Refused` | throws `ActionError.Refused` | `true` |

A collection with no placeholder follows the same table: no defaults while
the file is absent, and `set` does not make it. A file that opens with `---`
and has no closing fence counts as front matter that cannot be read. `list`
returns such a file as a row with `problems` and no fields.

**A read gives `path`, each key, each field, `body`, and `problems`. It no longer gives `other`.**

Front matter no field declares is still kept on every write.

**The verbs `actions()` gives take keys in one flat input.**

`get`, `set`, `edit`, and `delete` take each key as an input field,
positional in path order, where they took `path`; `list` and `add` are
unchanged: `epicenter vocab set serendipity --meaning "a lucky find"`. A
collection with no placeholder gives the same six verbs, so
`epicenter vocab settings add` makes the file on a fresh install, and the
command line's refusal of `set` on a missing file names `add`. Rows and
records still carry `path`.

`holds` is removed. A field may still not share a name with a key, because a
record holds both.

## Consequences

- A trial rewrote the collection calls of Vocab, Flights, and Mail against
  these signatures, and all three type-check. Every
  `get({ path: pathOf(...) })` went away. The six writes that used `update`
  and threw `ActionError.Missing` by hand become `set` with a function.
- An app changes the calls that pass `path`. About 59 `add` calls do not
  change.
- `packages/cli/src/bin.ts` supplies its own `@epicenter/app` to every
  `epicenter.ts` it loads, so an app has no version of its own to stay on:
  the apps under `~/Epicenter/apps` change in the same step as installing the
  command that carries this.
- A method and its verb no longer take the same object. The method separates
  the keys from the change; the verb's input is flat because a command line
  is, and it keeps the same split as positional words and flags.
- A change computed by a function, in `set` or `update`, is not checked the
  way plain data is: a `readOnly` field and a reference
  ([ADR-0919](0919-a-field-can-list-values-and-can-refer-to-another-collections-record-by-its-key.md))
  are the app's own to get right there.
- A collection with no placeholder reads as `undefined` before its first
  write: `(await google.get()) ?? {}`.
- A page that routes by a record's path (`#/data/words/<word>.md`) routes by
  its keys, which every row carries. Vocab has two such pages. An action that
  took `path` as input takes the key.
- One call site reads `other`, in Mail, to refuse front matter it does not
  know. It already reads the file's text and checks there.
- A person or agent repairs unreadable front matter with a text editor or
  `folder.update(path, ...)`. The collection's own methods refuse it.

## Considered alternatives

- **`collection.at(keys)`, returning a record with `get`, `set`, and the
  rest.** It separates the keys from the change as this decision does, and
  adds a selector and a record type to do it. It came from a nested design
  where a page had to be selected before its contents could be reached. It
  would also rename `add` to `create` in about 59 places.
- **One flat object, `set({ word, meaning })`.** It keeps a method and its
  verb identical, and leaves a reader to work out which names say which
  record and which say what to change.
- **Use a key exactly as given.** It makes every listed name find its file.
  In the trial it stopped a typed `"Tokyo "` from finding its record at four
  sites and let `update` write an untidy name at two.
- **`list(someKeys)`.** In the trial it replaced a `.filter` that was already
  one line.
- **A `keysOf(path)` helper.** Three sites wanted it. It would make the path a
  second way to name a record.
- **`set` takes plain data only, and `update` covers every computed write.**
  Six of nine computed writes in the trial need the record to exist, and each
  threw by hand and called `pathOf` only to build the error.
- **Keep fewer methods and the old defaults for a collection with no
  placeholder.** `get()` would describe a file that `ls` does not show, and a
  fresh install had no verb that made the file.
- **Nested declarations, `directory({ path, entries })`, bound by `defineApp`
  through an `actions` callback.** A nested declaration has a relative path,
  so it exists before it can act. Helpers in every multi-file app import a
  collection across modules, `routines.set` matches an action by identity,
  and `packages/cli/src/home.ts` calls `defineApp(exported)` again on load.
- **A literal object tree whose keys are path segments.** Call sites then
  spell the layout, so moving a folder changes every caller.
- **Rename `defineCollection` to `markdown`.** With one kind of declared file,
  the name would repeat `.md` in the path the way "collection" repeats
  `{word}`.
