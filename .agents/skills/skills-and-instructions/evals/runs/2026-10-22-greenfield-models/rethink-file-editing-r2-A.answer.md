# Rethinking Epicenter's file editor: one buffer, with independent facts about storage

## Current state in this snapshot

The nested proposal is already implemented here. `BufferSnapshot` has the shape `unread | loading | unavailable | ready{text, unsaved?}` (`packages/folder/src/edit-owner.ts:141`), and the README documents it (`packages/folder/README.md:244`). I couldn't read the threads or the live branch, so this describes only the snapshot.

Five behaviours in the code bear on your questions:
- **Callers merge `dirty` and `saving`.** Epicenter (`FileEditor.svelte:81`) and Capture (`TextDetail.svelte:157-162`) show both as "Saving…". Whispering calls "held and not failed" `isSaving` (`whispering.svelte.ts:1039-1041`).
- **Typing clears an older failure.** New text clears a non-conflict error (`edit-owner.ts:1153`, `:860`). A retry also clears the error as soon as it starts (`:847`).
- **`save()` can report on the wrong text.** If newer text was typed but not yet tried, the save loop can end and return the older revision's failure (`:871`, `:888`).
- **A clean file deleted elsewhere loses its text.** The buffer becomes `unavailable` with no text. Epicenter works around this by keeping its own `lastShown` copy (`FileEditor.svelte:54-64`).
- **Typing doesn't clear a conflict** (`:1153`).

## Central answer: no single five-way status

**Your hypothesis holds.** `clean | dirty | saving | failed | conflict` blends three independent facts and then picks one to display:

1. **Is the text unsaved?** This compares the current text with storage.
2. **Is a write running?** That write may contain older text.
3. **What stopped the last write?** Either a failure or a conflict.

Real sequences combine these facts. You can type during a save (unsaved and saving). You can retry a failure (saving, and the failure still applies). You can type after a conflict (unsaved, and the conflict still applies). A single union has to hide one fact in each of these cases.

A union is still right for the third fact. A failure and a conflict carry different payloads and offer different actions, and they can't both be true at once, so they belong in one union.

## Organizing idea

**The editor *is* the file-backed buffer, and it always has text.** Loading belongs to *acquiring* an editor, not to the editor. Once you have one, it holds text, a revision number, and a fixed set of facts about how that text relates to storage. The folder still owns one buffer per path. Handles share it, and it outlives the components that show it.

```ts
// Acquisition: async, outside the editing component
const opened = await folder.open('notes/a.md', { schema: noteSchema });
//   Result<Editor<S>, ReadError | Missing | NotText>
//   Resolves immediately if the folder already holds this path's buffer.
//   folder.held(path): Editor | undefined, synchronous, for remounts and recovery.

type Editor<S> = {
  readonly path: string;
  readonly text: string;                     // always present
  readonly markdown: MarkdownContent<S>;     // the same text, read through the schema
  readonly revision: number;                 // +1 for each accepted change
  readonly dirty: boolean;                   // revision > savedRevision
  readonly saving: boolean;                  // a write is running (maybe of an older revision)
  readonly problem?:                         // why the last write didn't land
    | { name: 'Failed'; at: number; error: SaveFailure }
    | { name: 'Conflict'; base: string | null; current: FileContent | null };
  readonly readError?: ReadError;            // the last refresh failed; text unaffected
  readonly locked?: string;                  // a fenced action holds the path
  readonly ended?: 'deleted' | 'not-text' | 'closed'; // the editor is finished; text stays copyable

  replaceText(text: string): ChangeResult;
  change(change: DocumentChange<S>): ChangeResult;
  save(): Promise<Result<{ revision: number }, SaveFailure | SaveConflict | ActionError>>;
  revert(): void;                            // new revision whose text is the saved text
  keepMine(text?: string): Promise<SaveResult>; // resolve a conflict: overwrite storage
  takeTheirs(): void;                        // resolve a conflict: take storage's text, no write
  discard(): Recovery | undefined;
  subscribe(listener: () => void): () => void;
  release(): void;                           // drop this handle; held text survives
};
```

## Definitions

- **Base (the witness):** the exact source storage was last known to hold, `null` for "no file". Every write is checked against the base inside the guarded storage call.
- **Saved revision:** the newest revision whose text storage has confirmed. **Saved** means `revision === savedRevision`.
- **Dirty:** `revision > savedRevision`. Changing the text back doesn't rewind it:
  - With no write running, a change whose text equals the base is marked saved immediately.
  - While a write runs, that same change stays dirty, because storage is about to change.
- **`save()`:** captures `r = revision` and resolves when revision `r` or a newer one lands, returning that revision. It resolves with an error only if a write *containing r or newer* fails. It never reports an older revision's outcome.
- **Flush:** cancel the autosave pause and save now. `editor.save()` flushes one path. `folder.flush()`, today's `settle`, flushes every dirty path and returns what remains unsaved.
- **Saved ≠ durable:** saved means storage acknowledged the write. Crash recovery of in-memory text is a separate journal, and none of these terms promise it.
- **Error lifetimes:**
  - A **conflict** describes the base, so it lasts until `keepMine` or `takeTheirs`. Typing doesn't clear it, and autosave stops because it would only conflict again.
  - A **failure** describes an attempt. It stays until a later write lands or the text becomes clean again. A retry keeps the old failure visible while it runs, then either clears it or replaces it. Typing after a failure triggers a normal autosave of the new revision, but the same revision is never retried automatically.
  - A **read error** concerns observing storage, not saving. The next successful read clears it.

## Five sequences

**1. Typing during a save.** Revision r5 is being written and you type r6, so the editor is `saving` and `dirty`. When r5 lands, `savedRevision` becomes 5 and the base becomes r5's text. The editor is still dirty, and autosave writes r6. A `save()` called during r5 resolves after r5 lands. One called after r6 waits for r6.

**2. Reverting while a save runs.** The base is T4 and r5 (text T5) is being written. `revert()` creates r6 with text T4, which stays dirty.
- If r5 lands, the base becomes T5, and r6 is written to restore T4.
- If r5 fails, storage still holds T4, which equals r6. The editor becomes clean with no write, and the failure disappears because no unsaved text remains.

**3. Retrying a failure.** r5 failed, so `problem` is `Failed{at: 5}`. Calling `save()` starts a write while `problem` stays set, so the UI can show "Retrying…". Success clears `problem`. Another failure replaces it with the new error.

**4. Typing after a conflict.** Saving r5 hit a conflict: storage holds C. You type r6. The conflict remains and autosave stays stopped. Three ways out:
- `keepMine()` makes C the base and writes r6.
- `takeTheirs()` sets the text to C as a new revision, already saved.
- To merge, call `replaceText(mergeText(base, C, text))`, then `keepMine()`.

**5. Refreshing while text is usable.**
- **The read fails:** `readError` is set, and the text and editing are untouched.
- **The file was deleted and the editor is clean:** the editor follows storage, so `ended: 'deleted'`. The text stays readable and copyable. Epicenter's `lastShown` workaround goes away.
- **The file was deleted and the editor is dirty:** the editor reports `Conflict{current: null}` immediately. The next save would have discovered the same fact. `keepMine()` recreates the file; `takeTheirs()` ends the editor.

Your question about always-retained text gets an explicit answer in the clean-deletion case. The editor keeps the text but stops accepting changes, so a file deleted elsewhere is never silently brought back.

## Vanilla use

```ts
const opened = await folder.open(path);
if (opened.error) return showOpenError(opened.error);
const editor = opened.data;

editor.replaceText(next);               // accepted into memory, autosaves after the pause
const saved = await editor.save();      // covers every revision up to this call
if (saved.error?.name === 'Conflict') showCompare(editor.problem);
editor.release();                       // dirty text stays held by the folder
```

## Svelte

```svelte
<!-- Parent: acquisition owns loading and unavailability -->
{#await folder.open(path)}
  <Loading label="Opening…" />
{:then opened}
  {#if opened.error}<OpenError error={opened.error} retry={...} />
  {:else}{#key path}<FileEditor editor={opened.data} />{/key}{/if}
{/await}
```

```svelte
<script lang="ts">
  import { reactiveEditor } from '@epicenter/svelte/edits';
  let { editor: owned }: { editor: Editor } = $props();
  const editor = reactiveEditor(owned); // subscribes; calls release() on destroy
  const conflict = $derived(editor.problem?.name === 'Conflict' ? editor.problem : undefined);
</script>

<span role="status">
  {#if conflict}Saved file changed
  {:else if editor.saving}{editor.problem ? 'Retrying…' : 'Saving…'}
  {:else if editor.problem}Not saved: {editor.problem.error.message}
  {:else if editor.dirty}Edited
  {:else}Saved{/if}
</span>

{#if conflict}
  <CompareSources mine={editor.text} theirs={conflict.current} />
  <Button onclick={() => editor.keepMine()}>Replace saved file</Button>
  <Button onclick={() => editor.takeTheirs()}>Use saved file</Button>
{:else if editor.problem && !editor.saving}
  <Button onclick={() => editor.save()}>Try again</Button>
{/if}
{#if editor.ended === 'deleted'}<p>Deleted elsewhere. Copy anything you need.</p>{/if}
{#if editor.readError}<p>Couldn't check for outside changes. Your text is kept.</p>{/if}

<Textarea readonly={!!editor.ended || !!editor.locked}
  bind:value={() => editor.text, (v) => editor.replaceText(v)} />
```

The status line is a display priority built *from* the facts. It isn't the contract, so each app can choose its own ordering.

## What disappears

- **The `buffer` container and its four availability states.** They become the outcome of `open()`, and the editing component never sees "no text".
- **`unsaved` as a separate thing.** It becomes `dirty`, `saving` and `problem`. `Recovery` remains only as a detached copy.
- **Caller workarounds:** `lastShown`, the `text !== undefined` guards, and the `status === 'ready'` narrowing that every caller repeats.
- **The mismatch between `save()` and what it covers.** The revision number states what landed.

## Where complexity moves

- **Parents own loading and open errors.** Honeycrisp's `FileDetail` gating (size queries, `isWriting || isUnsaved`) moves before `open()`.
- **The owner needs a `release()` lifetime,** counted per handle. Today the folder infers this from subscriptions.
- **Clean deletion ends the editor.** Restoring a file deleted elsewhere becomes an explicit action instead of continued typing.
- **The schema stays bound at open,** and handles with different schemas still share one text.
- **React gets an immutable snapshot of the facts above.** That snapshot is an adapter detail, not a separate concept.

## Guarantees that justify what remains

- **`text`:** accepted input exists until it is saved, discarded or ended, regardless of mounting.
- **`revision`:** every completion names what it completed.
- **`problem`:** the two outcomes that need a person are mutually exclusive, and each has its own resolution.
- **`dirty` and `saving`:** they stay separate because typing during a save makes both true.
- **`ended`:** observed storage, not stale memory, decides whether a clean editor continues.

## Unresolved, and evidence requests for the coordinator

- **Confirm the stale-failure path with a test:** start a slow failing save of r5, type r6 more than 1 s later, and check that `save()` returns r5's failure while r6 was never tried.
- **Check the main branch's latest nested-buffer state.** I couldn't read the threads.
- **Decide failure policy:** whether a failure should pause autosave of new revisions (backoff) rather than let each keystroke trigger a new attempt.
- **Choose the clean-deletion product promise:** end the editor, or keep it editable as a "recreate" draft.
