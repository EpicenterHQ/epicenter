# @epicenter/react

React views over an opened `@epicenter/folder`. The Folder package
owns files, rows, merging, storage, each path's editable markdown, and the
input typed into it, from the moment it opens until it closes; this package
lets a React view read and type through a folder's edits.

## Editing a file

```tsx
import { useFileEdit } from '@epicenter/react/edits';

function Title({ folder, id }: Props) {
  const fileEdit = useFileEdit(folder.tables.notes.edit(id));
  const markdown = fileEdit.getMarkdown();
  if (markdown?.issues !== null) return null;
  return <input
    value={markdown.fields.title}
    disabled={fileEdit.isLocked()}
    onChange={event => fileEdit.change({ fields: { title: event.currentTarget.value } })}
    onBlur={() => void fileEdit.save()}
  />;
}
```

`useFileEdit(coreEdit)` observes one path-owned editor. A table supplies a schema;
`useFileEdit(folder.files.edit(path, schema?))` works for arbitrary files.
`getMarkdown()` returns `text`, `body`, `fields` and `issues` interpreted from
`getText()`. `issues === null` narrows fields to the schema. Each read returns
this render's stable `useSyncExternalStore` snapshot. `getReadStatus()` tells
unknown, missing, text and non-text apart; `getPending()` and `isLocked()` expose
the same path's unsaved input and fence.
When frontmatter cannot be interpreted, fields are `undefined`; body is available
only when its boundary is known. Exact source remains available through
`getText()`. `getPending()` returns raw, non-generic input across all views of the
path. Accepted nested field values are owned copies of the caller's input.

Markdown, text and read-status reads request an initial file read after the
render commits, when nothing is known and no read has failed. Pending-only
observers request no initial read. A failed read waits for explicit `read()`;
a failed reread keeps the last source. `read()` completes the refresh; obtain
the current values through the read methods afterwards.

`change({ fields?, body? })` patches named fields and replaces the supplied body.
`replaceText(text)` replaces the full source. Both return
`Result<void, ChangeError>` for acceptance into memory. The hook merges changes against the committed render: body changes use line
merging, while complete source changes use the same path-aware file merge as
storage. This preserves changes another handler made in the same event. Fields take the explicitly supplied value.

`save()` attempts input, including a previous failure, or joins its running
attempt. Failure retains input and error without looping. Accepted new input
or another attempt clears the older error. `discard()`, `delete()` and
`exclusive()` call the same owner. Valid switching between source and structured
views needs no save or refresh. Unmounting releases the view's subscription;
the folder retains input, timers, saves and failures until it closes.

## Commands

```sh
bun run typecheck
bun run test
```
