# 0573. A control binds one part of a row: fields are patched and the body is opened

- **Status:** Proposed
- **Date:** 2026-10-16
- **Relates:** [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) (`InvalidRow`, no partial row), [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (a row merges by field and the body by line), [ADR-0554](0554-a-field-edit-sets-fields-on-the-file-as-it-is-now.md) (`table.update`), [ADR-0572](0572-an-app-opens-its-folder-behind-await-and-provides-its-options-through-context.md) (`getFolder()`)
- **Unbuilt:** moving the body editors in Todos (`TodoDetail.svelte`), Honeycrisp (`notes.svelte.ts`), Capture (`captures.svelte.ts`, `capture-form.svelte.ts`), Vocab (`entries.svelte.ts`), Whispering (`library.svelte.ts`), and the Folders window (`RowBody.svelte`) from hand-wired `createBodyDraftState` to it.

## Context

ADR-0554 made a field edit `table.update` and kept `table.save` with a
starting version for a whole body, and `createBodyDraftState`
(`packages/folder/src/svelte/draft.svelte.ts`) holds a body's draft. Each app
wires the body by hand: it creates the table's save mutation, passes
`createBodyDraftState` a `save` that builds `{ fields: base.row.fields, body:
content }`, passes the cached row to `change`, and picks between the draft's
text and the cached body to show. Seven editors repeat that wiring. Nothing
stated why a field and a body are written differently, so the split read as
a choice per control rather than a rule of the file.

## Decision

**A row is a file with parts: each frontmatter key, and the body.** Every
control binds exactly one part.

**A file that does not validate has no parts.** One key that fails its schema
refuses the whole row as `InvalidRow`, as ADR-0518 decides. The file opens as
its text with its issues, and no control binds to it. A person or a coding
agent repairs the text, and the next read binds it again.

**A field is patched.** A key is one value, edited in an instant: a click, or
a short text committed on `change`. Its control sends
`update.mutate({ stem, set })` or `unset`, which sets the key on the file as
it is now. When another writer changed the same key, the saver wins.

```svelte
<Checkbox bind:checked={() => book.data.row.fields.done, (done) => update.mutate({ stem, set: { done } })} />
```

**The body is opened.** A body is edited over minutes, and a whole-body write
at the end would replace everything another writer did to it in that time. Its
control opens it with `createBodyEditor` from `@epicenter/folder/svelte`,
given the row as the cache holds it and the table's save mutation. It keeps
a body draft over them:

```ts
const save = createMutation(() => folder.books.save.mutationOptions());
const body = createBodyEditor({ row: () => book.data ?? undefined, save: save.mutateAsync, onSaved });
body.text      // the text typed, or the body as the file holds it
body.typed     // the text typed and not yet in the file
body.change(t) // the first change takes the row as the cache holds it as the base
body.save()    // one save at a time, merging by line with what changed meanwhile
body.saving
```

```svelte
<Textarea bind:value={() => body.text ?? '', (text) => body.change(text)} onblur={() => body.save()} />
```

The app passes the query and the mutation in, so `@epicenter/folder`
takes no dependency on TanStack's Svelte adapter, and an app keeps its own
`onError` on the mutation.

A body save sends the row's fields as the base holds them with the new body,
so the merge (ADR-0551) keeps every field another writer changed. A failed save
keeps the draft. `onSaved` receives each landed save with the save that
restores what it replaced, as `createBodyDraftState` does now.

**`table.update` never carries a body.** Replacing a body on the file as it is
now is the write this record exists to prevent, so the verb that would do it
does not take one.

## Consequences

- Which write a control uses follows from the part it binds, not from a
  judgment about the control: a key is patched, the body is opened.
- The seven hand-wired body editors become one `createBodyEditor` call each,
  and both kinds of control bind with a plain `bind:` getter and setter.
- A long text kept in frontmatter is a value: the saver wins over it whole.
  Text that should merge by line belongs in the body.
- A typo in one key locks every control on that row until the file is
  repaired as text.

## Considered alternatives

- **The body as a field, sent with `update`.** One verb and no draft, but a
  save at the end of an editing session silently replaces everything another
  writer did to the body during it, which no commit holds (ADR-0529).
- **Validity per key** (bind the valid keys, show only the broken one). More
  forgiving, but each binding needs its own validity, a save must leave the
  broken key's text untouched, and ADR-0518 has no partial row.
- **Keeping `createBodyDraftState` as the app-facing call.** It works, but
  every app keeps rebuilding the row from `base.row.fields` and choosing what
  to show, and a mistake there is a body saved with stale fields as ours.
