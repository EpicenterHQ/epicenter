# Adversarial review: the file-editing API

## Recommendation

The five statuses should not be one mutually exclusive value. The sequences you asked about show at least four separate facts, and each has its own lifetime:

| Fact | What it describes | Lifetime |
|---|---|---|
| `dirty` | Whether another write is needed before storage holds `text` | Changes with each revision and each write that lands |
| `saving` | Whether a guarded write is in flight. It may be carrying older text. | One attempt |
| `failure` | The latest finished attempt was refused, for example because storage is offline or a permission was denied. | Until a write lands, or the input is reverted to match storage |
| `conflict` | Storage no longer matches the witness the input was based on. | Until it is explicitly resolved |

These facts occur together in normal use: dirty while saving, dirty while in conflict, saving while a failure is still showing. A single `status` turns them into a display priority, so callers lose real information.

Your hypothesis holds: a status earns its place when its values exclude each other. Two parts of the status do meet that test. One is how the file can be opened (`loading | missing | not-text | ready`); that moves into acquisition. The other is the kind of save problem, which `failure` and `conflict` payloads already distinguish.

**What I recommend:** acquire the editor asynchronously, keep one folder-owned editor per path, and expose a flat snapshot of those independent facts. Write operations return Results; they don't record refusals in shared state.

## What the snapshot implements today

The nested proposal is already implemented here: `BufferSnapshot` holds `ready` with `text` and an optional `unsaved` (`packages/folder/src/edit-owner.ts:141-145`). I could only read this frozen snapshot, not the live main conversation. The code already tracks the distinctions above internally, but the public union hides them:

- **Typing during a save keeps showing `saving`.** New input inherits `saving: input?.pending.saving` (`edit-owner.ts:1152`). So `saving` already means "an attempt for some revision is running", not "the current text is being saved".
- **Failures and conflicts already have different lifetimes.** New typing clears a failure but keeps a conflict (`edit-owner.ts:1153-1156`). A failure on an older revision is dropped, and the newer revision is sent at once (`edit-owner.ts:860, 871-872`).
- **Typing after a conflict re-runs a write that must fail.** Each typing pause schedules a save (`edit-owner.ts:1162`). The loop then clears the error and marks the input as saving (`edit-owner.ts:847`), and it sends against the same stale `from`, which conflicts again. The status goes conflict → saving → conflict. In `FileEditor.svelte:81-91`, the conflict alert disappears while "Saving…" shows.
- **A clean buffer loses its text when the file is deleted elsewhere.** With `doc === null` and no input, `shownText` is undefined and the status becomes `unavailable` (`edit-owner.ts:1093-1099, 575-590`). `FileEditor.svelte:54-64` works around this by keeping a `lastShown` copy, so the current contract doesn't meet that caller's need.
- **`save()` can report a later revision's failure.** Calling `save()` while a save is running joins the drain loop (`edit-owner.ts:806-808`), which returns the outcome of its last attempt. Suppose revision r1 lands, typing creates r2, a timer joins it, and r2 fails. The caller who asked to save r1 gets an error even though r1 was stored.
- **Reading a getter starts a file read, so callers avoid the getter.** The Svelte adapter reads the file when `buffer` is accessed in the `unread` state (`packages/svelte/src/edits.ts:24-27`). Honeycrisp and Whispering only touch `buffer` when `file.data?.kind === 'text' || isWriting || isUnsaved` (`FileDetail.svelte:77-80`, `RecordingDetail.svelte:74-76`).
- **`buffer.error` mixes unrelated kinds of error.** It combines read errors, refusals, missing or non-text source, and save errors. Keeping it accurate takes the refusal bookkeeping in `record`, `execute` and `refusalOf` (`edit-owner.ts:504-563`).
- **The folder-level names are confused.** `isUnsaved` means "has a failure", and `isSaving` means "unsaved and not failed" (`whispering.svelte.ts:1039-1049`).

## Definitions

- **Revision:** each accepted `replaceText` or `change` increments it.
- **Witness:** the exact stored content the input was based on. It is updated whenever a write lands or a clean editor refreshes.
- **Saved(r):** storage is confirmed to hold revision r, or a later revision, through a guarded write.
- **Dirty:** another write is needed before storage holds `text`. It is false when `text` equals the witness and nothing is in flight, or when `text` equals the in-flight text.
- **Save (attempt):** one guarded write of the current text against the witness.
- **Flush:** resolves when the revision that was current at the call is saved, including when a later saved revision supersedes it. It never reports on revisions accepted after the call. It fails with the failure or conflict that blocks that revision.
- **Durability:** separate from all of the above. Text held in memory is not crash recovery.

## Sequences

1. **Typing during a save.** r1 is in flight and r2 is accepted, so `saving` and `dirty` are both true. When r1 lands, the witness becomes r1 and `dirty` stays true, so autosave sends r2. `flush()` called at r1 resolves `{revision: 1}`.
2. **Reverting while a save runs.** The editor holds witness W and r1 is in flight. A revert is an ordinary edit back to W's text, so `dirty` is true: r1 will land, and W must then be written back. Nothing is refused, and no `discard` lock is needed. This is how the current code behaves (`edit-owner.ts:1139-1147`), but the new definition makes it visible to callers.
3. **Retrying a failure.** The retry keeps the failure visible: `failure` is set and `saving` is true, so the UI can show "Not saved: offline · retrying…". The failure clears only when a write lands. Typing does not clear it either; the next autosave is simply another retry. This is the main product choice: it removes the flicker and contradicts the premise that a failure and a running retry exclude each other. The current behaviour, where typing makes the failure disappear, is the alternative.
4. **Typing after a conflict.** The conflict stays, input is accepted, and autosave pauses because a guarded write against the same witness cannot succeed. Autosave starts again in two cases. One is `resolve(...)`. The other is a refresh showing that storage equals the witness again, which clears the conflict.
5. **A refresh fails while text is usable.** `storage.error` is set, while `text`, `dirty` and autosave are unchanged; writes stay guarded.
6. **A refresh finds the file deleted, with no input.** The editor keeps `text` as the last known content and sets `storage.state` to `'missing'`. Typing is accepted. The first save, or an eager refresh check, turns this into a `conflict` with `current: null`. Only `resolve('mine')` recreates the file. The `lastShown` workaround is no longer needed.
7. **A refresh finds the file deleted, with input.** This is an eager conflict with `current: null`, and autosave pauses.

## Greenfield API

```ts
type Editor<S> = {
  readonly path: string;
  readonly state: {
    text: string;                 // always present
    revision: number;
    dirty: boolean;
    saving: boolean;
    failure?: SaveFailure;        // latest finished attempt was refused
    conflict?: SaveConflict;      // carries the observed `current`
    storage: { state: 'present' | 'missing' | 'not-text'; error?: ReadError };
  };
  readonly locked?: string;       // an exclusive action holds the path
  markdown(schema?: S): MarkdownContent<S>;
  replaceText(text: string): Result<void, ChangeError>;
  change(c: DocumentChange<S>): Result<void, ChangeError>;
  revert(): void;                 // text := witness text, as an ordinary edit
  flush(): Promise<Result<{ revision: number }, SaveFailure | SaveConflict>>;
  resolve(choice: 'mine' | 'theirs' | { text: string }): Promise<Result<void, ...>>;
  subscribe(fn: () => void): () => void;
  release(): void;                // decrements the count of holders
};
folder.open<S>(path, schema?): Promise<Result<Editor<S>, OpenError /* missing | not-text | read */>>;
```

Vanilla use:

```ts
const opened = await folder.open('notes/a.md');
if (opened.error) return report(opened.error);
const editor = opened.data;
const stop = editor.subscribe(render);
editor.replaceText(editor.state.text + '\nMore.');
const done = await editor.flush();   // { revision } covering this edit, or the blocking problem
stop(); editor.release();            // held input stays with the folder until saved or closed
```

Svelte. The parent owns loading:

```svelte
{#await folder.open(path)}
  <Loading />
{:then opened}
  {#if opened.error}<OpenFailed error={opened.error} />
  {:else}<FileEditor editor={reactive(opened.data)} />{/if}
{/await}
```

```svelte
<script lang="ts">
  let { editor } = $props();
  const s = $derived(editor.state);
</script>
<span role="status">
  {#if s.conflict}Changed elsewhere
  {:else if s.failure}Not saved: {s.failure.message}{#if s.saving} · retrying…{/if}
  {:else if s.dirty || s.saving}Saving…
  {:else if s.storage.state === 'missing'}Deleted elsewhere
  {:else}Saved{/if}
</span>
{#if s.conflict}
  <Compare saved={s.conflict.current} yours={s.text} />
  <Button onclick={() => editor.resolve('theirs')}>Use saved file</Button>
  <Button onclick={() => editor.resolve('mine')}>Keep my text</Button>
{:else if s.failure}
  <Button onclick={() => editor.flush()}>Try again</Button>
{/if}
{#if s.storage.error}<p role="alert">{s.storage.error.message}</p>{/if}
<Textarea readonly={!!editor.locked}
  bind:value={() => s.text, (v) => editor.replaceText(v)} />
```

## What disappears, what moves, what stays

**Disappears:**
- The `unread`, `loading` and `unavailable` statuses inside the editor, and every `text === undefined` branch in callers.
- The `NoSource` and `NotText` change errors.
- The adapter starting a read from a getter, and the `isWriting`/`isUnsaved` gating callers use to avoid it.
- `lastShown`.
- The nested `Unsaved` entity.
- The mixed `buffer.error` and its refusal bookkeeping (`record`, `execute`, `refusalOf`). Callers toast the Results instead.
- `discard()` being refused while a save runs. `Recovery` is no longer needed per editor, though `close()` still returns unsaved input.
- Pointless writes after a conflict.

**Moves:**
- Loading UI moves to the parent or an `await` block.
- `open` must deduplicate per path and count holders. That counting replaces today's `subscribe`/`prune` reference counting.
- The folder keeps clean text for deleted files while editors hold them. Memory is bounded by the number of open editors.
- Eager conflict detection on refresh: refresh results are now compared against the witness.

**Stays, because a guarantee depends on it:**
- Read ordering against saves (`clock`, `docAt`), so stale reads never replace newer knowledge.
- Guarded witness writes, so outside changes are never silently overwritten.
- The drain loop, so newer typing survives a write landing or failing.
- Fences, so actions save input first.
- One shared source for the text and Markdown views.
- The folder-level aggregate for app status and `close()`.

## Open uncertainties and checks for the coordinator

1. **Retaining a failure across retries (sequence 3)** is a product decision for you. It conflicts with the earlier premise that a failure and a retry exclude each other.
2. **Remove the conflict from the snapshot, or keep it while autosave pauses?** Pausing depends on accepting that conflicts are detected eagerly on refresh. Check that a guarded write cannot succeed while the witness is stale. Reading `replaceSource` in `handle.ts` would settle this; I did not read it.
3. **Flash for cached editors.** I believe a Svelte 5 `{#await}` on an already resolved promise still renders the pending branch for a tick, but I haven't verified it. If it does, a synchronous `folder.peek(path)` for cached editors is needed. Please measure this.
4. **Execution evidence requested.** I ran nothing. Please write tests that reproduce:
   - (a) `save()` at r1 returning r2's failure;
   - (b) typing after a conflict producing repeated write attempts and the status going conflict → saving → conflict;
   - (c) a clean outside deletion turning `ready` into `unavailable`.
