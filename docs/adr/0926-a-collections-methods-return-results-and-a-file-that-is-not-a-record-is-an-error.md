# 0926. A collection's methods return Results, and a file that is not a record is an error

- **Status:** Proposed
- **Date:** 2026-11-15
- **Amends:** [ADR-0918](0918-a-collection-selects-a-record-by-its-keys-and-a-file-that-is-not-there-reads-as-absent.md): what each method returns, `need`, and a collection with no placeholder; [ADR-0923](0923-a-read-gives-only-what-the-file-holds-and-no-field-has-a-default.md): `problems` on a record, and the rule for a change a function computes; [ADR-0914](0914-action-errors-share-one-contract-and-the-envelope-records-execution.md): one more variant, and what a returned error is on the wire.
- **Unbuilt:** all of it. Every collection method throws, `get` returns a record with `problems`, and `need` is on the branch.

## Context

Reading a record is parsing a file, and a parse has three outcomes: there is
no file, the file is a record, or the file is there and is not one. `get`
gave the third as a record with some fields absent and a `problems` list
beside them. Code reads fields, so it read the absent ones.

Twelve apps were moved to the package, and their code makes 21 single reads:

- 13 handle the file being absent, and 7 throw `Missing` by hand.
- Most never look at `problems`. The first pass added `?? []` and `?? false`
  where a type complained, which treats a malformed list as an empty one.
  One app reads a send attempt with a malformed file as no attempt, which
  can hide a send that was never confirmed.
- A second pass replaced the guards with a check of `problems` at each read,
  and five apps then wrote the same refusal by hand. `need(keys)` was added
  to do it for them. It covers the 7 reads that require the record.

The apps also refuse ordinary requests with `throw new Error(...)`, about
200 times. A caller receives each as `Threw`, the same name a crash gets.

The rest of the monorepo already carries an ordinary failure as a
wellcrafted `Result`. A page receives one from every action it calls. The
collection's methods are the part that throws.

## Decision

**A read returns a `Result`. Its value is the record, or `undefined` when there is no file. Its error is a file that is not a record.**

```ts
const { data: watch, error } = await watches.get({ name });
if (error) return Err(error);      // or show error.problems, or recover
if (!watch) return ActionError.Missing({ path: watches.pathOf({ name }) });
watch.from;                        // string[]
```

| The file | `get` returns |
| --- | --- |
| is not there | `Ok(undefined)` |
| is a record | `Ok(record)`, with every field its type |
| has a value that does not fit, or front matter that cannot be read | `Err(ActionError.Misfit)` |

A record no longer has `problems`. Code cannot read a field of a file that
did not parse, because it does not have one until it has looked at the
error. `need` and `FittingRecordOf` are removed.

**`ActionError.Misfit` carries what a person needs to repair the file.**

Its fields are `path`, `problems` (each with its line number and its words,
as `epicenter check` prints them), and `record`: the keys, the body, and each
field that did fit, absent when the front matter could not be read. A page
draws its repair form from that.

**`list()` returns one `Result` per file.**

`partitionResults` from wellcrafted splits them into the records and the
files that are not records. One bad file does not fail the list, and code
that drops the bad ones has written that it did.

**A write returns a `Result`.**

| Method | Errors |
| --- | --- |
| `add(record)` | `Refused` when a file is already there, or what was given does not fit |
| `set(keys, change)` | `Missing`, `Misfit` when given a function, `Refused` when what was given does not fit, `Changed` |
| `update(keys, fn)` | `Misfit`, `Refused`, `Changed` |
| `delete(keys)` | none; it returns `true` or `false` |

A function given to `set` or `update` is only ever given a record, so a file
that is not one returns `Misfit` before the function runs. Plain data may
still be written to such a file, which is how it is repaired. The function
may return an `Err` of its own to refuse, and the write returns it having
written nothing. The rule that a function may not write a field that did not
fit is removed, with the tracking behind it.

**A collection with no placeholder is one record that is always there.**

A missing `data/settings.md` is that record with nothing in it. `get()`
returns `Ok(record)` whether or not the file exists, and `set` writes the
file. It has no `add`, and none of its fields may be required. The `set`
verb and the `set` method no longer differ there.

**An action's `run` may return a `Result`, and an `Err` is how it declines.**

`Ok(value)` answers with the value. `Err(error)` is carried as a thrown
tagged error is today, so the wire envelope does not change. An
`ActionError` reaches the caller as itself. An error an app defines with
`defineErrors` reaches it as `Refused`, with its name and fields kept, where
a thrown one stays `Threw`. So `Threw` means the action broke, and `Refused`
means it said no.

**App code does not call `unwrap` on these.** It destructures, and the branch
on `error` is where it says what it does about the failure.

## What still throws

- A definition that is wrong: `defineCollection`, `defineAction`, and
  `defineApp` throw when loaded, as they do now. That is a mistake in the
  app's code, found before anything runs.
- A bug. An unexpected throw is not turned into an `Err`.
- `try` with `finally` stays where it owns cleanup. Of about 310 `try`
  blocks in the package, the command, and the apps, about 96 have one.

## Consequences

- One read serves code that computes, code that hands a record to a page,
  and a survey. Before, each had its own: `need`, `get`, and a filter on
  `problems`.
- Every read and write in the 12 apps changes shape, and each gains a branch
  on `error`. That is the same pass that moves their pages to one `set` call.
- A function write is refused when any value in the file does not fit, not
  only the values it writes. A hand-written action over a collection with
  many such files refuses them until they are repaired.
- An app's own refusals become defined errors it returns. This is done one
  app at a time, after the package: Mail has 97 such throws, Flights 59,
  Zhongwen 25.
- `packages/cli/src` is not converted here. Most of its 109 `try` blocks
  guard processes, locks, and sockets.
- Not decided here: whether the `get` and `list` verbs answer a file that is
  not a record as `Misfit` too. Until then they answer as they do now, a
  record with `problems`, built from the error.

## Considered alternatives

- **A `get` that throws on a file that does not fit.** One line for code
  that computes. Code that shows the file to a person then needs a second,
  tolerant read, and the choice between them is made by which name was typed.
- **Keep `need` beside a tolerant `get`.** It protects the 7 reads that
  require the record and leaves the 14 that do not.
- **`unwrap` in each action.** It is the same as throwing, written shorter.
  The branch it hides is the one place the action says what it does about a
  bad file.
- **`Missing` as an error from `get`.** 13 of 21 reads treat an absent file
  as ordinary.
- **Convert every `try` and `throw`.** A wrong definition and a bug are not
  ordinary failures, and cleanup needs `finally`.
- **A separate error family for collections.** ADR-0914 gave producers and
  clients one. `Misfit` joins it.
