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

# Rethinking Epicenter's file-editing API

**Answer to the central question:** no, the five statuses should not be one mutually exclusive value. Only `conflict` earns its own variant, because it is the only one that changes behaviour: autosave stops, a decision is required, and it carries a payload (what storage now holds). The others record three independent facts:

- **Dirty:** how the current text relates to its base.
- **Saving:** an attempt that is in flight, possibly for older text.
- **Failed:** the outcome of the last attempt.

A single union turns those facts into a display priority, and the snapshot shows it losing information.

## What the snapshot shows

I couldn't read the thread (the snapshot says thread tools are unavailable), so everything below about the implementation comes from this checkout.

- The nested proposal is in place. `BufferSnapshot` has `unread | loading | unavailable | ready` with optional `unsaved` (`packages/folder/src/edit-owner.ts:123-145`), and the Svelte and React adapters expose it.
- Internally, `Pending` keeps `saving: boolean` and `error` as separate fields (`edit-owner.ts:102-107`). `snapshotOf` then flattens them by priority, with saving ahead of error ahead of dirty (`:483-491`).
- **A retry erases the failure it is retrying.** `drain` clears `error` when the attempt starts (`:847`).
- **Typing erases a non-conflict failure** (`:1153-1156`), while a conflict survives typing.
- **A failure of an older revision is dropped silently** when newer typing exists (`:860`).
- `discard` is refused with `BUSY` while a save runs (`:1013-1016`).
- **No caller tells `dirty` and `saving` apart.**
  - Epicenter shows "Saving…" for both (`apps/epicenter/src/folders/FileEditor.svelte:81`), and so does Capture (`TextDetail.svelte:157-162`).
  - Honeycrisp and Whispering compute `isSaving = unsaved && !failure` from folder status (`notes.svelte.ts:450`, `whispering.svelte.ts:1039-1041`).
- **Every caller does tell `failed` and `conflict` apart**, because they lead to different actions: Try again versus Use saved / Replace.
- Epicenter keeps a `lastShown` copy so text survives an outside deletion (`FileEditor.svelte:54-64`). That shows the buffer doesn't hold that promise today.
- `buffer.error` mixes five error families: read, change, action, source-unavailable and save. Refusals are written into the snapshot by the `record`/`execute` machinery (`:504-563`).

## The proposal: an open file *is* the buffer

> **`folder.open(path)` asynchronously acquires one folder-owned text file per path. Once open, its text always exists. The text is the user's intent, and storage converges to it unless a conflict suspends that.** Loading and unavailability belong to acquisition, not to the editor.

```ts
type TextFileSnapshot = {
  readonly path: string;
  readonly text: string;
  readonly revision: number;                   // +1 per accepted change
  readonly dirty: boolean;                     // text !== base
  readonly writing: { revision: number } | null;
  readonly failure: { revision: number; error: SaveFailure } | null;
  readonly conflict: { storage: StoredText | Missing | Binary } | null;
  readonly check: { error: ReadError } | null; // last refresh failed
  readonly locked: string | null;              // a fenced folder action holds the path
};

interface TextFile extends TextFileSnapshot, Disposable {
  snapshot(): TextFileSnapshot;                // frozen, for useSyncExternalStore
  subscribe(listener: () => void): () => void;
  replace(text: string): Result<{ revision: number }, Locked>;
  as<S>(schema: S): MarkdownView<S>;           // .value, .change({ fields, body })
  revert(): Result<{ revision: number; previous: string }, Locked>;
  save(): Promise<Result<{ revision: number }, SaveFailure | SaveConflict | Locked>>;
  resolve(keep: 'mine' | 'theirs'): Promise<Result<Resolved, SaveError>>;
  refresh(): Promise<Result<void, ReadError>>;
}
```

The fields are not all independent. These invariants hold:

- `writing` implies no `conflict`.
- `conflict` implies no autosave.
- `writing` and `failure` can coexist; that combination means "retrying".
- A clean buffer can still have a write in flight (see "Revert during a save" below).

**Choosing those invariants, not a priority order, is the design work.**

Holding text in memory is not crash recovery. Durable journaling would be a separate hook the folder owns, for example `onUnsaved(snapshot)`.

## Definitions

- **Revision:** a counter that increases with each accepted change, including `revert` and adopting outside text.
- **Base:** the stored content the text descends from. It is the guard for the next write.
- **Dirty:** `text !== base text`. This compares content, so typing back to the base makes the file clean.
- **Saved (revision r):** storage holds the text of revision r, confirmed by a guarded write that landed. On landing, base becomes the text that was written.
- **`save()`:** captures r, the revision when you call it. It resolves `Ok({ revision })` once storage holds some revision ≥ r. It resolves with an error when the attempt for r fails or conflicts. It does not wait for typing that comes after the call, so callers can compare the result with `file.revision`.
- **Flush:** a folder-level operation, not a per-file one. `folder.flush()` saves every dirty file and resolves with snapshots of whatever is still unsaved. Close and fenced actions use it. Today's two per-file verbs (`save()` plus an internal `flush`) become one per-file and one per-folder.
- **Failure:** the outcome of the last attempt, labelled with the revision it tried. Typing does not clear it, and starting a retry does not clear it. Only a later attempt's outcome replaces it: success clears it, and a new failure replaces it.

## The consequential sequences

**Typing during a save.**
1. Revision 5 is being written. You type, giving revision 6: `dirty`, `writing: {5}`.
2. Revision 5 lands. Base becomes text 5. A `save()` called at revision 5 resolves `{ revision: 5 }`. The file is still dirty, so autosave writes revision 6.

The single union would show "saving" for revision 6, which is not being written yet.

**Revert during a save.**
1. Revision 5 is being written. `revert()` creates revision 6 with text equal to base B0, so `dirty: false` and `writing: {5}`. This state can't be expressed in the five-status union.
2. Revision 5 lands. Base becomes text 5, so the file is dirty again and autosave writes B0 back.

What the screen showed is what ends up stored. `revert` never refuses, so the `BUSY` refusal goes away. `previous` returns the abandoned text so the UI can offer to copy or undo.

**Retrying a failure.**
1. Revision 5 failed: `failure: {5, EACCES}`, and autosave does not loop on the same revision.
2. `save()` starts: `writing: {5}`, and `failure` is kept, so the UI shows "Retrying…".
3. Success clears `failure`. A failure replaces it with `{5, newError}`.

If you type revision 6 after the failure, `failure: {5}` stays visible as "Last save failed". Autosave tries revision 6 after the pause, and that attempt's outcome replaces the failure.

**Typing after a conflict.**
- The conflict belongs to the base, not to an attempt, so it persists. Revision 6 is accepted and nothing is written.
- `save()` re-checks storage. If storage matches the base again, the conflict dissolves and the write proceeds. Otherwise `save()` returns the conflict without writing.
- `resolve('mine')` sets base to the conflicting storage and writes the latest revision, including revision 6.
- `resolve('theirs')` makes the stored text a new, clean revision and returns `previous`.

**A refresh fails.** `refresh()` returns `Err`, and `check` records it. `text`, `dirty`, `writing` and `failure` don't change, so a read problem never touches save state. The next successful read clears `check`.

**A refresh finds an outside change while the file is clean.** The buffer adopts the stored text as a new revision, marked as coming from storage so a rich editor can keep its undo history consistent.

**A refresh finds a deletion while text remains usable.**
- Dirty or clean, this produces `conflict: { storage: missing }`.
- The text stays and remains editable, autosave stops, and the UI offers Restore (`resolve('mine')` recreates the file) or Close.
- **This is the honest cost of "text always exists."** A clean buffer can't follow storage into nothing, so a deletion becomes a decision instead of a silent disappearance.
- **`resolve('theirs')` on a missing file ends the file**: it returns `{ ended: true, previous }` and the component must leave. Ending this way, from outside, is the one route besides releasing the file.
- The `lastShown` workaround disappears.

## Use

```ts
const opened = await folder.open('notes/groceries.md');
if (opened.error) return show(opened.error);   // missing | not-text | read failed
using file = opened.data;                      // release on scope exit

file.replace(file.text + '\n- milk');
const saved = await file.save();
if (saved.error?.name === 'Conflict') await file.resolve('mine');
else if (saved.data && saved.data.revision < file.revision) {
  /* newer typing still pending; autosave owns it */
}

const note = file.as(noteSchema);              // same buffer, schema-bound view
note.change({ fields: { title: 'Groceries' } });
```

The route owns acquisition:

```svelte
<script lang="ts">
  let { path }: { path: string } = $props();
  const opening = $derived(folder.open(path));
  $effect(() => {
    const pending = opening;
    return () => void pending.then((r) => r.data?.[Symbol.dispose]());
  });
</script>

{#await opening}
  <Loading label="Opening…" />
{:then opened}
  {#if opened.error}
    <Unavailable error={opened.error} onretry={() => (path = path)} />
  {:else}
    {#key path}<FileEditor file={reactiveFile(opened.data)} />{/key}
  {/if}
{/await}
```

The editor component never sees loading:

```svelte
<script lang="ts">
  let { file }: { file: ReactiveTextFile } = $props();
</script>

<header role="status">
  {#if file.locked}{file.locked}
  {:else if file.conflict}Changed elsewhere
  {:else if file.writing}{file.failure ? 'Retrying…' : 'Saving…'}
  {:else if file.failure}Not saved: {file.failure.error.message}
    <Button onclick={() => file.save()}>Try again</Button>
  {:else if file.dirty}Edited
  {:else}Saved{/if}
  {#if file.check}<small>Couldn’t check for outside changes.</small>{/if}
</header>

{#if file.conflict}
  <Alert.Root variant="destructive">
    {file.conflict.storage.kind === 'missing'
      ? 'This file was deleted elsewhere. Your text is still here.'
      : 'The saved file changed. Your text is still here.'}
    <Button onclick={() => file.resolve('mine')}>
      {file.conflict.storage.kind === 'missing' ? 'Restore file' : 'Keep mine'}
    </Button>
    <Button variant="ghost" onclick={() => file.resolve('theirs')}>
      {file.conflict.storage.kind === 'missing' ? 'Close' : 'Use saved'}
    </Button>
  </Alert.Root>
{/if}

<Textarea
  readonly={file.locked !== null}
  bind:value={() => lf(file.text), (v) => file.replace(withFileNewlines(v, file.text))}
/>
```

## What disappears, what moves, what remains

**Disappears:**
- `unread | loading | unavailable` and `text: string | undefined` inside the editor.
- The `buffer` container, `unsaved` as an entity, and `Recovery` as a separate type, because a frozen snapshot is already copyable.
- The `BufferIssue` grab bag and the refusal-recording machinery. Refusals are just return values.
- `discard`'s `BUSY` refusal, Epicenter's `lastShown`, and the callers' `isSaving` derivations.

**Moves elsewhere:**
- Every view needs an await boundary at its parent.
- Lease lifetime becomes explicit. A forgotten release keeps a clean buffer in memory, so components should acquire through a helper that releases on destroy.
- Passive observers such as Whispering's per-path status and the save lines must not open files. They need folder-level `folder.unsaved` and `folder.peek(path)`.
- The owner holds the text of clean open files in memory.

**What remains, and the guarantee each concept buys:**

| Concept | Guarantee |
| --- | --- |
| `text` | The intent, which storage converges to. |
| `revision` | Lets results and failures say what they are about. |
| `dirty` | An exact content relation. |
| `writing` | An attempt in flight, possibly older than the text. |
| `failure` | Kept until a later attempt decides it. |
| `conflict` | The only state that suspends autosave. |
| `check` | Freshness of what is known about storage, kept separate from saving. |
| `locked` | A fence by a folder action. |

A combined status label is still fine as a **derived presentation helper**, not as the contract.

## Still uncertain

- **What the main conversation has implemented since this snapshot.** Coordinator: please run `git log`/`git diff` on `packages/folder/src/edit-owner.ts` in the live worktree.
- **Whether a failure should also pause autosave of newer revisions.** I kept today's behaviour, where newer typing retries.
- **Svelte ergonomics of `{#await}` plus disposal.** A small `openFile` resource helper may be better.
- **How adopting outside text affects the rich editor's undo history.** This needs a test against Honeycrisp's `RichEditor`.


## Pair 1, response B

I couldn't use `read_thread`, which is unavailable in this snapshot. Everything below comes from the source and from REQUEST.md.

**What the snapshot already has.** The nested proposal is in place. `BufferSnapshot` has the states `unread | loading | unavailable | ready`, and a ready buffer carries `unsaved?: Unsaved` (`packages/folder/src/edit-owner.ts:123-145`). All the callers read `buffer.unsaved`. Five things in the code shape the answer:

- **Typing during a save keeps the status `saving`, even though the text is now newer than what is being written** (`edit-owner.ts:1152`). So `saving` already coexists with newer, unsaved text.
- **A retry clears the earlier error as soon as it starts** (`:847`). Typing clears a failure but keeps a conflict (`:1153-1155`).
- **When a file is deleted elsewhere and there's no unsaved input, the text disappears** (`shownText`, `:1093-1099`). `FileEditor.svelte:55-64` works around this with `lastShown`.
- **`discard()` is refused while a save is running** (`:1013-1016`).
- **Every caller shows `dirty` and `saving` the same way, as "Saving…"** (`FileEditor.svelte:81`, `TextDetail.svelte:157-161`, `FileDetail.svelte:237-242`). None of them distinguishes the two.

## Answer to the central question

**No.** Those five statuses shouldn't be one mutually exclusive value, because `saving` isn't the same kind of fact as the others. Four of them describe **how the editor's text relates to storage, and who has to act next**. `saving` describes **an operation in progress**, and the text it's writing may be older than the current text. It can run alongside `dirty` (typing during a save) and alongside `failed` (a retry). So your hypothesis holds: keeping `saving` in the union squashes two facts into a display priority.

With `saving` taken out, the remaining relation *is* exclusive. Each value decides who makes progress and which command does it:

> **status: `clean`** (nothing to write) · **`dirty`** (autosave will write it) · **`failed`** (this exact text was tried and failed; it waits for `save()`) · **`conflict`** (storage moved away from the base; it waits for `resolve()`) · **`detached`** (clean, but storage no longer holds text)

**Errors attach to what they describe:**
- A save failure is about one attempt, at one revision. It stops applying once the text changes.
- A conflict is about the base, meaning the stored content the edits started from. It survives typing, because any later save from the same base would conflict too.
- A read error is about what we know of storage. It never changes the text.

## Definitions

- **revision**: a counter that goes up each time input is accepted.
- **base**: the exact stored content the text last agreed with. That's either the first content read or the last save that landed. Every write is guarded against it (compare-and-swap).
- **expected**: what storage will hold if every write in flight lands. That's the text of the attempt in flight, or the base if nothing is in flight.
- **dirty**: the text differs from *expected*.
- **saved (for revision r)**: a guarded write of r's text landed.
- **`save()`**: write the revision that's current when you call it. It resolves `Ok({ revision })` once that revision or a later one has landed, so `revision` is at least the one you called with. Otherwise it resolves with the failure or conflict that stopped it. It also re-attempts a `failed` draft.
- **`folder.flush()`**: skip the autosave pause everywhere, try every held draft that isn't in conflict once, and resolve with what is still unwritten (`{ path, text, revision, status, error }`). Closing the folder is a flush followed by refusing new input.
- **conflict is detected as soon as it's known**: by a read, not only by a save. If storage differs from the base while there's local work, that's a conflict right away.

## Proposed API

```ts
const opened = await folder.open('notes/a.md', { schema: Note });
if (opened.error) return show(opened.error);   // Missing | NotText | ReadFailed
using editor = opened.data;                    // released when the scope ends; held drafts stay with the folder

editor.text;        // always a string
editor.markdown;    // the same text, read through the schema
editor.revision;
editor.status;      // { status:'clean' } | { status:'dirty' }
                    // | { status:'failed'; error: SaveFailure }
                    // | { status:'conflict'; theirs: FileContent | null }
                    // | { status:'detached'; stored: 'missing' | 'not-text' }
editor.saving;      // { revision } | undefined   (independent of status)
editor.readError;   // ReadError | undefined     (independent; text unaffected)
editor.locked;      // reason | undefined         (a fenced action holds the path)

editor.replaceText(text);            // Result<void, ChangeError>; refusals are returned, never stored
editor.change({ fields, body });
await editor.save();
editor.revert();                     // text = base; returns the abandoned text
await editor.resolve('theirs' | 'mine' | { text });
await editor.refresh();
```

Svelte. The opener handles acquisition and release, so the editor component only ever sees text:

```svelte
<!-- FileDetail.svelte -->
<script lang="ts">
  const opening = openEditor(folder, () => path, { schema: Note }); // reactive; releases on change or destroy
</script>
{#if opening.editor}
  <NoteEditor editor={opening.editor} />
{:else if opening.error?.name === 'Missing'}<Empty>This note is no longer in the folder.</Empty>
{:else if opening.error}<Retry onclick={opening.retry}>{opening.error.message}</Retry>
{:else}<Loading />{/if}
```

```svelte
<!-- NoteEditor.svelte -->
<script lang="ts">
  let { editor } = $props();
  const s = $derived(editor.status);
</script>
<span role="status">
  {#if s.status === 'failed'}Not saved: {s.error.message}{#if editor.saving} · Retrying…{/if}
  {:else if s.status === 'conflict'}Changed elsewhere
  {:else if s.status === 'dirty' || editor.saving}Saving…
  {:else if s.status === 'detached'}Deleted elsewhere. This is the last text you saw.
  {:else}Saved{/if}
</span>
{#if s.status === 'failed'}<Button onclick={() => editor.save()}>Try again</Button>{/if}
{#if s.status === 'conflict'}
  <Compare theirs={s.theirs} mine={editor.text} />
  <Button onclick={() => editor.resolve('theirs')}>{s.theirs === null ? 'Let it go' : 'Use saved file'}</Button>
  <Button onclick={() => editor.resolve('mine')}>{s.theirs === null ? 'Restore it' : 'Replace saved file'}</Button>
{/if}
{#if editor.readError}<p role="alert">Couldn't refresh: {editor.readError.message}. Your text is kept.</p>{/if}
<Textarea readonly={!!editor.locked}
  bind:value={() => lf(editor.text), (v) => editor.replaceText(withFileNewlines(v, editor.text))} />
```

## The sequences

Throughout, B is the base and A(x) is a save attempt writing text x.

1. **Typing during a save.** You type r1 and A(r1) starts. You type r2. Now: text r2, `dirty`, `saving {r1}`.
   - If A lands, the base becomes r1 and the status stays `dirty`. Autosave writes r2 after the pause. A `save()` called at r1 resolves `{revision: r1}`; one called at r2 waits for r2.
   - If A fails, the failure belonged to r1, so it's dropped. The status stays `dirty`, autosave tries r2, and a failure there becomes `failed`.

2. **Reverting while a save runs.** The text is X, A(X) is in flight, and you call `revert()`, so the text becomes B. Expected is X, so the status is **`dirty`**.
   - If A lands, the base becomes X, and autosave writes B back, guarded against X.
   - If A fails, expected falls back to B, so the status is `clean` and the failure (which was about X) is dropped.
   - No BUSY refusal is needed. A write can't be recalled, so the definition says "dirty" honestly.

3. **Retrying a failure.** The status is `failed {E}` at revision r. `save()` starts A(r).
   - **The status stays `failed {E}` alongside `saving {r}`**, so a retry that hangs still shows why the last one failed.
   - If A lands, the status becomes `clean`. If it fails with E2, it becomes `failed {E2}`. **Retry keeps the old failure until the new outcome replaces it.** Today the error is cleared when the retry starts.
   - If you type during the retry, the status is `dirty` and E is dropped.

4. **Typing after a conflict.** The status is `conflict {theirs}`. Typing changes the text, and the status stays `conflict`. Autosave is paused, because it would only conflict again.
   - `save()` makes one guarded attempt. It succeeds only if storage has gone back to the base.
   - `resolve('mine')` makes `theirs` the base and saves, and a further outside change produces a new conflict. `resolve('theirs')` sets text and base to theirs and the status to `clean`. `resolve({text})` handles a merge.

5. **A refresh that fails.** `readError` is set, and the text, status, and autosave are untouched. The next successful read clears it.

6. **A refresh that finds the file deleted.**
   - With local work, the status becomes `conflict {theirs: null}` immediately. The Whispering and FileEditor banners that say "saving will report a conflict" become a direct state.
   - With a clean editor, the status becomes **`detached`** and the text is kept. Typing then produces a conflict straight away, because there's local work and storage differs from the base. "Restore it" means `resolve('mine')`.
   - A clean editor whose file changes elsewhere (to other text) just follows the new text.

## What this costs and what it buys

**What disappears:**
- The `buffer` container and `unsaved` as a separate object.
- The `unread/loading/unavailable` states, which move to `open()`.
- `BufferIssue` and the stored-refusal machinery (`record`/`execute`/`refusalOf`, `:504-563`). Callers already toast the errors that commands return.
- The `lastShown` workaround, the BUSY refusal on revert, and the duplication between `Recovery` and `Unsaved`.
- The per-app `isWriting`/`isUnsaved` derivations, replaced by `folder.drafts`.

**What moves elsewhere:**
- Loading, missing, and not-text handling move to the opener, a parent component or route.
- Handle lifetime becomes explicit (`using`, or the adapter releasing on destroy). Today it's inferred from subscriber counts (`subscribeTo`, `:1032-1063`). A handle that's never released keeps a clean editor's text in memory. That costs memory, never data.
- Eager conflict detection makes the owner compare each read with the base.
- Each view decides what a `detached` clean editor shows, or releases it.

**Which guarantees justify the remaining concepts:**
- The text exists for the editor's whole lifetime.
- Accepted input survives until it lands or is explicitly reverted or resolved.
- Each status names exactly one party who makes progress.
- `saving` carries the revision it covers, and `save()` reports which revision landed.
- Memory is not durability: `flush()` reports what is still unwritten, and crash recovery is a separate layer.

## Still open, and evidence to request

- **Should Svelte callers `{#await}` acquisition?** The opener adapter assumes they shouldn't, but Honeycrisp keeps `NoteDetail` mounted under `FileDetail` while it switches presentations, which may need a synchronous `folder.editors.get(path)` for paths already open.
- **Eager conflict on a read while dirty is a behaviour change.** A read and a save that land close together could cause flicker. I'd ask the coordinator to check how `answered`/`know` (`:632-663`) order reads against `stored()`.
- **Does `detached` earn a separate status, or could it be `clean` plus a `source` fact?** I chose a status because the next action it calls for (release, or restore by typing) differs from `clean`.
- **Please have the coordinator confirm the main branch's current state of `edit-owner.ts`.** This snapshot may be older than the work underway.


## Pair 2, response A

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


## Pair 2, response B

I couldn't read the referenced thread here, and I didn't run any tests. So everything below about current behaviour comes from reading the code in this snapshot. The nested `buffer.status` / `buffer.unsaved?.status` design is fully in place in it: `BufferSnapshot` (`packages/folder/src/edit-owner.ts:141`) is used by all four apps and by both adapters.

## Answer to the central question

**No. The five statuses shouldn't be one mutually exclusive value.** Your hypothesis holds, and the code shows where the compression breaks:

- **Dirty while saving.** While a save runs, new typing keeps `saving: input?.pending.saving` (`edit-owner.ts:1152`). The status stays `saving` even though the newer text hasn't been sent, so no caller can tell that it will still be unsaved after the save lands.
- **Failed while retrying.** A retry clears the error as the attempt starts (`:847`), so the banner disappears during the retry and reappears if it fails.
- **Conflict isn't a save outcome.** It means the file in storage has moved away from the version your text was based on. That's why conflict survives typing (`:1153`) while failure doesn't (`:860`). It's also why autosave keeps sending writes that are bound to conflict again (`:827`).

Only one fact here has mutually exclusive cases that each carry their own payload: **how storage relates to the editor's base**. That deserves a union. The rest are independent facts, and choosing which one to show first is a display decision for the UI.

## The organizing idea

> **An editor is text plus a base: the stored version that text came from.** "Dirty" means the text differs from the base. Whether storage still matches the base is a separate fact. A conflict is simply both at once.

Three rules follow from this:

1. **Fast-forward.** If the editor is clean and storage changes to new text, the editor adopts it (base and text both become the stored text). If storage changes to exactly your text, the editor adopts that too, which clears a conflict without user action.
2. **Autosave** only writes when the editor is dirty and storage still matches the base. Writes that can only conflict are never sent.
3. **Text is never taken from a held editor.** Deleting the file or making it unreadable changes `storage`, not `text`.

That settles the side questions:
- **FileEdit is the buffer.** There's no `.buffer` container and no `unsaved` object.
- **The snapshot is just an immutable value** for `useSyncExternalStore` or Svelte.
- **Opening is asynchronous; editing is synchronous.** You `await` opening the file once, and from then on `text` always exists.

## Vanilla use

```ts
const opened = await folder.open('notes/milk.md', { schema: notes }); // reads only if no buffer is held
if (opened.error) return show(opened.error);         // Missing | NotText | ReadFailed
const editor = opened.data;                          // released by editor.release() or dispose

editor.replaceText(next);            // Result<void, Locked | NotText>; never stored as an "issue"
editor.change({ fields: { title } });// same text, seen through the schema

type EditorSnapshot = {
  text: string;                      // always present
  markdown: MarkdownContent<S>;      // the same text, schema view
  revision: number;                  // increases with each accepted change
  dirty: boolean;                    // text ≠ base
  storage:
    | { kind: 'matches' }                                            // storage = base
    | { kind: 'changed'; current: FileContent; text: string | undefined }
    | { kind: 'removed' };
  saving?: { revision: number };     // a write in progress, possibly of older text
  failure?: { error: SaveFailure; revision: number }; // last finished attempt
  refreshError?: ReadError;          // last check of storage failed; text unaffected
  locked?: string;                   // fence reason
};

await editor.save();    // Result<{ revision }, SaveFailure | Conflict>
editor.revert();        // text = base; returns the discarded text for copying
editor.rebase();        // base = what storage holds now; the next save replaces it
await editor.refresh(); // Result<void, ReadError>
```

The three resolution choices become ordinary operations:
- **Use saved file** = `revert()`. The text returns to the base, and fast-forward then brings in the stored version.
- **Replace saved file** = `rebase()`.
- **Merge** = `replaceText(merged)` followed by `rebase()`.

## Definitions

- **Dirty:** `text` differs from the base text, compared by content rather than by revision number. Typing back to the original makes the editor clean, even while a save runs. Today that only happens when no save is running (`:1139`).
- **Saved:** not dirty, and `storage.kind === 'matches'`. Storage is known to hold exactly this text.
- **`save()`:** skips the autosave delay and makes the revision current at the call reach storage. Each write is guarded by the base. It resolves `Ok({ revision })` once that revision or a later one has landed. That returned revision is what completed, and the editor may already be dirty again.
- **Flush:** a folder-level operation (`folder.flush()`, close, fenced actions). It freezes input first, so "current" is final, then saves every dirty editor. It reports what stays unsaved because of a failure or conflict.
- **Which error still applies after text changes:**
  - `failure` stays across typing. The storage problem hasn't been resolved, and newer text hasn't been tried. It is cleared only when a later attempt finishes, or when the editor becomes clean.
  - A conflict lasts as long as its two conditions do.
- **Retry keeps the old failure until the new attempt finishes.** `saving` and `failure` coexist ("Retrying… last attempt: offline"). Success clears the failure; another failure replaces it.

## The five sequences

**1. Typing during a save.** Revision 5 is being written, and you type revision 6.
- Snapshot: `{ dirty: true, saving: { revision: 5 } }`.
- Revision 5 lands: the base becomes revision 5's text. The editor is still dirty, so the autosave timer writes revision 6.
- A `save()` called during revision 5 resolves with `{ revision: 6 }`, after waiting for 5 to land.

**2. Reverting while a save runs.** Today this is refused with `BUSY` (`:1013`). Here it is just an edit: the text becomes the old base.
- If revision 5 lands, the base becomes revision 5, the text differs from it, and autosave writes the reverted text. Storage ends up holding what you asked for.
- If revision 5 fails, the editor is clean, so the failure is dropped.
- There are no refusals and no special cases.

**3. Retrying a failure.**
- `{ failure: { revision: 5 } }` becomes `{ saving: { revision: 5 }, failure }` while the retry runs.
- Then it becomes either `{}` (success) or a new `failure` (another failure).

**4. Typing after a conflict.**
- Storage is `changed` and the editor is dirty, so it's a conflict.
- Typing keeps it dirty, so the conflict persists, and autosave sends nothing.
- If someone else saves exactly your text, the fast-forward rule resolves the conflict. Otherwise the user chooses `revert` or `rebase`.

**5. A refresh fails or finds the file deleted.**
- **A failed refresh** sets `refreshError`. Text and `storage` stay as last known.
- **A refresh that finds deletion** sets `storage: removed`:
  - **Dirty editor:** this is a conflict, and `rebase()` recreates the file.
  - **Clean editor:** the text stays visible as the last version seen, and the editor is not dirty. Typing makes it dirty, which is immediately a conflict, so the file is never silently recreated.
- Today a clean deletion makes the text `undefined` (`:1096`, `:587`). `FileEditor.svelte:55-64` keeps its own `lastShown` copy to work around that.

The cost of keeping text: a deleted file looks editable until you type. Once released, it can't be reopened (`open` returns `Missing`), unless a dirty buffer for that path is still held.

## Svelte

```svelte
<!-- FilePane.svelte: opening happens outside the editor -->
{#key path}
  {#await folder.open(path)}<Loading />
  {:then opened}
    {#if opened.error}<OpenProblem error={opened.error} retry={() => (path = path)} />
    {:else}<FileEditor editor={opened.data} />{/if}
  {/await}
{/key}
```

```svelte
<!-- FileEditor.svelte -->
<script lang="ts">
  let { editor }: { editor: Editor } = $props();
  const e = createEditor(editor);  // reactive getters; releases on destroy
  const conflict = $derived(e.dirty && e.storage.kind !== 'matches');
</script>

<span role="status">
  {#if conflict}Not saved: the file changed elsewhere
  {:else if e.saving}{e.failure ? 'Retrying…' : 'Saving…'}
  {:else if e.failure}Not saved: {e.failure.error.message}
  {:else if e.dirty}Unsaved
  {:else if e.storage.kind === 'removed'}Deleted elsewhere
  {:else}Saved{/if}
</span>

{#if conflict}
  <Compare saved={e.storage.kind === 'changed' ? e.storage.text : null} mine={e.text} />
  <Button onclick={e.revert}>Use saved file</Button>
  <Button onclick={e.rebase}>{e.storage.kind === 'removed' ? 'Recreate file' : 'Replace saved file'}</Button>
{:else if e.failure && !e.saving}
  <Button onclick={() => e.save()}>Try again</Button>
  <Button onclick={() => copy(e.revert())}>Discard edit</Button>
{/if}
{#if e.refreshError}<p role="alert">Couldn't check the saved file. <Button onclick={e.refresh}>Retry</Button></p>{/if}

<Textarea readonly={!!e.locked}
  bind:value={() => lf(e.text), (v) => e.replaceText(withFileNewlines(v, e.text))} />
```

The order of the status line is the UI's own choice; the library no longer bakes it in. Honeycrisp opens once in `FileDetail` and passes the same editor to both the note view and the source view.

## What disappears

- The `unread | loading | unavailable` cases, and the read requests that adapters trigger as a side effect (`svelte/src/edits.ts:24-28`, `react/src/edits.ts:33-36`).
- The `Unsaved` and `Recovery` entities.
- `resolveConflict` and the private `conflictCurrent` guard (`:1225-1289`).
- The refusal-tracking machinery and the mixed `buffer.error` union (`:504-563`). Refusals become command results only.
- The `BUSY` refusal for discard.
- `lastShown`.
- Honeycrisp and Whispering checking query state before reading `fileEdit.buffer`, just to avoid triggering a read (`FileDetail.svelte:77-80`, `RecordingDetail.svelte:74-77`).

## Where complexity moves

- **Every caller needs a loading boundary** (`{#await}`, a route loader, or a parent component).
- **The owner must apply the fast-forward rule whenever it learns what storage holds.** It already tracks the base (`from`) and the stored content (`doc`) separately, so this is a relocation rather than new state.
- **Release becomes an explicit lifetime.** The folder keeps a buffer while it is dirty or while any handle holds it.
- **The full-file classification query in Honeycrisp stays**, folded into `open`'s errors.

## Why each remaining concept stays

- **`text`:** a held editor always has something to show.
- **`base`:** it defines dirty and conflict, and guards every write.
- **`storage`:** the only union, because each case carries its own payload.
- **`saving`:** a write in progress, tagged with the revision it carries.
- **`failure`:** the last finished attempt.
- **`locked`:** the fence.

Keeping input in memory is all the editor promises. A crash-recovery journal would be a separate subscriber, storing path, base and text for dirty editors.

## Still open

- Whether a clean editor whose file was deleted should keep its text. I recommend yes, so the user's view never disappears under them, but it's a product call.
- Whether autosave should retry a failure without new typing.
- Whether any caller depends on refusals appearing in `buffer.error`. Capture's `TextDetail.svelte:206` shows that error, but I didn't trace which errors reach it.

**What I need from the coordinator:** the latest state of the main implementation thread. Without it, I can't confirm that this snapshot matches what has actually been built.


