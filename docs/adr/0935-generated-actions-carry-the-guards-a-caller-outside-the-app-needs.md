# 0935. Generated actions carry the guards a caller outside the app needs

- **Status:** Proposed
- **Date:** 2026-11-16
- **Amends:** [ADR-0926](0926-a-collections-methods-return-results-and-a-file-that-is-not-a-record-is-an-error.md) on the generated `get` of a one-file key whose file is absent: it answers `Ok(undefined)`.
- **Unbuilt:** all of it. The generated actions are `collection.actions()` in `packages/app/src/collection.ts`.
- **Relates:** [ADR-0933](0933-an-apps-data-is-top-level-folders-of-markdown-records-and-single-markdown-files.md) (the declaration); [ADR-0934](0934-code-reaches-a-record-by-its-keys-name-and-its-id.md) (the handle these are built over); [ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md) (a call that lost its answer is sent again); [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (a read-only call's writes throw).

## Context

Nine of twelve apps spread a collection's generated actions, so pages and
agents reach most records through them. These callers are outside the app:
they read a record a while ago, may send a value that is no longer there,
may send a field only the app should write, may send a ref to a record that
was never made, and, with serve keeping nothing about calls
([ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md)),
may send the same request again after losing its answer.

Four UIs send the generated `set`'s `was` (reading, tasks, vocab, zhongwen),
and several send `edit`. Two of them repair a record that does not fit:
tasks' `TaskRepair.svelte` and reading's `BookRepair.svelte` build `was` from
the record the `Misfit` carries.

[ADR-0934](0934-code-reaches-a-record-by-its-keys-name-and-its-id.md)'s
handle trusts its caller and has none of these guards.

## Decision

**`data.<key>.actions(...verbs)` generates an action for each verb named, and each adds the guards a caller outside the app needs.**

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
| `set` | `id` (none for a `.md` key), fields, `body?`, `was?`, `edit?` | false | true | true |
| `delete` | `id` (none for a `.md` key) | false | true | true |

- Verbs are always named. There is no default set, so adding a verb is a
  line in `epicenter.ts`, and a key offers nothing it was not given.
- A one-file key offers `get`, `set`, and `delete`. A `.local` key offers no
  actions, so its values never leave this computer through one. Naming a verb
  a key does not offer is a type error, as is naming `add` for a key with a
  required read-only field.
- Every generated action has `openWorldHint: false`. `list` and `get` run
  read-only, so their writes throw.
- Each action is described by the key's `description` and returns the
  handle's Result, except that the generated `get` of an absent record in a
  folder key answers `Missing`, as today, because a page asked for one record
  by its id.

**The guards:**

- **`id`.** `add` requires `id`, as `field.id()`, described from the key's
  `description` ("the name of the new word I'm learning"). Whoever adds a
  record names it. A page that wants records sorted by time sends `timeId()`,
  exported from `@epicenter/app/client`, made once when the person presses
  the button; an agent sends a name.
- **Read-only fields.** `add` and `set` leave them out of their input; only
  the app's own code writes them.
- **`was`.** `set` takes the values the caller last read, by field, with
  `null` for a field that was absent, and returns `Changed` (`was`) when the
  record a read gives holds anything else. For a record that does not fit,
  that is the record its `Misfit` carries, which leaves out the fields that
  do not fit, so `was` cannot guard those; the save writes when the result
  fits, so a repair form guards what it could read.
- **`edit`.** `set` takes `{ old, new }` and replaces the one passage of the
  body equal to `old`, returning `Changed` (`quote`, `twice`, `empty`) as
  today.
- **Refs.** `add` and `set` read the file each sent ref names and return
  `Refused`, naming the field, when there is none. `epicenter check` holds
  refs to the exact bytes of a listed id; the action does not list the folder
  on every write.

**A caller that lost its answer sends the call again.**

- `add`: a repeat that finds the record answers `Changed` (`there`) and
  writes nothing, so every add is safe to send again. When the caller made
  the id with `timeId()`, its earlier attempt made the record, and a `get`
  shows it. When the id is a name, a record by that name exists, which may
  not be the caller's.
- `set` answers `Ok` without checking `was` when the record already holds
  every value sent, so a repeated `set` of fields whose first call landed
  succeeds. A repeated `edit` whose first call landed answers `Changed`
  (`quote`); the caller reads the record again.

The generated actions and the handle share one writer inside the library.
The generated `set` is not built on the handle's `update(id, fn)`, which returns
a record's `Misfit` before calling `fn`; a guarded repair needs the record a
read gives.

An app writes any other action with `defineAction`, its own description, and
a handle. A refusal returns an `Err`, and a throw means a bug.

## Consequences

- A repeated add needs no comparison of content, and an action that changes
  its input before adding (Tasks splitting a title into title and notes) need
  not change it the same way every time.
- An agent that adds a word it already has learns that from `Changed`
  (`there`) instead of making a second file.
- Mail's proposals, the one collection whose generated `add` filled `{time}`,
  are named by the page with `timeId()`; an agent adding one over MCP names it.
- A generated action's input is `id` beside the fields. The generator loses
  the work that laid a template's keys beside the input.
- A ref sent as `Dune` passes the action on a disk that ignores case when
  `dune.md` is there, and `epicenter check` reports it.
- Nine apps keep about 60 actions they would otherwise write by hand.

## Considered alternatives

- **Guards on the handle (`set(id, change, { was })`, `edit(id, { old, new })`).** One write path for every caller, but code in the app carries options only pages send.
- **Generated reads only; every write written by hand.** The platform would own no guard, and each app would restate `was`, `edit`, read-only omission, and id handling in its own actions.
- **A default verb set when none is named.** It needed a rule per verb (`delete` only when named, `add` only without a required read-only field) that a reader had to know.
- **The generated `add` answering `Ok` when the same fields and body are there.** Safe only for actions that add exactly what they were sent, and it decided for the caller what "already there" meant.
- **An optional `id` defaulting to `timeId()`, with an `id` option on a key to require it.** The default served one key (Mail's proposals), about ten keys named by a word, title, or slug would each have declared the option, and a caller that left the id out added twice when it sent the call again.
- **An optional `id` with no way to require it.** An agent adding a word without an id would make a time-named word whose word is stored nowhere.
- **A guarded `set` that needs a record that fits.** Simpler to state, but the tasks and reading repair forms could not guard their saves.
- **Refs checked against the listed ids on every write.** Exact, but it lists the target folder on every guarded write; `epicenter check` already holds refs to that.
- **One `effect: 'read' | 'add' | 'change' | 'delete'` on `defineAction` in place of the four hints.** It rules out contradictions such as read-only and destructive, but the four hints are MCP's own names, which agents already read.
