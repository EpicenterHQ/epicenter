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
