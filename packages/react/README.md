# @epicenter/react

React views over an opened `@epicenter/folder`. The Folder package owns
files, rows, each path's source, and the input accepted into it, from the
moment it opens until it closes; this package lets a React view read a
shared document's snapshot.

## Edit a document

```tsx
import { useDocument } from '@epicenter/react/document';

function Title({ folder, id }: Props) {
  const document = folder.tables.notes.document(id);
  const { text, loadError, isDirty, saveError } = useDocument(document);
  if (text === undefined)
    return <p>{loadError === undefined ? 'Loading' : loadError.message}</p>;
  const note = folder.tables.notes.parse(text);
  if (note.issues !== null) return <p>Repair this note's frontmatter</p>;
  return <input
    value={note.fields.title}
    onChange={event => document.patch({ fields: { title: event.currentTarget.value } })}
    onBlur={() => void document.save()}
  />;
}
```

`useDocument(document)` returns the document's cached snapshot,
`{ text, loadError, isDirty, isSaving, saveError }`, through one
`useSyncExternalStore`, using the handle's pure `getSnapshot()`. Subscribing
requests acquisition when source is unknown or invalidated, so no effect
requests a read. `folder.files.document(path)` works for arbitrary files.
The snapshot is schema-neutral; `folder.tables.notes.parse(text)` returns
`body`, `fields` and `issues` when a view needs structured content. Absent text with no `loadError` means text
is awaited; with a `loadError` (`Missing`, `NotText`, `ReadFailed`),
acquisition failed. Present content stays editable when a later read reports
a `loadError`.

Commands stay on the document: `replace(text)` replaces complete source,
even before acquisition; `patch({ fields?, body? })` patches acquired text.
Both commands return synchronous `Result<void, ChangeError>` and start
autosave. `save()` captures the current text and returns
`Promise<Result<void, ChangeError | SaveError>>` for that exact publication.
Later typing does not change the captured write. `refresh()` reads after admitted writes; `discard()` drops
unpublished input and returns its text.

Unmounting releases the view's independent subscription. The last unsubscribe
stops further read demand after any ongoing read; the Folder retains acquired
source, input, timers, saves, and failures until `folder.close()`. There is no
component document session to close. Writes are unconditional: the last
publication wins. For the complete contract, see
[working documents](../folder/README.md#working-documents).

## Commands

```sh
bun run typecheck
bun run test
```
