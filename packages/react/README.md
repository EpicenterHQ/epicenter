# @epicenter/react

React views over an opened `@epicenter/folder`. The Folder package owns
files, rows, each path's source, and the input accepted into it, from the
moment it opens until it closes; this package lets a React view read a
folder editor's snapshot.

## Editing a file

```tsx
import { useFileEdit } from '@epicenter/react/edits';

function Title({ folder, id }: Props) {
  const edit = folder.tables.notes.edit(id);
  const { content, loadError, isDirty, saveError } = useFileEdit(edit);
  if (content === undefined)
    return <p>{loadError === undefined ? 'Loading' : loadError.message}</p>;
  if (content.issues !== null) return null;
  return <input
    value={content.fields.title}
    onChange={event => edit.change({ fields: { title: event.currentTarget.value } })}
    onBlur={() => void edit.save()}
  />;
}
```

`useFileEdit(edit)` answers the editor's cached snapshot,
`{ content, loadError, isDirty, isSaving, saveError }`, through one
`useSyncExternalStore`. Subscribing starts the editor's first read, so no
effect requests one. A table supplies a schema;
`useFileEdit(folder.files.edit(path, schema?))` works for arbitrary files.
`content` holds `text`, `body`, `fields` and `issues`; `issues === null`
narrows fields to the schema. Absent content with no `loadError` means text
is awaited; with a `loadError` (`Missing`, `NotText`, `ReadFailed`),
acquisition failed. Present content stays editable when a later read reports
a `loadError`.

Commands stay on the editor: `replaceText(text)` and `change({ fields?,
body? })` apply to its live source immediately, in call order, including
several handlers in one event, and return `Result<void, ChangeError>`.
`save()` publishes the exact current text; `refresh()` reads now;
`discard()` drops unpublished input and answers its text. Writes are
unconditional: the last publication wins. Unmounting releases the view's
subscription; the folder keeps input, timers, saves and failures until it
closes. The editor's rules are in `@epicenter/folder`'s README ("Editors").

## Commands

```sh
bun run typecheck
bun run test
```
