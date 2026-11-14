# Rethinking Epicenter's file editor: one buffer, separate facts

I couldn't use `read_thread`, so I couldn't read the Clarify thread or the earlier one. What's below comes from this snapshot only. The nested buffer/unsaved proposal is already built here: `BufferSnapshot` and `Unsaved` in `packages/folder/src/edit-owner.ts:123-145`, `getBuffer()` in both adapters, and every app reads `buffer.unsaved?.status`.

## Should the five statuses be one value?

No. Your hypothesis is right, and I'd sharpen it: a union earns its place when all its arms describe **one fact** on **one timeline**. The five statuses mix four facts that change at different times:

| Fact | What changes it | Arms that can't coexist |
|---|---|---|
| The text compared with what is stored (dirty or saved) | typing, or a write landing | — (it's a comparison) |
| A write in progress (saving) | a write starting or settling | in flight, or not |
| The last finished write failed | the next write finishing | failed, or not |
| Storage no longer holds the text you edited from (conflict) | refresh, or a write being refused | changed, deleted, not text |

The code already treats them as separate facts and then hides that:
- Typing keeps a conflict but clears a failure (`edit-owner.ts:1152-1156`, `:860`).
- A retry wipes the failure as soon as it starts (`:844-848`).
- Typing during a save keeps `saving` set (`:1152`).

"Conflict" isn't even a save outcome. It's a fact about storage that stays true through any number of retries. Forcing all of this into one value means picking a display priority, and then the template can't say "Retrying… the last save failed."

## The proposal: the editor *is* the buffer

Opening is asynchronous. Every editor you get back already has its text.

```ts
const opened = await folder.openText(path);
// error: missing | not-text | ReadError

type TextEditor = {
  readonly path: string;
  get(): EditorState;              // immutable, same object until it changes
  subscribe(listener: () => void): () => void;
  replaceText(text: string): ChangeResult;
  revert(): void;                  // replaceText(base); allowed while a write runs
  save(): Promise<Result<{ revision: number }, SaveError | ActionError>>;
  resolve(choice: 'mine' | 'theirs'): Promise<Result<{ revision: number }, …>>;
  markdown<S>(schema: S): MarkdownView<S>; // a projection, not a second buffer
  release(): Recovery | undefined; // drop this handle
};

type EditorState = {
  readonly text: string;
  readonly revision: number;       // +1 for each accepted change of text
  readonly base: string | null;    // what storage held when this text was edited from it
  readonly saved: boolean;         // derived, defined below
  readonly writing?: { readonly revision: number };
  readonly failure?: { readonly revision: number; readonly error: SaveFailure };
  readonly diverged?: { readonly current: string | Uint8Array | null };
  readonly refreshError?: ReadError;
  readonly lock?: { readonly reason: string };
};
```

The folder owns one buffer per path. `openText` hands out a counted handle to it. The buffer lasts while handles exist or the text differs from `base`.

`markdown(schema)` reads `text` and turns `change({fields, body})` into `replaceText`. Honeycrisp currently opens two handles for one path (`NoteDetail.svelte:33,47`). With views, it needs one editor and two views.

### Definitions

- **`base`**: the stored text this buffer last confirmed, from a read or from its own write landing. A guarded write expects storage to still hold `base`.
- **Saved**: storage is known to hold exactly `text`, and no write in progress will change that. In code: `text === base && !writing && !diverged`.
- **Dirty**: the same as not saved. There is one definition, not a second flag.
- **Edited**: `text !== base`. This is the folder's "unsaved" list (the close prompt). It means user text that storage doesn't hold, so a clean editor whose file was deleted doesn't nag at close.
- **`save()`**: get the revision that was current when you called into storage. It retries a failure. If a write of an older revision is in progress, it waits for that write and then writes again. It resolves `Ok({ revision: r })` when storage confirms revision `r`, where `r` is at least the revision at call time. `r` can be newer if typing went into the same write. Compare `r` with `get().revision` to know whether anything newer is still waiting. That comparison replaces Whispering's `settlePath`, which checks `getStatus()` after `save()` (`whispering.svelte.ts:527-531`).
- **`folder.flush(paths?)`**: `save()` for every edited editor, using each one's revision at call time. It resolves to `{ saved: [{path, revision}], unsaved: [{path, revision, failure | diverged}] }`. Fenced actions and `close()` use flush.
- **Saved vs crash recovery**: "saved" means "in the folder's storage" and nothing else. Keeping text in memory until `close()` is a guarantee of the owner. A crash journal is a separate opt-in layer. If added, it would publish `journaled: revision` and change none of the definitions above.

### Rules for errors

- **`failure`** describes the last *finished* write and is tagged with its revision. Typing doesn't clear it. A retry keeps it while running, so both `writing` and `failure` can be present. The next finished write replaces it: success clears it, failure overwrites it. It also goes away once `saved` is true, because nothing is lost then.
  - After a failure, autosave stops for that revision so it doesn't retry in a tight loop. The next change of text or an explicit `save()` tries again.
- **`diverged`** means storage is known to hold something other than `base`. A refresh can detect it, not only a refused write.
  - Typing keeps it.
  - Autosave stays paused while it is set.
  - Only `resolve()` clears it, or storage coming back to `base`.
  - For a clean editor whose file changes to other text, there's no divergence: `text` and `base` just follow the new file as a new revision.
- **`refreshError`** never touches `text` or `saved`. A successful refresh clears it.
- **Refused commands** (locked, not text, invalid fields) are only return values. They aren't published as state. This removes the refusal bookkeeping in `edit-owner.ts:504-563`.

## The requested sequences

Start every case with `base = B`, text at revision 0.

**1. Typing during a save.**
1. Type X (r1). Autosave writes r1, so `writing = {1}` and `saved = false`.
2. Type Y (r2) while that write runs.
3. r1 lands, so `base = X`. Text is Y, which isn't `base`, so autosave schedules r2.
4. A `save()` called at r1 resolves `{revision: 1}`. One called at r2 skips the pause, writes Y expecting X, and resolves `{revision: 2}`.

**2. Reverting while a save runs.**
1. Type X (r1) and start writing it.
2. `revert()` produces r2 with text B. It isn't saved yet, because the write in progress will change storage.
3. If r1 lands, `base = X` and the text is B, so B is written back, expecting X.
4. If r1 fails, `base` is still B and the text is B, so `saved` becomes true right away. The failure is dropped because nothing was lost.

Today a revert keeps input held only while a save runs (`edit-owner.ts:1139-1147`), and `discard()` is refused while a save runs (`:1013`). Both quirks go away.

**3. Retrying a failure.**
1. The write of r3 fails with disk full, so `failure = {3, DiskFull}`.
2. `save()` starts a retry: `writing = {3}` and `failure` is kept.
3. If the retry succeeds, the failure is gone and `saved` is true. If it fails, it becomes `failure = {3, <new error>}`.
4. If you type r4 first, `failure = {3}` stays visible ("an earlier save failed") until autosave's attempt at r4 finishes.

**4. Typing after a conflict.**
1. The write of r5 expects B but finds C, so `diverged = {current: C}`.
2. Typing r6 is accepted. `diverged` stays and autosave stays paused.
3. The resolution choices:
   - `resolve('mine')` sets `base = C` and writes r6 expecting C.
   - `resolve('theirs')` sets `text = base = C` as r7 and returns r6 as a `Recovery`.
   - Or merge by hand with `replaceText(mergeText(B, C, text))`, then `resolve('mine')`.
4. If storage moves on to D in the meantime, the guarded write refuses again with `diverged = {current: D}`. A resolution only ever applies to the exact text it was shown.

**5. Refresh fails, or finds the file deleted, while text remains.**
- **The refresh fails:** `refreshError` is set. Text, `saved` and editing are unchanged.
- **The file was deleted and the editor is clean:**
  - The text stays and the state is `diverged = {current: null}`.
  - The path isn't counted as edited, so there's no close prompt.
  - Typing is allowed, autosave stays paused, and `resolve('mine')` recreates the file.
  - Today the text disappears (`edit-owner.ts:1096-1098`), so `FileEditor.svelte:54-64` keeps its own `lastShown` copy.
- **The file was deleted and the editor is dirty:** the same, but the path is counted as edited.
- **The file was replaced with binary:** the same as deletion, with `current` holding the bytes.

So the promise that text always exists changes deletion from "the editor becomes unavailable" to "the editor knows storage left it." That's the honest version: the text the person was looking at doesn't vanish because another program acted.

## Vanilla use

```ts
const opened = await folder.openText('notes/a.md');
if (opened.error) return report(opened.error);
const editor = opened.data;

editor.replaceText('# Hello');
const saved = await editor.save();
if (saved.error === null && saved.data.revision < editor.get().revision) {
  // newer typing is still on its way
}

const note = editor.markdown(noteSchema);
note.change({ fields: { title: 'Hello' } });   // the same buffer, a new revision
editor.release();                               // the buffer lives on if edited
```

## Svelte

The adapter `openEditor(() => path)` exposes `current`, `error` and `loading`. It opens again when the path changes and calls `release()` when the component is destroyed. Loading is handled by the parent:

```svelte
{#if opener.loading}<Loading />{:else if opener.error}<OpenError error={opener.error} />
{:else}<TextEditor editor={opener.current} />{/if}
```

```svelte
<script lang="ts">
  let { editor }: { editor: TextEditor } = $props();
  const s = $derived(editor.state);
</script>

<header role="status">
  {#if s.lock}{s.lock.reason}
  {:else if s.diverged}Needs a decision
  {:else if s.writing}Saving…{#if s.failure} (last attempt failed){/if}
  {:else if s.failure}Not saved: {s.failure.error.message}
    <button onclick={() => editor.save()}>Try again</button>
  {:else if !s.saved}Unsaved{:else}Saved{/if}
</header>

{#if s.diverged}
  <Alert>
    {s.diverged.current === null ? 'Deleted elsewhere.' : 'Changed elsewhere.'}
    <button onclick={() => editor.resolve('mine')}>
      {s.diverged.current === null ? 'Recreate with my text' : 'Replace with mine'}</button>
    {#if s.diverged.current !== null}
      <button onclick={() => editor.resolve('theirs')}>Use theirs</button>{/if}
  </Alert>
{/if}
{#if s.refreshError}<p>Couldn't check for outside changes. Your text is safe.</p>{/if}

<textarea readonly={!!s.lock}
  bind:value={() => s.text, (v) => editor.replaceText(v)}></textarea>
```

There are no `undefined` text branches, no `status === 'ready'` narrowing, and no grab-bag error to tell apart by `name`.

## What disappears and what moves

**Disappears:**
- the `buffer` container and `unread | loading | unavailable | ready`
- the `Unsaved` entity and its nested status
- the `BufferIssue` precedence (`edit-owner.ts:573`)
- published refusals
- `getText(): string | undefined`
- the `lastShown` workaround
- the `getStatus()` check after `save()`
- one of Honeycrisp's two handles per note
- `discard()` being refused while a save runs; `revert()` covers it

**Moves:**
- Loading moves to the opener: the parent or route awaits it.
- Display priority moves to templates. A shared `saveLabel(state)` helper is fine there.
- Detecting divergence on refresh moves into the owner.
- Handle lifetime (`release`) moves into the adapters.

**What each remaining concept guarantees:**
- `text`: it always exists while you hold an editor.
- `revision`: it makes save results and failures point at specific text.
- `base`: it makes guarded writes and merges exact.
- `writing`: the write in progress, and which revision it holds.
- `failure`: the last finished write's outcome, with its revision.
- `diverged`: the only thing that pauses autosave and needs a person's decision.
- `saved`: one derived answer to "could I lose this?"

## Open questions

- **Following outside edits:** a clean editor following an outside text change could swap the text mid-composition, for example during an IME session. The adapters may need to delay that while the field has focus.
- **Pausing on refresh:** whether a refresh that finds divergence in a dirty editor should pause autosave before any write is refused is a policy choice. I recommend yes.
- **Handle counting:** counting handles adds a lifetime rule for callers. It needs to be checked against how React StrictMode and Svelte mount, unmount and mount again.
- **Thread history:** I couldn't read the threads, so earlier decisions there might rule out parts of this.

**Evidence I'd ask the coordinator to collect:**
- run `buffer.test.ts` and `edits.test.ts` to confirm the current behaviors I cited
- trace one Honeycrisp deletion and one Capture conflict in the running app
