# 0934. Code reaches a record by its key's name and its id

- **Status:** Accepted
- **Date:** 2026-11-16
- **Amends:** [ADR-0926](0926-a-collections-methods-return-results-and-a-file-that-is-not-a-record-is-an-error.md) on two answers: a file already there when adding is `Changed` (`there`), not `Refused`, and an absent one-file key reads as `Ok(undefined)`, not as an empty record.
- **Relates:** [ADR-0933](0933-an-apps-data-is-top-level-folders-of-markdown-records-and-single-markdown-files.md) (the declaration); [ADR-0935](0935-a-keys-generated-actions-are-its-handles-verbs-named-by-the-app.md) (what a caller outside the app gets); [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (no app lock; `folder.update`); [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one writer).

## Context

A collection's methods take the values of its template's placeholders:
`watches.get({ name })`, `checks.get({ name, day })`, `notes.add({ body, kind })`
with `{time}` filled in, and `watches.pathOf({ name })`. A collection with no
placeholder has methods without keys and no `add`.

A collection also guards: every `add` and `set` reads the record each ref
names and refuses one that names nothing, and the generated `set` refuses a
stale value (`was`). Epicenter presumes one person, one writer, and one
implementer ([ADR-0936](0936-one-serve-per-home-runs-every-action.md)),
and `epicenter check` reports a ref that names nothing.

Under [ADR-0933](0933-an-apps-data-is-top-level-folders-of-markdown-records-and-single-markdown-files.md)
every record is named by one id.

## Decision

**`data.<key>` is a handle that reads and writes its key's files and trusts its caller.**

```ts
await data.watches.get('sfo-nyc');                       // Ok(record), Ok(undefined) when absent, Misfit, Refused
await data.notes.list();                                 // one Result per record, sorted by path
await data.notes.add(timeId(), { kind: 'quote', body }); // creates; Changed (there) when a file is there
await data.checks.set(id, { day });                      // Missing when absent
await data.checks.update(id, (check) => Ok({ ...check, day: next(check?.day) }));  // check is undefined when absent
await data.notes.delete(id);                             // Ok(true) when it existed
data.watches.pathOf('sfo-nyc');                          // 'data/watches/sfo-nyc.md'; checks neither the id nor the disk

await data['settings.md'].get();                         // Ok(undefined) before the file exists
await data['settings.md'].set({ level: 'HSK 3' });       // creates the file when the result fits
```

| Today | After |
| --- | --- |
| `c.get({ name })` | `data.c.get(id)` |
| `c.add({ name, ...fields, body })` | `data.c.add(id, { ...fields, body })` |
| `c.add({ ...fields })` with `{time}` | `data.c.add(timeId(), { ...fields })` |
| `c.set(keys, change)`, `c.update(keys, fn)`, `c.delete(keys)` | the same with `id` |
| `c.set(keys, fn)` | `data.c.update(id, fn)` |
| `c.pathOf(keys)` | `data.c.pathOf(id)` |
| a no-placeholder collection's `get()`, `set(change)`, `update(fn)`, `delete()` | `data['x.md']`'s; it has no `list` or `add` |

- A record is `{ path, id, ...fields, body }`. A one-file key's record has no
  `id`.
- An id that breaks ADR-0933's rule makes a method that reads or writes
  return `Refused`; no method throws for one. `pathOf` only joins strings.
- An absent file reads as `Ok(undefined)` for both kinds of key.
- `add(id, record)` creates a file and never replaces one. Inside one
  `folder.edit`, it finds no file there, including one whose name differs
  only in case on a disk that ignores case, and writes. A caller that finds a
  file there gets `Changed` with `why: 'there'`, and decides what that means.
  `timeId()` makes an id that sorts by time and ends in random
  characters (`2026-11-16T09-12-04-120Z-k3x9a2f8`), so two callers never make
  the same one.
- `set` changes a record that is there. For a folder key, an absent record is
  `Missing`, because the id may be mistyped. For a one-file key, `set` creates
  the file when the result fits: there is no id to mistype, and pages call
  `set` on settings that were never written.
- `set` takes an object and applies it to the record a read gives, so it
  repairs a record that does not fit when the result fits. `update` takes a
  function of the current record, `undefined` when absent, that returns a
  Result; it needs a record that fits and returns its `Misfit` before calling
  the function. Each verb takes one kind of change.
- The handle writes every declared field and opens no other file: a ref is written as given. Code in the app is the author of
  its own data; [ADR-0935](0935-a-keys-generated-actions-are-its-handles-verbs-named-by-the-app.md)
  turns its verbs into actions for callers outside it.
- Every write goes through `folder.edit`, which reads the file, decides, and
  writes. The handle takes no lock and promises nothing about another writer
  changing the same file at the same moment: Epicenter presumes one
  ([ADR-0936](0936-one-serve-per-home-runs-every-action.md)).
- Failures are the four `ActionError` variants: `Missing`, `Misfit`,
  `Changed`, `Refused`. `Changed` gains `why: 'there'`.

## Consequences

- `delete` reads the file and then deletes it; it answers whether the file
  was there.
- The handle has no `was`, no `edit`, and no ref checks. Today app code gets
  ref checks on `add` and `set` (vocab's and zhongwen's
  `conversations.add({ words })`); after this, a ref is written as given and
  `epicenter check` reports one that names nothing.
- An agent that adds a word it already has gets `Changed` (`there`) and
  can read the record, instead of learning nothing or making a second file.
- The one `set` with a function in the apps (`codex/code/lib/replies.ts`)
  becomes `update`; the thirteen `update` calls stay.
- A page that reads a one-file key before it is written gets `undefined`
  where it got an empty record, and shows its own default, as zhongwen's
  pinyin switch already does with `?? false`.
- A call's `folder` stays underneath every method, so the handle writes only
  under `data/`. Nothing else refuses a write: an action's `readOnlyHint` is a
  hint, and no call is read-only
  ([ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md)).
- The single-file handle and the folder handle keep their two shapes; the type
  that chose between them by counting placeholders now reads whether the key
  ends in `.md`.

## Considered alternatives

- **`add` answering `Ok` when the same content is there.** It made a repeated add look like success without the caller doing anything, but only the caller knows whether "already there" means its own earlier attempt or a record someone else made by that name.
- **"Already there" as `Refused`.** A caller could not tell it from any other refusal without reading the message, and a typed `why` on `Refused` would change every refusal's shape.
- **A `Folder.create` that links a finished temporary file to its name.** It made an add safe against a second writer; Epicenter presumes one.
- **`set(id, fn)` beside `update(id, fn)`.** Two verbs computed a record from the current one, differing only in what an absent record meant; one app called the first, once.
- **`was` and `edit` on the handle.** Code in the app never sends a stale value, so every caller would carry options only pages use.
- **`add` creating a one-file key, `set` requiring it.** The same rule for both kinds, but it adds an `add` no app calls and breaks the settings pages that call `set` first.
- **`add` refusing a name that folds to a listed one.** It would list the folder on every add and still miss files written without the handle; `epicenter check` reports the pair.
- **The handle's `add(record)` making a time id when none is given.** A rule the reader cannot see in code; `add(timeId(), record)` says it.
- **`data.at(id).get()`, a record handle.** One more call per use; the methods already take the record's name first.
- **A standalone `defineCollection('notes', { fields })` per collection.** Refs by name could not be checked in one place, and a collection would learn its folder only when registered.
