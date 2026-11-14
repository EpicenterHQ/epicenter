**Recommendation: change the design.** The five statuses should not be one mutually exclusive value. Of the five, only three are truly exclusive, and all three describe how the text relates to storage: **saved**, **unsaved** and **diverged**. "Saving" and "a failure" are facts that can be true at the same time, and they belong inside the unsaved case. Pair that with a second change: an editor is obtained asynchronously, so once you have one its `text` always exists. Together these remove the availability states, the stored refusal machinery, and several caller workarounds.

## Files read
```
.agents/skills/adversarial-review/{SKILL.md, references/deletion-prizes.md}
REQUEST.md
packages/folder/src/{edit-owner.ts, handle.ts (replaceSource only)}
packages/{svelte,react}/src/edits.ts
apps/epicenter/src/folders/FileEditor.svelte
apps/honeycrisp/src/{lib/notes.svelte.ts, routes/components/NoteDetail.svelte}
apps/capture/src/lib/components/TextDetail.svelte
apps/whispering/src/routes/components/RecordingDetail.svelte (+ grep of whispering callers)
```

## What this snapshot actually implements
The nested proposal is already in place. `BufferSnapshot` is `unread | loading | unavailable | ready{text, unsaved?}` plus a catch-all `error?: BufferIssue` (`edit-owner.ts:141`). Internally, though, `Pending` stores `saving: boolean` and `error` as **independent** fields (`:102`). They only become one status in `snapshotOf` (`:484`), where "saving" takes priority over any error. That is exactly the "display priority" your hypothesis warned about, and the code itself shows the facts are not exclusive:

- **Typing clears a failure but keeps a conflict** (`:1153`). So the two are different kinds of thing, not two values of one state.
- **A retry erases the old failure the moment it starts** (`drain`, `:847`), so the failure is invisible while the retry runs.
- **`buffer.error` merges four sources by priority**: command refusals, then read errors, then source problems (`:573`). A refused keystroke can hide a read failure.

## A behaviour defect, separate from the redesign
**Typing after a conflict triggers a write that is certain to be refused.** The sequence:

1. `submitText` keeps the conflict and calls `schedule()`.
2. One second later, `drain` sets `saving: true` and clears the error.
3. The write is sent with the old `from` (`:827`), which `handle.ts:347` uses as the write guard, so it is refused again.

While that write is in flight, the status reads "saving". Epicenter's and Capture's conflict alerts only render for `failed | conflict`, so the alert disappears and "Saving…" shows. Clicking "Replace saved file" during that window is refused with `BUSY` (`:1231`). I did not confirm the engine's guard semantics in a test. **Please run:** conflict → type → wait past `SAVE_AFTER_MS` → check that a write was attempted and that `resolveConflict('draft')` returns `BUSY` during it.

## Definitions
- **Base:** the stored content this text was last reconciled with, i.e. the last read adopted or the last write that landed.
- **Saved:** storage is known to hold exactly `text` and no write is in flight. Saved is a relationship that holds right now, not "a save call resolved".
- **Unsaved:** `text` differs from what storage holds or will hold, and storage still matches the base. Autosave is responsible for it.
- **Diverged:** storage no longer holds the base. Either a guarded write was refused, or a newer read differed from the base while the editor held edits or storage became non-text or missing. Autosave stops.
- **`save()`:** resolves `Ok` once storage holds the revision that was current when you called it, or a later one. It does **not** promise the editor is saved afterwards, because newer typing may already exist. On failure it returns the error of the attempt that covered that revision.
- **Flush:** the folder-level operation used by close and fences. It attempts every held revision once and returns what remains, for recovery. It never retries in a loop.

## The greenfield API
```ts
type Storage =
  | { status: 'saved' }
  | { status: 'unsaved'; saving: boolean; failure?: SaveFailure } // failure = last settled attempt
  | { status: 'diverged'; current: string | null | 'binary'; edited: boolean };

type TextEditor<S> = {
  readonly path: string;
  readonly text: string;              // always present
  readonly revision: number;
  readonly storage: Storage;
  readonly stale?: ReadError;         // last refresh failed; text and storage are as last known
  readonly locked?: { reason: string };
  markdown(): MarkdownContent<S>;     // derived from text, cached per revision
  replaceText(text: string): ChangeResult;
  change(c: DocumentChange<S>): ChangeResult;
  save(): Promise<Result<{ revision: number }, SaveError | ActionError>>;
  keepMine(): Promise<Result<…>>;     // diverged → base := current; unsaved; save
  takeTheirs(): Result<…>;            // diverged with text current → text := current; saved
  discard(): Recovery | undefined;
  subscribe(fn: () => void): () => void;
  [Symbol.dispose](): void;           // release this lease
};
folder.files.open(path): Promise<Result<TextEditor, ReadError | SourceUnavailable>>;
folder.tables.notes.open(id): Promise<Result<TextEditor<NoteSchema>, …>>;
```
Each case of the union earns its place because it changes behaviour. **Saved** means nothing to do. **Unsaved** means autosave runs and retries. **Diverged** means autosave stops and the person must resolve it. The cases also carry different data. Every remaining impossible combination is now unrepresentable:
- saving while diverged (the conflict defect above)
- a failure while saved (a revert must drop it)
- a saved editor with a write in flight

**Vanilla use:**
```ts
const opened = await folder.files.open('notes/a.md');
if (opened.error) return show(opened.error);
using editor = opened.data;
editor.replaceText(editor.text + '\nmore');
const r = await editor.save();      // r.data.revision ≥ the revision when save() was called
```

**Svelte:** the route or parent awaits, and the component receives a ready editor.
```svelte
{#await folder.files.open(path) then opened}
  {#if opened.error}<Unavailable error={opened.error} />{:else}<Editor editor={createEditor(opened.data)} />{/if}
{/await}

<!-- Editor.svelte -->
{@const s = editor.storage}
<span role="status">
  {#if s.status === 'saved'}Saved
  {:else if s.status === 'unsaved'}{s.saving ? (s.failure ? 'Retrying…' : 'Saving…') : s.failure ? 'Not saved' : 'Edited'}
  {:else}{s.current === null ? 'Deleted elsewhere' : 'Changed elsewhere'}{/if}
</span>
{#if s.status === 'unsaved' && s.failure && !s.saving}
  <Alert>{s.failure.message} <Button onclick={() => editor.save()}>Try again</Button></Alert>
{:else if s.status === 'diverged'}
  <Alert>
    <Button onclick={() => editor.keepMine()}>{s.current === null ? 'Restore file' : 'Replace saved file'}</Button>
    {#if typeof s.current === 'string'}<Button onclick={() => editor.takeTheirs()}>Use saved file</Button>{/if}
    <Button onclick={close}>{s.edited ? 'Discard edit' : 'Close'}</Button>
  </Alert>
{/if}
{#if editor.stale}<p>Couldn't check for outside changes. <Button onclick={editor.refresh}>Retry</Button></p>{/if}
<Textarea bind:value={() => editor.text, (v) => editor.replaceText(v)} readonly={!!editor.locked} />
```

## The sequences you asked for
1. **Typing during a save of r1.** The status stays `unsaved{saving:true}` at r2. When r1 lands, the base becomes r1 and the status is still unsaved, so autosave writes r2. A `save()` called at r1 resolves after r1 lands. A `save()` called at r2 resolves after r2. (The current loop already behaves this way through `again`.)
2. **Reverting during a save.** The text equals the old base, but a write of r1 is in flight, so by definition the editor is unsaved, not saved. When r1 lands, the reverted text differs from the new base, and autosave writes it back. The current code agrees, because it keeps the input while `running` (`:1142`).
3. **Retrying a failure.** The status is `unsaved{saving:true, failure}`, so the person sees "Retrying…" and does not lose the reason. The new attempt's outcome replaces the failure only when it settles. Typing keeps the failure, because the text is still not persisted and the cause (for example, a full disk) still applies. A revert back to the base removes it.
4. **Typing after a conflict.** The status stays `diverged` and `edited` becomes true. No write is attempted. Resolution is explicit, through `keepMine` or `takeTheirs`, or a manual merge via `replaceText` followed by `keepMine`.
5. **A refresh that fails while text is shown.** Only `stale` is set. Text and storage keep their last known values.
6. **A refresh that finds the file deleted.**
   - With edits: `diverged{current:null, edited:true}`, and `keepMine` recreates the file.
   - **Without edits:** `diverged{current:null, edited:false}`, and the text is kept. Today the text disappears (`shownText` → `unavailable`). Epicenter works around that with `lastShown` and then mislabels it "Your unsaved source is still available" in a read-only box (`FileEditor.svelte:55,143`). Honeycrisp shows "no longer in the folder" instead.

   Under the proposal, each app decides whether to close, offer restore, or keep showing the text. A clean editor whose file changes to other *text* simply adopts the new text and stays saved.

## What this deletes
- **Availability states:** `unread`, `loading`, `unavailable`, `UNREAD`, `ChangeError.NoSource` and `NotText` on open editors.
- **Adapter workarounds:** the Svelte `trackRead`/`trackChanges` split and the React `requested`/effect read trigger.
- **Caller narrowing:** every `buffer.status === 'ready' ? …` and `text === undefined` branch in Epicenter, Capture, Honeycrisp and Whispering, plus Epicenter's `lastShown`.
- **Stored refusals:** the `refusal`/`record`/`execute`/`refusalOf` code (about 80 lines) and the `BufferIssue` catch-all. Refusals come back from the command, which Honeycrisp's toasts already use.
- **Conflict plumbing:** `conflictCurrent` as a private guard (the diverged base is stored explicitly instead), `resolveConflict`'s re-read-and-compare branch, and the doomed-autosave defect.

## What moves elsewhere, and the cost
- **Loading and "not text" move to acquisition.** Each view needs an `{#await}` or a loader in the parent, and must handle an open that fails.
- **The owner now has a lease lifecycle.** It must count open handles, because a clean editor kept after deletion stays in memory until it is released. A forgotten `dispose` leaks the path state, which today's subscribe-based pruning avoids.
- **Apps decide what deletion means.** The editor no longer disappears on its own, so Honeycrisp must actively close a deleted note it previously dropped automatically.
- **Two state machines become three relations.** That is more than one flat status, and the coexistence of `saving` and `failure` is a choice the UI has to render, not a given.
- **Kept as-is:** one owner per path, fences, close-then-flush, and recovery values returned from `discard` and close. These protect input and are not touched.

## Unresolved
- **Whispering's passive path:** `RecordingDetail.svelte:74` only reads `buffer` once the view needs text. I could not confirm that acquiring eagerly would not add reads for rows that are only listed. **Please measure** how many reads a list view triggers if each detail is opened eagerly.
- **Adopting outside text:** whether a clean editor should take on new text silently, or show it as a change the person accepts, is a product choice.
- **Race between a read and a write:** the rule that diverged implies no write in flight depends on a read observed during an in-flight write waiting for that write to settle. The tick ordering in `answered` (`:652`) suggests this is achievable, but nothing proves it yet.
