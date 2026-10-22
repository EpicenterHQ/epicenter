# 0575. A control binds one part of a row: fields are patched and the body is opened

- **Status:** Proposed
- **Date:** 2026-10-16
- **Amended by:** [ADR-0656](0656-a-folder-owns-typed-input-from-open-to-close.md) (Proposed): a field and the body are typed through one edit handle per row (`folder.tables.<t>.edit(id)`) as one nested change, `{ fields?, body? }`, held by the folder and saved as one merge; `createBodyEditor`, the per-part mutations, and the rule that nothing saves fields and the body together give way to it. A field still takes the typed value, the body still merges by line, and the saver still wins.
- **Amends:** [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md), withdrawing the "Restore theirs" notice: where a save meets another writer's change to the same unit, the saver wins and nothing is shown. That Save and Sync share one merge remains.
- **Relates:** [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) (the one write each part's helper calls), [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) (`InvalidRow`, no partial row), [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (a row merges by field and the body by line), [ADR-0554](0554-a-field-edit-sets-fields-on-the-file-as-it-is-now.md) (`table.update`), [ADR-0574](0574-an-app-opens-its-folder-behind-await-and-provides-its-options-through-context.md) (`getFolder()`)

- **Current edit implementation:** [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md) records the retained-source model implemented in `bd78bfb52b`. Editors and direct file/table commands share each path's publication lane; local writes are unconditional whole-file last-write-wins. Git synchronization keeps its merge rules. Earlier draft-merge and guarded-save descriptions below are historical.

## Context

ADR-0554 made a field edit `table.update` and kept `table.save` with a
starting version for a whole body, and `createBodyDraftState`
(in `@epicenter/folder/svelte`) holds a body's draft. Each app
wired the body by hand: it created the table's save mutation, passed
`createBodyDraftState` a `save` that built `{ fields: base.row.fields, body:
content }`, passed the cached row to `change`, and picked between the draft's
text and the cached body to show. Seven editors repeated that wiring. A body
save sent every field as the base held it, so it rewrote the whole
frontmatter in canonical form and relied on the merge to keep fields another
writer changed. Nothing stated why a field and a body are written
differently, so the split read as a choice per control rather than a rule of
the file.

## Decision

**A row is a file with parts: each frontmatter key, and the body.** Every
control binds exactly one part, and each part has its own write.

**A file that does not validate has no parts.** One key that fails its schema
refuses the whole row as `InvalidRow`, as ADR-0518 decides. The file opens as
its text with its issues, and no control binds to it. A person or a coding
agent repairs the text, and the next read binds it again.

**A field is patched.** A key is one value, edited in an instant: a click, or
a short text committed on `change`. Its control sends
`setBook.mutate({ stem, fields })`, which sets the key on the file as it is
now; `undefined` removes an optional key. When another writer changed the
same key, the saver wins.

```svelte
<Checkbox bind:checked={() => book.data.row.fields.done, (done) => setBook.mutate({ stem, fields: { done } })} />
```

**The body is opened.** A body is edited over minutes, and a whole-body write
at the end would replace everything another writer did to it in that time.

> Since ADR-0656 the field and body controls below both bind the row's edit
> handle (`createRowEdit(folder.tables.books.edit(stem), () => row)`) and
> type `edit.change({ fields })` or `edit.change({ body })`; the folder holds
> the input and merges each save by unit. The calls below record the
> original decision.

Its control opens it with `createBodyEditor` from `@epicenter/folder/svelte`,
given the row as the cache holds it and the table's `write` mutation:

```ts
const writeBook = createMutation(() => folder.books.write.mutationOptions());
const body = createBodyEditor({
  row: () => book.data ?? undefined,
  write: (change) => writeBook.mutateAsync({ stem, ...change }),
});
body.text      // the text typed, or the body as the file holds it
body.typed     // the text typed and not yet in the file
body.change(t) // the first change takes the row as the cache holds it
body.save()    // one save at a time
body.saving
```

```svelte
<Textarea bind:value={() => body.text ?? '', (text) => body.change(text)} onblur={() => body.save()} />
```

The app passes the query and the mutation in, so `@epicenter/folder` takes no
dependency on TanStack's Svelte adapter, and an app keeps its own `onError` on
the mutation.

**A body is written as a change of the row it started from.** Each save is
the change from the row the editor started from to that row with the typed
body, merged into the file as it is now (ADR-0576): body lines only the
other writer changed stay, the typed lines win lines both changed, and
fields another writer changed meanwhile stand. The body is written with
`\n` line endings and well-formed text (ADR-0572). A failed save keeps what
was typed.

**Where a save meets another writer's change to the same unit, the saver
wins, and nothing is shown.** This holds for a body region, a field, and a
setting alike. The save returns no list of what it replaced and there is no
"Restore theirs": `Replaced`, `restoreTheirs`, `SavedRow.replaced`,
`SavedFile.replaced`, the drafts' `onSaved`, and `ReplacedNotice` are
deleted. The engine logs each overwrite that lands through
`wellcrafted/logger` (`folder/save`) with the units it replaced.

**No control saves a whole row over the file as it is now.** Replacing a
body on the file as it is now is the write this record exists to prevent.
(ADR-0656 replaces the rest of this rule: one change may name fields and the
body, and its save merges each unit with the file as it is then, so the body
is still never replaced whole.)

## Consequences

- Which write a control uses follows from the part it binds, not from a
  judgment about the control: a key is patched, the body is opened.
- An overlap lost to the saver is gone unless a version holds it (ADR-0529).
  Nobody is asked, and the log is the only record.
- The hand-wired body editors become one `createBodyEditor` call each, and
  both kinds of control bind with a plain `bind:` getter and setter.
- A long text kept in frontmatter is a value: the saver wins over it whole.
  Text that should merge by line belongs in the body.
- A typo in one key locks every control on that row until the file is
  repaired as text.

## Considered alternatives

- **The body as a field, sent with `set`.** One verb and no draft, but a
  save at the end of an editing session silently replaces everything another
  writer did to the body during it, which no commit holds (ADR-0529).
- **Validity per key** (bind the valid keys, show only the broken one). More
  forgiving, but each binding needs its own validity, a save must leave the
  broken key's text untouched, and ADR-0518 has no partial row.
- **Keeping `createBodyDraftState` as the app-facing call.** It works, but
  every app keeps building the save from the base and choosing what to show.
