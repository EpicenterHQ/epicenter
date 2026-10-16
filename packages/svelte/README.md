# @epicenter/svelte

Svelte utilities for synchronizing state with external systems.

## Overview

This package adapts opened Epicenter data and agent conversations into Svelte reactivity, and words Sync's result for a status line (`sync-line`).

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

### Running a sync from a page

A page runs `folder.sync.run()` as one of its own mutations, invalidating
the page's queries when it settles; this package keeps no sync state. Sync
asks nothing (ADR-0576): what both sides changed merges into one commit,
and the result is `synced`, `saved` (merged here, not yet on the remote), or
a `SyncError` saying why it stopped.

`describeSync(result, describePush?)` from `@epicenter/svelte/sync-line`
words a result for a toast or a status line. It is a plain module, so status
helpers import it without loading runes. The rest of what a person is told
stays with the page.

### Header status (`@epicenter/svelte/status-line`, `status-popover`, `status-row`)

Honeycrisp, Todos, and Whispering show their folder's state as one summary
button with details. Each app words its own lines; this package holds what
they share.

`status-line` is a plain module: the `StatusLine` shape (`label`, optional
`short` for narrow screens, `detail`, and a `Tone`), `mostSevere(lines)`
(the most severe line, the earlier one on a tie), `withTime`, `localTime`,
`shortOid`, and `changeList` for the changed paths a check saw. Each app
decides which lines may lead its summary and what a calm header says.

`StatusPopover` renders the button and the details: one row per
`{ name, testid, line }` in `details`, then the app's own `StatusRow`s as
children, then a `footer` snippet for actions. `bind:open` is there for an
app that reads something while the details show. `toastStatus(line)` shows an
outcome line as a toast in its tone, so the toast and the details agree.

```svelte
<StatusPopover {summary} details={[{ name: 'Files', testid: 'status-files', line: files }]}>
	<StatusRow name="Folder" class="font-mono text-xs break-all" data-testid="status-folder">
		{location}
	</StatusRow>
	{#snippet footer()}
		<Button size="sm" onclick={saveVersion}>Save version</Button>
	{/snippet}
</StatusPopover>
```

`packages/ui/src/app.css` scans this package's sources, so its Tailwind
classes reach every app that loads the shared stylesheet.

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
