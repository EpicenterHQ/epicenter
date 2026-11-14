**Recommendation: change the design.** Don't make the five statuses one mutually exclusive value. Your hypothesis holds up against the code.

The only real either/or is the reason autosave has stopped: a **failure**, fixed by retrying, or a **conflict**, fixed by choosing a version. "Dirty" means the folder still owes storage a write. "Saving" means a write is in flight. Those two often overlap. Merging them into one status already loses information in this snapshot.

The editor I'd build is `text` (always present), `pending`, `writing`, and `problem: SaveFailure | SaveConflict | undefined`. You get one with `await folder.open(path)`. Loading, missing-file and not-text outcomes come back from `open` instead of living on the editor as states.

## What I read

```
.agents/skills/adversarial-review/{SKILL.md, references/deletion-prizes.md}
REQUEST.md
packages/folder/src/{edit-owner.ts, edits.ts}
packages/svelte/src/edits.ts   packages/react/src/edits.ts
apps/epicenter/src/folders/FileEditor.svelte
apps/honeycrisp/src/routes/components/{NoteDetail,FileDetail(60–127)}.svelte
apps/capture/src/lib/components/TextDetail.svelte
apps/whispering/src/routes/components/RecordingDetail.svelte
apps/whispering/src/lib/whispering.svelte.ts (485–534, 1035–1080)
```

I couldn't use `read_thread`, so this describes only what's in the snapshot. The nested proposal is implemented, but as `getBuffer()` → `BufferSnapshot` (`edit-owner.ts:141`) rather than a `fileEdit.buffer` property. The Svelte adapter exposes that as `.buffer`.

## Why one status misleads

Here is what the code does today:

- **`saving` can hide newer text.** Typing during a save keeps `saving: true` on the newer input (`edit-owner.ts:1152`). The status claims the current text is being saved when an older revision is.
- **`saving` hides a failure during retry.** `drain` clears the error when an attempt starts (`:847`), so the "Try again" banner disappears and reappears.
- **`saving` hides a conflict.** `submitText` schedules autosave unconditionally (`:1162`), even when a conflict is held. The attempt sends the stale `input.from` (`:827`), so it conflicts again unless storage happens to have changed back. On each pause in typing, status goes conflict → saving → conflict. The conflict panels in FileEditor, Capture and Honeycrisp, which check `status === 'conflict'`, flicker with it.
- **No caller distinguishes dirty from saving.** FileEditor:81 and TextDetail:157–161 both show "Saving…" for either. Whispering's `isSaving` means "unsaved and not failed" (`whispering.svelte.ts:1039`).
- **The display-priority compression is in `buffer.error`.** `refusal ?? read error ?? source issue` (`:573`) merges refusals, read failures and deletion into one field. Invalidating it takes about 60 lines (`:504–563`), even though every command already returns its refusal as a `Result`.

## Definitions

- **Revision:** a counter that goes up each time a change to the text is accepted.
- **Witness:** the exact stored bytes the current text was derived from, last read or last confirmed written by us.
- **Saved(r):** storage confirmed it holds revision r's text, written while it still held the witness. The witness then becomes that text.
- **Pending (dirty):** the folder owes storage a write. This is true while `input` exists. Text that equals the witness is still pending if a write of a different revision is in flight.
- **`save()`:** resolves `Ok({ revision })` once some revision at least as new as the one at call time is confirmed. Otherwise it returns that attempt's error. Today it returns the whole drain loop's final outcome (`:806–808`, `:888`), so it can wait for later typing or report a later revision's failure.
- **Flush:** remove it from the editor's vocabulary. It's internal in the owner. The public folder-level operation is `settle()`/`close()`: attempt every pending editor once and return what is still held.
- **Memory vs durability:** pending text is memory. Crash recovery is a separate journal, and nothing in memory gets called "saved".

## Sequences

1. **Typing during a save.** r1 is being written; you type r2. Then `writing=true`, `pending=true`, `text=r2`. When r1 lands, the witness becomes r1, `writing=false`, r2 stays pending and autosave follows. A `save()` called at r1 resolves with `{revision: r1}` and doesn't wait for r2.
2. **Revert while a save runs.** The witness is w0 and r1 is in flight. `revert()` accepts r2 = w0's text. It stays pending because r1 will land and make storage differ from w0. After r1 lands, autosave writes w0's text back. The code already does this (`:1139–1147`). By contrast, `discard()` refuses with BUSY (`:1013`). Make `revert()` the one verb that never refuses.
3. **Retrying a failure.** `problem` = failure for r1. `save()` sets `writing=true` and keeps the failure until the attempt settles: success clears it, another failure replaces it. Typing r2 clears it, because it described r1, and schedules autosave. That last part is already implemented (`:1153`).
4. **Typing after a conflict.** A conflict describes the witness, not a revision, so every later revision inherits it. The conflict stays, typing is accepted, autosave is suspended, and `save()` returns the conflict without writing. Only `resolve('mine' | 'stored' | {text})` changes the witness.
5. **Refresh fails, text still usable.** The editor state doesn't change. `refresh()` returns the error to its caller, and the polling query (`createQuery(queries.read(...))`) already owns that error.
6. **Refresh finds the file deleted.**
   - **With pending text:** `problem = Conflict{stored: null}` and the text stays. `resolve('mine')` recreates the file. `resolve('stored')` releases the editor.
   - **Clean:** today the text disappears (`shownText` → undefined, status `unavailable`). FileEditor works around this with `lastShown` and a readonly box (`FileEditor.svelte:54–64`). Under the "text always exists" promise, a clean editor shows the same deletion conflict with `pending=false`. Typing is held but not written.
   - **Cost:** this is the one case where a clean editor doesn't follow storage. Clean editors still adopt outside *modifications* automatically.

## Proposed API

```ts
folder.open(path): Promise<Result<Editor, Missing | NotText | ReadFailed>>
folder.peek(path): Result<Editor, never> | undefined   // already held: no loading flash

type Editor = {
  readonly path: string;
  readonly text: string;             // always
  readonly pending: boolean;         // folder owes storage a write
  readonly writing: boolean;         // an attempt is in flight, possibly of an older revision
  readonly problem: SaveFailure | SaveConflict | undefined; // exclusive: retry vs choose
  markdown<S>(schema: S): MarkdownContent<S>;
  replaceText(text: string): Result<void, Refusal>;
  change(doc: DocumentChange): Result<void, Refusal>;
  revert(): void;                    // text := witness text
  save(): Promise<Result<{ revision: number }, SaveFailure | SaveConflict>>;
  resolve(choice: 'mine' | 'stored' | { text: string }): Promise<Result<void, SaveError>>;
  refresh(): Promise<Result<void, ReadError>>;
  subscribe(fn: () => void): () => void;
};
```

Invariants: a failure implies `pending`, and so does `writing`. A conflict means writes are suspended. Failure and conflict never coexist; a conflict replaces a failure.

Vanilla use:

```ts
const opened = await folder.open('notes/a.md');
if (opened.error) return show(opened.error);
const editor = opened.data;
editor.replaceText(editor.text + '\nMore.');
const saved = await editor.save();
if (saved.error?.name === 'Conflict') await editor.resolve('mine');
```

Svelte:

```svelte
<!-- Parent -->
{#await folder.peek(path) ?? folder.open(path)}
  <Loading label="Opening…" />
{:then opened}
  {#if opened.error}<OpenFailed error={opened.error} />
  {:else}<TextEditor editor={opened.data} />{/if}
{/await}

<!-- TextEditor.svelte -->
<script lang="ts">
  let { editor: raw } = $props();
  const editor = editorView(raw); // createSubscriber over raw.subscribe
  const conflict = $derived(editor.problem?.name === 'Conflict' ? editor.problem : undefined);
</script>
<span role="status">
  {#if conflict}Not saved: the file changed elsewhere
  {:else if editor.problem}Not saved{editor.writing ? ' · retrying…' : ''}
  {:else if editor.pending}Saving…
  {:else}Saved{/if}
</span>
{#if conflict}
  <Button onclick={() => editor.resolve('stored')}>Use saved file</Button>
  <Button onclick={() => editor.resolve('mine')}>Replace saved file</Button>
{:else if editor.problem}
  <Button disabled={editor.writing} onclick={() => editor.save()}>Try again</Button>
{/if}
<Textarea bind:value={() => editor.text, (v) => editor.replaceText(v)} />
```

The display priority now lives in the template, where it is plainly a presentation choice.

## What disappears

- **Availability states:** `unread | loading | unavailable`, `UNREAD`, and the `bufferOf` availability branches.
- **Read-on-subscribe in the adapters:** Svelte's `trackRead` (`svelte/edits.ts:24–28`) and React's `requested` effect (`react/edits.ts:32–36`).
- **Passivity workarounds in callers:** `buffer = cond ? fileEdit.buffer : undefined` (RecordingDetail:74, FileView:66, FileDetail:77). Those callers would call `open` only after their size or text query says to.
- **FileEditor's `lastShown`.**
- **Stored refusals:** `refusal`, `record`, `execute`, `refusalOf`, and the `BufferIssue` union.
- **Stored read errors:** `state.error` / `statusAt` / `readFine`, if refresh errors go to the caller.
- **Discard's BUSY refusal.**
- **The repeated guaranteed-conflict attempts and their flicker.**
- **Three getters, reduced:** `getText`/`getMarkdown`/`getBuffer` become `text` and `markdown(schema)`.

## What stays, and why

- **One folder-owned editor per path:** input outlives unmounts.
- **Witness compare-and-swap, `conflictCurrent`:** no silent overwrite of outside changes.
- **Revisions and the coalescing save loop:** newer typing survives a save landing or failing.
- **The read-ordering clock (`docAt`/`asOf`):** a stale read can't erase knowledge of a later save.
- **Fences:** delete and finishDraft.
- **`close`/`settle`/`release`, detached `Recovery`:** recovery is still needed at close.
- **Folder `getStatus()`:** save indicators that don't open files.

## What moves, and what it costs

- **Initial loading moves to callers.** Each route needs pending and failed branches. NoteDetail and TextDetail already have them.
- **Clean deleted editors linger.** They stay held until the view releases them.
- **Refusals are the caller's to show.** A caller that wants one to persist keeps its own state. Honeycrisp already uses toasts.
- **Released handles are an open question.** "Text always exists" with pruning needs a rule for a handle kept after release. I'd say it keeps answering its last text, detached.

## Correctness findings in the current code

These are separate from the redesign. They need checking by running tests:

1. **Conflict re-attempts.** Type after a conflict and wait more than `SAVE_AFTER_MS`. Expected: `unsaved.status` goes conflict → saving → conflict, and `replaceSource` is called again with the old `from`.
2. **`save()` reports the wrong revision.** Type r1, call `save()`, type r2 before r1 lands, and make r2 fail. Expected: the first `save()` resolves with r2's error.
3. **Retry hides the failure.** After a failed save, `save()` should show `status: 'saving'` with no error while the retry runs.

## Still unresolved

- Whether `replaceSource` treats an outside write of identical text as success or as a conflict. That decides whether a conflict can clear itself.
- Whether any consumer needs `loading` while it is *already holding* an editor. If one does, `peek`/`open` alone isn't enough and some state comes back.
- Durable crash recovery is out of scope. Nothing in this API should name memory "saved".
