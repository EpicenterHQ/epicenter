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

## Available Utilities

### `edit-session` (`@epicenter/svelte/edit-session`)

Edit sessions over `@epicenter/folder` files: the app owns the draft and the
folder's guarded autosave writes it. `createRowSession(table, stored)` edits a
valid row; `createTextSession(files, opened)` edits a file's text and keeps
input well formed with `wellFormed` from `@epicenter/folder`. Both are `createEditSession` over a source
(`rowSource`, `textSource`) that says how to save, read again, and recreate.

```ts
const session = createRowSession(folder.tables.todos, stored, { locked });
session.edit((row) => {
	row.fields.title = 'Oat milk';
}); // saves at once; only the latest request waits
session.state; // saving | saved | error, each with `file`, the last confirmed capture
await session.keepMine(); // after Conflict: save the draft over theirs, or recreate it
await session.reloadTheirs(); // after Conflict: show theirs in place of the draft
await session.rename((file) => folder.tables.todos.rename(file, 'next'));
session.release(); // the person left: no input, and a running command starts nothing more
```

A save never assigns the draft. `keepMine`, `reloadTheirs`, and `rename` run
one at a time with input locked (`session.locked`), and `settled()` waits for
them. `adopt()` takes a newer version of the file only while the session is
saved and idle. `generation` advances whenever a read replaces the draft, for
views such as a rich text editor that must remount then. Which item is open,
leaving, and what a person is told stay with the app.

### `open-item` (`@epicenter/svelte/open-item`)

The one item a page has open. `createOpenItem({ load, sessionOf, holds, closed })`
keeps what `load` built for a key and owns how it is left: opening another key
waits for the open session's saves and releases it, or answers
`{ kind: 'unsaved', session }` so the app can ask and open again with
`{ discard: session }`. Opening the shown key does nothing, and a load that
answers after a newer open is released. `keepMine` and `reloadTheirs` act
only on the session given while it is open; Reload theirs closes a gone file
and reopens one that cannot be shown through `load`. `removeOpen(session, remove)`
releases, waits for the saves, and removes what the last one confirmed. What an
item is, listings, refusals, and wording stay with the app.

`createOpenItems(options)` keeps a slot per key, for a page with several
items open at once. `slot(key)` has the same commands as `createOpenItem`,
which is one such slot; `keys()`, `sessions()`, `holding(session)`,
`keepMine(session)`, `reloadTheirs(session)`, `adopt()`, and `close()` act
across slots, and `move(from, to)` follows a renamed file. A slot exists while
it shows something or a command on it runs, so a late load is always released
by the slot it started in.

```ts
const drafts = createOpenItems<string, { path: string; as: 'row' | 'text' }, Draft, Session>({
	load,
	sessionOf,
	sameKey: (a, b) => a.path === b.path && a.as === b.as,
});
const opened = await drafts.slot(path).open({ path, as: 'row' });
if (opened.kind === 'unsaved') ask(opened.session); // then open again with { discard }
```

### `admissions` (`@epicenter/svelte/admissions`)

`createAdmissions()` counts the work a page started so closing can wait for
it. `command(fn)` wraps a whole method so each call counts from the call,
before its first await; `admit(fn)` counts one piece; `quiet()` waits for all
of it; `busy` is reactive.

### `SaveBar` (`@epicenter/svelte/save-bar`)

The save state and conflict prompt for one edit session: Reload theirs or
Keep mine for a change made elsewhere, Discard or Keep mine for a file deleted
elsewhere (Discard only without `onKeepMine`), Try again or Save again for
other failures, and what to fix for a value a row cannot hold.

### `SyncReview` (`@epicenter/svelte/sync-review`)

The modal review for one `folder.sync` attempt that needs choices
(ADR-0514, ADR-0516). It shows each conflicting setting, field, body, or
whole file with the two captured versions and a result, and holds that
attempt's `SyncChoices` only while it is shown. `Use this` takes a side
exactly; typing replaces, as text for text values and as JSON, once it
parses, for any other value; `Leave out` removes. Apply calls
`onApply(attempt, choices)` only when every conflict has a choice. Cancel
calls `onCancel`.

```svelte
{#if syncs.attempt}
	{#key syncs.attempt.id}
		<SyncReview
			attempt={syncs.attempt}
			{pending}
			problems={syncs.problems}
			onCancel={() => syncs.cancel()}
			onApply={(attempt, choices) => syncs.apply(attempt, choices)}
		/>
	{/key}
{/if}
```

Show it in place of the page while the attempt waits, keyed on
`attempt.id`. Pass the `problems` of an `InvalidChoices` refusal back in;
each shows beside its row until the person changes that row's choice. The
sides read "This device" and "Remote" unless `labels` says otherwise.

### `createSyncController` (`@epicenter/svelte/sync`)

The page's state around `folder.sync`: `syncing` while a run or an Apply is
in flight, the `attempt` whose review shows, `locked` from the start of a
run until that attempt ends, and the `problems` of the last refused Apply.
`run()` and `apply(attempt, choices)` call the folder between the page's
`beforeSync` and `afterSync`; `refused` stops either before it starts, and
no run starts while an attempt waits. `cancel()` discards the attempt;
nothing carries to the next one.

```ts
const syncs = createSyncController({
	folder,
	beforeSync: async () => openItem.session?.settled(), // the checkpoint holds the open item's saves
	afterSync: () => readEverythingAgain(),
	refused: () => (quitting ? 'Quitting' : undefined),
});
const locked = () => syncs.locked || quitting; // the open item takes no input during a review
await syncs.run(); // conflicts keep syncs.attempt
await syncs.apply(attempt, choices); // refused choices stay as syncs.problems; anything else ends the attempt
syncs.cancel(); // or discard it
```

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
