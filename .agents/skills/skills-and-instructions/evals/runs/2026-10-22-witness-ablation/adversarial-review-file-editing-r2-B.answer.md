# Adversarial review: Epicenter file-editing API

**Scope.** I couldn't use `read_thread` here, so this review is based only on the frozen snapshot. In that snapshot the nested proposal is already implemented. `packages/folder/src/edit-owner.ts:123-145` defines `BufferSnapshot` (`unread|loading|unavailable|ready`) with nested `Unsaved` (`dirty|saving|failed|conflict`), and the Svelte adapter, React adapter and all four apps already use it. I can't confirm anything the main conversation did after this snapshot.

## Verdict

**FileEdit should be the buffer itself, with no container around it.** It should also not be one five-way status. The five candidate statuses cover three separate facts:

1. **Relationship:** whether the current text has landed in storage.
2. **Attempt:** whether a write is running, and which revision it carries.
3. **Source:** what we last learned about the stored file.

Facts 1 and 2 overlap, but not completely. Fact 3 is fully independent. Your hypothesis holds, with one refinement: `failed` belongs to an attempt and should be dropped when the text changes, while `conflict` belongs to the base the text was edited from and should survive typing. That difference is what earns the union its place.

**Callers back this up.** None of them treats `dirty` and `saving` differently:
- Epicenter shows "Saving…" for both (`FileEditor.svelte:81`).
- Capture does the same (`TextDetail.svelte:157-162`).
- Whispering's `isSaving` merges them (`whispering.svelte.ts:1039-1041`).

So a pending write is a flag inside "unsaved", not a sibling status.

## Definitions

- **Base:** the exact stored content the held text was edited from, or the last revision that landed.
- **Saved:** no held revision and no write running. "Saved" means the text equals the base as confirmed by the latest read or landed write. It does not mean the text matches storage right now.
- **Unsaved:** a held revision exists that hasn't landed. Either the text differs from the base, or a write of other content is running.
- **`save()`:** land the revision that is current when you call it. It resolves when that revision, or a later one that replaced it, has landed or failed. Typing after the call doesn't change what it resolves to. It returns the revision number it covered.
- **Flush (internal only):** used by fences and close. It locks input, then saves until nothing is held or one attempt fails. Without the input lock, flush could chase typing forever, so it shouldn't be public.

## Proposed API

```ts
type SaveState =
  | { status: 'saved' }
  | { status: 'unsaved'; saving: boolean }          // saving may carry an older revision
  | { status: 'failed'; error: SaveFailure }        // latest attempt of THIS text; nothing running
  | { status: 'conflict'; error: SaveConflict };    // base no longer matches storage; autosave paused

type Stored = 'text' | 'missing' | 'not-text';      // last known, independent of SaveState

type Editor<S> = {
  readonly path: string;
  readonly text: string;                 // always present
  readonly markdown: Markdown<S>;        // same source, read with a schema
  readonly save: SaveState;
  readonly stored: Stored;
  readonly readError: ReadError | undefined;   // latest refresh failed; older knowledge kept
  readonly locked: boolean;
  replaceText(text: string): ChangeResult;     // refusals are returned, not stored
  change(c: DocumentChange<S>): ChangeResult;
  save(): Promise<Result<{ revision: number }, SaveError | ActionError>>;
  revert(): Result<string | undefined, ActionError>;   // returns the dropped text
  resolve(choice: 'theirs' | 'mine'): Promise<Result<void, SaveError | ReadError | ActionError>>;
  refresh(): Promise<Result<void, ReadError>>;
  subscribe(fn: () => void): () => void;
  [Symbol.dispose](): void;                    // ends this lease, never discards input
};

folder.files.open(path, { signal }): Promise<Result<Editor, OpenError>>;   // missing | not-text | read failed
```

**Vanilla use:**

```ts
const opened = await folder.files.open('notes/a.md');
if (opened.error) return show(opened.error);
using editor = opened.data;
editor.replaceText(editor.text + '\nmore');
const { data } = await editor.save();          // revision `data.revision` landed
if (editor.save.status !== 'saved') /* newer typing is still held */;
```

**Svelte.** The adapter ties the lease to the component and makes the getters reactive:

```svelte
<!-- Route -->
{#await folder.files.open(path, { signal }) then opened}
  {#if opened.error}<OpenFailed error={opened.error} />{:else}<FileEditor editor={useEditor(opened.data)} />{/if}
{:catch}…{/await}

<!-- FileEditor.svelte -->
<header role="status">
  {#if editor.locked}Another operation is using this file.
  {:else if editor.save.status === 'unsaved'}Saving…
  {:else if editor.save.status === 'failed'}Not saved: {editor.save.error.message}
    <Button onclick={() => editor.save()}>Try again</Button>
  {:else if editor.save.status === 'conflict'}The saved file changed.
    <Button onclick={() => editor.resolve('theirs')}>Use saved file</Button>
    <Button onclick={() => editor.resolve('mine')}>Replace saved file</Button>
  {:else if editor.stored === 'missing'}Deleted elsewhere. Typing will ask before recreating it.
  {/if}
</header>
{#if editor.readError}<p role="alert">Couldn't check for changes: {editor.readError.message}</p>{/if}
<Textarea readonly={editor.locked}
  bind:value={() => lf(editor.text), (v) => editor.replaceText(withFileNewlines(v, editor.text))} />
```

The "Reading…", "unavailable" and "unread" branches leave every editing component.

## Sequences

| Sequence | Proposed behavior | Snapshot today |
|---|---|---|
| **Typing during a save** | `unsaved, saving:true` while revision 3 is in flight and the text is at revision 4. When 3 lands, the base becomes 3's text and the state is `unsaved, saving:false` until autosave sends 4. A `save()` called before the typing resolves when 3 lands. | Same transitions (`edit-owner.ts:874-885`). `save()` resolves with the loop's *last* outcome. That could be a later revision's error, or Ok while still dirty. Whispering re-checks `getStatus().unsaved` after `save()` because of this (`whispering.svelte.ts:528-530`). |
| **Revert while a save runs** | Accepted as a new revision whose text is the pre-save base. It stays `unsaved` until the running write lands, then the original text is written back. The file ends where the user asked. | `discard()` is refused with `BUSY` (`:1013-1016`). Typing the original text back skips the clean shortcut while a write runs (`:1139-1147`), which is correct. No `revert` exists. |
| **Retry a failure** | The new attempt replaces the failure: `failed` → `unsaved, saving:true` → `saved` or a new `failed`. No stale error is kept. | Same (`:844-848`). |
| **Typing after a failure** | The failure belonged to the old text, so the state becomes `unsaved` and autosave resumes. | Same (`:1153-1156`, `:860`). |
| **Typing after a conflict** | Stays `conflict` because the base is still stale. Autosave is **paused** until `resolve`. `resolve('mine')` moves the base to theirs and does an ordinary save. | **Defect.** `schedule()` runs anyway (`:1162`). Each pause sends a save that is bound to fail, which clears the conflict error while it runs (`:847`) and then sets it again. The resolve alert flickers away, and `resolveConflict` returns `BUSY` during each attempt (`:1229-1233`). |
| **Refresh fails, text usable** | Text and save state stay as they are. `readError` is set and clears on the next successful read. | `ready` plus `buffer.error`, which mixes read, refusal, source and save errors. Callers filter by `name` (`FileEditor.svelte:114`, `RecordingDetail.svelte:149`). |
| **Outside deletion, clean** | Text stays, `stored: 'missing'`, still `saved` with the old base. Typing is accepted. The save conflicts because the file is gone, so nothing is recreated by accident. `resolve('mine')` recreates it. | Text vanishes and the state becomes `unavailable` (`:1093-1098`). Epicenter rebuilds it with a `lastShown` cache (`FileEditor.svelte:54-64`), then shows a false "Your unsaved source is still available" with a readonly box (`:141-150`). |
| **Outside deletion, dirty** | Text stays, `unsaved` → the save conflicts → `resolve`. | Same. |

**What "always has text" costs.** A clean editor no longer follows the file into nonexistence. It keeps a ghost of the old text until the lease ends. The folder can't drop that text when the last subscriber leaves, as `:1048-1061` does today. So memory lifetime moves from subscription to an explicit lease. That is the main new obligation: `open` needs a `signal` so an await that resolves after unmount doesn't leak. Honeycrisp and Capture still get their "no longer here" screen by checking `stored === 'missing' && save.status === 'saved'`.

## What disappears, what moves, what remains

**Disappears:**
- `buffer` and the nested `unsaved`.
- `unread`, `loading` and `unavailable` inside the editor, along with every caller's loading and unavailable branch.
- The `text === undefined` guards.
- Epicenter's `lastShown`.
- Lazy first reads in the adapters (`svelte/edits.ts:24-28`, `react/edits.ts:30-36`).
- The `Recovery`/`Unsaved` split.
- The stored-refusal machinery: `record`, `execute`, `refusalOf`, `PathState.refusal`, about 80 lines whose invalidation rule is hard to follow. Refusals are already returned from commands, and Honeycrisp already toasts them that way.

**Moves:**
- Acquisition and its failure move to the opener: the route, `{#await}`, or a loader.
- Lifetime moves to the lease.

**Remains, and why:**
- The `failed`/`conflict` split, because they behave differently when the text changes.
- Revision-scoped `save()`, which is what callers actually want to know.
- The internal flush under fence and close, for the guarantee that actions see saved input.
- `stored` and `readError` as independent fields, because a usable buffer outlives storage problems.

## Alternatives weighed

- **Your five-status union:** it expresses the same contract as mine. The difference is whether `dirty` and `saving` sit side by side or as one status with a flag, and callers support the flag. The changes that matter are pausing autosave on conflict, revision-scoped `save()`, keeping text after deletion, and taking refusals out of state.
- **Independent flags** (`isDirty`, `isSaving`, `saveError`): rejected. They allow the meaningless "saving with a failure" combination and lose the rule that a failure belongs to one revision.

## Unresolved, and checks for the coordinator

1. **Decides whether "always has text" is worth it:** does anything need an editor without asking for its content? Lock-only observers and status rows like Whispering's `SaveStatus` use the folder aggregate, not the editor. Please grep for `.edit(` callers that read only `locked` or `isLocked`. If none exist, the lease cost is contained.
2. **Should a clean, deleted editor accept typing?** I recommend accepting it and asking at save time through the conflict. Refusing is the other option. This is a product decision for the user.
3. **Please run a focused test of the conflict-flicker defect.** Cause a conflict, then call `replaceText`, wait past `SAVE_AFTER_MS`, and confirm the status goes `conflict` → `saving` → `conflict` and that `resolveConflict` returns `BUSY` mid-attempt. This applies to the current code whatever API is chosen.
4. **`save()` contract change:** whether to return `{ revision }` affects Whispering (`whispering.svelte.ts:528`) and Honeycrisp's `void fileEdit.save()` calls (`notes.svelte.ts:211, 480`).

I didn't run any tests or commands. Everything above comes from reading source.
