# 0935. A key's generated actions are its handle's verbs, named by the app

- **Status:** Proposed
- **Date:** 2026-11-16
- **Amends:** [ADR-0926](0926-a-collections-methods-return-results-and-a-file-that-is-not-a-record-is-an-error.md) on the generated `get` of a one-file key whose file is absent: it answers `Ok(undefined)`.
- **Unbuilt:** all of it. The generated actions are `collection.actions()` in `packages/app/src/collection.ts`.
- **Relates:** [ADR-0933](0933-an-apps-data-is-top-level-folders-of-markdown-records-and-single-markdown-files.md) (the declaration); [ADR-0934](0934-code-reaches-a-record-by-its-keys-name-and-its-id.md) (the handle these are built from); [ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md) (a caller whose answer was lost reads the record); [ADR-0936](0936-serve-runs-every-action-while-it-is-running.md) (one writer).

## Context

Nine of twelve apps spread a collection's generated actions, so pages and
agents reach most records through them. Today those actions also guard: the
generated `set` takes `was` and refuses when a field changed since the page
read it, every write reads the record each ref names and refuses one that
names nothing, and `edit` refuses an empty passage.

Epicenter presumes one person, one writer, and one implementer
([ADR-0936](0936-serve-runs-every-action-while-it-is-running.md)). A field
written twice in a minute by that person is last write wins, and Git history
keeps every version. A ref that names nothing is reported by
`epicenter check`, which reads every record anyway.

## Decision

**`data.<key>.actions(...verbs)` turns each named verb of the key's handle into an action.**

```ts
// code/epicenter.ts
import { defineApp } from '@epicenter/app';
import { data } from './data';

export default defineApp({
	data,
	actions: {
		...data.words.actions('list', 'get', 'add', 'set'),
		...data['settings.md'].actions('get', 'set'),
		practice,
	},
});
```

| Verb | Input | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| --- | --- | --- | --- | --- |
| `list` | none | true | | |
| `get` | `id` (none for a `.md` key) | true | | |
| `add` | `id`, the fields, `body?` | false | false | true |
| `set` | `id` (none for a `.md` key), fields, `body?`, `edit?` | false | true | true |
| `delete` | `id` (none for a `.md` key) | false | true | true |

- Verbs are always named. There is no default set, so adding a verb is a
  line in `epicenter.ts`, and a key offers nothing it was not given.
- A one-file key offers `get`, `set`, and `delete`. A `.local` key offers no
  actions, so its values never leave this computer through one. Naming a verb
  a key does not offer is a type error.
- Every generated action has `openWorldHint: false`.
- Each action is described by the key's `description` and returns the
  handle's Result, except that the generated `get` of an absent record in a
  folder key answers `Missing`, as today, because a page asked for one record
  by its id.

**What an action adds to its verb is its input:**

- **`id`.** `add` requires `id`, as `field.id()`, described from the key's
  `description` ("the name of the new word I'm learning"). Whoever adds a
  record names it: a page that wants records sorted by time sends
  `timeId()`, exported from `@epicenter/app/client`; an agent sends a name.
  When a file is already there, `add` answers `Changed` (`there`), because
  that is what creating means.
- **`edit`.** `set` takes `{ old, new }`, with `old` not empty, and replaces
  the one passage of the body equal to `old`: `Changed` (`quote`) when no
  passage is, `Changed` (`twice`) when more than one is. It is the handle's
  `update`, so it needs a record that fits.

Everything else is the handle: every declared field is in `add`'s and
`set`'s input, fields are last write wins, a ref is written
as given, and a `set` of fields repairs a record that does not fit when the
result fits. A caller whose answer was lost reads the record
([ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md)).

An app writes any other action with `defineAction`, its own description, and
a handle. A refusal returns an `Err`, and a throw means a bug.

## Consequences

- The generated actions use only the public handle: `set` with fields is the
  handle's `set`, and `set` with `edit` is the handle's `update`.
- The four UIs that build `was` (reading, tasks, vocab, zhongwen) drop it,
  and the tasks and reading repair forms send only the fields. `Changed`
  (`was`), `Changed` (`empty`), and the field name `was` go with
  `defineCollection`.
- `readOnly` goes with `defineCollection`, and `defineData` refuses it. A
  key whose records only the app writes (flights' checks, finance's
  imports) offers `list` and `get` and no write verb. A value the app can
  derive (mail's `status`, from its lines) is derived where it is read. A
  value the app computes but a person may change (vocab's and zhongwen's
  review schedule) is a field anyone can set: an agent that sets `due`
  reschedules a word.
- An action that changes its input before adding (Tasks splitting a title
  into title and notes) need not change it the same way every time.
- An agent that adds a word it already has learns that from `Changed`
  (`there`) instead of making a second file.
- Mail's proposals, the one collection whose generated `add` filled `{time}`,
  are named by the page with `timeId()`; an agent adding one over MCP names it.
- A ref an agent mistypes is written, and `epicenter check` reports it.
- Nine apps keep about 60 actions they would otherwise write by hand.

## Considered alternatives

- **`was` on the generated `set`.** It refused a save when a field had changed since the page read it. It cost a guard, a repair contract evaluated against a misfit's partial record, a writer shared behind the handle, and a rule for a repeated `set` whose first call landed, to protect a field one person wrote twice.
- **Generated writes refusing a ref that names nothing.** Every write read the files its refs named; `epicenter check` already reports each such ref, and the handle opens no other file.
- **`Changed` (`empty`) for an empty `old`.** An empty passage is a malformed input, not a change to the file, so the input schema refuses it before the action runs.
- **`readOnly` fields left out of the generated `add` and `set`.** It kept an agent from setting a field the app computes. Of its 23 uses, 9 sat on keys that offer no write verb, mail's `status` is derivable from the record's lines, finance's checksums guarded half of their invariant, and the review schedule is a value the one person may want to set. Choosing which verbs a key offers already decides who writes it.
- **Guards on the handle (`set(id, change, { was })`, `edit(id, { old, new })`).** One write path for every caller, but code in the app carries options only pages send.
- **Generated reads only; every write written by hand.** Each app would restate `edit` and id handling in its own actions.
- **A default verb set when none is named.** It needed a rule per verb (`delete` only when named, `add` only for keys whose records a caller names) that a reader had to know.
- **The generated `add` answering `Ok` when the same fields and body are there.** It decided for the caller what "already there" meant; Messages' outbox would have sent a claimed message twice.
- **An optional `id` defaulting to `timeId()`, with an `id` option on a key to require it.** The default served one key (Mail's proposals), about ten keys named by a word, title, or slug would each have declared the option, and a caller that left the id out added twice when it sent the call again.
- **One `effect: 'read' | 'add' | 'change' | 'delete'` on `defineAction` in place of the four hints.** It rules out contradictions such as read-only and destructive, but the four hints are MCP's own names, which agents already read.
