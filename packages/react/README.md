# @epicenter/react

React views over an opened `@epicenter/folder`. The Folder package
owns files, rows, merging, storage, each path's editable document, and the
input typed into it, from the moment it opens until it closes; this package
lets a React view read and type through a folder's edits.

## Editing a row or a file

```tsx
import { useRowEdit } from '@epicenter/react/edits';

function Title({ folder, id }: Props) {
	const edit = useRowEdit(folder.tables.notes, id);
	const row = edit.getRow();
	const { known, error } = edit.getReadStatus();
	if (error !== undefined) return <p>{error.message}</p>;
	if (known === 'nothing') return <p>Loading</p>;
	if (row?.issues !== null) return null;
	return (
		<input
			value={row.fields.title}
			disabled={edit.isLocked()}
			onChange={(event) =>
				edit.change({ fields: { title: event.currentTarget.value } })
			}
			onBlur={() => void edit.save()}
		/>
	);
}
```

`useRowEdit(table, id)` answers the folder edit's methods, each with what
this render read as a `useSyncExternalStore` snapshot:

| Member | Meaning |
| --- | --- |
| `getRow()` | The row as last known stored, with held input in it; `undefined` while nothing is known or no file is there. |
| `getReadStatus()` | `{ known, reading, error }`: nothing known yet, no file, a file, or bytes that are not text; whether a read runs; why the last read failed. |
| `getPending()` | The held input, or `undefined`; its identity holds until it changes. |
| `isLocked()` | Input is refused: another action holds the file, or the folder closes. |
| `change({ fields?, body? })` | Type fields and the body over what this render showed, as one change. |
| `read()`, `save()`, `retry()`, `discard()`, `delete()` | The folder edit's own commands. |

When a render asks for the document (`getRow` or `getReadStatus`) with
nothing known, no read running and no read error, the hook reads the file once that render
commits. A row a list already read needs no read of its own. A view that asks
only for `getPending` or `isLocked` requests no new document; a subscription
may refresh one already read. A failed first read waits for an explicit `read()`.

`change` and `changeFields` return `Result<void, ChangeError>`: success means
accepted into memory, and failure explains why no input was accepted. A row
not read yet or gone returns `ChangeError.NoSource`. Storage outcomes come
later.

`save()` sends new input or joins its running attempt. Failed input stays
held until `retry()` explicitly attempts it again or accepted new input clears
the old error. Autosave, blur, settlement and close do not retry a failure.
Both commands resolve after the attempt; `getPending()` reports a failure.

`useTextEdit(folder.files, path)` does the same for a file's whole text:
`getText()` is what this render shows (the held text, the held fields over
the stored file, or the stored file with its byte-order mark kept),
`change(text)` types the whole text and `changeFields(fields)` frontmatter
fields, and `exclusive(action)` calls the folder edit.

Each command types over what the render whose handler runs showed. A whole
text or a body typed in the committed render's handler keeps a change the same
event already made through another handler: the hook merges it by line, as a
save would (`mergeText`). A field is the value typed.

Making an edit reads and holds nothing, so a view makes one each render, and
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
