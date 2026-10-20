# 0656. A folder owns typed input from open to close

- **Status:** Proposed
- **Date:** 2026-10-21
- **Amends:** [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md) and [ADR-0554](0554-a-field-edit-sets-fields-on-the-file-as-it-is-now.md), where an editor's input lives: input not yet saved is held by the folder, not by a page draft or a queue in each app. A field edit still sets fields on the file as it is now, a body or text still merges by line, and one write path and one channel of change remain.
- **Relates:** [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (the merge each save uses), [ADR-0553](0553-a-pages-own-writes-keep-its-folder-cache-in-step-and-folder-queries-carry-their-read-policy.md) (folder queries), [ADR-0574](0574-an-app-opens-its-folder-behind-await-and-provides-its-options-through-context.md) (the app's folder context), [ADR-0575](0575-a-control-binds-one-part-of-a-row-fields-are-patched-and-the-body-is-opened.md) (a control binds one part of a row)
- **Built:** `createEditOwner` (`packages/folder/src/edit-owner.ts`) inside every folder handle; `folder.tables.<t>.edit(id)` and `folder.files.edit(path)`; `folder.status` with `unsaved`, `failures` and `closing`; `folder.settle()` and `folder.close()` answering `Pending[]`; the `saveAfterMs` open option on every opener; read notes (`shared/observation.ts`); `createRowEdit` and `createTextEdit` in `@epicenter/svelte/edits`; `useRowEdit` and `useTextEdit` in `@epicenter/react/edits`; a context `saveState` read from `folder.status` alone; Todos, Capture, Honeycrisp, Vocab, Whispering and the generic editor on them; and the deletions below.

## Context

Typed input had three owners. The Svelte folder context kept a queue of row
edits (`context.edits`), Capture and the generic editor kept text drafts of
their own (`text-drafts.ts`, `drafts.svelte.ts`), and Whispering kept another
(`text-drafts.svelte.ts`). Each joined the folder's lifecycle through
`registerWork`, so close waited on whatever had registered, and each decided
for itself what a view showed between a save and the next read.

That split produced the same bugs in every owner:

- A view that rendered an older read sent that read as its starting point, so
  a later save overwrote text the person had already saved (an old callback),
  or a deliberate revert to the older text was dropped as "nothing changed".
- A failed reread after a save showed the text from before the save.
- Close could finish while an owner that had not registered yet still held
  input, and an owner registered late could not tell whether close had begun.
- A plain script opening a folder had no input owner at all.
- Saves ended only after the page read the folder again, so a slow or failed
  display read held up an action, its save label, and close.

## Decision

**The folder owns accepted file edits from construction until close.** Opening a
folder creates its owner; nothing attaches to it and nothing registers with
it. Every runtime (browser, Bun, Tauri, plain JavaScript) gets the same owner.

**What the folder does not own.** App actions and jobs (a request it waits
for, a recording), forms not yet submitted (a new thought, a connection
draft), and the page's query cache stay the app's. The Svelte context counts
started actions in `busy`, `leaving`, and the window's close; a form says what
it holds through `registerUnsent`. Their lifetimes do not determine file save
status: `saveState` is read from `folder.status` alone.

### Entry points

```ts
// Plain code names the row or bytes it read.
const rowEdit = folder.tables.notes.edit(id); // RowEdit
rowEdit.change(observedRow, { fields: { done: true }, body: 'Two litres\n' });

const textEdit = folder.files.edit('notes/a.md'); // TextEdit
textEdit.change(observedBytes, edited);
textEdit.changeFields(observedBytes, { title: 'x' });
await textEdit.exclusive(async (file) => file.write(before, next));
```

```ts
// Svelte: a binding per view, over the value the view's query answers.
const edit = $derived(createRowEdit(folder.tables.notes.edit(id), () => row));
edit.row; // what the view shows: the row, own saves and held input over it
edit.change({ fields: { title } });
```

```ts
// React: the render's snapshot.
const edit = useRowEdit(folder.tables.notes.edit(id), row);
edit.change({ body });
```

A handle is passive: making one reads and holds nothing, and every handle of
one path shares one input. A row change is one nested value,
`{ fields?, body? }`; there is no flat patch and no separate body command. A
text source is the file's bytes (`Uint8Array`). `undefined` means no
observation is available; a text change can then continue held text using its
existing base, but cannot start a new edit.

### Sources and presentations

Every command names the source the person saw. `shown(observed)` answers a
presentation whose `source` is a value of its own, remembered with what that
view showed, held input included. A change is merged when it is made:

- From a view that showed the held input, the change replaces it, so a revert
  to older text is kept and saved.
- From a view that showed older input, a field takes the typed value, and a
  body or text merges by line into what is held.
- Any other value is read as what the person saw.

Each view uses its own binding for display and commands. The Svelte binding
names the presentation it last displayed; a command that composes its change
from the row (Capture's thought form) reads `seen`, that same row, which
reading neither moves nor tracks. Whether a position the person picked is
still current is a separate question, answered from the latest read through
`shown`, which moves no view. React's `row` is already the render's snapshot,
and its commands name that render's presentation.

### Reads are noted, never matched

Each read through the handle notes the commit count when it started on the
values it answers (rows, and `Blob` contents through `fileBytes`). A note is
written once per object; `rowBytes` and `readDocument` carry it to values
derived from one read. A value no read noted counts as older than every own
save. No value is matched to a read by equal content, and folder queries over
source values keep structural sharing off, so a newer read reaches a view as a
new value.

### Own saves show over reads older than them

A landed save lets go of its input and stays as the path's committed
contribution, numbered by the commit it landed as: the last whole text
(composed with earlier contributions), and the last value of each field and of
the body. `shown` puts back every contribution newer than the read its value
came from, so a failed reread never shows older text and typing on never
undoes a save. A read that started after the commit already holds it, and
shows as read. Contributions stay until the file is deleted or the folder
closes; a delete that keeps a changed file keeps them.

### One save per path at a time, with an exact receipt

The handle runs saves of one path one at a time. A save's commit is the change
notice heard while that save runs; a save that changed nothing gets a notice
of its own, so `onChange` is the one path after every save. Input captured for
a queued save is copied at the call, so a caller's later mutation, or a proxy,
cannot change what is sent.

### One read path after a save

A save ends when storage answers. The views read again because `onChange`
named the path, never because the save waited for them. An app reads after an
action only where its next step goes by what is listed (opening a file just
created, counting a bulk transcription), and that read runs after the action,
outside what close and `saveState` wait for.

### Lifecycle

- `saveAfterMs` is an open option on every opener (default
  `SAVE_AFTER_MS`); a negative or non-finite value throws `RangeError` at
  open.
- `folder.status` is `{ saving, storageFailure, unsaved, failures, closing }`.
- `folder.settle()` sends held input once and answers what is still held.
- `folder.close()` refuses new input and makes every storage call throw at
  once, gives input that storage failed one last try (input refused as gone
  or malformed is never sent), waits for saves but not reads, and answers
  what is still held. What is held stays readable: `status`, and `edit(...)`
  handles, whose `pending`, `shown` and `discard` answer and whose `save()`
  and `retry()` join the close.
- `delete()` and `exclusive(action)` take the path, send held input once, and
  refuse with `ActionError.NotStarted` (`DELETING`, `BUSY`, `UNSAVED`,
  `CLOSING`) otherwise. `exclusive` hands the action an `ExclusiveFile` that
  reads, writes and deletes while the folder closes and ends with the action.
- Held input copies as text a person can keep: whole text exactly, and fields
  as JSON with the values `set`, the names to `remove`, and the `body`, so a
  removal never reads as a value.

The Svelte folder context keeps only the UI fence: `context.closing` refuses
app input, app actions finish, then `folder.close()` runs.

### Deleted

`context.edits`, `registerWork`, `FolderWork`, the attach step, `changeBody`,
the flat row patch, the `saveAfterMs` option of the folder context and
`<FolderApp>`, Capture's `text-drafts.ts` and its form's commands with no
view, the generic editor's `drafts.svelte.ts`, Whispering's
`text-drafts.svelte.ts` and its rereads after every action, and Honeycrisp's
public `editTitle`, `editBody`, `saveRow` and change helpers with no source. No
stored format changes; nothing migrates.

## Consequences

- One owner decides what a view shows and what a save starts from, for every
  app and every runtime, and close cannot miss input.
- A view must name a presentation it displayed. Rendering one value and
  sending another is the remaining way to lose a merge, and the bindings make
  it the hard path.
- Committed contributions live as long as the folder is open: per path, the
  composed text, the last value of each field typed, and the last body.
- The handle serializes saves per path, so typing fast on one path waits for
  the save in flight instead of racing it.
- A view shows its own save a moment before its list does: the save ends at
  storage, and the list follows on `onChange`.

## Considered

- **An owner attached after open.** Close could not tell whether one was still
  coming, and plain scripts had none.
- **A flat row patch with `changeBody`.** Fields and body typed together were
  two accepted updates, so one could be taken and the other refused, and a
  view could not say both came from what it saw.
- **A global "latest source" per path.** A command could not say which view it
  came from, so an old callback looked current.
- **Matching a value to a read by equal content.** An intentional revert to
  older text is equal to an older read; matching made it a no-op.
- **Keeping reads (`keepReads`) to find a value's age.** It relabeled objects
  a view already held with a later read, so an old view looked current; a
  write-once note on the value cannot be relabeled.
- **Guessing a save's commit from the next notice.** Two saves in flight could
  swap receipts; one save per path makes the receipt exact.
- **Reading the folder again before a save or action ends.** It made a display
  read part of persistence: close, labels and the next action waited on it,
  and a failed read looked like a failed save.
