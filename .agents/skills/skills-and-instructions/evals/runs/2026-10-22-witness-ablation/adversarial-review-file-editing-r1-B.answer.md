# Adversarial review: Epicenter file-editing API

## Recommendation

Make the editor the buffer itself. Open it asynchronously so its text always exists. Then replace the five-way status with one mutually exclusive value for how the text relates to storage, plus a separate fact about any write in flight.

The five statuses should not be one value. `saving` describes a write, and that write may carry older text. `failed` is the result of one attempt. `dirty` and `conflict` describe how the current text relates to storage. Putting them in one union forces the API to pick one to show, and that loses facts callers need. This snapshot already shows the losses (sequences below).

```ts
type EditorSnapshot = {
  readonly text: string;            // always present once opened
  readonly revision: number;        // increments on every accepted change
  readonly persistence:
    | { state: 'saved' }            // no held input; text is what storage last confirmed
    | { state: 'unsaved';
        writing?: { revision: number };    // may be older than `revision`
        lastFailure?: { error: SaveFailure; revision: number } }
    | { state: 'conflict'; conflict: SaveConflict;   // autosave stops
        writing?: { revision: number } };            // only during resolve()
  readonly storage: { exists: boolean; refreshError?: ReadError };
};

type Editor<S> = {
  readonly path: string;
  snapshot(): EditorSnapshot;                 // immutable, for useSyncExternalStore
  markdown(): MarkdownContent<S>;             // derived from snapshot().text
  subscribe(fn: () => void): () => void;
  replaceText(text: string): ChangeResult;
  change(c: DocumentChange<S>): ChangeResult;
  save(): Promise<Result<{ revision: number }, SaveError | ActionError>>;
  revert(): ChangeResult;                     // a new revision equal to known storage
  resolve(choice: 'theirs' | 'mine' | { text: string }): Promise<...>;
  refresh(): Promise<Result<void, ReadError>>;
  release(): void;                            // drops a clean buffer; held input stays with the folder
};

folder.files.open(path, schema?): Promise<Result<Editor<S>, OpenError /* missing | not-text | read */>>
```

**Why this account wins:**
- Every union arm has its own behaviour and payload. `saved` cannot hold a write. `unsaved` keeps autosave running. `conflict` stops it.
- Facts that can coexist go in separate fields:
  - a write in flight next to newer typing;
  - an earlier failure during a retry;
  - "file deleted" next to text you can still use.

## Definitions

- **Stored:** the newest content this owner knows is at the path, from a read, a list, or its own commit.
- **Base:** the stored content that held input was derived from. Saves compare against it.
- **Saved:** no held input. The text equals the last content this owner confirmed in storage, and no write is in flight.
- **Unsaved (dirty):** the owner holds input that storage has not confirmed. This includes the case where a write is carrying it.
- **save():** asks storage to store the revision current at call time. It resolves when that revision or a later one lands, or it returns the failure of the attempt that carried it. It returns `{ revision }`. `Ok` means "revision r is stored", not "the current text is stored". The caller compares r with `snapshot().revision`.
- **flush (owner-level `settle`):** keeps going until no attempt is left that can run without new input. Afterwards every path is either saved or blocked by a failure or conflict.
- **lastFailure:** belongs to the revision that was attempted. It stays visible through typing and retries. A newer failure replaces it, and any successful landing clears it. Typing does not fix a disconnected drive, so the warning should not disappear on the next keystroke.

## Consequential sequences: snapshot vs. recommendation

All references are to `packages/folder/src/edit-owner.ts`.

**1. Typing during a save.** `submitText` copies `saving: true` into the new input (`:1152`). The snapshot shows `saving` while the current text has not been sent. Nothing can show "older revision in flight, newer text waiting". Callers have already given up on the distinction: Epicenter shows "Saving…" for both `dirty` and `saving` (`apps/epicenter/src/folders/FileEditor.svelte:81`), and so does Capture (`TextDetail.svelte:157-162`). Whispering's `isSaving` is just "held and not failed". In the recommendation the state is `unsaved` with `writing.revision < revision`. That is the same "Saving…" display, but correct.

**2. Revert while a save runs.** `discard` is refused while a save runs (`:1014`). Typing back to the base text while a save runs keeps the input (`:1139-1146`). After the save lands, that input is rebased onto the landed text and saved again (`:881-885`). That outcome is correct. `revert()` makes it a first-class action: a new revision equal to stored, available at any time.

**Counterexample (correctness, not architecture):**
1. Open a file whose stored text is A. Type B.
2. An outside write stores C. The reread updates stored to C, and B stays pinned.
3. Type A again.

`textOf(from) === typed` (`:1140-1146`) clears the input. `getText()` then answers C, even though `replaceText('A')` succeeded. Accepted input is silently replaced. The recommendation compares against *stored* (C): A stays as unsaved input and its save reports a conflict.

**3. Retrying a failure.** `drain` sets `{ saving: true, error: undefined }` (`:847`), so the failure is gone during the retry. If newer input exists, the failure is dropped (`:860`) and the loop retries at once (`:871-872`). Typing alone also clears a non-conflict failure (`:1153-1156`). The UI goes Not saved → Saving… → Not saved with every pause. In the recommendation, `lastFailure` stays next to `writing` until a landing clears it.

**4. Typing after a conflict.** `submitText` keeps the conflict but also calls `schedule` (`:1162`). When the timer fires, `drain` clears the error and sets `saving` (`:847`). It then sends with the stale base, gets another conflict, and if newer input arrived, loops once more (`:871-872`). So a conflict does not stay stable under typing. Each pause produces a storage attempt and a `conflict → saving → conflict` flicker, and Epicenter shows "Saving…" in the middle. In the recommendation, `conflict` stops autosave. Typing updates `text`. `resolve('mine')` writes the current text against `conflict.current`.

**5. A refresh that fails or finds the file deleted, while text is still usable.**
- **Read error:** `bufferOf` keeps `ready` and adds `error` (`:573-583`). Good, and kept as `storage.refreshError`.
- **Deleted, with held input:** stays `ready` with MISSING. Saving conflicts because the base no longer matches null. Good.
- **Deleted, clean:** `shownText` returns undefined, so the status becomes `unavailable` and the text is gone. Epicenter already works around this with `lastShown` (`FileEditor.svelte:54-64`). Separately, when the last subscriber leaves, a clean document is dropped (`:1048-1061`).

In the recommendation an opened editor keeps its text: `persistence: saved, storage.exists: false`. That changes behaviour, and the bargain needs naming:
- The UI must decide whether to show "deleted elsewhere" or close.
- The first edit becomes unsaved with base A, and its save is a conflict against null, so it cannot silently recreate the file.
- Honeycrisp and Capture currently show "no longer here". They would branch on `storage.exists` instead of `buffer.error.reason`.

## Concrete use

```ts
const opened = await folder.files.open('notes/a.md', NoteSchema);
if (opened.error) return showOpenError(opened.error);   // missing | not-text | read
const editor = opened.data;
editor.replaceText('# Hi');
const r = await editor.save();
if (r.error === null && r.data.revision === editor.snapshot().revision) markClean();
editor.release();
```

```svelte
{#await folder.files.open(path) then opened}
  {#if opened.error}<OpenFailed error={opened.error} />{:else}
    {@const ed = createEditor(opened.data)}   <!-- reactive snapshot; release on destroy -->
    {@const p = ed.snapshot.persistence}
    <span role="status">
      {#if p.state === 'saved'}Saved
      {:else if p.state === 'conflict'}Changed elsewhere
      {:else if p.lastFailure}Not saved: {p.lastFailure.error.message}{#if p.writing} · retrying…{/if}
      {:else}Saving…{/if}
    </span>
    {#if !ed.snapshot.storage.exists}<p>Deleted elsewhere. Your text is kept.</p>{/if}
    {#if p.state === 'conflict'}
      <button onclick={() => ed.resolve('theirs')}>Use saved</button>
      <button onclick={() => ed.resolve('mine')}>Replace with mine</button>
    {/if}
    <textarea bind:value={() => ed.snapshot.text, (v) => ed.replaceText(v)}></textarea>
  {/if}
{/await}
```

## What disappears, and what moves

**Disappears:**
- `unread | loading | unavailable` and the `ready` gate on every field access.
- `getText(): string | undefined`.
- The `trackRead` trick that starts a read on first access, in Svelte (`edits.ts:24-28`) and React (`edits.ts:32-36`).
- Caller-side `lastShown`.
- The `buffer` container and the `Unsaved` entity. `Recovery` becomes `{ path, text, persistence }`, taken from a snapshot.
- The dirty/saving split nobody uses, and the conflict re-send loop.

**Moves:**
- **Loading now happens before mounting.** That means `{#await}`, a route loader, or Suspense.
- **The handle's lifetime becomes explicit.** `release()` replaces "last subscriber plus a microtask". It needs refcounting because several views can share one per-path owner.
- **Binary content is refused at open.**

**Stays (each with the outcome it protects):**
- The per-path folder owner and its timer, so input outlives the view.
- Revision tracking against a base, so newer typing survives a landing or failure.
- Fences and close/settle, so actions never overwrite held input.
- Read ticks, so an older read cannot overwrite knowledge of a later save.

These are necessary work, and none of them is in the public state.

**Not solved here:** holding text in memory is not crash recovery. Persisting a journal is a separate decision.

## Fit with the current work and uncertainty

- **What this snapshot shows:** the nested `buffer.status / buffer.text / buffer.unsaved?.status` proposal is implemented (`edit-owner.ts:123-145`), and all four app callers use it.
- **What I could not check:** I had no `read_thread`, so the main thread's latest state and the Clarify discussion are unverified.
- **This review neither cancels nor authorizes that work.** Its findings (sequences 1–5 and the revert counterexample) apply whichever shape is chosen.

**Execution evidence requests for the coordinator:**
1. Test: type during a conflict and record every snapshot and storage call across one autosave pause. This confirms sequence 4.
2. Test: the A→B, outside C, type-A sequence. Assert `getText()` answers `'A'`.
3. Test: a transient failure, then typing. Record whether "Not saved" disappears before any landing.
4. Check whether any caller needs a `ready` editor without awaiting, for example list previews that only render. If so, keep a separate passive status query (Whispering's `isSaving`/`isUnsaved` already work that way) rather than putting loading back into the editor.
