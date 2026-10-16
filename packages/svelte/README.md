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
