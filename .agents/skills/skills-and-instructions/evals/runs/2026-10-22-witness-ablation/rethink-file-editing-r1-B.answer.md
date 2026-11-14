I couldn't use `read_thread`, which is unavailable in this snapshot. Everything below comes from the source and from REQUEST.md.

**What the snapshot already has.** The nested proposal is in place. `BufferSnapshot` has the states `unread | loading | unavailable | ready`, and a ready buffer carries `unsaved?: Unsaved` (`packages/folder/src/edit-owner.ts:123-145`). All the callers read `buffer.unsaved`. Five things in the code shape the answer:

- **Typing during a save keeps the status `saving`, even though the text is now newer than what is being written** (`edit-owner.ts:1152`). So `saving` already coexists with newer, unsaved text.
- **A retry clears the earlier error as soon as it starts** (`:847`). Typing clears a failure but keeps a conflict (`:1153-1155`).
- **When a file is deleted elsewhere and there's no unsaved input, the text disappears** (`shownText`, `:1093-1099`). `FileEditor.svelte:55-64` works around this with `lastShown`.
- **`discard()` is refused while a save is running** (`:1013-1016`).
- **Every caller shows `dirty` and `saving` the same way, as "Saving…"** (`FileEditor.svelte:81`, `TextDetail.svelte:157-161`, `FileDetail.svelte:237-242`). None of them distinguishes the two.

## Answer to the central question

**No.** Those five statuses shouldn't be one mutually exclusive value, because `saving` isn't the same kind of fact as the others. Four of them describe **how the editor's text relates to storage, and who has to act next**. `saving` describes **an operation in progress**, and the text it's writing may be older than the current text. It can run alongside `dirty` (typing during a save) and alongside `failed` (a retry). So your hypothesis holds: keeping `saving` in the union squashes two facts into a display priority.

With `saving` taken out, the remaining relation *is* exclusive. Each value decides who makes progress and which command does it:

> **status: `clean`** (nothing to write) · **`dirty`** (autosave will write it) · **`failed`** (this exact text was tried and failed; it waits for `save()`) · **`conflict`** (storage moved away from the base; it waits for `resolve()`) · **`detached`** (clean, but storage no longer holds text)

**Errors attach to what they describe:**
- A save failure is about one attempt, at one revision. It stops applying once the text changes.
- A conflict is about the base, meaning the stored content the edits started from. It survives typing, because any later save from the same base would conflict too.
- A read error is about what we know of storage. It never changes the text.

## Definitions

- **revision**: a counter that goes up each time input is accepted.
- **base**: the exact stored content the text last agreed with. That's either the first content read or the last save that landed. Every write is guarded against it (compare-and-swap).
- **expected**: what storage will hold if every write in flight lands. That's the text of the attempt in flight, or the base if nothing is in flight.
- **dirty**: the text differs from *expected*.
- **saved (for revision r)**: a guarded write of r's text landed.
- **`save()`**: write the revision that's current when you call it. It resolves `Ok({ revision })` once that revision or a later one has landed, so `revision` is at least the one you called with. Otherwise it resolves with the failure or conflict that stopped it. It also re-attempts a `failed` draft.
- **`folder.flush()`**: skip the autosave pause everywhere, try every held draft that isn't in conflict once, and resolve with what is still unwritten (`{ path, text, revision, status, error }`). Closing the folder is a flush followed by refusing new input.
- **conflict is detected as soon as it's known**: by a read, not only by a save. If storage differs from the base while there's local work, that's a conflict right away.

## Proposed API

```ts
const opened = await folder.open('notes/a.md', { schema: Note });
if (opened.error) return show(opened.error);   // Missing | NotText | ReadFailed
using editor = opened.data;                    // released when the scope ends; held drafts stay with the folder

editor.text;        // always a string
editor.markdown;    // the same text, read through the schema
editor.revision;
editor.status;      // { status:'clean' } | { status:'dirty' }
                    // | { status:'failed'; error: SaveFailure }
                    // | { status:'conflict'; theirs: FileContent | null }
                    // | { status:'detached'; stored: 'missing' | 'not-text' }
editor.saving;      // { revision } | undefined   (independent of status)
editor.readError;   // ReadError | undefined     (independent; text unaffected)
editor.locked;      // reason | undefined         (a fenced action holds the path)

editor.replaceText(text);            // Result<void, ChangeError>; refusals are returned, never stored
editor.change({ fields, body });
await editor.save();
editor.revert();                     // text = base; returns the abandoned text
await editor.resolve('theirs' | 'mine' | { text });
await editor.refresh();
```

Svelte. The opener handles acquisition and release, so the editor component only ever sees text:

```svelte
<!-- FileDetail.svelte -->
<script lang="ts">
  const opening = openEditor(folder, () => path, { schema: Note }); // reactive; releases on change or destroy
</script>
{#if opening.editor}
  <NoteEditor editor={opening.editor} />
{:else if opening.error?.name === 'Missing'}<Empty>This note is no longer in the folder.</Empty>
{:else if opening.error}<Retry onclick={opening.retry}>{opening.error.message}</Retry>
{:else}<Loading />{/if}
```

```svelte
<!-- NoteEditor.svelte -->
<script lang="ts">
  let { editor } = $props();
  const s = $derived(editor.status);
</script>
<span role="status">
  {#if s.status === 'failed'}Not saved: {s.error.message}{#if editor.saving} · Retrying…{/if}
  {:else if s.status === 'conflict'}Changed elsewhere
  {:else if s.status === 'dirty' || editor.saving}Saving…
  {:else if s.status === 'detached'}Deleted elsewhere. This is the last text you saw.
  {:else}Saved{/if}
</span>
{#if s.status === 'failed'}<Button onclick={() => editor.save()}>Try again</Button>{/if}
{#if s.status === 'conflict'}
  <Compare theirs={s.theirs} mine={editor.text} />
  <Button onclick={() => editor.resolve('theirs')}>{s.theirs === null ? 'Let it go' : 'Use saved file'}</Button>
  <Button onclick={() => editor.resolve('mine')}>{s.theirs === null ? 'Restore it' : 'Replace saved file'}</Button>
{/if}
{#if editor.readError}<p role="alert">Couldn't refresh: {editor.readError.message}. Your text is kept.</p>{/if}
<Textarea readonly={!!editor.locked}
  bind:value={() => lf(editor.text), (v) => editor.replaceText(withFileNewlines(v, editor.text))} />
```

## The sequences

Throughout, B is the base and A(x) is a save attempt writing text x.

1. **Typing during a save.** You type r1 and A(r1) starts. You type r2. Now: text r2, `dirty`, `saving {r1}`.
   - If A lands, the base becomes r1 and the status stays `dirty`. Autosave writes r2 after the pause. A `save()` called at r1 resolves `{revision: r1}`; one called at r2 waits for r2.
   - If A fails, the failure belonged to r1, so it's dropped. The status stays `dirty`, autosave tries r2, and a failure there becomes `failed`.

2. **Reverting while a save runs.** The text is X, A(X) is in flight, and you call `revert()`, so the text becomes B. Expected is X, so the status is **`dirty`**.
   - If A lands, the base becomes X, and autosave writes B back, guarded against X.
   - If A fails, expected falls back to B, so the status is `clean` and the failure (which was about X) is dropped.
   - No BUSY refusal is needed. A write can't be recalled, so the definition says "dirty" honestly.

3. **Retrying a failure.** The status is `failed {E}` at revision r. `save()` starts A(r).
   - **The status stays `failed {E}` alongside `saving {r}`**, so a retry that hangs still shows why the last one failed.
   - If A lands, the status becomes `clean`. If it fails with E2, it becomes `failed {E2}`. **Retry keeps the old failure until the new outcome replaces it.** Today the error is cleared when the retry starts.
   - If you type during the retry, the status is `dirty` and E is dropped.

4. **Typing after a conflict.** The status is `conflict {theirs}`. Typing changes the text, and the status stays `conflict`. Autosave is paused, because it would only conflict again.
   - `save()` makes one guarded attempt. It succeeds only if storage has gone back to the base.
   - `resolve('mine')` makes `theirs` the base and saves, and a further outside change produces a new conflict. `resolve('theirs')` sets text and base to theirs and the status to `clean`. `resolve({text})` handles a merge.

5. **A refresh that fails.** `readError` is set, and the text, status, and autosave are untouched. The next successful read clears it.

6. **A refresh that finds the file deleted.**
   - With local work, the status becomes `conflict {theirs: null}` immediately. The Whispering and FileEditor banners that say "saving will report a conflict" become a direct state.
   - With a clean editor, the status becomes **`detached`** and the text is kept. Typing then produces a conflict straight away, because there's local work and storage differs from the base. "Restore it" means `resolve('mine')`.
   - A clean editor whose file changes elsewhere (to other text) just follows the new text.

## What this costs and what it buys

**What disappears:**
- The `buffer` container and `unsaved` as a separate object.
- The `unread/loading/unavailable` states, which move to `open()`.
- `BufferIssue` and the stored-refusal machinery (`record`/`execute`/`refusalOf`, `:504-563`). Callers already toast the errors that commands return.
- The `lastShown` workaround, the BUSY refusal on revert, and the duplication between `Recovery` and `Unsaved`.
- The per-app `isWriting`/`isUnsaved` derivations, replaced by `folder.drafts`.

**What moves elsewhere:**
- Loading, missing, and not-text handling move to the opener, a parent component or route.
- Handle lifetime becomes explicit (`using`, or the adapter releasing on destroy). Today it's inferred from subscriber counts (`subscribeTo`, `:1032-1063`). A handle that's never released keeps a clean editor's text in memory. That costs memory, never data.
- Eager conflict detection makes the owner compare each read with the base.
- Each view decides what a `detached` clean editor shows, or releases it.

**Which guarantees justify the remaining concepts:**
- The text exists for the editor's whole lifetime.
- Accepted input survives until it lands or is explicitly reverted or resolved.
- Each status names exactly one party who makes progress.
- `saving` carries the revision it covers, and `save()` reports which revision landed.
- Memory is not durability: `flush()` reports what is still unwritten, and crash recovery is a separate layer.

## Still open, and evidence to request

- **Should Svelte callers `{#await}` acquisition?** The opener adapter assumes they shouldn't, but Honeycrisp keeps `NoteDetail` mounted under `FileDetail` while it switches presentations, which may need a synchronous `folder.editors.get(path)` for paths already open.
- **Eager conflict on a read while dirty is a behaviour change.** A read and a save that land close together could cause flicker. I'd ask the coordinator to check how `answered`/`know` (`:632-663`) order reads against `stored()`.
- **Does `detached` earn a separate status, or could it be `clean` plus a `source` fact?** I chose a status because the next action it calls for (release, or restore by typing) differs from `clean`.
- **Please have the coordinator confirm the main branch's current state of `edit-owner.ts`.** This snapshot may be older than the work underway.
