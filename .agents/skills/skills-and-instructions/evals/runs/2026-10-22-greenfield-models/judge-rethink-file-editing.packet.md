# Task

Environment note: this is a frozen, read-only source snapshot. The historical absolute workspace path in the request maps to this checkout. Thread-reading tools are unavailable; do not substitute live repository or conversation state. Relevant historical source and callers are included under packages/ and apps/. The original request is reproduced without the later discussion. Describe implementation only as observed in this snapshot.

Help me rethink Epicenter’s file-editing API from first principles. This is conceptual exploration, not an implementation request. Don’t let existing tests, migration costs, or the latest proposal determine the destination.

Read Clarify draft storage and flushing, using `read_thread` with thread ID `01a15ec3-ae90-7fd3-a48d-f29144fabe73` and host `remote-ssh-discovered:studio`. Earlier context is Tighten Markdown File Contracts.

The main conversation has begun implementing the nested buffer/unsaved proposal. This exploration does not cancel or authorize changes to that work. Check its latest state before describing what is implemented.

The workspace is `/Users/braden/.claude/worktrees/epicenter-overnight/v1-doctrine`. Relevant evidence includes `packages/folder/src/edit-owner.ts`, the Svelte and React edit adapters, and the Epicenter, Honeycrisp, Capture, and Whispering callers. Read them to understand the problem, without treating their current boundaries as requirements.

We want one folder-owned editor buffer per path. Raw text and schema-bound Markdown views edit the same source. Accepted input survives component unmounts, failed saves, conflicts, and newer typing during a save. Saving uses an observed source witness to avoid silently overwriting outside changes. Holding input in memory is distinct from durable crash recovery.

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

# Rethinking FileEdit: one source, a witness, and facts that can coexist

I couldn't read the thread (`read_thread` isn't available here), so "implemented" below means only what this snapshot contains. The snapshot already has the nested proposal: `BufferSnapshot` with `ready | … ; unsaved?: Unsaved` (`packages/folder/src/edit-owner.ts:123-145`), it's documented in `packages/folder/README.md:244-266`, and every caller reads `buffer.unsaved`. I can't tell whether the main conversation has moved past that.

## My reading of what you want

> An editor is text that always exists, plus the exact source that text came from. Saving, failing and conflicting describe how storage relates to that text. They are not stages the text passes through.

## The central question: these should not be one value

Your hypothesis holds. For each pair of facts, every combination is a real situation:

| | not saving | saving |
|---|---|---|
| **clean** | idle | you reverted while an older save is still running |
| **dirty** | waiting for autosave | normal save, or you typed during a save |

- **A failure and a retry can both be true.** The UI wants "Retrying… (disk full)".
- **Storage changing elsewhere doesn't require dirty text.** A clean buffer whose file was deleted elsewhere is diverged but not dirty.

The current code shows what happens when these are squeezed into one status:

- **Wrong label.** Typing during a save keeps the old `saving` flag (`edit-owner.ts:1152`). The snapshot says `saving` while the text on screen is newer than what's being saved.
- **Lost error.** An older revision's error is thrown away when newer typing exists (`857-860`). Typing after an error also clears it (`1153-1156`).
- **Retry hides the reason.** A retry clears the error as soon as it starts (`844-848`).

A five-way union really expresses a display priority. Keep that priority, but as a function the app owns, not as the model.

## Definitions

> - **Revision**: a counter that goes up each time a change is accepted.
> - **Base (the witness)**: the exact source that the current text derives from. It's set by a read, or by a save that landed.
> - **Dirty**: `text ≠ base`. It can flip without typing: when a save lands, the base becomes the text that was submitted.
> - **Saved(r)**: storage was seen to hold revision *r*, through a guarded write or a read.
> - **`save()`**: covers the revision current when you call it. If an older save is running, it waits for that, then makes one guarded attempt against the base. It resolves `Ok({ revision })` for the revision that landed. Typing after the call is not waited for; check `dirty` afterwards.
> - **`flush()`**: the folder-level version. It saves every dirty editor and returns detached `{ path, text, base, failure?, diverged? }` for each one that didn't save.
> - **Failure**: the error from the last *finished* attempt. A later attempt replaces it when that attempt finishes, not when it starts. It is cleared by a successful save, or when the text becomes clean.
> - **Diverged**: storage holds something other than the base, and the text can't simply follow it. Autosave stops; only an explicit `rebase()` can overwrite.

## Vanilla use

```ts
const opened = await folder.open('notes/a.md', { schema: Note }); // Result<Editor, NotFound | NotText | ReadFailed>
if (opened.error) return showOpenProblem(opened.error);
using editor = opened.data;          // a lease; held input outlives it

editor.text;          // string, always
editor.markdown;      // the same source read through Note
editor.revision;      // number
editor.dirty;         // boolean
editor.saving;        // boolean
editor.failure;       // SaveFailure | undefined
editor.diverged;      // { current: string | Uint8Array | null } | undefined
editor.refreshError;  // ReadError | undefined
editor.locked;        // reason | undefined

editor.replaceText(t);            // Result<{ revision }, Locked | Closed>
editor.change({ fields, body });
editor.revert();                  // replaceText(base): ordinary input
editor.rebase();                  // adopt diverged.current as the base; next save is guarded against it
const r = await editor.save();    // Result<{ revision }, SaveFailure | Conflict | Locked>
await editor.refresh();
```

`{ create: true }` opens with base `null`, for a file that doesn't exist yet.

## Svelte

The parent handles loading:

```svelte
{#await folder.open(path, { schema: Note }) then opened}
  {#if opened.error}<OpenProblem error={opened.error} />
  {:else}<NoteEditor editor={opened.data} />{/if}
{:else}<Loading />{/await}
```

The editor component never sees a missing text:

```svelte
<script lang="ts">
  let { editor }: { editor: Editor<typeof Note> } = $props();
  const e = reactiveEditor(editor);           // createSubscriber; releases on destroy
  function label() {
    if (e.diverged) return 'Changed elsewhere';
    if (e.saving) return e.failure ? 'Retrying…' : 'Saving…';
    if (e.failure) return 'Not saved';
    return e.dirty ? 'Unsaved' : 'Saved';
  }
</script>

<span role="status">{label()}</span>
{#if e.diverged}
  <Alert>
    {#if e.diverged.current === null}
      Deleted elsewhere. Your text is still here.
      <Button onclick={e.rebase}>Recreate the file</Button>
    {:else}
      Changed elsewhere. <Compare saved={e.diverged.current} mine={e.text} />
      <Button onclick={e.revert}>Use saved file</Button>
      <Button onclick={e.rebase}>Keep mine</Button>
    {/if}
  </Alert>
{:else if e.failure}
  Not saved: {e.failure.message}
  <Button disabled={e.saving} onclick={e.save}>Try again</Button>
{/if}
{#if e.refreshError}<p>Couldn't check for outside changes. <Button onclick={e.refresh}>Retry</Button></p>{/if}
<Input bind:value={() => e.markdown.fields.title, (title) => e.change({ fields: { title } })} />
<Textarea bind:value={() => e.text, (v) => e.replaceText(v)} readonly={!!e.locked} />
```

## The sequences

Notation: B is the base, T1/T2 are typed revisions, C is what storage holds after an outside change.

**1. Typing during a save.**
- T1 (revision 1) is being saved, and you type T2 (revision 2). The editor shows `dirty, saving`.
- The save lands: base becomes T1, `saving` goes false, and you're still dirty.
- The `save()` call made at revision 1 resolves `{ revision: 1 }`. The autosave for T2 runs, guarded against T1.

**2. Reverting during a save.**
- T1 is being saved and you revert. Text becomes B, which equals the base, so `dirty` is false while `saving` is true.
- The save lands: base becomes T1, so you're dirty again, and autosave writes B guarded against T1. Storage ends up holding B.
- One rule covers this, so nothing needs refusing. Today `discard()` is refused while a save runs (`edit-owner.ts:1013-1016`).

**3. Retrying a failure.**
- An attempt fails with "disk full". The editor shows `dirty, failure`.
- Autosave doesn't keep retrying the same failed revision. `save()` starts a retry, and the editor shows `saving, failure` ("Retrying…").
- Success clears the failure. Another failure replaces it.
- Typing after a failure keeps the failure and schedules an attempt for the new revision. The failure no longer applies only when that attempt finishes, or when the text becomes clean.

**4. Typing after a conflict.**
- The editor is diverged with `{ current: C }`. Typing is still accepted, but autosave stays off.
- Today, typing after a conflict re-schedules autosave (`edit-owner.ts:1162`) against the stale base, so it looks like the save is attempted and conflicts again after every pause. Please confirm this (see the requests at the end).
- How to resolve it:
  - "Keep mine" is `rebase()` then save, guarded against C.
  - "Use saved" is `revert()`: the text becomes clean, and clean text follows readable storage, so it becomes C.
  - A merge is `replaceText(merged)` then `rebase()`.
- These replace the three-way `resolveConflict` and its private `conflictCurrent` guard.

**5. A refresh fails, or finds the file deleted.**
- A failed read sets `refreshError` and changes nothing else.
- A read showing a *text* change:
  - Clean text follows it silently.
  - Dirty text becomes diverged **when the refresh happens**, not one autosave later.
- A read showing deletion or binary content:
  - The text stays, `diverged.current` is `null` or the bytes, and the editor isn't dirty. "Recreate" is `rebase()`.
  - Today a clean buffer loses its text in this case (`shownText`, `edit-owner.ts:1093-1099`). That's why Epicenter keeps `lastShown` (`apps/epicenter/src/folders/FileEditor.svelte:54-64`).
  - The cost of keeping the text: an orphaned clean buffer holds memory until its lease is released.

## What disappears, what moves, what stays

**Disappears:**
- The `unread | loading | unavailable` availability states, and the narrowing workaround ("capture a ready snapshot before deferred callbacks", `README.md:278-279`).
- The nesting (`BufferSnapshot` / `Unsaved`), `resolveConflict`, and the `BUSY` refusal from `discard`.
- `buffer.error` handling three different things at once. Refusals become command Results, read problems become `refreshError`, and storage problems become `diverged`. With that, the stored-refusal machinery (`record`/`execute`/`refusalOf`, `edit-owner.ts:504-563`) looks unnecessary, because the template already shows `locked`.
- The `status === 'ready' ? buffer.unsaved : undefined` chains in Epicenter, Capture and Honeycrisp.

**Moves:**
- Loading and not-found handling go to whoever calls `open`.
- The owner must compare each read with the base to detect divergence. It already holds `from` and `doc`.
- Each app writes its own display priority.
- Passive observers (Whispering `isSaving`, Honeycrisp `isWriting`) stay on the folder's status and don't open anything. That's what they already want (`apps/whispering/src/lib/whispering.svelte.ts:1039-1050`).

**What each remaining concept guarantees:**

| Concept | Guarantee |
|---|---|
| `text` | Present for the editor's whole life |
| base | No outside change is silently overwritten |
| `revision` | Save results say exactly what they covered |
| `dirty` | Answers whether it's safe to close |
| `saving` | An operation is still running |
| `failure` | The most recent storage verdict, until it's superseded |
| `diverged` | The only way to overwrite outside changes is to ask explicitly |

Crash recovery stays a separate folder journal; the editor only holds memory.

## Open questions and evidence requests

1. **Show me the current state of the main implementation.** I can only see this snapshot.
2. **Run a test: conflict, then type, then wait two pauses, and count calls to `replaceSource`.** This confirms or refutes the repeated-conflict claim in sequence 4.
3. **Does any caller depend on a clean, deleted buffer losing its text?** Honeycrisp's "no longer in the folder" screen would become `diverged.current === null && !dirty`.
4. **`rebase()` on a deleted file means "create only if still absent".** I need to confirm that `replaceSource(path, null, text)` already guards that way.

The point I'm least sure of is whether a failure should survive typing until the next attempt finishes. If you'd rather "Not saved" disappear on the next keystroke, the rule changes to "cleared by acceptance", and failure and saving become mutually exclusive again.


## Pair 1, response B

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


## Pair 2, response A

# Rethinking Epicenter's file editor: one buffer, with independent facts about storage

## Current state in this snapshot

The nested proposal is already implemented here. `BufferSnapshot` has the shape `unread | loading | unavailable | ready{text, unsaved?}` (`packages/folder/src/edit-owner.ts:141`), and the README documents it (`packages/folder/README.md:244`). I couldn't read the threads or the live branch, so this describes only the snapshot.

Five behaviours in the code bear on your questions:
- **Callers merge `dirty` and `saving`.** Epicenter (`FileEditor.svelte:81`) and Capture (`TextDetail.svelte:157-162`) show both as "Saving…". Whispering calls "held and not failed" `isSaving` (`whispering.svelte.ts:1039-1041`).
- **Typing clears an older failure.** New text clears a non-conflict error (`edit-owner.ts:1153`, `:860`). A retry also clears the error as soon as it starts (`:847`).
- **`save()` can report on the wrong text.** If newer text was typed but not yet tried, the save loop can end and return the older revision's failure (`:871`, `:888`).
- **A clean file deleted elsewhere loses its text.** The buffer becomes `unavailable` with no text. Epicenter works around this by keeping its own `lastShown` copy (`FileEditor.svelte:54-64`).
- **Typing doesn't clear a conflict** (`:1153`).

## Central answer: no single five-way status

**Your hypothesis holds.** `clean | dirty | saving | failed | conflict` blends three independent facts and then picks one to display:

1. **Is the text unsaved?** This compares the current text with storage.
2. **Is a write running?** That write may contain older text.
3. **What stopped the last write?** Either a failure or a conflict.

Real sequences combine these facts. You can type during a save (unsaved and saving). You can retry a failure (saving, and the failure still applies). You can type after a conflict (unsaved, and the conflict still applies). A single union has to hide one fact in each of these cases.

A union is still right for the third fact. A failure and a conflict carry different payloads and offer different actions, and they can't both be true at once, so they belong in one union.

## Organizing idea

**The editor *is* the file-backed buffer, and it always has text.** Loading belongs to *acquiring* an editor, not to the editor. Once you have one, it holds text, a revision number, and a fixed set of facts about how that text relates to storage. The folder still owns one buffer per path. Handles share it, and it outlives the components that show it.

```ts
// Acquisition: async, outside the editing component
const opened = await folder.open('notes/a.md', { schema: noteSchema });
//   Result<Editor<S>, ReadError | Missing | NotText>
//   Resolves immediately if the folder already holds this path's buffer.
//   folder.held(path): Editor | undefined, synchronous, for remounts and recovery.

type Editor<S> = {
  readonly path: string;
  readonly text: string;                     // always present
  readonly markdown: MarkdownContent<S>;     // the same text, read through the schema
  readonly revision: number;                 // +1 for each accepted change
  readonly dirty: boolean;                   // revision > savedRevision
  readonly saving: boolean;                  // a write is running (maybe of an older revision)
  readonly problem?:                         // why the last write didn't land
    | { name: 'Failed'; at: number; error: SaveFailure }
    | { name: 'Conflict'; base: string | null; current: FileContent | null };
  readonly readError?: ReadError;            // the last refresh failed; text unaffected
  readonly locked?: string;                  // a fenced action holds the path
  readonly ended?: 'deleted' | 'not-text' | 'closed'; // the editor is finished; text stays copyable

  replaceText(text: string): ChangeResult;
  change(change: DocumentChange<S>): ChangeResult;
  save(): Promise<Result<{ revision: number }, SaveFailure | SaveConflict | ActionError>>;
  revert(): void;                            // new revision whose text is the saved text
  keepMine(text?: string): Promise<SaveResult>; // resolve a conflict: overwrite storage
  takeTheirs(): void;                        // resolve a conflict: take storage's text, no write
  discard(): Recovery | undefined;
  subscribe(listener: () => void): () => void;
  release(): void;                           // drop this handle; held text survives
};
```

## Definitions

- **Base (the witness):** the exact source storage was last known to hold, `null` for "no file". Every write is checked against the base inside the guarded storage call.
- **Saved revision:** the newest revision whose text storage has confirmed. **Saved** means `revision === savedRevision`.
- **Dirty:** `revision > savedRevision`. Changing the text back doesn't rewind it:
  - With no write running, a change whose text equals the base is marked saved immediately.
  - While a write runs, that same change stays dirty, because storage is about to change.
- **`save()`:** captures `r = revision` and resolves when revision `r` or a newer one lands, returning that revision. It resolves with an error only if a write *containing r or newer* fails. It never reports an older revision's outcome.
- **Flush:** cancel the autosave pause and save now. `editor.save()` flushes one path. `folder.flush()`, today's `settle`, flushes every dirty path and returns what remains unsaved.
- **Saved ≠ durable:** saved means storage acknowledged the write. Crash recovery of in-memory text is a separate journal, and none of these terms promise it.
- **Error lifetimes:**
  - A **conflict** describes the base, so it lasts until `keepMine` or `takeTheirs`. Typing doesn't clear it, and autosave stops because it would only conflict again.
  - A **failure** describes an attempt. It stays until a later write lands or the text becomes clean again. A retry keeps the old failure visible while it runs, then either clears it or replaces it. Typing after a failure triggers a normal autosave of the new revision, but the same revision is never retried automatically.
  - A **read error** concerns observing storage, not saving. The next successful read clears it.

## Five sequences

**1. Typing during a save.** Revision r5 is being written and you type r6, so the editor is `saving` and `dirty`. When r5 lands, `savedRevision` becomes 5 and the base becomes r5's text. The editor is still dirty, and autosave writes r6. A `save()` called during r5 resolves after r5 lands. One called after r6 waits for r6.

**2. Reverting while a save runs.** The base is T4 and r5 (text T5) is being written. `revert()` creates r6 with text T4, which stays dirty.
- If r5 lands, the base becomes T5, and r6 is written to restore T4.
- If r5 fails, storage still holds T4, which equals r6. The editor becomes clean with no write, and the failure disappears because no unsaved text remains.

**3. Retrying a failure.** r5 failed, so `problem` is `Failed{at: 5}`. Calling `save()` starts a write while `problem` stays set, so the UI can show "Retrying…". Success clears `problem`. Another failure replaces it with the new error.

**4. Typing after a conflict.** Saving r5 hit a conflict: storage holds C. You type r6. The conflict remains and autosave stays stopped. Three ways out:
- `keepMine()` makes C the base and writes r6.
- `takeTheirs()` sets the text to C as a new revision, already saved.
- To merge, call `replaceText(mergeText(base, C, text))`, then `keepMine()`.

**5. Refreshing while text is usable.**
- **The read fails:** `readError` is set, and the text and editing are untouched.
- **The file was deleted and the editor is clean:** the editor follows storage, so `ended: 'deleted'`. The text stays readable and copyable. Epicenter's `lastShown` workaround goes away.
- **The file was deleted and the editor is dirty:** the editor reports `Conflict{current: null}` immediately. The next save would have discovered the same fact. `keepMine()` recreates the file; `takeTheirs()` ends the editor.

Your question about always-retained text gets an explicit answer in the clean-deletion case. The editor keeps the text but stops accepting changes, so a file deleted elsewhere is never silently brought back.

## Vanilla use

```ts
const opened = await folder.open(path);
if (opened.error) return showOpenError(opened.error);
const editor = opened.data;

editor.replaceText(next);               // accepted into memory, autosaves after the pause
const saved = await editor.save();      // covers every revision up to this call
if (saved.error?.name === 'Conflict') showCompare(editor.problem);
editor.release();                       // dirty text stays held by the folder
```

## Svelte

```svelte
<!-- Parent: acquisition owns loading and unavailability -->
{#await folder.open(path)}
  <Loading label="Opening…" />
{:then opened}
  {#if opened.error}<OpenError error={opened.error} retry={...} />
  {:else}{#key path}<FileEditor editor={opened.data} />{/key}{/if}
{/await}
```

```svelte
<script lang="ts">
  import { reactiveEditor } from '@epicenter/svelte/edits';
  let { editor: owned }: { editor: Editor } = $props();
  const editor = reactiveEditor(owned); // subscribes; calls release() on destroy
  const conflict = $derived(editor.problem?.name === 'Conflict' ? editor.problem : undefined);
</script>

<span role="status">
  {#if conflict}Saved file changed
  {:else if editor.saving}{editor.problem ? 'Retrying…' : 'Saving…'}
  {:else if editor.problem}Not saved: {editor.problem.error.message}
  {:else if editor.dirty}Edited
  {:else}Saved{/if}
</span>

{#if conflict}
  <CompareSources mine={editor.text} theirs={conflict.current} />
  <Button onclick={() => editor.keepMine()}>Replace saved file</Button>
  <Button onclick={() => editor.takeTheirs()}>Use saved file</Button>
{:else if editor.problem && !editor.saving}
  <Button onclick={() => editor.save()}>Try again</Button>
{/if}
{#if editor.ended === 'deleted'}<p>Deleted elsewhere. Copy anything you need.</p>{/if}
{#if editor.readError}<p>Couldn't check for outside changes. Your text is kept.</p>{/if}

<Textarea readonly={!!editor.ended || !!editor.locked}
  bind:value={() => editor.text, (v) => editor.replaceText(v)} />
```

The status line is a display priority built *from* the facts. It isn't the contract, so each app can choose its own ordering.

## What disappears

- **The `buffer` container and its four availability states.** They become the outcome of `open()`, and the editing component never sees "no text".
- **`unsaved` as a separate thing.** It becomes `dirty`, `saving` and `problem`. `Recovery` remains only as a detached copy.
- **Caller workarounds:** `lastShown`, the `text !== undefined` guards, and the `status === 'ready'` narrowing that every caller repeats.
- **The mismatch between `save()` and what it covers.** The revision number states what landed.

## Where complexity moves

- **Parents own loading and open errors.** Honeycrisp's `FileDetail` gating (size queries, `isWriting || isUnsaved`) moves before `open()`.
- **The owner needs a `release()` lifetime,** counted per handle. Today the folder infers this from subscriptions.
- **Clean deletion ends the editor.** Restoring a file deleted elsewhere becomes an explicit action instead of continued typing.
- **The schema stays bound at open,** and handles with different schemas still share one text.
- **React gets an immutable snapshot of the facts above.** That snapshot is an adapter detail, not a separate concept.

## Guarantees that justify what remains

- **`text`:** accepted input exists until it is saved, discarded or ended, regardless of mounting.
- **`revision`:** every completion names what it completed.
- **`problem`:** the two outcomes that need a person are mutually exclusive, and each has its own resolution.
- **`dirty` and `saving`:** they stay separate because typing during a save makes both true.
- **`ended`:** observed storage, not stale memory, decides whether a clean editor continues.

## Unresolved, and evidence requests for the coordinator

- **Confirm the stale-failure path with a test:** start a slow failing save of r5, type r6 more than 1 s later, and check that `save()` returns r5's failure while r6 was never tried.
- **Check the main branch's latest nested-buffer state.** I couldn't read the threads.
- **Decide failure policy:** whether a failure should pause autosave of new revisions (backoff) rather than let each keystroke trigger a new attempt.
- **Choose the clean-deletion product promise:** end the editor, or keep it editable as a "recreate" draft.


## Pair 2, response B

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


