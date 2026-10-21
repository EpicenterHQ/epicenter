# @epicenter/react

React views over an opened `@epicenter/folder`. The Folder package
owns files, rows, whole-source drafts, storage, each path's editable markdown,
and the input typed into it, from the moment it opens until it closes; this package
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
this render's stable `useSyncExternalStore` snapshot. `getBuffer()` reports
`unread`, `loading`, `unavailable`, or `ready`; a ready buffer has `text` and an
optional `unsaved` lifecycle. `isLocked()` reports the input fence.
When frontmatter cannot be interpreted, fields are `undefined`; body is available
only when its boundary is known. Exact source remains available through
`getText()` and a ready buffer's `text`. Its `unsaved.status` distinguishes
`dirty`, `saving`, `failed`, and `conflict`, with a save error on the latter two.
Accepted nested field values are copied into the source.

Markdown, text and buffer reads request an initial file read after the render
commits when the buffer is `unread`. Lock-only observers request no initial
read. A failed read waits for explicit `read()`; a failed reread keeps the last
source. `read()` completes the refresh; obtain the current values through the
read methods afterwards.

`change({ fields?, body? })` changes the owner's displayed source immediately.
`replaceText(text)` replaces that source, including changes another handler
made earlier in the same event. Both return `Result<void, ChangeError>` for
acceptance into memory. An operation that leaves the source unchanged is a
no-op. The hook reads render snapshots; commands act on the live path owner.

`save()` attempts input, including a previous failure, or joins its running
attempt. Failure retains input and error without looping. `discard()` and
`delete()` call the same owner. Save, conflict resolution and discard return
Results; command refusals are also recorded in the buffer for views to present.
Switching between source and structured views needs no save or refresh.
Unmounting releases the view's subscription; the folder retains input,
timers, saves and failures until it closes.

A draft pins the entire source as soon as typing changes it. A reread can
update storage knowledge, but it does not fold outside fields or body edits
into that draft. Saving compares against the source the draft began from,
even when the outside edit touched a different field. Outside deletion also
conflicts; recreating the file requires an explicit draft resolution.

`resolveConflict('current')` accepts the saved source and releases the draft.
`resolveConflict('draft')` explicitly replaces it with the held source;
`resolveConflict({ text })` submits a source composed by the caller. These
replacements are guarded against another storage change. Direct
`folder.tables.*.set` and `folder.files.write` retain their own merge behavior;
the adapters' edit commands do not perform field-level merging on save.

## Commands

```sh
bun run typecheck
bun run test
```
