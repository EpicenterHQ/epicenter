Help me rethink Epicenter’s file-editing API from first principles. This is conceptual exploration, not an implementation request. Don’t let existing tests, migration costs, or the latest proposal determine the destination.

Read Clarify draft storage and flushing, using `read_thread` with thread ID `01a15ec3-ae90-7fd3-a48d-f29144fabe73` and host `remote-ssh-discovered:studio`. Earlier context is Tighten Markdown File Contracts.

The main conversation has begun implementing the nested buffer/unsaved proposal. This exploration does not cancel or authorize changes to that work. Check its latest state before describing what is implemented.

The workspace is `/Users/braden/.claude/worktrees/epicenter-overnight/v1-doctrine`. Relevant evidence includes `packages/folder/src/edit-owner.ts`, the Svelte and React edit adapters, and the Epicenter, Honeycrisp, Capture, and Whispering callers. Read them to understand the problem, without treating their current boundaries as requirements.

We want one folder-owned editor buffer per path. Raw text and schema-bound Markdown views edit the same source. Accepted input survives component unmounts, failed saves, conflicts, and newer typing during a save. Saving uses an observed source witness to avoid silently overwriting outside changes. Holding input in memory is distinct from durable crash recovery.

The main proposal became:
```arduino
fileEdit.buffer.status
fileEdit.buffer.text
fileEdit.buffer.unsaved?.status
```

Availability uses `unread | loading | unavailable | ready`. Only a ready buffer has text and optional unsaved work. Unsaved work uses `dirty | saving | failed | conflict`. Nested unsaved state does not repeat text or path; detached recovery values do.

Our side discussion questioned this more deeply:

- Is FileEdit actually the file-backed buffer itself, rather than something containing another buffer?
- Is `fileEdit.buffer` merely an immutable snapshot of that resource?
- Would asynchronous acquisition give callers an editor whose text always exists, moving initial loading outside the editing component?
- A buffer itself is synchronous memory. `await openText(path)` would await any necessary file read. Folder ownership and asynchronous acquisition are independent decisions.
- A promise that a buffer always retains text also changes behavior after outside deletion, especially when no dirty input exists. Examine that explicitly.
- `buffer.state` feels like an unnecessary container. `unsaved` also feels questionable as an entity when it describes a relationship to storage.

We explored a flatter editor:
```scss
editor.text
editor.isDirty
editor.isSaving
editor.saveError

editor.replaceText(value)
editor.save()
editor.revert()
```

But independent flags leave relationships implicit. If a failed save and a running retry are mutually exclusive, a discriminated union may express the contract better:
```graphql
type EditorSnapshot = { text: string } & (
  | { status: 'clean' }
  | { status: 'dirty' }
  | { status: 'saving' }
  | { status: 'failed'; error: SaveFailure }
  | { status: 'conflict'; error: SaveConflict }
);
```

**This is a candidate, not a decision.** My central question is whether these five statuses deserve to be exactly one mutually exclusive value.

A hypothesis to challenge: a status earns its place when it expresses mutually exclusive behavior and payloads. It becomes misleading when it compresses independent facts into a display priority. “Dirty” concerns the relationship between current text and persistence; “saving” concerns an operation that may contain older text. Those distinctions might coexist without requiring separate public state machines.

Walk through concrete sequences: typing during a save, reverting while a save runs, retrying a failure, typing after a conflict, and a refresh failing or finding deletion while usable text remains. Define “dirty,” “saved,” “save,” and “flush” precisely. Which revision has completed when a save or flush resolves? Which error still applies after text changes? Does retry replace or retain a failure?

Develop the strongest greenfield API you can, even if it differs substantially from every proposal above. Show its vanilla use and a realistic Svelte template. Explain what disappears, what complexity moves elsewhere, and which guarantees justify the remaining concepts
