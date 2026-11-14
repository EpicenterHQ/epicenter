**Verdict:** No. These five statuses should not be one mutually exclusive value. They mix two kinds of fact:

- **Behavior** decides who acts next and which commands mean what.
- **Coexisting facts** ("a write is in flight", "the last attempt failed") don't change any command.

I recommend three exclusive save states, with `saving` and `failure` carried as payload inside `unsaved`. File availability moves out of the editor and into an asynchronous `open`.

## What the snapshot implements (observed)

This snapshot exposes `getBuffer(): BufferSnapshot`, with `unread | loading | unavailable | ready`, and `ready.unsaved: dirty | saving | failed | conflict`. There is one merged `error?: BufferIssue` slot (`packages/folder/src/edit-owner.ts:141-145`). I couldn't read the main thread, so this describes the snapshot only. Engine facts that matter for the decision:

- **Typing during a save** keeps `saving` and clears a non-conflict error. If the in-flight write fails, the error is dropped and the newer revision is retried at once (`:857-872`).
- **Conflicts survive typing** (`:1153-1156`). Autosave then re-sends against the same stale witness, so the status flickers `conflict → saving → conflict`, costing a storage round trip each time (`:844-848`, `:1162`).
- **Retry** sets `saving` and erases the failure before the outcome is known (`:847`).
- **`discard()` is refused while a save runs** (`:1013-1016`). That's why Honeycrisp disables its buttons on `saving` (`FileDetail.svelte:256-257`).
- **An outside deletion with no input** removes the text (`unavailable`). `FileEditor.svelte:55-64` works around this with a local `lastShown` cache.
- **Every caller collapses `dirty | saving` into "Saving…"** (`FileEditor.svelte:81`, `TextDetail.svelte:157-161`, `FileDetail.svelte:237-241`). Honeycrisp and Whispering also rebuild per-path `isWriting`/`isSaving`/`isUnsaved` from the aggregate (`notes.svelte.ts:450-454`, `whispering.svelte.ts:1039-1049`). They gate `fileEdit.buffer` behind these so that observing save state doesn't trigger a file read (`RecordingDetail.svelte:74-77`).

The commands available under `dirty` and `failed` are identical: type, save, discard. Only `conflict` changes what `save` means. `saving` alone gates anything, and only because discard is refused during a save. That refusal is an engine choice, not a user need. So the five-way union is a display priority, which supports your hypothesis.

## Definitions

- **Revision:** a monotonically increasing id assigned to each accepted text change.
- **Witness:** the exact stored content the text was edited over. It's either the last read, taken before the first edit, or the content this editor last wrote.
- **Dirty:** `text !== witness text`. This is a derived relation, not stored state. Typing back to the witness makes the editor clean.
- **Saved:** not dirty, and nothing unresolved. It means "matches what this editor last observed in storage", not "storage holds this now", and it is not crash durability.
- **save():** covers the revision current at call time, R. It resolves `Ok` once some revision ≥ R has landed; a coalesced newer write also satisfies it. It resolves with an error if the attempt that carries R fails. Its result is `{ landed: Revision }`, so a caller can compare that to `editor.revision`. `Ok` never claims the *current* text is saved.
- **flush:** the folder-level version of the same contract. It skips the debounce, covers every path's revision as of the call, and is used by `settle` and `close`.
- **Failure:** the outcome of the most recent completed attempt. It persists until a later attempt completes, and clears when the editor becomes clean.
- **Conflict:** a fact about the witness, not about a revision. It persists across typing and suspends autosave.

## Recommended API

```ts
const opened = await folder.open(path, schema?);   // Result<Editor, OpenError: missing|not-text|read>
const editor = opened.data;

editor.text            // string — always, while open
editor.markdown        // schema view of the same text (cached derivation)
editor.revision
editor.state
  // | { kind: 'saved' }
  // | { kind: 'unsaved'; saving: boolean; failure: SaveFailure | null }
  // | { kind: 'conflict'; theirs: string | null | Uint8Array; error: SaveConflict }
editor.source          // { refreshError: ReadError | null }
editor.locked
editor.closed          // undefined | { reason: 'deleted' | 'released'; lastText: string }

editor.replaceText(t) / editor.change({fields, body})   // Result<Revision, Refusal> — refusals are returned, not stored
editor.save()          // Promise<Result<{landed}, SaveFailure | SaveConflict>>
editor.revert()        // text := witness text; always allowed
editor.resolve('mine' | 'theirs' | { text })
editor.refresh()
editor.release()
```

Each state kind corresponds to a different behavior:

| Kind | Who acts next | Effect on commands |
|---|---|---|
| `saved` | nobody | none |
| `unsaved` | the system (debounce, in-flight write, explicit retry) | `save` writes |
| `conflict` | the human | `save` won't overwrite; autosave is off; `resolve` is required |

Invariants: a failure implies dirty, and a conflict implies no write is in flight.

The lifetime rule: the folder retains unsaved and conflict work regardless of mounts. Clean text lives only while some handle is open; when the last handle is released, it's dropped.

## Consequential sequences

1. **Typing during a save.** R5 is in flight and the user types R6, so the state is `unsaved{saving:true}`. R5 lands, the witness becomes R5's text, and the editor is still dirty, so R6 autosaves after the debounce. A `save()` called at R5 resolves `{landed:5}`. If R5 fails instead, the state becomes `unsaved{failure, saving:false}` and R6's debounce sends R6. The failure stays visible until R6's outcome replaces it, so nothing is erased silently.
2. **Reverting while a save runs.** The text becomes the witness text, so the editor is clean while R5 is still in flight. When R5 lands, the witness becomes R5's text, the editor is dirty again, and autosave writes the original back. That takes two writes but ends in the right state, and no BUSY refusal is needed.
3. **Retrying a failure.** The state becomes `unsaved{saving:true, failure}`, so the UI reads "Not saved — retrying…". The outcome replaces the failure. Whispering's dedupe by `Recovery` identity (`whispering.svelte.ts:482-505`) now sees one stable failure instead of disappear-and-reappear.
4. **Typing after a conflict.** The conflict stays and no write is sent. `resolve('mine')` rebases the witness to `theirs` and saves. `resolve('theirs')` sets the text to `theirs`, or closes the editor if `theirs` is a deletion. If the user's text already equals `theirs`, the conflict clears on its own.
5. **A refresh fails while text remains.** This sets `source.refreshError` and leaves `state` alone. The compare-at-write still prevents an unseen overwrite, so a stale read is harmless.
6. **A refresh finds an outside change or deletion.** The rule: clean editors follow storage; dirty editors keep their text and raise a conflict.
   - Clean and changed: the text and witness update silently.
   - Clean and deleted: the editor closes with `{reason:'deleted', lastText}`. Nothing is at risk, and `lastText` replaces `FileEditor`'s cache.
   - Dirty and changed or deleted: the state becomes `conflict` straight away (`theirs: null` for a deletion), instead of waiting for a save to fail.

## Svelte use

```svelte
<!-- Parent: acquisition owns loading/unavailable -->
{#await folder.open(path) then opened}
  {#if opened.error}<OpenFailure error={opened.error} />
  {:else}<FileEditor editor={opened.data} />{/if}
{:catch}…{/await}
```

```svelte
<script lang="ts">
  let { editor }: { editor: Editor } = $props();
  $effect(() => () => editor.release());
  const s = $derived(editor.state);
</script>

{#if editor.closed}
  <p>This file was deleted elsewhere.</p><pre>{editor.closed.lastText}</pre>
{:else}
  <span role="status">
    {#if s.kind === 'saved'}Saved
    {:else if s.kind === 'conflict'}Changed elsewhere
    {:else if s.failure}Not saved: {s.failure.message}{s.saving ? ' — retrying…' : ''}
    {:else}Saving…{/if}
  </span>
  {#if s.kind === 'conflict'}
    <Compare theirs={s.theirs} mine={editor.text} />
    <Button onclick={() => editor.resolve('theirs')}>Use saved file</Button>
    <Button onclick={() => editor.resolve('mine')}>Replace saved file</Button>
  {:else if s.kind === 'unsaved' && s.failure}
    <Button disabled={s.saving} onclick={() => editor.save()}>Try again</Button>
  {/if}
  {#if s.kind !== 'saved'}<Button variant="ghost" onclick={() => editor.revert()}>Discard edit</Button>{/if}
  {#if editor.source.refreshError}<p role="alert">{editor.source.refreshError.message} Your text is kept.</p>{/if}
  <Textarea bind:value={() => editor.text, (v) => editor.replaceText(v)} readonly={editor.locked} />
{/if}
```

## What disappears, what moves, what remains

**Disappears:**
- `unread | loading | unavailable` and the `ready` wrapper; the `buffer` container goes with them.
- The merged `BufferIssue` slot and the stored-refusal machinery (`record`, `execute`, `refusalOf`, `state.refusal`, about 70 lines).
- The BUSY refusal on discard, and the button gating built around it.
- Conflict re-send flicker.
- The per-app `isWriting`/`isSaving`/`isUnsaved` derivations, and the read-avoidance gating of `buffer`. Observing an editor no longer triggers reads, and `folder.held(path)` can answer "is there work here" synchronously.
- `FileEditor`'s `lastShown`.

**Moves:**
- Loading moves to one acquisition boundary. That needs an `{#await}` or a generic helper, plus an explicit `release()` lifetime, effectively reference counting. That cost is real.
- Proactive conflict detection moves into refresh.
- Revision ids appear in `save()` results.

**Remains, and why:**
- The witness, because it is what prevents silent overwrites.
- `conflict` as its own kind, because it changes what `save` means.
- Folder ownership of unsaved work, because input must survive unmounts.
- The lock, because fenced actions need it.
- `saving` as a flag, because the UI must not offer a retry while one is in flight.
- A failure that survives typing, because the honest answer to "is my work safe?" is "no, the last attempt was refused".

## Unresolved product choices and checks for the coordinator

- **Clean editor on deletion: close, or let typing recreate the file?** I recommend closing. Recreating would keep text always present, but turns the next keystroke into a resurrection the user didn't ask for.
- **Conflict on refresh, or only on a save attempt?** Refresh is earlier and cheaper. The cost is that a divergence the user never planned to save can interrupt them.
- **Should failures auto-retry with backoff?** This is policy, and the shape works either way.
- **Execution evidence requests:**
  - Confirm the main thread's current implementation against this snapshot.
  - Test whether the conflict loop actually re-sends on each debounce: type after a conflict and count `replaceSource` calls.
  - Check that the Whispering failure toast fires twice across a failed retry today.
