# Task

Environment note: this is a frozen, read-only source snapshot. The historical absolute workspace path in the request maps to this checkout. Thread-reading tools are unavailable; do not substitute live repository or conversation state. Relevant historical source and callers are included under packages/ and apps/. The original request is reproduced without the later discussion. Describe implementation only as observed in this snapshot.

Help me rethink Epicenter’s file-editing API from first principles. This is conceptual exploration, not an implementation request. Don’t let existing tests, migration costs, or the latest proposal determine the destination.

Read Clarify draft storage and flushing, using `read_thread` with thread ID `01a15ec3-ae90-7fd3-a48d-f29144fabe73` and host `remote-ssh-discovered:studio`. Earlier context is Tighten Markdown File Contracts.

The main conversation has begun implementing the nested buffer/unsaved proposal. This exploration does not cancel or authorize changes to that work. Check its latest state before describing what is implemented.

The workspace is `/Users/braden/.claude/worktrees/epicenter-overnight/v1-doctrine`. Relevant evidence includes `packages/folder/src/edit-owner.ts`, the Svelte and React edit adapters, and the Epicenter, Honeycrisp, Capture, and Whispering callers. Read them to understand the problem, without treating their current boundaries as requirements.

We want one folder-owned editor buffer per path. Raw text and schema-bound Markdown views edit the same source. Accepted input survives component unmounts, failed saves, conflicts, and newer typing during a save. Holding input in memory is distinct from durable crash recovery.

The main proposal became:
```arduino
fileEdit.buffer.status
fileEdit.buffer.text
fileEdit.buffer.unsaved?.status
```

Availability uses `unread | loading | unavailable | ready`. Only a ready buffer has text and optional unsaved work. Unsaved work uses `dirty | saving | failed | conflict`. Nested unsaved state does not repeat text or path; detached recovery values do.

Our side discussion questioned this more deeply:

- Is FileEdit actually the file-backed buffer itself, rather than something containing another buffer?
- Is `fileEdit.buffer` merely an immutable snapshot of that resource?
- Would asynchronous acquisition give callers an editor whose text always exists, moving initial loading outside the editing component?
- A buffer itself is synchronous memory. `await openText(path)` would await any necessary file read. Folder ownership and asynchronous acquisition are independent decisions.
- A promise that a buffer always retains text also changes behavior after outside deletion, especially when no dirty input exists. Examine that explicitly.
- `buffer.state` feels like an unnecessary container. `unsaved` also feels questionable as an entity when it describes a relationship to storage.

We explored a flatter editor:
```scss
editor.text
editor.isDirty
editor.isSaving
editor.saveError

editor.replaceText(value)
editor.save()
editor.revert()
```

But independent flags leave relationships implicit. If a failed save and a running retry are mutually exclusive, a discriminated union may express the contract better:
```graphql
type EditorSnapshot = { text: string } & (
  | { status: 'clean' }
  | { status: 'dirty' }
  | { status: 'saving' }
  | { status: 'failed'; error: SaveFailure }
  | { status: 'conflict'; error: SaveConflict }
);
```

**This is a candidate, not a decision.** My central question is whether these five statuses deserve to be exactly one mutually exclusive value.

A hypothesis to challenge: a status earns its place when it expresses mutually exclusive behavior and payloads. It becomes misleading when it compresses independent facts into a display priority. “Dirty” concerns the relationship between current text and persistence; “saving” concerns an operation that may contain older text. Those distinctions might coexist without requiring separate public state machines.

Walk through concrete sequences: typing during a save, reverting while a save runs, retrying a failure, typing after a conflict, and a refresh failing or finding deletion while usable text remains. Define “dirty,” “saved,” “save,” and “flush” precisely. Which revision has completed when a save or flush resolves? Which error still applies after text changes? Does retry replace or retain a failure?

Develop the strongest greenfield API you can, even if it differs substantially from every proposal above. Show its vanilla use and a realistic Svelte template. Explain what disappears, what complexity moves elsewhere, and which guarantees justify the remaining concepts


# Responses

## Pair 1, response A

# Adversarial review: Epicenter file-editing API

**Verdict: change the design.** The five statuses should not be one mutually exclusive value. Only the relationship between the text and storage is mutually exclusive: `saved | unsaved | conflict`. Whether a save is running, and the last save failure, are separate facts that belong inside `unsaved`. The current union can't represent the common case of "typing during a save", and it erases a failure as soon as a retry starts. Your hypothesis holds.

This was a single local pass, as delegated. Nothing was run.

## Files read
```
.agents/skills/adversarial-review/{SKILL.md, references/deletion-prizes.md}
REQUEST.md
packages/folder/src/edit-owner.ts
packages/svelte/src/edits.ts
packages/react/src/edits.ts
apps/epicenter/src/folders/FileEditor.svelte
apps/honeycrisp/src/routes/components/{FileDetail,NoteDetail}.svelte
apps/honeycrisp/src/lib/notes.svelte.ts
apps/capture, apps/whispering (grep of buffer/unsaved/save/discard callsites)
```

## What this snapshot implements
- The nested proposal is in place: `BufferSnapshot` is `unread | loading | unavailable | ready`, and a ready buffer carries `unsaved?: dirty | saving | failed | conflict` (`edit-owner.ts:123-145`).
- There is also a top-level `error`, picked by priority: `refusal ?? readError ?? sourceIssue` (`:573`). That is exactly the "display priority" compression you described, at the buffer level.

## How the current code behaves in each sequence

- **Typing during a save.** New input inherits `saving: true` (`:1152`), so it shows as `saving` even though the newest text isn't the text being saved. When the older save lands, the state becomes `dirty` with `from` set to the submitted text (`:881`). No caller tells `dirty` and `saving` apart: Epicenter (`FileEditor.svelte:81`) and Honeycrisp (`FileDetail.svelte:240`) both just show "Saving…".
- **Reverting while a save runs.** Typing back to the original text creates a new revision while the save runs, and the text is written back after the save lands (`:1139-1146`). That's correct. But `discard()` is refused with `BUSY` while saving (`:1013`).
- **Retrying a failure.** The retry immediately sets `error: undefined, saving: true` (`:847`). The failure disappears before the retry has any outcome.
- **Typing after a failure** drops the failure, because only conflicts are retained (`:1153`). The UI goes back to "Saving…" with no sign that storage is failing.
- **Typing after a conflict** keeps the conflict, but `schedule()` still runs (`:1162`). Every pause sends another save from a stale base, which presumably conflicts again.
- **A refresh that fails** while text exists gives `ready` with `error: ReadError`. That's fine.
- **Outside deletion with no input.** `shownText` returns `undefined`, so the text disappears and the status becomes `unavailable` (`:1093-1099`). Epicenter works around this by caching `lastShown` itself (`FileEditor.svelte:54-64`), which shows callers want the text to survive.
- **Outside deletion with input.** The status is `ready` with error `MISSING`, and "saving will report a conflict" (`FileEditor:143`). Three callers handle this "deleted but unsaved" case separately (FileDetail `recovery`, Whispering `FileView:128-137` and `RecordingDetail:153-161`).

## Definitions

- **Confirmed text:** the latest content this editor knows storage holds, either from a save that landed or a read.
- **Base:** the confirmed text the current input was edited from.
- **Saved:** every save attempt has settled and the current text equals the confirmed text. So `saved` implies nothing is saving.
- **Unsaved:** not saved, and storage still matches the base (or hasn't been observed to move).
- **Conflict:** storage was observed to differ from the base (other text, deleted, or not text). This is a relationship you can work out from any read, not just from a save. Text that matches storage exactly is treated as saved.
- **`save()`:** ask for the revision that is current *at the moment of the call*. It resolves `Ok({ revision })` once that revision or a later one is confirmed. It resolves with an error if the attempt carrying it fails or conflicts. It never waits for typing that happens after the call, and it never reports a later revision's failure.
  - The current code does neither reliably. A joined `save()` returns the outcome of the loop's *last* round (`:888`). So it can return a later revision's failure even though the requested revision landed.
- **Flush:** a folder-level operation. It tries each held revision once, never retries a revision it already tried, and returns the input that is still unsaved (today's `settle()` returns `Recovery[]`). Flush promises one attempt each, not durability.
- **Which error applies after the text changes:**
  - `lastFailure` describes storage, not the text, so it is kept through typing and retries. It is replaced only when a later attempt settles, and cleared when the editor becomes saved.
  - A conflict is kept until a resolution sets a new base.
  - A refresh error is kept until a read succeeds, and never affects status.

## Proposed API

```ts
const opened = await folder.openText(path);   // Result<TextEditor, Missing | NotText | ReadFailed>

type EditorState = {
  readonly revision: number;
  readonly text: string;                      // always present
  readonly refreshError?: ReadError;          // observation only
} & (
  | { status: 'saved' }
  | { status: 'unsaved'; saving: boolean; lastFailure?: SaveFailure }
  | { status: 'conflict'; theirs: Theirs; edited: boolean }
);
type Theirs = { kind: 'text'; text: string } | { kind: 'deleted' } | { kind: 'binary' };

interface TextEditor {
  readonly path: string;
  readonly state: EditorState;                // immutable snapshot
  readonly locked: boolean;                   // fences: separate on purpose
  subscribe(fn: () => void): () => void;
  replaceText(text: string): ChangeResult;    // refusals returned, not stored
  revert(): ChangeResult;                     // text := confirmed, or := theirs in conflict
  keepMine(): Promise<SaveResult>;            // base := theirs, then save
  save(): Promise<SaveResult>;                // revision at call
  as<S>(schema: S): { markdown: MarkdownContent<S>; change(c: DocumentChange<S>): ChangeResult };
}
```

Rules that keep this small:
- Autosave is suspended while there's a conflict.
- An editor with no edits follows storage changes automatically, as it does today.
- An editor with no edits whose file is deleted becomes `conflict{ theirs: deleted, edited: false }` and keeps its text. That's the rule that makes "text always exists" true. Dropping the handle closes it, and `revert()` returns an error in that case.
- `revert()` is just an edit, so it's never refused during a save.

**Vanilla use**
```ts
const r = await folder.openText('notes/a.md');
if (r.error) return showUnavailable(r.error);
const ed = r.data;
ed.subscribe(() => render(ed.state));
ed.replaceText('# Hello');
const saved = await ed.save();
if (saved.error?.name === 'Conflict') ed.state.status === 'conflict' && confirmKeep() ? ed.keepMine() : ed.revert();
```

**Svelte**
```svelte
<!-- FileDetail.svelte, keyed by path -->
{#await folder.openText(path)}<Loading />
{:then r}
  {#if r.error}<Empty.Root>{r.error.message}</Empty.Root>
  {:else}<TextEditorView editor={createEditor(r.data)} />{/if}
{/await}

<!-- TextEditorView.svelte -->
{@const s = editor.state}
<span role="status">
  {#if s.status === 'saved'}Saved
  {:else if s.status === 'unsaved'}{s.saving ? 'Saving…' : 'Unsaved'}
    {#if s.lastFailure} · last save failed: {s.lastFailure.message}{/if}
  {:else}{s.theirs.kind === 'deleted' ? 'Deleted elsewhere' : 'Changed elsewhere'}{/if}
</span>
{#if s.status === 'conflict'}
  {#if s.theirs.kind === 'text'}<pre>{s.theirs.text}</pre>{/if}
  <Button onclick={() => editor.revert()} disabled={s.theirs.kind === 'deleted'}>Use saved</Button>
  <Button onclick={() => editor.keepMine()}>{s.theirs.kind === 'deleted' ? 'Recreate' : 'Keep mine'}</Button>
{/if}
{#if s.refreshError}<p role="alert">{s.refreshError.message} <Button onclick={editor.refresh}>Retry</Button></p>{/if}
<Textarea bind:value={() => s.text, (v) => editor.replaceText(v)} readonly={editor.locked} />
```

## What gets deleted
- **Availability states:** `unread | loading | unavailable`, `UNREAD`, the `bufferOf` branches (`:585-590`), and the `string | undefined` results of `getText`/`getMarkdown`. `ChangeError.NoSource` and `NotText` move to `openText`.
- **Auto-read in the adapters:** Svelte `trackRead` (`svelte/edits.ts:24-28`) and React `requested`/`useEffect` (`react/edits.ts:30-36`).
- **Refusals stored in the snapshot:** `record`, `execute`, `refusalOf`, `PathState.refusal` (`:504-563`, about 60 lines), and the `BufferIssue` union. Commands already return their refusals, and Capture already uses the returned result (`TextDetail:195`).
- **`resolveConflict`** (`:1225-1289`), including its reread and its "input changed while resolving" error. It's replaced by `revert`/`keepMine`, with `theirs` taken from what storage is known to hold. `conflictCurrent` disappears as private state.
- **Caller workarounds:** Epicenter's `lastShown`, `missing`, `sourceLocked`; the three "deleted but unsaved" branches; and repeated autosaves against a stale base after a conflict.

## Where complexity moves, and what it costs
- **Loading moves up a level, to whoever opens the editor.** NoteDetail's loading, missing and error branches move to FileDetail. The total is roughly the same, but it's now in one place.
- **Conflicts are detected on read, not only on save.** A dirty editor stops autosaving as soon as a poll sees an outside change. That's earlier than today, with the same outcome.
- **An editor with no edits that sees an outside deletion now shows a conflict** instead of disappearing. Honeycrisp's "no longer in the folder" view has to map from `theirs.kind === 'deleted' && !edited`.
- **Handles keep their last snapshot,** so the owner can still drop path state when nothing holds it. A pruned path that gets resubscribed is read again while the handle shows its snapshot.
- **What survives unchanged:** one owner per path, fences and `locked`, the close/settle/release lifecycle, the aggregate `getStatus`, detached `Recovery` values, and one source shared by the text and schema views.
- **Unresolved edge case:** a save already running when a read detects a conflict. I say it settles before the status leaves `conflict`. That's a design rule that needs a test, not something I verified.

## Correctness findings in the snapshot
These are separate from the redesign. None is proven to be a regression.
1. A joined `save()` can resolve with a later revision's failure, or `Ok` while newer input is still unsaved (`:833-889`).
2. A retry erases the failure before it has an outcome (`:847`), and typing erases a non-conflict failure (`:1153`).
3. Autosave keeps retrying against a stale base after a conflict (`:1162`).
4. `discard` is refused while a slow save runs (`:1013`).

## Remaining plan
This review doesn't cancel or authorize changes to the work in progress. If you adopt it:
- Collapse the remaining nested `buffer.unsaved` work into `openText` plus `state`.
- Drop any planned work on `unread`/`loading` UI in editor components.
- Replace the `resolveConflict` tests with `revert`/`keepMine` tests.

## Evidence to request from the coordinator
- Whether a `replaceSource` call that conflicts is cheap and side-effect-free. This decides how serious finding 3 is.
- Whether `buffer.test.ts` and `source-draft.test.ts` cover a joined `save()` when a later revision fails (finding 1).
- The latest state of the main implementation beyond this snapshot. I described only what is in this checkout.


## Pair 1, response B

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


## Pair 2, response A

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


## Pair 2, response B

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


