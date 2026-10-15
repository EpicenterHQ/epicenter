# @epicenter/svelte

Svelte utilities for synchronizing state with external systems.

## Overview

This package adapts opened Epicenter data and agent conversations into Svelte reactivity, and holds the shared sync review UI.

## Installation

This package is part of the Epicenter monorepo and is used internally. To use it in your app:

```json
{
  "dependencies": {
    "@epicenter/svelte": "workspace:*"
  }
}
```

## Available utilities

### `SyncReview` (`@epicenter/svelte/sync-review`)

The modal review for one `folder.sync` attempt that needs choices
(ADR-0514, ADR-0516). It shows each conflicting setting, field, body, or
whole file with each side's version and a result, and holds that attempt's
`SyncChoices` only while it is shown. `Use this` takes that side's version:
for a body or a text file, the line merge with that side winning where both
changed the same lines, so the other side's other lines stay (ADR-0551).
`Use all from` takes one side for every part; typing replaces, as text for
text values and as JSON, once it parses, for any other value; a file that is
not text is taken or left out, never typed; `Leave out` removes. Apply calls `onApply(attempt, choices)` only when
every conflict has a choice. Cancel calls `onCancel`, which discards the
attempt; nothing is lost by not syncing.

```svelte
{#if attempt}
	{#key attempt.id}
		<SyncReview
			{attempt}
			pending={apply.isPending}
			problems={apply.error?.name === 'InvalidChoices' ? apply.error.problems : []}
			onCancel={() => sync.reset()}
			onApply={(attempt, choices) => apply.mutate({ attempt, choices })}
		/>
	{/key}
{/if}
```

Show it in place of the page while the attempt waits, keyed on
`attempt.id`. Pass the `problems` of an `InvalidChoices` refusal back in;
each shows beside its row until the person changes that row's choice. The
sides read "This device" and "Remote".

### `ReplacedNotice` (`@epicenter/svelte/replaced-notice`)

The one notice for a save that replaced another writer's change (ADR-0551).
It names each value in `saved.replaced`: a field or setting with what was
kept and what was theirs, each competing span of text by its lines, or the
whole file. **Restore theirs** calls `onRestore`, which the app runs as one
more save of `restoreTheirs(saved)` from `@epicenter/folder`; **Dismiss**
calls `onDismiss`. Render it inline, or show it in the app's `Toaster` until
it is dismissed with `toastReplaced`:

```ts
import { restoreTheirs } from '@epicenter/folder';
import { toastReplaced } from '@epicenter/svelte/replaced-notice';

void toastReplaced({
	replaced: saved.replaced,
	subject: saved.stored.path,
	restore: () => void save.mutateAsync(restoreTheirs(saved)),
});
```

### Running a sync from a page

A page runs `folder.sync` as two of its own mutations; this package keeps no
sync state. `run()` is one mutation and `resolve(attempt, choices)` another,
both invalidating the page's queries when they settle. A sync that needs
choices fails with `SyncError.NeedsChoices`, so the attempt the review shows
is the run mutation's error, and the mutation's own state is all the page
keeps:

```ts
const sync = createMutation(() => syncOptions); // mutationFn: () => folder.sync.run()
const apply = createMutation(() => applyOptions); // mutationFn: ({ attempt, choices }) => folder.sync.resolve(attempt, choices)
const attempt = $derived(
	sync.error?.name === 'NeedsChoices' ? sync.error.attempt : undefined,
);
// Cancel: sync.reset(). An Apply refused as InvalidChoices keeps the review;
// any other result ends it with sync.reset().
```

`apps/todos` builds both with `resultMutationOptions` from
`wellcrafted/query`, so the errors stay typed.

`describeSync(result, describePush?)` from `@epicenter/svelte/sync-line`
words a result for a toast or a status line. It is a plain module, so status
helpers import it without loading runes. The rest of what a person is told
stays with the page.

### `fromData`

Adapts one opened `@epicenter/app/store` handle into Svelte reactivity, mirroring
the declaration: `tables.<name>`, `kv`, and `persistence`, with the same verbs
and the same types. Other handle members keep their descriptors and identities.
Reads are reactive; writes pass through unchanged. Repeated calls with the same
raw store return the same wrapper, so route components can remount over one
open store.

Each read registers a Svelte dependency and calls the native method. The adapter
holds no row values or diagnostics, so a read sees the same transaction writes,
validation, and closed-store rejection as the native read (ADR-0500). One
subscription per table wakes its readers on each table commit; it attaches on
the first reactive reader and detaches after the last. Body text edits are not
table commits: listen to them with the table's `watch`.

Inputs must be plain-object handles with closure-bound methods. A class
instance is rejected, because its prototype methods would not survive wrapping.

```ts
const app = fromData(data);
const active = $derived(app.tables.notes.rows.filter((n) => !n.deletedAt));
const note = app.tables.notes.get(id);   // wakes on any notes commit
app.persistence.get() === 'blocked';     // this device stopped saving
```

## Contributing

When adding new utilities to this package:

1. Add the utility file to `src/`
2. Export it from `src/index.ts`
3. Update this README with documentation
4. Add type tests if applicable

## Dependencies

This package depends on:

- `svelte`: For reactive state primitives
- `wellcrafted`: For error handling utilities
