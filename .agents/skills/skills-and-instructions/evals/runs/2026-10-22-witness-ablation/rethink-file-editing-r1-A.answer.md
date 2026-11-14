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
