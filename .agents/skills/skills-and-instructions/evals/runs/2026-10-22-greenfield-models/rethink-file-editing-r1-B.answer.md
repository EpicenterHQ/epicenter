# Rethinking Epicenter's file-editing API

I couldn't read the Clarify thread because thread tools aren't available here. Everything below comes from the frozen snapshot. In that snapshot the nested proposal is already in place. `edit-owner.ts:141-145` defines `BufferSnapshot` as `unread | loading | unavailable | ready{text, unsaved?}`, and `Unsaved` is `dirty | saving | failed | conflict` (`:123-126`). All four apps consume it.

## Answer to the central question

> **No. The five statuses are not one value. They are three independent facts, and each fact is a small union with its own payload.** Your hypothesis holds, with one refinement: **"conflict" is not a save status at all.** It describes how stored content relates to the source this editor last observed (the witness). A refresh can find it without any save running, and typing doesn't clear it.

The current code already shows the compression in several places:

- **Newer typing is labelled as saving.** `submitText` copies `saving: input?.pending.saving` onto the new input (`edit-owner.ts:1152`). Text that has never been sent shows as "saving".
- **An older revision's failure disappears.** `drain` keeps the failure only if the revision is unchanged (or it was a conflict). Otherwise it drops the error and immediately tries the newer revision (`:860`, `:871-872`).
- **Unrelated errors share one field.** `BufferIssue` merges command refusals, read failures, deletion and save errors, picking one by priority (`refusalOf(state) ?? state.error ?? sourceIssue`, `:573`).
- **Apps rebuild the missing facts themselves.** Whispering computes `isSaving = unsaved && !failed` from the folder-wide aggregate (`whispering.svelte.ts:1039-1042`). That treats "waiting for the pause" as "saving".
- **Callers keep their own copy after a deletion.** `FileEditor.svelte` keeps `lastShown` so the text survives an outside deletion (`:55-64`).

## The proposal: an editor, not a buffer inside an edit

```ts
// Acquisition is async. The editor is synchronous memory whose text always exists.
folder.files.open(path, schema?): Promise<Result<TextEditor, NotFound | NotText | ReadFailed>>

type TextEditor<S> = {
  readonly path: string;
  readonly state: EditorState;              // immutable snapshot, replaced on change
  readonly markdown: MarkdownContent<S>;    // schema view of state.text, cached per schema
  subscribe(listener: () => void): () => void;

  replaceText(text: string): Result<void, Refusal>;
  change(change: DocumentChange<S>): Result<void, Refusal>;  // turns into replaceText
  save(): Promise<Result<{ revision: number }, SaveFailure | Diverged | Refusal>>;
  resolve(d: Divergence, choice: 'mine' | 'theirs' | { text: string }): Promise<Result<…>>;
  discard(): string;                         // drops held input and returns its text
  release(): void;                           // [Symbol.dispose]
};

type EditorState = {
  text: string;
  revision: number;                          // bumps on every accepted change
  storage:                                   // how text relates to the witness
    | { kind: 'saved' }
    | { kind: 'unsaved' }
    | { kind: 'diverged' } & Divergence;
  saving?: { revision: number };             // the one write in flight
  failure?: { revision: number; error: SaveFailure };  // latest attempt that failed
  refreshFailure?: ReadError;                // latest read failed; text is unaffected
  locked?: { reason: string };               // a fenced action holds the path
};
type Divergence = { theirs: { kind: 'text'; text: string } | { kind: 'missing' } | { kind: 'binary' } };
```

The folder still owns one buffer per path. `open` on a path that is already held resolves without reading. `release` gives up the view's lease. Input that is unsaved or diverged stays with the folder after the view unmounts. Folder ownership and async acquisition remain separate decisions: only `open` is asynchronous.

### Definitions

- **Witness.** The exact stored content this editor last reconciled with. Every write is a compare-and-swap against it.
- **Saved.** Storage is known to hold exactly `text` (text equals the witness), and no write is running that could change that.
- **Dirty (`unsaved`).** Not saved, and storage is not known to have moved. Autosave will run after the pause.
- **Diverged.** A read or a rejected write saw stored content that differs from the witness while the editor held input. It also applies after any outside deletion. Autosave stops and `save()` writes nothing. This is the guarantee against silent overwrites.
- **Attempt.** One compare-and-swap write of one revision's text. This is what `saving.revision` and `failure.revision` refer to.
- **`save()` / flush.** These are one operation. It skips the pause and targets **R, the revision current when it was called**. It resolves `Ok({revision})` when storage holds R or something newer. The returned revision is the one that actually landed, which can be newer than R if typing continued before an attempt started. It resolves `Err` with the failure of the attempt covering R, or with `Diverged`. It does not wait for typing that arrives after the call. `folder.flush()` does the same for every held path and replaces `settle()`.
- **Failure lifetime.** A failure applies to its revision and stays until (a) a later attempt settles, which clears or replaces it, or (b) the text becomes saved. **A retry keeps the failure while it runs**, so `saving` and `failure` can both be set. Divergence clears any failure, because the compare-and-swap precondition is already known to be false.

### What callers can count on

| Concept | Guarantee |
|---|---|
| `text: string` | A view never branches on undefined. Deletion can't take the text away. |
| `revision` | Results and failures say exactly which text they concern. |
| `storage` | Answers "is it safe to close?" and "will autosave run?" |
| `saving.revision` | Shows whether the write in flight is older than what's on screen. |
| `failure.revision` | Says whether the error is about this text or an earlier one. |
| `Divergence` token | Resolution applies to exactly the source that was observed. If storage moved again, it is refused. |

## The sequences

**Typing during a save.** The witness is A and the write of r5 (text B) is in flight; the user types r6 (C).
- State becomes `unsaved, saving{5}`. The UI can say "Saving… newer changes wait."
- If r5 lands, the witness becomes B and r6 autosaves over B.
- If r5 fails, the state is `failure{5}` and r6 autosaves after the pause. While r6 is in flight the state is `saving{6}, failure{5}`. When r6 settles, the failure clears or is replaced.

**Reverting while a save runs.** The witness is A, r5 (B) is in flight, and the user reverts to r6 = A.
- State is `unsaved`, because the outcome is still open.
- If r5 lands, the witness is B, A ≠ B, so r6 writes A. Storage briefly holds B; that is the cost of a write that can't be cancelled.
- If r5 fails, the witness is still A and equals the text, so the state is `saved`. The failure is dropped because it concerned text nobody holds any more.
- This matches the snapshot's two-write path (`:874-885`). The difference is that the state no longer claims the reverted text is "saving".

**Retrying a failure.** The state is `failure{5}`; the user calls `save()`.
- State becomes `saving{5}, failure{5}`, so the UI can show "Retrying…" without the message flickering away.
- On success both clear and the state is `saved`.
- On failure, `failure{5}` carries the new error.
- Autosave never retries the same revision by itself. New typing does schedule a new attempt.

**Typing after a conflict.** The state is `diverged{theirs}`; the user types r7.
- Typing is accepted and the state stays diverged, because the divergence belongs to the witness, not the text.
- `save()` returns `Err(Diverged)`.
- `resolve(d, 'mine')` makes `theirs` the new witness and autosaves r7 over it, still with compare-and-swap.
- `'theirs'` replaces the text and gives `saved`.
- `{text: merged}` rebases onto theirs and saves the merged text.
- If storage moved again, `d` is stale and the call is refused.

**A refresh fails.** Only `refreshFailure` is set. Text, `storage` and autosave are unchanged, since a write has its own guard. The next successful read clears it.

**A refresh finds the file deleted.**
- *With unsaved input:* `diverged{missing}`. "Restore" is `'mine'`, which creates the file. "Discard" is `discard()` plus closing the view.
- *Clean:* this is where "text always exists" costs something. A clean editor quietly follows an outside *change*, but it cannot follow a deletion and still have text. So a **clean deletion also becomes `diverged{missing}`**. The last stored text stays visible and nothing autosaves; it would be wrong to bring the file back silently. `'theirs'` on a missing (or binary) source ends the editor: it is released and the result says `ended: true`.
- This asymmetry is deliberate. It replaces `lastShown`, `SourceUnavailable`-while-ready and the "deleted elsewhere" branches in all four apps.

**Memory versus crash recovery.** `saved` means the compare-and-swap write committed to folder storage. Keeping held input in memory survives unmounts, failures and conflicts, but not a crash or reload. A crash-recovery journal would be a separate folder feature. The editor contract makes no durability claim beyond `saved`.

## Vanilla use

```ts
const opened = await folder.files.open('notes/a.md');
if (opened.error) return show(opened.error);     // NotFound | NotText | ReadFailed
using editor = opened.data;

editor.replaceText('# Hello');
const off = editor.subscribe(() => render(editor.state));
const saved = await editor.save();               // Ok({ revision: 1 })
if (saved.error?.name === 'Diverged') {
  const s = editor.state;
  if (s.storage.kind === 'diverged') await editor.resolve(s.storage, 'mine');
}
```

## Svelte

The parent handles acquisition. Loading and "not found / not text" move out of the editing component:

```svelte
{#key path}
  {#await folder.files.open(path, NoteSchema)}
    <Loading label="Opening…" />
  {:then opened}
    {#if opened.error}<OpenError error={opened.error} onRetry={...} />
    {:else}<NoteEditor editor={opened.data} />{/if}
  {/await}
{/key}
```

```svelte
<script lang="ts">
  import { reactiveEditor } from '@epicenter/svelte/edits';
  let { editor: raw } = $props();
  const editor = reactiveEditor(raw);          // tracks state; releases on destroy
  const s = $derived(editor.state);
  const note = $derived(editor.markdown);
</script>

<p role="status">
  {#if s.storage.kind === 'diverged'}Changed elsewhere
  {:else if s.saving}Saving{s.saving.revision < s.revision ? ' (newer changes wait)' : ''}…
  {:else if s.failure}Not saved: {s.failure.error.message}
  {:else if s.storage.kind === 'unsaved'}Unsaved
  {:else}Saved{/if}
</p>

{#if s.storage.kind === 'diverged'}
  {@const d = s.storage}
  {@const gone = d.theirs.kind !== 'text'}
  <Alert.Root variant="destructive">
    {gone ? 'This note was deleted elsewhere.' : 'This note changed elsewhere.'}
    <Button onclick={() => editor.resolve(d, 'mine')}>{gone ? 'Restore' : 'Keep mine'}</Button>
    <Button onclick={() => editor.resolve(d, 'theirs')}>{gone ? 'Close' : 'Use theirs'}</Button>
  </Alert.Root>
{:else if s.failure && !s.saving}
  <Button onclick={() => editor.save()}>Try again</Button>
{/if}
{#if s.refreshFailure}<p>Couldn't check for outside changes. Your text is kept.</p>{/if}

<Input bind:value={() => note.fields.title, (t) => toast(editor.change({ fields: { title: t } }))}
       disabled={!!s.locked} />
<Textarea bind:value={() => s.text, (v) => toast(editor.replaceText(v))} readonly={!!s.locked} />
```

The ordering of status messages now sits in the view, where it is a visible choice, rather than being built into the type.

## What disappears and where the complexity goes

**Removed:**
- `unread | loading | unavailable`; they become the result of `open`.
- `getText(): string | undefined`.
- `BufferIssue`, along with the refusal-recording machinery (`record`, `execute`, `refusalOf`, `:504-563`). Refusals are only return values; Honeycrisp already shows them as toasts.
- `Recovery`, which duplicated text and path.
- `SourceUnavailable` on a ready buffer.
- The reread step inside `resolveConflict('current')`.
- `lastShown`.
- Whispering's `isSaving`/`isUnsaved` derivations; the folder aggregate should expose the same three facts per path.

**Moved:**
- *Folder:* lease and reference-count semantics for `open`.
- *Refresh:* compare what was read against the witness, so divergence shows up before a save.
- *Divergence tokens:* track enough identity to refuse a stale resolution.
- *Adapters:* Svelte and React need an async boundary.
- *Apps:* views must now render "deleted elsewhere" for clean files as well.

## Unresolved questions and evidence the coordinator should gather

1. **Clean deletion.** Ending the editor straight away is the simpler alternative to `diverged{missing}`. Choose it if "always text" matters less than a smaller state space.
2. **Witness comparison on refresh.** Can every refresh cheaply compare observed content with the witness? `answered`/`know` already track `doc`, which suggests yes, but it isn't verified.
3. **Main conversation state.** Its latest status is unverified. Please check the live branch before saying what's implemented beyond this snapshot.
4. **Tests.** Please run, or point me to, the `edits.test.ts` cases covering revert during save and failure after newer typing. That would confirm the current behaviour I describe above.
