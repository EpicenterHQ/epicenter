**Recommendation: change the design.** The five statuses should not be one mutually exclusive value. Three of them (`clean`, `dirty`, `conflict`) describe how the current text relates to storage, and those three do exclude each other. `failed` is extra information attached to unsaved text. `saving` is an independent fact about a write in progress, and it can carry older text. I'd also make opening a file an explicit async step, so that **an open document always has text**. Editors would then never handle a missing source.

## Evidence read

```
.agents/skills/adversarial-review/{SKILL.md, references/deletion-prizes.md}
REQUEST.md
packages/folder/src/{edit-owner.ts, edits.ts}
packages/svelte/src/edits.ts
packages/react/src/edits.ts
apps/epicenter/src/folders/FileEditor.svelte
apps/honeycrisp/src/routes/components/NoteDetail.svelte
apps/capture/src/lib/{captures.svelte.ts, components/TextDetail.svelte}
apps/whispering/src/routes/components/RecordingDetail.svelte
(grep) whispering.svelte.ts, honeycrisp notes.svelte.ts / FileDetail.svelte, whispering FileView.svelte
```

The thread was unavailable, so this describes only what this snapshot contains. The nested proposal is implemented as `getBuffer(): BufferSnapshot` (`edit-owner.ts:141-145`), and the adapters expose it as `.buffer`. Internally it is still independent flags: `Pending { saving: boolean; error }` (`:102-107`). `snapshotOf` squashes these into one status, and `saving` hides any error (`:484-490`).

## What the code and callers show

1. **Reading `.buffer` starts a file read.** In the Svelte adapter, `trackRead` starts a read on first access (`svelte/edits.ts:24-28`). React does the same through a `requested` flag and an effect (`react/edits.ts:32-36`). Whispering and Honeycrisp therefore avoid touching `fileEdit.buffer` unless `isSaving || isUnsaved || opened.data?.kind === 'text'` (`RecordingDetail.svelte:74-77`, `FileDetail.svelte:78-79`, `FileView.svelte:66`).
2. **Callers already keep "text always exists" by hand.** When the file is deleted and nothing is held, `shownText` returns `undefined` (`edit-owner.ts:1096`). Epicenter works around this with `lastShown` (`FileEditor.svelte:55-64`). Capture and Honeycrisp drop the text and show "no longer here".
3. **No caller tells `dirty` from `saving`.** Epicenter (`:81`) and Capture (`:157-162`) show "Saving…" for both. Honeycrisp's `isWriting` and Whispering's `isSaving` mean "held and not failed". Callers branch only on failed vs. conflict, which decides between Try again and resolve.
4. **The implementation already treats conflict and failure differently.** Typing keeps a conflict but erases a failure (`:1153-1156`). A failure from an older revision is dropped (`:860`). So a conflict belongs to the base (the stored source the edit started from); a failure belongs to one save attempt.
5. **`buffer.error` mixes four kinds of problem:** command refusals, read errors, `SourceUnavailable`, and save errors (`:134-139`). Epicenter offers "Try reading again" for whatever is there (`FileEditor.svelte:114-123`), including a refusal like `Locked`, where reading again doesn't help.

## Definitions

- **base**: the exact stored source this owner last knew storage held, from a read or from its own successful write. It is the guard on every write.
- **saved**: storage is known to hold exactly `text` (`text === base`, and nothing seen since says otherwise).
- **unsaved / dirty**: `text !== base`.
- **conflict**: storage is known to differ from `base`. A guarded write found this, or a refresh found the file missing or no longer text.
- **save()** (this is also "flush"; one word is enough): makes the text that was current at the call durable. If an older write is running, it waits for it and then sends this text. It resolves for that revision only; typing after the call doesn't extend it. Autosave is just `save()` after a pause.
- **writing**: a guarded write is in flight. Its text may be older than `text`.

Invariants:
- Conflict stops all writes, so `conflict ⇒ ¬writing`.
- A failure only exists on unsaved text.
- A clean document adopts outside text changes silently.

## The sequences

**Typing during a save.** r1 is in flight and the user types r2. State: `unsaved, writing`. r1 lands, `base := r1`, still `unsaved`. Autosave sends r2. `save()` called during r1 resolves when r1 lands. `save()` called after the typing resolves when r2 lands.

**Reverting while a save runs.** r1 is in flight and `revert()` sets `text := base` (the original). This is correct for that instant: `saved, writing`. Then r1 lands, `base := r1`, and the state becomes `unsaved`. Autosave writes the original back. Today `discard()` refuses this case with `BUSY` (`:1011-1016`); `revert()` should never be refused.

**Retrying a failure.** The failure stays visible while the retry runs (`unsaved{failure}, writing`, displayed as "Retrying…"). The retry's result replaces it: success clears it, failure overwrites it. Typing does not clear it, because typing doesn't fix storage. Reverting to clean does clear it. Today the code clears the failure at the start of the attempt (`:847`) and on typing (`:1153`), so the alert flickers off and on.

**Typing after a conflict.** The edit is accepted. The state stays `conflict` with the same stored payload, and nothing is written. Today `submitText` schedules autosave (`:1162`), and `drain` clears the error and re-sends with the old guard (`:844-849`). That is a predictable repeat conflict, and the status flickers conflict→saving→conflict. If a refresh finds storage back at `base`, the conflict clears by itself.

**Refresh fails while usable text remains.** `refreshError` is set, and text and persistence are unchanged. It is about how fresh our knowledge is, not about the text.

**Refresh finds the file deleted, nothing dirty.** The text stays, and the state is `conflict{stored: null}`. Nothing autosaves. The user chooses Restore (`overwrite()`) or Close (`release()`).

What that costs: a clean "ghost" can outlive its file, the UI needs that one state, and the document stays in memory until it is released. In return the "text always exists" promise holds for the whole life of a handle, and `lastShown` goes away. If the file is replaced with non-text content, the same rule applies.

## Proposed API

```ts
type Persistence =
  | { state: 'saved' }
  | { state: 'unsaved'; failure?: SaveFailure }
  | { state: 'conflict'; stored: string | Uint8Array | null };

interface TextDoc<S> extends Disposable {
  readonly path: string;
  readonly text: string;                 // always
  readonly markdown: MarkdownContent<S>; // same source, schema view
  readonly persistence: Persistence;     // text ↔ storage
  readonly writing: boolean;             // operation, orthogonal
  readonly locked: boolean;              // fence/closing
  readonly refreshError?: ReadError;
  replaceText(text: string): Result<void, Locked>;
  change(c: DocumentChange<S>): Result<void, Locked | InvalidFields>;
  save(): Promise<Result<void, SaveFailure | SaveConflict | Locked>>;
  revert(): string;                       // text := base (adopts stored on conflict); returns dropped text
  overwrite(): Promise<Result<void, ...>>; // conflict: base := stored, then save
  refresh(): Promise<Result<void, ReadError>>;
  subscribe(fn: () => void): () => void;
  release(): void;
}
// folder.files.open(path, schema?) / folder.tables.x.open(id)
//   : Promise<Result<TextDoc<S>, Missing | NotText | ReadError>>
```

The folder still owns one buffer per path, shared by every open handle. Releasing a handle never drops unsaved text, and the folder's `settle()` and `close()` still flush. Nothing here is crash recovery: unsaved text lives only in memory.

**Plain TypeScript:**

```ts
const opened = await folder.files.open('notes/a.md');
if (opened.error) return showOpenError(opened.error);
using doc = opened.data;
doc.subscribe(render);
doc.replaceText(doc.text + '\n- milk');
const saved = await doc.save(); // this revision only
if (saved.error?.name === 'Conflict') showCompare(doc.persistence);
```

**Svelte.** Loading moves out of the editor into a route helper that releases on destroy:

```svelte
<!-- FileRoute.svelte -->
<script lang="ts">
  let { path } = $props();
  const opened = openText(folder.files, path); // { doc?, error?, loading }
</script>
{#if opened.loading}<Loading label="Reading…" />
{:else if opened.error}<OpenFailed error={opened.error} retry={opened.retry} />
{:else}<FileEditor doc={opened.doc} />{/if}

<!-- FileEditor.svelte -->
<script lang="ts">
  let { doc }: { doc: TextDoc } = $props();
  const p = $derived(doc.persistence);
</script>
<span role="status">
  {#if p.state === 'conflict'}Not saved: the file changed elsewhere
  {:else if doc.writing}{p.state === 'unsaved' && p.failure ? 'Retrying…' : 'Saving…'}
  {:else if p.state === 'unsaved'}{p.failure ? `Not saved: ${p.failure.message}` : 'Unsaved'}
  {:else}Saved{/if}
</span>
{#if p.state === 'conflict'}
  <Alert.Root variant="destructive">
    {p.stored === null ? 'Deleted elsewhere.' : 'The saved file changed.'}
    <Button onclick={() => doc.overwrite()}>{p.stored === null ? 'Restore my text' : 'Replace saved file'}</Button>
    {#if p.stored === null}<Button onclick={close}>Close</Button>
    {:else}<Button onclick={() => doc.revert()}>Use saved file</Button>{/if}
  </Alert.Root>
{:else if p.state === 'unsaved' && p.failure && !doc.writing}
  <Button onclick={() => doc.save()}>Try again</Button>
  <Button onclick={() => doc.revert()}>Discard edit</Button>
{/if}
{#if doc.refreshError}<p>Couldn't check for outside changes. <Button onclick={() => doc.refresh()}>Retry</Button></p>{/if}
<Textarea readonly={doc.locked}
  bind:value={() => lf(doc.text), (v) => doc.replaceText(withFileNewlines(v, doc.text))} />
```

## What gets deleted

- **From the snapshot:** the `unread`/`loading`/`unavailable` states, `text | undefined` on every getter, `ChangeError.NoSource`/`NotText`, `SourceUnavailable` in `buffer.error`, and the `BufferIssue` union.
- **From the adapters:** the read-on-access side effect (`trackRead`, the React `requested` flag and effect).
- **From callers:** the Whispering/Honeycrisp gating, Epicenter's `lastShown`, and each caller's loading/missing/not-text branches inside the editor.
- **The refusal machinery** (`refusal`/`record`/`execute`, `:504-563`): refusals come back as return values instead of living in the snapshot.
- **The `resolveConflict('current')` re-read path** (`:1246-1278`): it becomes `revert()`.
- **The `discard` BUSY refusal.**
- **`Unsaved`/`Recovery` as separate entities.** `revert()` returns the text it dropped, and the folder's settle/close report what is still held.

## What it adds

- Handle lifetime (`open`/`release`, ref counting) and a route-level loader. Loading moves out of the editor; it doesn't disappear.
- A ghost state after outside deletion.
- `writing` as a second axis, so the label logic above takes four branches. One exported pure `describe(doc)` should own that display priority, not the contract.
- Capture's under-textarea `buffer.error` display (`TextDetail.svelte:206`) must handle the `replaceText` result itself.

## Why the remaining concepts earn their place

- `persistence` is the one claim the user cares about: is my text stored, and if not, what do I do? Each variant has its own payload and its own actions.
- `writing` exists because a save of older text is real and can overlap any persistence state.
- `refreshError` stays separate because it is about how fresh our knowledge is, not about the text.

## Correctness issues in the current snapshot (separate from the redesign)

1. **Autosave keeps writing after a conflict.** It re-sends against the old base on every pause, so each attempt re-conflicts (`:1162`, `:844-849`). Please run a test that types after a conflict and counts `replaceSource` calls.
2. **Failures get erased.** Typing or a superseded revision clears a non-conflict failure (`:860`, `:1153-1156`). "Not saved" disappears while storage may still be failing. This is a product decision; I recommend keeping the failure until a later attempt succeeds.
3. **Wrong recovery action for refusals.** Epicenter offers "Try reading again" for command refusals (`FileEditor.svelte:114-123`).

## Open questions

- **Can each caller acquire before it renders?** Every caller I read already has the component keyed by path, which suggests yes. Honeycrisp's `notes.open(...)` and Whispering's view-mode switch still need checking. If a caller can't, the prize shrinks to the adapter side-effect cleanup.
- **Is the ghost acceptable?** Whether to keep text for a clean file deleted elsewhere is a product call. If the answer is no, deletion has to end the handle, and callers need an "ended" branch.
- **None of this is verified at runtime.** Please run the type check and the folder edit tests (`edits.test.ts`, `field-edits.test.ts`) against a prototype before relying on it.
