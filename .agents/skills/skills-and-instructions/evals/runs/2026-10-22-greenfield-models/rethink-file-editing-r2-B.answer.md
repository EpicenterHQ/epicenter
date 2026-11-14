# Rethinking Epicenter's file-editing API

**Short answer:** no. The five statuses should not be one mutually exclusive value. They describe four different things:

- **Dirty** is a comparison between the current text and the stored version it started from.
- **Saving** is a write in progress, and the text it is writing may be older than what's on screen.
- **Failed** is the result of one past write.
- **Conflict** means storage has moved away from the stored version the edits started from.

These legitimately overlap: dirty and saving (typing during a save), saving and failed (a retry), conflict and failed (a resolution attempt fails). Putting them in one union forces a display priority into the contract. This snapshot already shows that loss: newer typing inherits `saving: true` (`packages/folder/src/edit-owner.ts:1152`), and Epicenter shows both dirty and saving as one "Saving…" label (`apps/epicenter/src/folders/FileEditor.svelte:81`). Your hypothesis holds. A union still makes sense *within* each fact, for example storage being `text | missing | not-text`.

**What I could and couldn't check.** I read the snapshot's `edit-owner.ts`, both edit adapters, and the Epicenter, Honeycrisp, Capture and Whispering callers. The snapshot implements the nested `BufferSnapshot`/`Unsaved` shape (`edit-owner.ts:123-145`), and all four apps consume `buffer.unsaved`. Thread reading isn't available, so I could not check the main conversation's latest state beyond this snapshot.

## The destination

The handle *is* the in-memory copy of the file (the buffer). It is opened asynchronously and always has text. It reports each independent fact as its own field.

```ts
const opened = await folder.open(path, { schema: noteSchema });
// Result<TextFile, NotFound | NotText | TooLarge | ReadFailed>
if (opened.error) return showOpenFailure(opened.error);
using file = opened.data;          // releases this handle; dirty input outlives it

file.replaceText('# Title\n');     // Result<{ revision }, ChangeError>, synchronous
file.change({ fields: { title: 'Hi' } });  // same text, read through the schema

const s = file.current;            // immutable snapshot; stable identity until something changes
s.text;      s.markdown;           // always present
s.revision;                        // count of changes accepted into memory
s.dirty;                           // s.text !== base text
s.saving;    // { revision } | undefined          — the revision being written
s.failure;   // { revision, error } | undefined   — last settled attempt failed
s.conflict;  // { current: string | Uint8Array | null } | undefined
s.storage;   // { observed: 'text' | 'missing' | 'not-text', checking, error?: ReadError }
s.locked;    // { reason } | undefined

await file.save();      // Result<{ revision }, SaveError | ActionError>
file.revert();          // text and base become the observed storage
await file.keepMine();  // conflict: adopt storage as base, then save
await file.refresh();   // Result<void, ReadError>; changes only storage, unless clean
file.discard();         // Recovery { path, text, base }
await folder.flush();   // Recovery[] still held after a write attempt
```

**The witness** (the stored version used to guard writes; I call it the *base*) is the one internal concept everything hangs on. It is the exact stored source the current text started from, or the last thing this editor stored. Every write goes through the existing guarded `replaceSource(path, base, text)`. The API names the base because dirty, conflict and revert are all defined in terms of it.

## Definitions

- **Accepted:** `replaceText`/`change` returned Ok. The input is in folder memory and survives unmounts, failed saves and conflicts. It does not survive a crash.
- **Dirty:** `text !== base`, compared by content, not by revision count. Typing back to the base text makes the file clean.
- **Saved:** revision *r* is saved when a guarded write of *r*'s text against the base has committed. The base then becomes that text.
- **`save()`:** settles the revision that was current *when you called it*. If an older write is in flight, it waits for that write and then sends the newer text; it never sends two at once. It resolves `Ok({ revision: r })` when *r* (or a later revision that already subsumed it) has committed. Otherwise it returns *r*'s failure or conflict. It says nothing about typing that happens after the call.
- **`flush()`:** a folder-level quiet point. It saves every dirty file, repeating while newer input arrives. A revision that fails is not retried within the same flush. It resolves with what is still held. Close and the action fence use it.
- **Durable recovery:** a separate, opt-in journal. Nothing called "save" or "flush" promises survival across a crash. Dirty means "in memory only."

## The requested sequences

| Sequence | Result |
|---|---|
| **Typing during a save** | `saving.revision = 4` while `revision = 6`, and `dirty` is true. When 4 lands, the base becomes text 4 and the file is still dirty, so autosave continues with 6. `save()` called at revision 4 resolves `Ok({ revision: 4 })`. |
| **Revert during a save** | Text returns to the base, so `dirty` becomes false while `saving` still shows 4. When 4 lands, the base becomes text 4, which differs from the text, so the file is dirty again and autosave writes the reverted text back. No special case is needed. Storage briefly holds 4, which is honest because a write that's already sent can't be recalled. (Today `edit-owner.ts:1139` does the same by keeping the input while a save runs.) |
| **Retrying a failure** | `failure` stays in place while the retry runs (`saving` and `failure` together), so the error banner doesn't flicker. The retry *replaces* it when it settles: cleared on success, overwritten on failure. Today the retry clears the failure at start (`edit-owner.ts:847`). |
| **Typing after a failure** | `failure` keeps its `revision`. It stays until a later attempt settles, because its cause (disk, permissions) probably still applies. `failure.revision < revision` tells the view "your latest typing hasn't been tried yet." Autosave tries the newer text normally. Today typing clears the failure (`edit-owner.ts:1153-1156`). |
| **Typing after a conflict** | `conflict` stays. It describes base versus storage, and typing changes neither. Autosave pauses while the conflict stands, since every write would conflict again. It ends with `revert()`, `keepMine()`, or `replaceText` followed by `keepMine()` for a manual merge. |
| **Refresh fails** | `storage.error` is set. Text, base, `failure` and `conflict` are untouched. Safety never depended on reads, because the guarded write is the real check. |
| **Refresh finds deletion, file dirty** | `storage.observed = 'missing'` and `conflict = { current: null }` immediately. A refresh can detect a conflict without any save attempt. `keepMine()` recreates the file. `discard()` returns the text for recovery. |
| **Refresh finds deletion, file clean** | Text stays: the last stored text, read-only by convention, with `storage.observed = 'missing'`. If the user types, the next save conflicts against `null`, and `keepMine()` recreates the file. Epicenter already fakes this with `lastShown` (`FileEditor.svelte:55-64`). Honeycrisp can still show "no longer in the folder" based on `storage.observed`. The cost: a clean buffer for a deleted file stays in memory while a handle is held. It is released with the last handle. |
| **Clean file, outside text change** | Text follows storage and the base moves with it. This is the only case where text changes without a command. |

## Invariants that justify each remaining concept

1. An open handle always has text.
2. Text changes only by command, or by following storage while clean.
3. No write without the base. That makes conflicts detectable, never silent.
4. `dirty ⇔ text ≠ base`.
5. `conflict ⇒ dirty` and autosave is paused.
6. `saving.revision ≤ revision` and `failure.revision ≤ revision`. Revisions are what make "which text?" answerable, which is why they're public.
7. A dirty file is kept in the folder until it is saved or discarded. A clean one lives only as long as its handles.

## Realistic Svelte use

```svelte
<!-- Parent: loading and open failures live here, not in the editor -->
{#await folder.open(path) then opened}
  {#if opened.error}<OpenFailure error={opened.error} retry={() => (path = path)} />
  {:else}<FileEditor file={opened.data} />{/if}
{/await}
```

```svelte
<script lang="ts">
  import { fileState } from '@epicenter/svelte/edits';
  let { file }: { file: TextFile } = $props();
  const s = fromFile(file);                 // reactive file.current
  $effect(() => () => file.release());
  const untried = $derived(s.failure && s.failure.revision < s.revision);
</script>

<span role="status">
  {#if s.conflict}Changed elsewhere
  {:else if s.failure}Not saved: {s.failure.error.message}{s.saving ? ' · retrying…' : untried ? ' · newer edits pending' : ''}
  {:else if s.saving || s.dirty}Saving…
  {:else if s.storage.observed === 'missing'}Deleted elsewhere
  {:else}Saved{/if}
</span>

{#if s.conflict}
  <Compare saved={s.conflict.current} mine={s.text} />
  <Button onclick={() => file.revert()}>Use saved file</Button>
  <Button onclick={() => file.keepMine()}>Replace saved file</Button>
{:else if s.failure && !s.saving}
  <Button onclick={() => file.save()}>Try again</Button>
{/if}
{#if s.storage.error}
  <p>Couldn't check for outside changes. <Button onclick={() => file.refresh()}>Retry</Button></p>
{/if}

<Textarea readonly={!!s.locked}
  bind:value={() => s.text, (v) => file.replaceText(withFileNewlines(v, s.text))} />
```

The display priority still exists, but now it sits in the template (or an exported `saveLabel(s)` helper) as presentation, not in the state contract.

## What disappears

- **Gone from the editor's state:** `unread | loading | unavailable`, the `buffer` container, the `Unsaved` entity, and `getText(): string | undefined`. Open failures replace them.
- **The mixed `buffer.error` slot**, which today combines read errors, refusals, missing/not-text, and save errors (`edit-owner.ts:134-139`). It splits into `storage.error`, `failure` and `conflict`, and refusals come back only as command results. That removes the stored-refusal machinery (`record`/`execute`/`refusalOf`, about 70 lines).
- **App workarounds:** Honeycrisp and Whispering run a separate file-kind query before touching the buffer (`FileDetail.svelte:77-82`), and Epicenter keeps `lastShown`. `open()` returning `NotText`/`TooLarge` replaces the first, and invariant 1 replaces the second.
- **Adapter logic:** the auto-read on first access in both adapters (`trackRead` in `packages/svelte/src/edits.ts:24-28`, and the React effect).
- **`resolveConflict('current' | 'draft' | { text })`** becomes `revert` and `keepMine`, with text resolution done as `replaceText` followed by `keepMine`.

## Where the complexity moves

- **Loading** moves to routes or loaders, through `{#await}` or a resource.
- **Lifetime** moves to handles (`release`/`using`). Forgetting to release keeps a *clean* buffer alive; it never loses input.
- **Revision numbers** become public, and the view must reason about them only to explain "newer edits pending."
- **The folder** must keep a clean buffer for a deleted file while a handle exists, and treat refresh as a source of conflicts. The tick ordering logic stays inside the owner as before.

## Unresolved questions

1. Whether `failure` should be *retained* across a retry and new typing, as I recommend, depends on whether users read a lingering banner as current. This is a product question.
2. Typing back to the base text during a conflict makes the file clean, so the text then follows storage. That is consistent with the rules but could surprise someone. One alternative is to pin text while a conflict exists.
3. A synchronous `folder.peek(path)` for list badges may still be needed. Today's aggregate status (`getStatus().unsaved`/`failures`) covers the current callers.
4. **Evidence to request from the coordinator:** whether the main thread's nested `buffer`/`unsaved` work has moved past this snapshot. If it has changed how `failure` is cleared, the comparisons to current behavior above need rechecking.
