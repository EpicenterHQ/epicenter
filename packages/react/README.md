# @epicenter/react

React bindings for an opened `@epicenter/folder` handle. The Folder package
owns files, rows, merging, storage, and the input typed into them, from the
moment it opens until it closes; this package lets a React view read and type
through a folder's edit handles.

## Editing a row or a file

```tsx
import { useRowEdit } from '@epicenter/react/edits';

function Title({ folder, id, row }: Props) {
	const edit = useRowEdit(folder.tables.notes.edit(id), row);
	if (edit.row === undefined) return null;
	return (
		<input
			value={edit.row.fields.title}
			disabled={edit.locked}
			onChange={(event) =>
				edit.change({ fields: { title: event.currentTarget.value } })
			}
			onBlur={() => void edit.save()}
		/>
	);
}
```

`useRowEdit(rowEdit, observedRow)` takes the row this render shows, read by
the app's own query. It answers:

| Member | Meaning |
| --- | --- |
| `row` | The observed row with the folder's own saves and the held input over it. |
| `pending` | The held input, or `undefined`; its identity holds until it changes. |
| `locked` | Input is refused: another action holds the file, or the folder closes. |
| `change({ fields?, body? })` | Type fields and the body over what this render showed, as one change. |
| `save()`, `discard()`, `delete()` | The handle's own commands. |

`useTextEdit(textEdit, observedBytes)` does the same for a file's whole text:
`text` is what this render shows (the held text or fields over its bytes,
else those bytes decoded with their byte-order mark kept), `change(text)`
types the whole text and `changeFields(fields)` frontmatter fields over what
this render showed, and `retry()` and `exclusive(action)` call the handle.
Read the bytes through `fileBytes` or `rowBytes` from `@epicenter/folder`, so
the handle knows how old they are.

What a render shows (`edit.shown`), the held input, and the input fence are
`useSyncExternalStore` snapshots, so a view re-renders when one changes,
including when close fences input while a save of the same input runs. Each
command names the presentation of the render whose handler runs: React may
render a newer row in a transition that suspends and never commits, and
typing still sends what the person saw. `row` is already that render's
snapshot, so a handler that composes a change from `row` composes over what
the person saw; the Svelte binding's `seen` has no React counterpart.

Making a handle reads and holds nothing, so a view makes one each render, and
a view whose path changes follows it. Unmounting lets go of the view's
subscription; the folder keeps the input, its pause, saves, and failures.
There is nothing to attach: the pause is the `saveAfterMs` option of the
folder's opener, and `folder.close()` sends held input and answers what did
not save
([ADR-0656](../../docs/adr/0656-a-folder-owns-typed-input-from-open-to-close.md)).

## Commands

```sh
bun run typecheck
bun run test
```
