# 0918. A collection selects a record by its keys, and a file that is not there reads as absent

- **Status:** Accepted (2026-11-16)
- **Date:** 2026-11-15
- **Amended by:** [ADR-0926](0926-a-collections-methods-return-results-and-a-file-that-is-not-a-record-is-an-error.md) on Result-returning methods and misfit reads.

## Context

`defineCollection({ path: 'data/words/{word}.md', fields })` returned a handle
whose methods took a record's path: `words.get({ path })`,
`words.set({ path, ...fields })`. Four parts of that shape cost more than they
gave:

- **Code that knows a key converted it to a path first.**
  `words.get({ path: words.pathOf({ word }) })`. The apps under
  `~/Epicenter/apps` called `pathOf` 22 times, nearly all to feed another
  method.
- **`set` and `edit` put two roles in one object.** In `set({ path, meaning })`
  one object said which record and what to change, and the method split it
  apart again. `update({ path }, change)` already kept them apart.
- **A path with no placeholder behaved differently.** `data/settings.md` got a
  second handle type: no `add`, `delete`, or `list`, a `get()` that returned
  defaults while there was no file, and a `set` that made the file.
- **A file whose front matter could not be read was treated as all body.**
  `set` refused it and `edit` wrote through it.

The generated verbs were also defined as the methods themselves: "each taking
the same object". A page, the command line, and an agent need things code
does not: plain data only, a guard against a stale save, and less on the
wire.

## Decision

**A record is one flat thing, and a method's arguments are separated by role.**

A record holds its `path`, its keys, its fields, and its `body` side by side.
`get` returns one and `add` takes one. A method that changes a record takes
which record first, then the change.

A key is a placeholder's value, named as the path names it: for
`data/words/{word}.md` the key is `word`, and for
`data/checks/{name}/{day}.md` the keys are `name` and `day`. A path may not
use `{was}` or `{edit}` as a placeholder, and no field may have those names:
the `set` verb takes them beside the keys and fields.

**The methods are a small core for code.**

```ts
await words.list();                                       // every record, whole
await words.get({ word });                                // one record, or undefined
await words.need({ word });                               // one record that fits, or it throws
await words.add({ word, meaning, body });                 // the whole new record
await words.set({ word }, { meaning });                   // fields, the body, or both
await words.set({ word }, (now) => ({ body: now.body + line }));
await words.update({ word }, (now) => ({ meaning }));     // may make the file
await words.delete({ word });
await checks.get(check);                                  // a record names itself
words.pathOf({ word });
```

| Writer | The file must | The change is |
| --- | --- | --- |
| `add(record)` | not exist | a whole record |
| `set(keys, change)` | exist | fields and `body`, or a function of the record that returns them |
| `update(keys, change)` | either | a function of the record, or of `undefined` |

- `set` throws `ActionError.Missing` itself. `update` is the one writer that
  may make a file. `null` for a field a file may go without leaves it out of
  a file being made, as it removes it from one that is there.
- `list` takes nothing and returns what `get` returns.
- `get` and `list` are the reads for code that hands a record on: they
  return a record whose values do not all fit, with `problems`. `need` is the
  read for code that computes from the record. It throws
  `ActionError.Missing` when there is no file and `ActionError.Refused`,
  listing the problems, when a value does not fit, and what it returns has
  every field in full. Five of the twelve apps had written that by hand.
- Only the placeholder names are read from the keys, so a record can be
  passed as it is.
- A collection with no placeholder has the same methods without the keys
  argument: `settings.get()`, `settings.add({ theme })`,
  `settings.set({ theme })`.

**The verbs `actions()` gives are ready-made actions built on those methods.**

| Verb | Input | Differs from the method |
| --- | --- | --- |
| `list` | none | its rows leave out `body` |
| `get` | the keys | throws `Missing` where the method answers `undefined` |
| `add` | the record | no |
| `set` | the keys, fields, and optionally `was` and `edit` | no `body` and no function; it names what it last saw instead |
| `delete` | the keys | given only when the app names it: `actions('delete')` |

An app may take some verbs, or replace any with an action of its own.

**The `set` verb is the `set` method for a caller that cannot send a function, so it sends what it last saw.**

```sh
epicenter vocab set '{"word":"serendipity","meaning":"a lucky find","was":{"meaning":"luck"},"edit":{"old":"first draft","new":"second draft"}}'
```

- `was` names the values of fields the caller last saw, `null` for one that
  was absent.
- `edit` is `{ old, new }`: the passage of the body the caller last saw, and
  the text to put in its place. `old` is in the body exactly once, or is the
  whole body, or is empty for an empty body.
- Every guard is checked before anything is written. When one does not hold,
  the call is refused with `ActionError.Changed` and nothing is written, not
  the fields and not the body.
- A write changes only the lines it names, so two callers changing different
  fields both land with no guard.

There is no `edit` verb. It was one until twelve apps were moved: three of
them save a record's fields and notes together, and did it as `set` then
`edit`, two writes, with words on the page for when the second was refused
after the first had landed.

For a collection with no placeholder, the `set` verb makes the file when
there is none, as `add` would. An `edit` needs a file to be in, so with none
it is refused as `Missing`. The `set` method still refuses, so code that
refreshes a sign-in cannot bring back a file a person deleted.

**A key finds its file by its exact name first.**

`get`, `set`, `delete`, and an `update` of a file that is there try the key
as given, then as `pathOf` tidies it: NFC, trimmed, each run of whitespace
one space. So `"Tokyo "` finds `Tokyo.md`, and a row for `Dune  Messiah.md`
finds that file. `add` and an `update` that makes a file always use the tidy
name. A key that is empty, holds `/` or `\`, starts with `.`, or is over 200
bytes is refused.

**A file that is not there reads as absent, in every collection.**

| The file | `get` | `add` | `set` | `update` | `delete` |
| --- | --- | --- | --- | --- | --- |
| is absent | `undefined` | writes it | throws `Missing` | calls `change(undefined)`; the result must be a whole record | `false` |
| fits | the record | refuses | writes | writes | `true` |
| has a field that does not fit | the record, with `problems` | refuses | checks only what it is given | the same | `true` |
| has front matter that cannot be read | throws `ActionError.Refused` | refuses | throws `Refused` | throws `Refused` | `true` |

A file that opens with `---` and has no closing fence counts as front matter
that cannot be read. `list` returns such a file with `problems` and no
fields.

**A read gives `path`, each key, each field, `body`, and `problems`.**

`other` and `holds` are removed. Front matter no field declares is kept on
every write, and nothing reports it. A field may not share a name with a
key, because a record holds both.

## Consequences

- A trial rewrote the collection calls of Vocab, Flights, and Mail against
  key selection, and all three type-check. Every
  `get({ path: pathOf(...) })` went away. The six writes that used `update`
  and threw `Missing` by hand become `set` with a function.
- `packages/cli/src/bin.ts` supplies its own `@epicenter/app` to every
  `epicenter.ts` it loads, so the apps under `~/Epicenter/apps` change in the
  same step as installing the command that carries this.
- A method and its verb no longer take the same object. The rule that they
  do is given up: the methods serve code, and the verbs serve callers that
  can send only plain data.
- The hand-written "replace the body" actions in Tasks, Reading, and Capture
  become `set` with `edit`, the whole body as `old`. Vocab's `amend`, which
  checked each field's old value by hand, becomes `set` with `was` and
  `edit` in one call.
- The `set` verb is not marked idempotent: when `edit.new` holds `edit.old`,
  a second call replaces again.
- A change computed by a function is not checked the way plain data is: a
  `readOnly` field and a reference
  ([ADR-0920](0920-a-field-can-list-values-and-can-refer-to-another-collections-record-by-its-key.md))
  are the app's own to get right there.
- A page that routes by a record's path routes by its keys. An action that
  took `path` as input takes the key.
- A person or agent repairs unreadable front matter with a text editor or
  `folder.update(path, ...)`.

## Considered alternatives

- **A version on every record, sent back with a save.** Two of three
  reviewers ended here. It refuses a save when anything in the file changed,
  including a field the caller did not touch, and it puts a value on every
  read. The owner chose the change that names what it replaces.
- **`set` as a verb takes `body`.** A blind replacement of a person's text
  from a stale page.
- **A separate `edit` verb.** Built, then removed: a page could not save
  fields and a passage in one write.
- **`old` and `new` beside the fields, not inside `edit`.** JSON Schema
  cannot say that two keys come together, so a caller would learn it from a
  refusal.
- **`body` under `was`, with `body` as its replacement.** One guard word. A
  caller that sent a whole new body against one quoted passage would
  duplicate the rest.
- **Always-there records for a collection with no placeholder.** It would
  remove the difference between the `set` verb and the `set` method there.
  That difference is what stops code that refreshes a sign-in from bringing
  back a file a person deleted.
- **`collection.at(keys)`, returning a record with `get`, `set`, and the
  rest.** It adds a selector and a record type to separate the keys from the
  change, and would rename `add` in about 59 places.
- **One flat object, `set({ word, meaning })`.** A reader must work out which
  names say which record.
- **Use a key exactly as given, with no tidy form.** In the trial it stopped
  a typed `"Tokyo "` from finding its record at four sites.
- **Always tidy the key.** A file a person named with two spaces was listed
  and could not be reached by its own row.
- **`list(someKeys)` and `keysOf(path)`.** The first replaced a one-line
  `.filter`; three sites wanted the second.
- **`set` makes a missing file in code too.** A token refresh written as
  `set` would undo a sign-out.
- **Nested declarations bound by `defineApp` through an `actions` callback,
  or a literal tree of path segments.** A nested declaration exists before it
  can act, and a tree makes every caller spell the layout.
- **Rename `defineCollection` to `markdown`.** With one kind of declared
  file, the name would repeat `.md` in the path.
