# 0554. A field edit sets fields on the file as it is now

- **Status:** Accepted
- **Date:** 2026-10-15
- **Superseded by:** [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md)
- **Amends:** [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md) at "an edit holds its own starting version", and [ADR-0553](0553-a-pages-own-writes-keep-its-folder-cache-in-step-and-folder-queries-carry-their-read-policy.md) where it describes drafts.
- **Built:** `table.update` and `WRITE_ATTEMPTS`; `folderOptions`' `update` and the per-file turn its writes share; Todos, Capture, Honeycrisp, Whispering, Vocab, the Git lab, and the Folders window composed as below; `createTextDraft` and `createBodyDraftState` for documents; and the deletions.

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

**A field edit is an update.** `table.update(stem, { set, unset })` does what a
database's `UPDATE … SET` does: it takes the row as it is now, sets the named
fields, clears the named optional ones, and writes the result, so every field
it does not name keeps whatever the file holds at that moment. Files have no
transactions, so the read and the write are made atomic by the strict
compare-and-swap of ADR-0551 (`{ merge: false }`): when another writer saved
in between, the update is done again on the newer row.

```ts
async update(stem, { set = {}, unset = [] }) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const current = await this.get(stem);                      // the row now
    if (current === undefined) return Err(NotFound);
    const fields = { ...current.row.fields, ...set };
    for (const name of unset) delete fields[name];
    const saved = await this.save(current, { fields, body: current.row.body }, { merge: false });
    if (saved.error?.name !== 'Conflict') return saved;        // written, or a real failure
  }
  return Err(KeptChanging);
}
```

Nothing is merged, because nothing the person did not name is sent. Redoing
the update on a newer row cannot undo another writer's change, and an update
replaces nothing it did not name, so its `replaced` is always empty. `unset`
is typed to accept only optional fields, so clearing a required field does not
compile; `null` stays a value a field may hold. An update never touches the
body: a whole body is a document.

**`save` stays the write for whole rows.** A document editor, a script holding
a row, and Sync send a whole row with the version it started from; only they
need the three-way merge, because only they send fields the person did not
just change.

**A page sends updates through one mutation per editable thing.**
`folderOptions(folder).tables.<name>.update.mutationOptions()` runs
`table.update`. Every write `folderOptions` makes to one file, update or
save, waits its turn behind the previous one, so one file's writes run in the
order they were made, whichever control made them. TanStack's mutation
`scope` is not used for this: its id is fixed when the options are built, not
per file, and a queued scoped mutation resumes only while the window has
focus, so a hidden window's saves would wait. `WRITE_ATTEMPTS`, shared with
`save`, caps how often a write is redone; repeated conflicts mean something
writes the file continuously.
An update is plain data, so its variables show in devtools and logs.

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
  let { stem: shownStem } = $props();
  // The file this editor writes, fixed when it is created: while a keyed view is
  // replaced, its props may already name the next file when its flush runs.
  const stem = shownStem;
  const todo = createQuery(() => folder$.tables.todos.get.queryOptions(stem));
  const saveDone = createMutation(() => folder$.tables.todos.update.mutationOptions());
  const saveTitle = createMutation(() => folder$.tables.todos.update.mutationOptions());

  /** Typed and not yet saved; `undefined` shows the file. */
  let title = $state<string>();
  function sendTitle() {
    if (title === undefined) return;
    const sent = title;
    saveTitle.mutate(
      { stem, set: { title: sent } },
      { onSuccess: () => { if (title === sent) title = undefined; } },
    );
  }
  const sendTitleLater = useDebounce(sendTitle, 1000);
  // runed's timer outlives the component; send now instead.
  onDestroy(() => void sendTitleLater.runScheduledNow());
</script>

<input type="checkbox" checked={todo.data?.row.fields.done}
  onchange={(e) => saveDone.mutate({ stem, set: { done: e.currentTarget.checked } })} />

<input value={title ?? todo.data?.row.fields.title}
  oninput={(e) => { title = e.currentTarget.value; void sendTitleLater(); }}
  onblur={() => void sendTitleLater.runScheduledNow()} />
{#if saveTitle.isError}Not saved. <button onclick={sendTitle}>Try again</button>{/if}
```

A checkbox shows the file, so a failed click leaves it showing the old value
and clicking again is the retry. A typed field keeps its text after a failed
save, so "Try again" sends what is typed now. The library adds no helper for
this; one is extracted when a second app repeats the pattern.

**Documents keep a starting version.** A note body, a transcript, or a file's
text cannot be an update. Their editors keep the text draft
(`createTextDraft`): the text typed and the version it started from, saved
after a pause through `files.save` or `table.save`, with a merged save's lines
folded back in under the cursor.

## Consequences

- Deleted: the row draft (`createDraft`'s row half, its revision counter, and
  its merge and retry in `saved`), `createDraftState`, "changed elsewhere", the
  Folders window's save queue, and the per-control drafts in every app.
- An update reads the file before writing, one read more than a save from a
  version known to be current.
- A person's update wins, with no notice, on a field another writer changed
  while they typed in it; every field they did not name keeps the other
  writer's value.
- Quitting loses at most the last second of typing, within
  [ADR-0542](0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)'s
  "a field mid-edit is lost on quit".
- Each typed field is about a dozen lines in its component, and each must be
  keyed by its file, fix that file when it is created, and flush when it goes
  away; two components editing the
  same field do not share typed text.
- Relative changes (a counter, appending to a list) are not updates; a script
  reads the row and saves it.

## Considered alternatives

- **A draft per control, saving every keystroke** (ADR-0548 as built). The
  overlap it creates is most of the draft's code.
- **One pending edit per file, owned by the page or the folder,** with changes
  kept as functions and replayed after a merged save. Correct, and a store with
  its own lifetime and framework bindings; an update applied to the current
  file gets the same result with neither.
- **A callback that changes a copy of the fields (`(f) => { f.title = … }`).**
  Expresses relative changes, which a person's controls never produce; needs a
  deep copy so the callback cannot alter the version being saved over, and a
  comparison to learn what it touched; can delete a required field, found only
  when the save refuses it; and its variables are a function.
- **A callback that returns new fields (`(f) => ({ ...f, title })`).** Spreading
  the cache's row instead of `f` sends back stale values of fields the person
  never touched.
- **An update through `save`'s three-way merge.** Correct, but it reports the
  person's own field as replaced and needs those entries filtered out; redoing
  the update on the newer row needs no merge at all.
- **Writing the whole row the page last read.** Reverts every field another
  writer changed since that read.
- **Typed text in TanStack's cache.** The next refresh replaces it, and the edit
  loses the version it started from.
- **A Yjs document as the buffer.** A second copy of a file that agents write
  directly, with its own lifetime, for live co-editing nobody needs yet.
- **Save on blur only.** Switching apps without leaving the field never saves.
