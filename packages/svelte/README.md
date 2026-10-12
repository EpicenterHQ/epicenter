# @epicenter/svelte

Svelte utilities for synchronizing state with external systems.

## Overview

This package provides utilities that help synchronize Svelte state with external data sources like local storage, remote APIs, or other browser APIs. These utilities handle the complexity of keeping state in sync across multiple sources while maintaining Svelte's reactive paradigm.

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
whole file with the two captured versions and a result, and holds that
attempt's `SyncChoices` only while it is shown. `Use this` takes a side
exactly, and `Use all from` takes one side for every part; typing
replaces, as text for text values and as JSON, once it parses, for any other
value; `Leave out` removes. Apply calls `onApply(attempt, choices)` only when
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

### `fromKv`

Adapts KV reads without wrapping a store's tables. Use it when a view needs
device settings while displaying another store. Repeated calls reuse the same
wrapper, including calls through `fromData`. Writes pass through unchanged.

```ts
const preferences = fromKv(local.kv);
preferences.get('showDetails');
preferences.update({ showDetails: true });
```

### `fromSubscription`

One value read through a subscription, kept fresh. The four lines every
adapter in this repo used to write by hand, written once, so the announce
cannot be forgotten: forget it and the value stays correct and never updates
again.

```ts
const preview = fromSubscription(
  (update) => table.watch(body, update),
  () => notePreview(body),
);
preview.current;
```

### `createPersistedState`

Creates a persisted state object tied to local storage, accessible through `.value`. This utility ensures your state survives page refreshes and synchronizes across browser tabs.

#### Features

- **Synchronous initialization**: Immediate access to a valid value
- **Automatic validation**: Uses the provided schema to validate stored data
- **Cross-tab synchronization**: Syncs state across browser tabs via storage events
- **Graceful error recovery**: Falls back to defaults via `onParseError` handler
- **Type-safe**: Full TypeScript support with inferred types

#### Usage

```typescript
import { createPersistedState } from '@epicenter/svelte';
import { z } from 'zod';

// Define your schema
const settingsSchema = z.object({
  theme: z.enum(['light', 'dark']),
  notifications: z.boolean()
});

// Create persisted state
const settings = createPersistedState({
  key: 'app-settings',
  schema: settingsSchema,
  onParseError: (error) => {
    // Handle different error types
    if (error.type === 'storage_empty') {
      return { theme: 'light', notifications: true }; // default value
    }
    console.error('Settings parse error:', error);
    return { theme: 'light', notifications: true }; // fallback value
  }
});

// Use in component
$effect(() => {
  console.log('Current theme:', settings.value.theme);
});

// Update settings
settings.value = { theme: 'dark', notifications: false };
```

**Note:** For production use, consider wrapping the persisted state in an encapsulated pattern with controlled access methods. See [Encapsulated State Pattern](../../docs/patterns/encapsulated-state-pattern.md) for best practices.

#### API

```typescript
createPersistedState<TSchema extends StandardSchemaV1>(options: {
  key: string;
  schema: TSchema;
  onParseError: (error: ParseErrorReason<TSchema>) => StandardSchemaV1.InferOutput<TSchema>;
  onUpdateSuccess?: (newValue: StandardSchemaV1.InferOutput<TSchema>) => void;
  onUpdateError?: (error: unknown) => void;
  onUpdateSettled?: () => void;
})
```

#### Parameters

- **`key`**: The key used to store the value in local storage
- **`schema`**: A Standard Schema v1 compatible schema for validation
- **`onParseError`**: Handler called when the value from storage cannot be parsed or validated. Must return a valid default value.
- **`onUpdateSuccess`** (optional): Called when the value is successfully written to storage
- **`onUpdateError`** (optional): Called when writing to storage fails
- **`onUpdateSettled`** (optional): Called after update attempt completes (success or failure)

#### Error Types

The `onParseError` handler receives one of these error types:

- **`storage_empty`**: No value found in storage for the given key
- **`json_parse_error`**: Failed to parse the stored JSON string
- **`schema_validation_async_during_sync`**: Schema validation returned a Promise during synchronous parsing
- **`schema_validation_failed`**: Schema validation failed with specific issues

#### Example: Persisting Table State

```typescript
// Persist table sorting state
const sorting = createPersistedState({
  key: 'data-table-sorting',
  schema: z.array(z.object({
    id: z.string(),
    desc: z.boolean()
  })),
  onParseError: () => [{ id: 'created_at', desc: true }] // default sort
});

// Persist row selection
const rowSelection = createPersistedState({
  key: 'data-table-selection',
  schema: z.record(z.boolean()),
  onParseError: () => ({}) // no selection by default
});
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
- `@standard-schema/spec`: For schema validation types
- `wellcrafted`: For error handling utilities
