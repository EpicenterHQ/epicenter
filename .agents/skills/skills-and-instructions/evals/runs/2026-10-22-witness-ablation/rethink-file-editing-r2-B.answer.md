I couldn't read the referenced thread here, and I didn't run any tests. So everything below about current behaviour comes from reading the code in this snapshot. The nested `buffer.status` / `buffer.unsaved?.status` design is fully in place in it: `BufferSnapshot` (`packages/folder/src/edit-owner.ts:141`) is used by all four apps and by both adapters.

## Answer to the central question

**No. The five statuses shouldn't be one mutually exclusive value.** Your hypothesis holds, and the code shows where the compression breaks:

- **Dirty while saving.** While a save runs, new typing keeps `saving: input?.pending.saving` (`edit-owner.ts:1152`). The status stays `saving` even though the newer text hasn't been sent, so no caller can tell that it will still be unsaved after the save lands.
- **Failed while retrying.** A retry clears the error as the attempt starts (`:847`), so the banner disappears during the retry and reappears if it fails.
- **Conflict isn't a save outcome.** It means the file in storage has moved away from the version your text was based on. That's why conflict survives typing (`:1153`) while failure doesn't (`:860`). It's also why autosave keeps sending writes that are bound to conflict again (`:827`).

Only one fact here has mutually exclusive cases that each carry their own payload: **how storage relates to the editor's base**. That deserves a union. The rest are independent facts, and choosing which one to show first is a display decision for the UI.

## The organizing idea

> **An editor is text plus a base: the stored version that text came from.** "Dirty" means the text differs from the base. Whether storage still matches the base is a separate fact. A conflict is simply both at once.

Three rules follow from this:

1. **Fast-forward.** If the editor is clean and storage changes to new text, the editor adopts it (base and text both become the stored text). If storage changes to exactly your text, the editor adopts that too, which clears a conflict without user action.
2. **Autosave** only writes when the editor is dirty and storage still matches the base. Writes that can only conflict are never sent.
3. **Text is never taken from a held editor.** Deleting the file or making it unreadable changes `storage`, not `text`.

That settles the side questions:
- **FileEdit is the buffer.** There's no `.buffer` container and no `unsaved` object.
- **The snapshot is just an immutable value** for `useSyncExternalStore` or Svelte.
- **Opening is asynchronous; editing is synchronous.** You `await` opening the file once, and from then on `text` always exists.

## Vanilla use

```ts
const opened = await folder.open('notes/milk.md', { schema: notes }); // reads only if no buffer is held
if (opened.error) return show(opened.error);         // Missing | NotText | ReadFailed
const editor = opened.data;                          // released by editor.release() or dispose

editor.replaceText(next);            // Result<void, Locked | NotText>; never stored as an "issue"
editor.change({ fields: { title } });// same text, seen through the schema

type EditorSnapshot = {
  text: string;                      // always present
  markdown: MarkdownContent<S>;      // the same text, schema view
  revision: number;                  // increases with each accepted change
  dirty: boolean;                    // text ≠ base
  storage:
    | { kind: 'matches' }                                            // storage = base
    | { kind: 'changed'; current: FileContent; text: string | undefined }
    | { kind: 'removed' };
  saving?: { revision: number };     // a write in progress, possibly of older text
  failure?: { error: SaveFailure; revision: number }; // last finished attempt
  refreshError?: ReadError;          // last check of storage failed; text unaffected
  locked?: string;                   // fence reason
};

await editor.save();    // Result<{ revision }, SaveFailure | Conflict>
editor.revert();        // text = base; returns the discarded text for copying
editor.rebase();        // base = what storage holds now; the next save replaces it
await editor.refresh(); // Result<void, ReadError>
```

The three resolution choices become ordinary operations:
- **Use saved file** = `revert()`. The text returns to the base, and fast-forward then brings in the stored version.
- **Replace saved file** = `rebase()`.
- **Merge** = `replaceText(merged)` followed by `rebase()`.

## Definitions

- **Dirty:** `text` differs from the base text, compared by content rather than by revision number. Typing back to the original makes the editor clean, even while a save runs. Today that only happens when no save is running (`:1139`).
- **Saved:** not dirty, and `storage.kind === 'matches'`. Storage is known to hold exactly this text.
- **`save()`:** skips the autosave delay and makes the revision current at the call reach storage. Each write is guarded by the base. It resolves `Ok({ revision })` once that revision or a later one has landed. That returned revision is what completed, and the editor may already be dirty again.
- **Flush:** a folder-level operation (`folder.flush()`, close, fenced actions). It freezes input first, so "current" is final, then saves every dirty editor. It reports what stays unsaved because of a failure or conflict.
- **Which error still applies after text changes:**
  - `failure` stays across typing. The storage problem hasn't been resolved, and newer text hasn't been tried. It is cleared only when a later attempt finishes, or when the editor becomes clean.
  - A conflict lasts as long as its two conditions do.
- **Retry keeps the old failure until the new attempt finishes.** `saving` and `failure` coexist ("Retrying… last attempt: offline"). Success clears the failure; another failure replaces it.

## The five sequences

**1. Typing during a save.** Revision 5 is being written, and you type revision 6.
- Snapshot: `{ dirty: true, saving: { revision: 5 } }`.
- Revision 5 lands: the base becomes revision 5's text. The editor is still dirty, so the autosave timer writes revision 6.
- A `save()` called during revision 5 resolves with `{ revision: 6 }`, after waiting for 5 to land.

**2. Reverting while a save runs.** Today this is refused with `BUSY` (`:1013`). Here it is just an edit: the text becomes the old base.
- If revision 5 lands, the base becomes revision 5, the text differs from it, and autosave writes the reverted text. Storage ends up holding what you asked for.
- If revision 5 fails, the editor is clean, so the failure is dropped.
- There are no refusals and no special cases.

**3. Retrying a failure.**
- `{ failure: { revision: 5 } }` becomes `{ saving: { revision: 5 }, failure }` while the retry runs.
- Then it becomes either `{}` (success) or a new `failure` (another failure).

**4. Typing after a conflict.**
- Storage is `changed` and the editor is dirty, so it's a conflict.
- Typing keeps it dirty, so the conflict persists, and autosave sends nothing.
- If someone else saves exactly your text, the fast-forward rule resolves the conflict. Otherwise the user chooses `revert` or `rebase`.

**5. A refresh fails or finds the file deleted.**
- **A failed refresh** sets `refreshError`. Text and `storage` stay as last known.
- **A refresh that finds deletion** sets `storage: removed`:
  - **Dirty editor:** this is a conflict, and `rebase()` recreates the file.
  - **Clean editor:** the text stays visible as the last version seen, and the editor is not dirty. Typing makes it dirty, which is immediately a conflict, so the file is never silently recreated.
- Today a clean deletion makes the text `undefined` (`:1096`, `:587`). `FileEditor.svelte:55-64` keeps its own `lastShown` copy to work around that.

The cost of keeping text: a deleted file looks editable until you type. Once released, it can't be reopened (`open` returns `Missing`), unless a dirty buffer for that path is still held.

## Svelte

```svelte
<!-- FilePane.svelte: opening happens outside the editor -->
{#key path}
  {#await folder.open(path)}<Loading />
  {:then opened}
    {#if opened.error}<OpenProblem error={opened.error} retry={() => (path = path)} />
    {:else}<FileEditor editor={opened.data} />{/if}
  {/await}
{/key}
```

```svelte
<!-- FileEditor.svelte -->
<script lang="ts">
  let { editor }: { editor: Editor } = $props();
  const e = createEditor(editor);  // reactive getters; releases on destroy
  const conflict = $derived(e.dirty && e.storage.kind !== 'matches');
</script>

<span role="status">
  {#if conflict}Not saved: the file changed elsewhere
  {:else if e.saving}{e.failure ? 'Retrying…' : 'Saving…'}
  {:else if e.failure}Not saved: {e.failure.error.message}
  {:else if e.dirty}Unsaved
  {:else if e.storage.kind === 'removed'}Deleted elsewhere
  {:else}Saved{/if}
</span>

{#if conflict}
  <Compare saved={e.storage.kind === 'changed' ? e.storage.text : null} mine={e.text} />
  <Button onclick={e.revert}>Use saved file</Button>
  <Button onclick={e.rebase}>{e.storage.kind === 'removed' ? 'Recreate file' : 'Replace saved file'}</Button>
{:else if e.failure && !e.saving}
  <Button onclick={() => e.save()}>Try again</Button>
  <Button onclick={() => copy(e.revert())}>Discard edit</Button>
{/if}
{#if e.refreshError}<p role="alert">Couldn't check the saved file. <Button onclick={e.refresh}>Retry</Button></p>{/if}

<Textarea readonly={!!e.locked}
  bind:value={() => lf(e.text), (v) => e.replaceText(withFileNewlines(v, e.text))} />
```

The order of the status line is the UI's own choice; the library no longer bakes it in. Honeycrisp opens once in `FileDetail` and passes the same editor to both the note view and the source view.

## What disappears

- The `unread | loading | unavailable` cases, and the read requests that adapters trigger as a side effect (`svelte/src/edits.ts:24-28`, `react/src/edits.ts:33-36`).
- The `Unsaved` and `Recovery` entities.
- `resolveConflict` and the private `conflictCurrent` guard (`:1225-1289`).
- The refusal-tracking machinery and the mixed `buffer.error` union (`:504-563`). Refusals become command results only.
- The `BUSY` refusal for discard.
- `lastShown`.
- Honeycrisp and Whispering checking query state before reading `fileEdit.buffer`, just to avoid triggering a read (`FileDetail.svelte:77-80`, `RecordingDetail.svelte:74-77`).

## Where complexity moves

- **Every caller needs a loading boundary** (`{#await}`, a route loader, or a parent component).
- **The owner must apply the fast-forward rule whenever it learns what storage holds.** It already tracks the base (`from`) and the stored content (`doc`) separately, so this is a relocation rather than new state.
- **Release becomes an explicit lifetime.** The folder keeps a buffer while it is dirty or while any handle holds it.
- **The full-file classification query in Honeycrisp stays**, folded into `open`'s errors.

## Why each remaining concept stays

- **`text`:** a held editor always has something to show.
- **`base`:** it defines dirty and conflict, and guards every write.
- **`storage`:** the only union, because each case carries its own payload.
- **`saving`:** a write in progress, tagged with the revision it carries.
- **`failure`:** the last finished attempt.
- **`locked`:** the fence.

Keeping input in memory is all the editor promises. A crash-recovery journal would be a separate subscriber, storing path, base and text for dirty editors.

## Still open

- Whether a clean editor whose file was deleted should keep its text. I recommend yes, so the user's view never disappears under them, but it's a product call.
- Whether autosave should retry a failure without new typing.
- Whether any caller depends on refusals appearing in `buffer.error`. Capture's `TextDetail.svelte:206` shows that error, but I didn't trace which errors reach it.

**What I need from the coordinator:** the latest state of the main implementation thread. Without it, I can't confirm that this snapshot matches what has actually been built.
