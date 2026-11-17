# 0934. Code reaches a record by its key's name and its id

- **Status:** Proposed
- **Date:** 2026-11-16
- **Amends:** [ADR-0926](0926-a-collections-methods-return-results-and-a-file-that-is-not-a-record-is-an-error.md) on two answers: a file already there when adding is `Changed` (`there`), not `Refused`, and an absent one-file key reads as `Ok(undefined)`, not as an empty record.
- **Unbuilt:** all of it. No runtime has `defineData`, and `Folder` has no `create`.
- **Relates:** [ADR-0933](0933-an-apps-data-is-top-level-folders-of-markdown-records-and-single-markdown-files.md) (the declaration); [ADR-0935](0935-generated-actions-carry-the-guards-a-caller-outside-the-app-needs.md) (what a caller outside the app gets); [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (no app lock; `folder.update`).

## Context

A collection's methods take the values of its template's placeholders:
`watches.get({ name })`, `checks.get({ name, day })`, `notes.add({ body, kind })`
with `{time}` filled in, and `watches.pathOf({ name })`. A collection with no
placeholder has methods without keys and no `add`.

The same methods serve two kinds of caller. Code in the app read the file a
moment ago and means what it writes. A page or an agent read it minutes ago,
may send a stale value, and may send the same request twice after losing an
answer. Today the guards for the second kind sit partly in the generated
actions (`was`, `edit`, read-only fields) and partly in the collection (ref
checks on every `add` and `set`), so code in the app pays for callers it is
not.

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
data.watches.pathOf('sfo-nyc');                          // 'data/watches/sfo-nyc.md', no disk access

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
- An id that breaks ADR-0933's rule makes the method return `Refused`; no
  method throws for one.
- An absent file reads as `Ok(undefined)` for both kinds of key.
- `add(id, record)` creates a file and never replaces one. It creates the
  file in one step that fails when a file is there, including one whose name
  differs only in case on a disk that ignores case, so two writers, in one
  process or two, cannot both create it. The one that finds a file there gets
  `Changed` with `why: 'there'`, and decides what that means. `Folder` gains
  `create(path, text)` for this; on disk it links a finished temporary file
  to its name. `timeId()` makes an id that sorts by time and ends in random
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
- The handle writes every declared field, read-only ones included, and opens
  no other file: a ref is written as given. Code in the app is the author of
  its own data; [ADR-0935](0935-generated-actions-carry-the-guards-a-caller-outside-the-app-needs.md)
  adds the guards a caller outside it needs.
- `set`, `update`, and `delete` go through `folder.update`, so a change made
  between the read and the write runs the change again on what is there now.
  With no app lock ([ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md)),
  this is what keeps two calls from losing each other's writes to one record.
  `folder.update` holds a lock on the one file while it compares and replaces
  it, so this holds across processes; until that is built, the app lock still
  covers calls.
- Failures are the four `ActionError` variants: `Missing`, `Misfit`,
  `Changed`, `Refused`. `Changed` gains `why: 'there'`. A `.local` record's
  `Misfit` carries no values.

## Consequences

- The handle has no `was`, no `edit`, and no ref checks. Today app code gets
  ref checks on `add` and `set` (vocab's and zhongwen's
  `conversations.add({ words })`); after this, an action that takes refs from
  outside checks them, as vocab's `start` already does by hand, and
  `epicenter check` reports any that slip through.
- A claim works without a second read. Messages' outbox claims a message id
  with `add` before sending (`messages/code/lib/device-sync.ts`), and a replay
  of the same message, from any process, gets `Changed` (`there`) and does not
  send twice.
- The one `set` with a function in the apps (`codex/code/lib/replies.ts`)
  becomes `update`; the thirteen `update` calls stay.
- A page that reads a one-file key before it is written gets `undefined`
  where it got an empty record, and shows its own default, as zhongwen's
  pinyin switch already does with `?? false`.
- A call's `folder` stays underneath every method: writes only under `data/`,
  and a read-only call's writes throw except on a `.local` path.
- The single-file handle and the folder handle keep their two shapes; the type
  that chose between them by counting placeholders now reads whether the key
  ends in `.md`.

## Considered alternatives

- **`add` answering `Ok` when the same content is there.** It made a repeated add look like success without the caller doing anything, but only the caller knows whether "already there" means its own earlier attempt or someone else's claim. Messages' replay would have answered `Ok` and sent twice.
- **"Already there" as `Refused`.** A caller could not tell it from any other refusal without reading the message, and a typed `why` on `Refused` would change every refusal's shape.
- **`add` as `folder.update` refusing a file that is there.** Safe within one process; two processes could both find the name free and both write.
- **`set(id, fn)` beside `update(id, fn)`.** Two verbs computed a record from the current one, differing only in what an absent record meant; one app called the first, once.
- **`was` and `edit` on the handle.** Code in the app never sends a stale value, so every caller would carry options only pages use.
- **`add` creating a one-file key, `set` requiring it.** The same rule for both kinds, but it adds an `add` no app calls and breaks the settings pages that call `set` first.
- **`add` refusing a name that folds to a listed one.** It would list the folder on every add and still miss files written without the handle; `epicenter check` reports the pair.
- **The handle's `add(record)` making a time id when none is given.** A rule the reader cannot see in code; `add(timeId(), record)` says it.
- **`data.at(id).get()`, a record handle.** One more call per use; the methods already take the record's name first.
- **A standalone `defineCollection('notes', { fields })` per collection.** Refs by name could not be checked in one place, and a collection would learn its folder only when registered.
