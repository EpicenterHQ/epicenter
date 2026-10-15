# 0554. A field edit is a patch the engine applies to the file as it is now

- **Status:** Proposed
- **Date:** 2026-10-15
- **Amends:** [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md) at "an edit holds its own starting version", and [ADR-0553](0553-a-pages-own-writes-keep-its-folder-cache-in-step-and-folder-queries-carry-their-read-policy.md) where it describes drafts.
- **Unbuilt:** all of it: `table.update`, `folderOptions`' `update` with a scope per file, Todos, Capture, Honeycrisp, Whispering, Vocab, and the Folders window composed as below, and the deletions.

## Context

ADR-0548 gave every editor a draft: the row it started from and the edited
row, kept outside the cache, saved one at a time. Building it on six apps and
the Folders window showed where its weight comes from:

- Todos saved on every keystroke, so saves overlapped. The draft grew a
  revision counter, a queue, and, when a save merged another writer's change
  while typing continued, a second merge in the page with a retry loop
  (`draft.ts`'s `saved`).
- Each control on one row held its own draft, so a title, a note, and a
  checkbox were three starting versions and three streams of saves.
- `createDraftState`, `createTextDraftState`, and the Folders window's own
  queue each made the same state reactive in a different way.
- "Changed elsewhere" marked a draft whose file moved; it mattered only while a
  draft lived long.

A person editing a field does not mean "here is the row as I last saw it". A
checkbox means "done is true"; a title box means "the title is Milk". Settings
already work this way: `kv.set` is an intent applied to the file as it is
([ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md)).

## Decision

**A field edit is a patch.** `table.update(stem, { fields, remove })` sets the
named fields, and removes those in `remove`, on whatever the file holds now:

```ts
async update(stem, { fields = {}, remove = [] }) {
  const current = await this.get(stem);                 // a content-carrying capture
  if (current === undefined) return Err(NotFound);
  const values = { ...current.row.fields, ...fields };
  for (const name of remove) delete values[name];
  return this.save(current, { fields: values, body: current.row.body });
}
```

It is a read and the existing `save`. When another writer saves between the
read and the write, `save` merges from `current`: the patch differs from
`current` only in its fields, so the merge keeps every other change, and the
patched fields win where both sides changed them. No second mechanism re-applies
the patch; the merge is that. `remove` exists because `null` may be a field's
real value. A patch never carries the body: a whole body is a document, and
setting it would replace another writer's lines.

**A page sends patches through one mutation per editable thing.**
`folderOptions(folder).tables.<name>.update.mutationOptions()` runs
`table.update` with the TanStack mutation scope set to the file's path, so one
file's updates run in the order they were made, whichever control made them.
A patch is data, so the mutation's variables can be shown, logged, and
inspected.

**A typed field is composed in the component.** What the person typed lives in
the framework's own state until it is sent; `undefined` means nothing typed, so
the input shows the file. A debounce sends it a second after the last
keystroke, as an editor's "save after delay" does, and a flush sends it when
the person leaves the field or the component goes away. The typed value clears
once its save lands and nothing was typed since, so the input never shows the
older cached value in between.

```svelte
<!-- rendered as {#key stem}<TodoDetail {stem} />{/key}: another todo is another editor -->
<script lang="ts">
  let { stem } = $props();
  const todo = createQuery(() => folder$.tables.todos.get.queryOptions(stem));
  const saveDone = createMutation(() => folder$.tables.todos.update.mutationOptions());
  const saveTitle = createMutation(() => folder$.tables.todos.update.mutationOptions());

  /** Typed and not yet saved; `undefined` shows the file. */
  let title = $state<string>();
  const sendTitle = useDebounce(() => {
    if (title === undefined) return;
    const sent = title;
    saveTitle.mutate(
      { stem, fields: { title: sent } },
      { onSuccess: () => { if (title === sent) title = undefined; } },
    );
  }, 1000);
  // runed's timer outlives the component; send now instead.
  onDestroy(() => void sendTitle.runScheduledNow());
</script>

<input type="checkbox" checked={todo.data?.row.fields.done}
  onchange={(e) => saveDone.mutate({ stem, fields: { done: e.currentTarget.checked } })} />

<input value={title ?? todo.data?.row.fields.title}
  oninput={(e) => { title = e.currentTarget.value; void sendTitle(); }}
  onblur={() => void sendTitle.runScheduledNow()} />
{#if saveTitle.isError}Not saved. <button onclick={() => void sendTitle.runScheduledNow()}>Try again</button>{/if}
```

A checkbox shows the file, so a failed click leaves it showing the old value
and clicking again is the retry. A typed field keeps its text after a failed
save, so "Try again" sends what is typed now. The library adds no helper for
this; one is extracted when a second app repeats the pattern.

**Documents keep a starting version.** A note body, a transcript, or a file's
text cannot be a patch. Their editors keep the text draft
(`createTextDraft`): the text typed and the version it started from, saved
after a pause through `files.save` or `table.save`, with a merged save's lines
folded back in under the cursor.

## Consequences

- Deleted: the row draft (`createDraft`'s row half, its revision counter, and
  its merge and retry in `saved`), `createDraftState`, "changed elsewhere", the
  Folders window's save queue, and the per-control drafts in every app.
- An update reads the file before writing, one read more than a save from a
  version known to be current.
- A person's save wins, with no notice, on a field another writer changed while
  they typed in it; every field they did not touch keeps the other writer's
  value.
- Quitting loses at most the last second of typing, within
  [ADR-0542](0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)'s
  "a field mid-edit is lost on quit".
- Each typed field is about a dozen lines in its component, and each must be
  keyed by its file and flush when it goes away; two components editing the
  same field do not share typed text.
- Relative changes (a counter, appending to a list) are not patches. Scripts and
  agents read the row and `save` it.

## Considered alternatives

- **A draft per control, saving every keystroke** (ADR-0548 as built). The
  overlap it creates is most of the draft's code.
- **One pending edit per file, owned by the page or the folder,** with changes
  kept as functions and replayed after a merged save. Correct, and a store with
  its own lifetime and framework bindings; the patch gets the same result from
  the existing merge.
- **A change callback instead of a patch.** Expresses relative changes, which a
  person's controls never produce, and cannot be shown, logged, or resent.
- **Typed text in TanStack's cache.** The next refresh replaces it, and the edit
  loses the version it started from.
- **A Yjs document as the buffer.** A second copy of a file that agents write
  directly, with its own lifetime, for live co-editing nobody needs yet.
- **Save on blur only.** Switching apps without leaving the field never saves.
