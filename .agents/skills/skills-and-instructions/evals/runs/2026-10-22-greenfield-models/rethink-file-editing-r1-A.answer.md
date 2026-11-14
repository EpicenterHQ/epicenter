# Rethinking FileEdit: one source, a witness, and facts that can coexist

I couldn't read the thread (`read_thread` isn't available here), so "implemented" below means only what this snapshot contains. The snapshot already has the nested proposal: `BufferSnapshot` with `ready | … ; unsaved?: Unsaved` (`packages/folder/src/edit-owner.ts:123-145`), it's documented in `packages/folder/README.md:244-266`, and every caller reads `buffer.unsaved`. I can't tell whether the main conversation has moved past that.

## My reading of what you want

> An editor is text that always exists, plus the exact source that text came from. Saving, failing and conflicting describe how storage relates to that text. They are not stages the text passes through.

## The central question: these should not be one value

Your hypothesis holds. For each pair of facts, every combination is a real situation:

| | not saving | saving |
|---|---|---|
| **clean** | idle | you reverted while an older save is still running |
| **dirty** | waiting for autosave | normal save, or you typed during a save |

- **A failure and a retry can both be true.** The UI wants "Retrying… (disk full)".
- **Storage changing elsewhere doesn't require dirty text.** A clean buffer whose file was deleted elsewhere is diverged but not dirty.

The current code shows what happens when these are squeezed into one status:

- **Wrong label.** Typing during a save keeps the old `saving` flag (`edit-owner.ts:1152`). The snapshot says `saving` while the text on screen is newer than what's being saved.
- **Lost error.** An older revision's error is thrown away when newer typing exists (`857-860`). Typing after an error also clears it (`1153-1156`).
- **Retry hides the reason.** A retry clears the error as soon as it starts (`844-848`).

A five-way union really expresses a display priority. Keep that priority, but as a function the app owns, not as the model.

## Definitions

> - **Revision**: a counter that goes up each time a change is accepted.
> - **Base (the witness)**: the exact source that the current text derives from. It's set by a read, or by a save that landed.
> - **Dirty**: `text ≠ base`. It can flip without typing: when a save lands, the base becomes the text that was submitted.
> - **Saved(r)**: storage was seen to hold revision *r*, through a guarded write or a read.
> - **`save()`**: covers the revision current when you call it. If an older save is running, it waits for that, then makes one guarded attempt against the base. It resolves `Ok({ revision })` for the revision that landed. Typing after the call is not waited for; check `dirty` afterwards.
> - **`flush()`**: the folder-level version. It saves every dirty editor and returns detached `{ path, text, base, failure?, diverged? }` for each one that didn't save.
> - **Failure**: the error from the last *finished* attempt. A later attempt replaces it when that attempt finishes, not when it starts. It is cleared by a successful save, or when the text becomes clean.
> - **Diverged**: storage holds something other than the base, and the text can't simply follow it. Autosave stops; only an explicit `rebase()` can overwrite.

## Vanilla use

```ts
const opened = await folder.open('notes/a.md', { schema: Note }); // Result<Editor, NotFound | NotText | ReadFailed>
if (opened.error) return showOpenProblem(opened.error);
using editor = opened.data;          // a lease; held input outlives it

editor.text;          // string, always
editor.markdown;      // the same source read through Note
editor.revision;      // number
editor.dirty;         // boolean
editor.saving;        // boolean
editor.failure;       // SaveFailure | undefined
editor.diverged;      // { current: string | Uint8Array | null } | undefined
editor.refreshError;  // ReadError | undefined
editor.locked;        // reason | undefined

editor.replaceText(t);            // Result<{ revision }, Locked | Closed>
editor.change({ fields, body });
editor.revert();                  // replaceText(base): ordinary input
editor.rebase();                  // adopt diverged.current as the base; next save is guarded against it
const r = await editor.save();    // Result<{ revision }, SaveFailure | Conflict | Locked>
await editor.refresh();
```

`{ create: true }` opens with base `null`, for a file that doesn't exist yet.

## Svelte

The parent handles loading:

```svelte
{#await folder.open(path, { schema: Note }) then opened}
  {#if opened.error}<OpenProblem error={opened.error} />
  {:else}<NoteEditor editor={opened.data} />{/if}
{:else}<Loading />{/await}
```

The editor component never sees a missing text:

```svelte
<script lang="ts">
  let { editor }: { editor: Editor<typeof Note> } = $props();
  const e = reactiveEditor(editor);           // createSubscriber; releases on destroy
  function label() {
    if (e.diverged) return 'Changed elsewhere';
    if (e.saving) return e.failure ? 'Retrying…' : 'Saving…';
    if (e.failure) return 'Not saved';
    return e.dirty ? 'Unsaved' : 'Saved';
  }
</script>

<span role="status">{label()}</span>
{#if e.diverged}
  <Alert>
    {#if e.diverged.current === null}
      Deleted elsewhere. Your text is still here.
      <Button onclick={e.rebase}>Recreate the file</Button>
    {:else}
      Changed elsewhere. <Compare saved={e.diverged.current} mine={e.text} />
      <Button onclick={e.revert}>Use saved file</Button>
      <Button onclick={e.rebase}>Keep mine</Button>
    {/if}
  </Alert>
{:else if e.failure}
  Not saved: {e.failure.message}
  <Button disabled={e.saving} onclick={e.save}>Try again</Button>
{/if}
{#if e.refreshError}<p>Couldn't check for outside changes. <Button onclick={e.refresh}>Retry</Button></p>{/if}
<Input bind:value={() => e.markdown.fields.title, (title) => e.change({ fields: { title } })} />
<Textarea bind:value={() => e.text, (v) => e.replaceText(v)} readonly={!!e.locked} />
```

## The sequences

Notation: B is the base, T1/T2 are typed revisions, C is what storage holds after an outside change.

**1. Typing during a save.**
- T1 (revision 1) is being saved, and you type T2 (revision 2). The editor shows `dirty, saving`.
- The save lands: base becomes T1, `saving` goes false, and you're still dirty.
- The `save()` call made at revision 1 resolves `{ revision: 1 }`. The autosave for T2 runs, guarded against T1.

**2. Reverting during a save.**
- T1 is being saved and you revert. Text becomes B, which equals the base, so `dirty` is false while `saving` is true.
- The save lands: base becomes T1, so you're dirty again, and autosave writes B guarded against T1. Storage ends up holding B.
- One rule covers this, so nothing needs refusing. Today `discard()` is refused while a save runs (`edit-owner.ts:1013-1016`).

**3. Retrying a failure.**
- An attempt fails with "disk full". The editor shows `dirty, failure`.
- Autosave doesn't keep retrying the same failed revision. `save()` starts a retry, and the editor shows `saving, failure` ("Retrying…").
- Success clears the failure. Another failure replaces it.
- Typing after a failure keeps the failure and schedules an attempt for the new revision. The failure no longer applies only when that attempt finishes, or when the text becomes clean.

**4. Typing after a conflict.**
- The editor is diverged with `{ current: C }`. Typing is still accepted, but autosave stays off.
- Today, typing after a conflict re-schedules autosave (`edit-owner.ts:1162`) against the stale base, so it looks like the save is attempted and conflicts again after every pause. Please confirm this (see the requests at the end).
- How to resolve it:
  - "Keep mine" is `rebase()` then save, guarded against C.
  - "Use saved" is `revert()`: the text becomes clean, and clean text follows readable storage, so it becomes C.
  - A merge is `replaceText(merged)` then `rebase()`.
- These replace the three-way `resolveConflict` and its private `conflictCurrent` guard.

**5. A refresh fails, or finds the file deleted.**
- A failed read sets `refreshError` and changes nothing else.
- A read showing a *text* change:
  - Clean text follows it silently.
  - Dirty text becomes diverged **when the refresh happens**, not one autosave later.
- A read showing deletion or binary content:
  - The text stays, `diverged.current` is `null` or the bytes, and the editor isn't dirty. "Recreate" is `rebase()`.
  - Today a clean buffer loses its text in this case (`shownText`, `edit-owner.ts:1093-1099`). That's why Epicenter keeps `lastShown` (`apps/epicenter/src/folders/FileEditor.svelte:54-64`).
  - The cost of keeping the text: an orphaned clean buffer holds memory until its lease is released.

## What disappears, what moves, what stays

**Disappears:**
- The `unread | loading | unavailable` availability states, and the narrowing workaround ("capture a ready snapshot before deferred callbacks", `README.md:278-279`).
- The nesting (`BufferSnapshot` / `Unsaved`), `resolveConflict`, and the `BUSY` refusal from `discard`.
- `buffer.error` handling three different things at once. Refusals become command Results, read problems become `refreshError`, and storage problems become `diverged`. With that, the stored-refusal machinery (`record`/`execute`/`refusalOf`, `edit-owner.ts:504-563`) looks unnecessary, because the template already shows `locked`.
- The `status === 'ready' ? buffer.unsaved : undefined` chains in Epicenter, Capture and Honeycrisp.

**Moves:**
- Loading and not-found handling go to whoever calls `open`.
- The owner must compare each read with the base to detect divergence. It already holds `from` and `doc`.
- Each app writes its own display priority.
- Passive observers (Whispering `isSaving`, Honeycrisp `isWriting`) stay on the folder's status and don't open anything. That's what they already want (`apps/whispering/src/lib/whispering.svelte.ts:1039-1050`).

**What each remaining concept guarantees:**

| Concept | Guarantee |
|---|---|
| `text` | Present for the editor's whole life |
| base | No outside change is silently overwritten |
| `revision` | Save results say exactly what they covered |
| `dirty` | Answers whether it's safe to close |
| `saving` | An operation is still running |
| `failure` | The most recent storage verdict, until it's superseded |
| `diverged` | The only way to overwrite outside changes is to ask explicitly |

Crash recovery stays a separate folder journal; the editor only holds memory.

## Open questions and evidence requests

1. **Show me the current state of the main implementation.** I can only see this snapshot.
2. **Run a test: conflict, then type, then wait two pauses, and count calls to `replaceSource`.** This confirms or refutes the repeated-conflict claim in sequence 4.
3. **Does any caller depend on a clean, deleted buffer losing its text?** Honeycrisp's "no longer in the folder" screen would become `diverged.current === null && !dirty`.
4. **`rebase()` on a deleted file means "create only if still absent".** I need to confirm that `replaceSource(path, null, text)` already guards that way.

The point I'm least sure of is whether a failure should survive typing until the next attempt finishes. If you'd rather "Not saved" disappear on the next keystroke, the rule changes to "cleared by acceptance", and failure and saving become mutually exclusive again.
