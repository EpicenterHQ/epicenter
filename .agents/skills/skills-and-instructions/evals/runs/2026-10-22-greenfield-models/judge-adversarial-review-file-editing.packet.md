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

**Verdict:** No. These five statuses should not be one mutually exclusive value. They mix two kinds of fact:

- **Behavior** decides who acts next and which commands mean what.
- **Coexisting facts** ("a write is in flight", "the last attempt failed") don't change any command.

I recommend three exclusive save states, with `saving` and `failure` carried as payload inside `unsaved`. File availability moves out of the editor and into an asynchronous `open`.

## What the snapshot implements (observed)

This snapshot exposes `getBuffer(): BufferSnapshot`, with `unread | loading | unavailable | ready`, and `ready.unsaved: dirty | saving | failed | conflict`. There is one merged `error?: BufferIssue` slot (`packages/folder/src/edit-owner.ts:141-145`). I couldn't read the main thread, so this describes the snapshot only. Engine facts that matter for the decision:

- **Typing during a save** keeps `saving` and clears a non-conflict error. If the in-flight write fails, the error is dropped and the newer revision is retried at once (`:857-872`).
- **Conflicts survive typing** (`:1153-1156`). Autosave then re-sends against the same stale witness, so the status flickers `conflict → saving → conflict`, costing a storage round trip each time (`:844-848`, `:1162`).
- **Retry** sets `saving` and erases the failure before the outcome is known (`:847`).
- **`discard()` is refused while a save runs** (`:1013-1016`). That's why Honeycrisp disables its buttons on `saving` (`FileDetail.svelte:256-257`).
- **An outside deletion with no input** removes the text (`unavailable`). `FileEditor.svelte:55-64` works around this with a local `lastShown` cache.
- **Every caller collapses `dirty | saving` into "Saving…"** (`FileEditor.svelte:81`, `TextDetail.svelte:157-161`, `FileDetail.svelte:237-241`). Honeycrisp and Whispering also rebuild per-path `isWriting`/`isSaving`/`isUnsaved` from the aggregate (`notes.svelte.ts:450-454`, `whispering.svelte.ts:1039-1049`). They gate `fileEdit.buffer` behind these so that observing save state doesn't trigger a file read (`RecordingDetail.svelte:74-77`).

The commands available under `dirty` and `failed` are identical: type, save, discard. Only `conflict` changes what `save` means. `saving` alone gates anything, and only because discard is refused during a save. That refusal is an engine choice, not a user need. So the five-way union is a display priority, which supports your hypothesis.

## Definitions

- **Revision:** a monotonically increasing id assigned to each accepted text change.
- **Witness:** the exact stored content the text was edited over. It's either the last read, taken before the first edit, or the content this editor last wrote.
- **Dirty:** `text !== witness text`. This is a derived relation, not stored state. Typing back to the witness makes the editor clean.
- **Saved:** not dirty, and nothing unresolved. It means "matches what this editor last observed in storage", not "storage holds this now", and it is not crash durability.
- **save():** covers the revision current at call time, R. It resolves `Ok` once some revision ≥ R has landed; a coalesced newer write also satisfies it. It resolves with an error if the attempt that carries R fails. Its result is `{ landed: Revision }`, so a caller can compare that to `editor.revision`. `Ok` never claims the *current* text is saved.
- **flush:** the folder-level version of the same contract. It skips the debounce, covers every path's revision as of the call, and is used by `settle` and `close`.
- **Failure:** the outcome of the most recent completed attempt. It persists until a later attempt completes, and clears when the editor becomes clean.
- **Conflict:** a fact about the witness, not about a revision. It persists across typing and suspends autosave.

## Recommended API

```ts
const opened = await folder.open(path, schema?);   // Result<Editor, OpenError: missing|not-text|read>
const editor = opened.data;

editor.text            // string — always, while open
editor.markdown        // schema view of the same text (cached derivation)
editor.revision
editor.state
  // | { kind: 'saved' }
  // | { kind: 'unsaved'; saving: boolean; failure: SaveFailure | null }
  // | { kind: 'conflict'; theirs: string | null | Uint8Array; error: SaveConflict }
editor.source          // { refreshError: ReadError | null }
editor.locked
editor.closed          // undefined | { reason: 'deleted' | 'released'; lastText: string }

editor.replaceText(t) / editor.change({fields, body})   // Result<Revision, Refusal> — refusals are returned, not stored
editor.save()          // Promise<Result<{landed}, SaveFailure | SaveConflict>>
editor.revert()        // text := witness text; always allowed
editor.resolve('mine' | 'theirs' | { text })
editor.refresh()
editor.release()
```

Each state kind corresponds to a different behavior:

| Kind | Who acts next | Effect on commands |
|---|---|---|
| `saved` | nobody | none |
| `unsaved` | the system (debounce, in-flight write, explicit retry) | `save` writes |
| `conflict` | the human | `save` won't overwrite; autosave is off; `resolve` is required |

Invariants: a failure implies dirty, and a conflict implies no write is in flight.

The lifetime rule: the folder retains unsaved and conflict work regardless of mounts. Clean text lives only while some handle is open; when the last handle is released, it's dropped.

## Consequential sequences

1. **Typing during a save.** R5 is in flight and the user types R6, so the state is `unsaved{saving:true}`. R5 lands, the witness becomes R5's text, and the editor is still dirty, so R6 autosaves after the debounce. A `save()` called at R5 resolves `{landed:5}`. If R5 fails instead, the state becomes `unsaved{failure, saving:false}` and R6's debounce sends R6. The failure stays visible until R6's outcome replaces it, so nothing is erased silently.
2. **Reverting while a save runs.** The text becomes the witness text, so the editor is clean while R5 is still in flight. When R5 lands, the witness becomes R5's text, the editor is dirty again, and autosave writes the original back. That takes two writes but ends in the right state, and no BUSY refusal is needed.
3. **Retrying a failure.** The state becomes `unsaved{saving:true, failure}`, so the UI reads "Not saved — retrying…". The outcome replaces the failure. Whispering's dedupe by `Recovery` identity (`whispering.svelte.ts:482-505`) now sees one stable failure instead of disappear-and-reappear.
4. **Typing after a conflict.** The conflict stays and no write is sent. `resolve('mine')` rebases the witness to `theirs` and saves. `resolve('theirs')` sets the text to `theirs`, or closes the editor if `theirs` is a deletion. If the user's text already equals `theirs`, the conflict clears on its own.
5. **A refresh fails while text remains.** This sets `source.refreshError` and leaves `state` alone. The compare-at-write still prevents an unseen overwrite, so a stale read is harmless.
6. **A refresh finds an outside change or deletion.** The rule: clean editors follow storage; dirty editors keep their text and raise a conflict.
   - Clean and changed: the text and witness update silently.
   - Clean and deleted: the editor closes with `{reason:'deleted', lastText}`. Nothing is at risk, and `lastText` replaces `FileEditor`'s cache.
   - Dirty and changed or deleted: the state becomes `conflict` straight away (`theirs: null` for a deletion), instead of waiting for a save to fail.

## Svelte use

```svelte
<!-- Parent: acquisition owns loading/unavailable -->
{#await folder.open(path) then opened}
  {#if opened.error}<OpenFailure error={opened.error} />
  {:else}<FileEditor editor={opened.data} />{/if}
{:catch}…{/await}
```

```svelte
<script lang="ts">
  let { editor }: { editor: Editor } = $props();
  $effect(() => () => editor.release());
  const s = $derived(editor.state);
</script>

{#if editor.closed}
  <p>This file was deleted elsewhere.</p><pre>{editor.closed.lastText}</pre>
{:else}
  <span role="status">
    {#if s.kind === 'saved'}Saved
    {:else if s.kind === 'conflict'}Changed elsewhere
    {:else if s.failure}Not saved: {s.failure.message}{s.saving ? ' — retrying…' : ''}
    {:else}Saving…{/if}
  </span>
  {#if s.kind === 'conflict'}
    <Compare theirs={s.theirs} mine={editor.text} />
    <Button onclick={() => editor.resolve('theirs')}>Use saved file</Button>
    <Button onclick={() => editor.resolve('mine')}>Replace saved file</Button>
  {:else if s.kind === 'unsaved' && s.failure}
    <Button disabled={s.saving} onclick={() => editor.save()}>Try again</Button>
  {/if}
  {#if s.kind !== 'saved'}<Button variant="ghost" onclick={() => editor.revert()}>Discard edit</Button>{/if}
  {#if editor.source.refreshError}<p role="alert">{editor.source.refreshError.message} Your text is kept.</p>{/if}
  <Textarea bind:value={() => editor.text, (v) => editor.replaceText(v)} readonly={editor.locked} />
{/if}
```

## What disappears, what moves, what remains

**Disappears:**
- `unread | loading | unavailable` and the `ready` wrapper; the `buffer` container goes with them.
- The merged `BufferIssue` slot and the stored-refusal machinery (`record`, `execute`, `refusalOf`, `state.refusal`, about 70 lines).
- The BUSY refusal on discard, and the button gating built around it.
- Conflict re-send flicker.
- The per-app `isWriting`/`isSaving`/`isUnsaved` derivations, and the read-avoidance gating of `buffer`. Observing an editor no longer triggers reads, and `folder.held(path)` can answer "is there work here" synchronously.
- `FileEditor`'s `lastShown`.

**Moves:**
- Loading moves to one acquisition boundary. That needs an `{#await}` or a generic helper, plus an explicit `release()` lifetime, effectively reference counting. That cost is real.
- Proactive conflict detection moves into refresh.
- Revision ids appear in `save()` results.

**Remains, and why:**
- The witness, because it is what prevents silent overwrites.
- `conflict` as its own kind, because it changes what `save` means.
- Folder ownership of unsaved work, because input must survive unmounts.
- The lock, because fenced actions need it.
- `saving` as a flag, because the UI must not offer a retry while one is in flight.
- A failure that survives typing, because the honest answer to "is my work safe?" is "no, the last attempt was refused".

## Unresolved product choices and checks for the coordinator

- **Clean editor on deletion: close, or let typing recreate the file?** I recommend closing. Recreating would keep text always present, but turns the next keystroke into a resurrection the user didn't ask for.
- **Conflict on refresh, or only on a save attempt?** Refresh is earlier and cheaper. The cost is that a divergence the user never planned to save can interrupt them.
- **Should failures auto-retry with backoff?** This is policy, and the shape works either way.
- **Execution evidence requests:**
  - Confirm the main thread's current implementation against this snapshot.
  - Test whether the conflict loop actually re-sends on each debounce: type after a conflict and count `replaceSource` calls.
  - Check that the Whispering failure toast fires twice across a failed retry today.


## Pair 1, response B

**Recommendation: change the design.** The five statuses should not be one mutually exclusive value. Three of them (`clean`, `dirty`, `conflict`) describe how the current text relates to storage, and those three do exclude each other. `failed` is extra information attached to unsaved text. `saving` is an independent fact about a write in progress, and it can carry older text. I'd also make opening a file an explicit async step, so that **an open document always has text**. Editors would then never handle a missing source.

## Evidence read

```
.agents/skills/adversarial-review/{SKILL.md, references/deletion-prizes.md}
REQUEST.md
packages/folder/src/{edit-owner.ts, edits.ts}
packages/svelte/src/edits.ts
packages/react/src/edits.ts
apps/epicenter/src/folders/FileEditor.svelte
apps/honeycrisp/src/routes/components/NoteDetail.svelte
apps/capture/src/lib/{captures.svelte.ts, components/TextDetail.svelte}
apps/whispering/src/routes/components/RecordingDetail.svelte
(grep) whispering.svelte.ts, honeycrisp notes.svelte.ts / FileDetail.svelte, whispering FileView.svelte
```

The thread was unavailable, so this describes only what this snapshot contains. The nested proposal is implemented as `getBuffer(): BufferSnapshot` (`edit-owner.ts:141-145`), and the adapters expose it as `.buffer`. Internally it is still independent flags: `Pending { saving: boolean; error }` (`:102-107`). `snapshotOf` squashes these into one status, and `saving` hides any error (`:484-490`).

## What the code and callers show

1. **Reading `.buffer` starts a file read.** In the Svelte adapter, `trackRead` starts a read on first access (`svelte/edits.ts:24-28`). React does the same through a `requested` flag and an effect (`react/edits.ts:32-36`). Whispering and Honeycrisp therefore avoid touching `fileEdit.buffer` unless `isSaving || isUnsaved || opened.data?.kind === 'text'` (`RecordingDetail.svelte:74-77`, `FileDetail.svelte:78-79`, `FileView.svelte:66`).
2. **Callers already keep "text always exists" by hand.** When the file is deleted and nothing is held, `shownText` returns `undefined` (`edit-owner.ts:1096`). Epicenter works around this with `lastShown` (`FileEditor.svelte:55-64`). Capture and Honeycrisp drop the text and show "no longer here".
3. **No caller tells `dirty` from `saving`.** Epicenter (`:81`) and Capture (`:157-162`) show "Saving…" for both. Honeycrisp's `isWriting` and Whispering's `isSaving` mean "held and not failed". Callers branch only on failed vs. conflict, which decides between Try again and resolve.
4. **The implementation already treats conflict and failure differently.** Typing keeps a conflict but erases a failure (`:1153-1156`). A failure from an older revision is dropped (`:860`). So a conflict belongs to the base (the stored source the edit started from); a failure belongs to one save attempt.
5. **`buffer.error` mixes four kinds of problem:** command refusals, read errors, `SourceUnavailable`, and save errors (`:134-139`). Epicenter offers "Try reading again" for whatever is there (`FileEditor.svelte:114-123`), including a refusal like `Locked`, where reading again doesn't help.

## Definitions

- **base**: the exact stored source this owner last knew storage held, from a read or from its own successful write. It is the guard on every write.
- **saved**: storage is known to hold exactly `text` (`text === base`, and nothing seen since says otherwise).
- **unsaved / dirty**: `text !== base`.
- **conflict**: storage is known to differ from `base`. A guarded write found this, or a refresh found the file missing or no longer text.
- **save()** (this is also "flush"; one word is enough): makes the text that was current at the call durable. If an older write is running, it waits for it and then sends this text. It resolves for that revision only; typing after the call doesn't extend it. Autosave is just `save()` after a pause.
- **writing**: a guarded write is in flight. Its text may be older than `text`.

Invariants:
- Conflict stops all writes, so `conflict ⇒ ¬writing`.
- A failure only exists on unsaved text.
- A clean document adopts outside text changes silently.

## The sequences

**Typing during a save.** r1 is in flight and the user types r2. State: `unsaved, writing`. r1 lands, `base := r1`, still `unsaved`. Autosave sends r2. `save()` called during r1 resolves when r1 lands. `save()` called after the typing resolves when r2 lands.

**Reverting while a save runs.** r1 is in flight and `revert()` sets `text := base` (the original). This is correct for that instant: `saved, writing`. Then r1 lands, `base := r1`, and the state becomes `unsaved`. Autosave writes the original back. Today `discard()` refuses this case with `BUSY` (`:1011-1016`); `revert()` should never be refused.

**Retrying a failure.** The failure stays visible while the retry runs (`unsaved{failure}, writing`, displayed as "Retrying…"). The retry's result replaces it: success clears it, failure overwrites it. Typing does not clear it, because typing doesn't fix storage. Reverting to clean does clear it. Today the code clears the failure at the start of the attempt (`:847`) and on typing (`:1153`), so the alert flickers off and on.

**Typing after a conflict.** The edit is accepted. The state stays `conflict` with the same stored payload, and nothing is written. Today `submitText` schedules autosave (`:1162`), and `drain` clears the error and re-sends with the old guard (`:844-849`). That is a predictable repeat conflict, and the status flickers conflict→saving→conflict. If a refresh finds storage back at `base`, the conflict clears by itself.

**Refresh fails while usable text remains.** `refreshError` is set, and text and persistence are unchanged. It is about how fresh our knowledge is, not about the text.

**Refresh finds the file deleted, nothing dirty.** The text stays, and the state is `conflict{stored: null}`. Nothing autosaves. The user chooses Restore (`overwrite()`) or Close (`release()`).

What that costs: a clean "ghost" can outlive its file, the UI needs that one state, and the document stays in memory until it is released. In return the "text always exists" promise holds for the whole life of a handle, and `lastShown` goes away. If the file is replaced with non-text content, the same rule applies.

## Proposed API

```ts
type Persistence =
  | { state: 'saved' }
  | { state: 'unsaved'; failure?: SaveFailure }
  | { state: 'conflict'; stored: string | Uint8Array | null };

interface TextDoc<S> extends Disposable {
  readonly path: string;
  readonly text: string;                 // always
  readonly markdown: MarkdownContent<S>; // same source, schema view
  readonly persistence: Persistence;     // text ↔ storage
  readonly writing: boolean;             // operation, orthogonal
  readonly locked: boolean;              // fence/closing
  readonly refreshError?: ReadError;
  replaceText(text: string): Result<void, Locked>;
  change(c: DocumentChange<S>): Result<void, Locked | InvalidFields>;
  save(): Promise<Result<void, SaveFailure | SaveConflict | Locked>>;
  revert(): string;                       // text := base (adopts stored on conflict); returns dropped text
  overwrite(): Promise<Result<void, ...>>; // conflict: base := stored, then save
  refresh(): Promise<Result<void, ReadError>>;
  subscribe(fn: () => void): () => void;
  release(): void;
}
// folder.files.open(path, schema?) / folder.tables.x.open(id)
//   : Promise<Result<TextDoc<S>, Missing | NotText | ReadError>>
```

The folder still owns one buffer per path, shared by every open handle. Releasing a handle never drops unsaved text, and the folder's `settle()` and `close()` still flush. Nothing here is crash recovery: unsaved text lives only in memory.

**Plain TypeScript:**

```ts
const opened = await folder.files.open('notes/a.md');
if (opened.error) return showOpenError(opened.error);
using doc = opened.data;
doc.subscribe(render);
doc.replaceText(doc.text + '\n- milk');
const saved = await doc.save(); // this revision only
if (saved.error?.name === 'Conflict') showCompare(doc.persistence);
```

**Svelte.** Loading moves out of the editor into a route helper that releases on destroy:

```svelte
<!-- FileRoute.svelte -->
<script lang="ts">
  let { path } = $props();
  const opened = openText(folder.files, path); // { doc?, error?, loading }
</script>
{#if opened.loading}<Loading label="Reading…" />
{:else if opened.error}<OpenFailed error={opened.error} retry={opened.retry} />
{:else}<FileEditor doc={opened.doc} />{/if}

<!-- FileEditor.svelte -->
<script lang="ts">
  let { doc }: { doc: TextDoc } = $props();
  const p = $derived(doc.persistence);
</script>
<span role="status">
  {#if p.state === 'conflict'}Not saved: the file changed elsewhere
  {:else if doc.writing}{p.state === 'unsaved' && p.failure ? 'Retrying…' : 'Saving…'}
  {:else if p.state === 'unsaved'}{p.failure ? `Not saved: ${p.failure.message}` : 'Unsaved'}
  {:else}Saved{/if}
</span>
{#if p.state === 'conflict'}
  <Alert.Root variant="destructive">
    {p.stored === null ? 'Deleted elsewhere.' : 'The saved file changed.'}
    <Button onclick={() => doc.overwrite()}>{p.stored === null ? 'Restore my text' : 'Replace saved file'}</Button>
    {#if p.stored === null}<Button onclick={close}>Close</Button>
    {:else}<Button onclick={() => doc.revert()}>Use saved file</Button>{/if}
  </Alert.Root>
{:else if p.state === 'unsaved' && p.failure && !doc.writing}
  <Button onclick={() => doc.save()}>Try again</Button>
  <Button onclick={() => doc.revert()}>Discard edit</Button>
{/if}
{#if doc.refreshError}<p>Couldn't check for outside changes. <Button onclick={() => doc.refresh()}>Retry</Button></p>{/if}
<Textarea readonly={doc.locked}
  bind:value={() => lf(doc.text), (v) => doc.replaceText(withFileNewlines(v, doc.text))} />
```

## What gets deleted

- **From the snapshot:** the `unread`/`loading`/`unavailable` states, `text | undefined` on every getter, `ChangeError.NoSource`/`NotText`, `SourceUnavailable` in `buffer.error`, and the `BufferIssue` union.
- **From the adapters:** the read-on-access side effect (`trackRead`, the React `requested` flag and effect).
- **From callers:** the Whispering/Honeycrisp gating, Epicenter's `lastShown`, and each caller's loading/missing/not-text branches inside the editor.
- **The refusal machinery** (`refusal`/`record`/`execute`, `:504-563`): refusals come back as return values instead of living in the snapshot.
- **The `resolveConflict('current')` re-read path** (`:1246-1278`): it becomes `revert()`.
- **The `discard` BUSY refusal.**
- **`Unsaved`/`Recovery` as separate entities.** `revert()` returns the text it dropped, and the folder's settle/close report what is still held.

## What it adds

- Handle lifetime (`open`/`release`, ref counting) and a route-level loader. Loading moves out of the editor; it doesn't disappear.
- A ghost state after outside deletion.
- `writing` as a second axis, so the label logic above takes four branches. One exported pure `describe(doc)` should own that display priority, not the contract.
- Capture's under-textarea `buffer.error` display (`TextDetail.svelte:206`) must handle the `replaceText` result itself.

## Why the remaining concepts earn their place

- `persistence` is the one claim the user cares about: is my text stored, and if not, what do I do? Each variant has its own payload and its own actions.
- `writing` exists because a save of older text is real and can overlap any persistence state.
- `refreshError` stays separate because it is about how fresh our knowledge is, not about the text.

## Correctness issues in the current snapshot (separate from the redesign)

1. **Autosave keeps writing after a conflict.** It re-sends against the old base on every pause, so each attempt re-conflicts (`:1162`, `:844-849`). Please run a test that types after a conflict and counts `replaceSource` calls.
2. **Failures get erased.** Typing or a superseded revision clears a non-conflict failure (`:860`, `:1153-1156`). "Not saved" disappears while storage may still be failing. This is a product decision; I recommend keeping the failure until a later attempt succeeds.
3. **Wrong recovery action for refusals.** Epicenter offers "Try reading again" for command refusals (`FileEditor.svelte:114-123`).

## Open questions

- **Can each caller acquire before it renders?** Every caller I read already has the component keyed by path, which suggests yes. Honeycrisp's `notes.open(...)` and Whispering's view-mode switch still need checking. If a caller can't, the prize shrinks to the adapter side-effect cleanup.
- **Is the ghost acceptable?** Whether to keep text for a clean file deleted elsewhere is a product call. If the answer is no, deletion has to end the handle, and callers need an "ended" branch.
- **None of this is verified at runtime.** Please run the type check and the folder edit tests (`edits.test.ts`, `field-edits.test.ts`) against a prototype before relying on it.


## Pair 2, response A

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


## Pair 2, response B

# Adversarial review: the file-editing API

## Recommendation

The five statuses should not be one mutually exclusive value. The sequences you asked about show at least four separate facts, and each has its own lifetime:

| Fact | What it describes | Lifetime |
|---|---|---|
| `dirty` | Whether another write is needed before storage holds `text` | Changes with each revision and each write that lands |
| `saving` | Whether a guarded write is in flight. It may be carrying older text. | One attempt |
| `failure` | The latest finished attempt was refused, for example because storage is offline or a permission was denied. | Until a write lands, or the input is reverted to match storage |
| `conflict` | Storage no longer matches the witness the input was based on. | Until it is explicitly resolved |

These facts occur together in normal use: dirty while saving, dirty while in conflict, saving while a failure is still showing. A single `status` turns them into a display priority, so callers lose real information.

Your hypothesis holds: a status earns its place when its values exclude each other. Two parts of the status do meet that test. One is how the file can be opened (`loading | missing | not-text | ready`); that moves into acquisition. The other is the kind of save problem, which `failure` and `conflict` payloads already distinguish.

**What I recommend:** acquire the editor asynchronously, keep one folder-owned editor per path, and expose a flat snapshot of those independent facts. Write operations return Results; they don't record refusals in shared state.

## What the snapshot implements today

The nested proposal is already implemented here: `BufferSnapshot` holds `ready` with `text` and an optional `unsaved` (`packages/folder/src/edit-owner.ts:141-145`). I could only read this frozen snapshot, not the live main conversation. The code already tracks the distinctions above internally, but the public union hides them:

- **Typing during a save keeps showing `saving`.** New input inherits `saving: input?.pending.saving` (`edit-owner.ts:1152`). So `saving` already means "an attempt for some revision is running", not "the current text is being saved".
- **Failures and conflicts already have different lifetimes.** New typing clears a failure but keeps a conflict (`edit-owner.ts:1153-1156`). A failure on an older revision is dropped, and the newer revision is sent at once (`edit-owner.ts:860, 871-872`).
- **Typing after a conflict re-runs a write that must fail.** Each typing pause schedules a save (`edit-owner.ts:1162`). The loop then clears the error and marks the input as saving (`edit-owner.ts:847`), and it sends against the same stale `from`, which conflicts again. The status goes conflict → saving → conflict. In `FileEditor.svelte:81-91`, the conflict alert disappears while "Saving…" shows.
- **A clean buffer loses its text when the file is deleted elsewhere.** With `doc === null` and no input, `shownText` is undefined and the status becomes `unavailable` (`edit-owner.ts:1093-1099, 575-590`). `FileEditor.svelte:54-64` works around this by keeping a `lastShown` copy, so the current contract doesn't meet that caller's need.
- **`save()` can report a later revision's failure.** Calling `save()` while a save is running joins the drain loop (`edit-owner.ts:806-808`), which returns the outcome of its last attempt. Suppose revision r1 lands, typing creates r2, a timer joins it, and r2 fails. The caller who asked to save r1 gets an error even though r1 was stored.
- **Reading a getter starts a file read, so callers avoid the getter.** The Svelte adapter reads the file when `buffer` is accessed in the `unread` state (`packages/svelte/src/edits.ts:24-27`). Honeycrisp and Whispering only touch `buffer` when `file.data?.kind === 'text' || isWriting || isUnsaved` (`FileDetail.svelte:77-80`, `RecordingDetail.svelte:74-76`).
- **`buffer.error` mixes unrelated kinds of error.** It combines read errors, refusals, missing or non-text source, and save errors. Keeping it accurate takes the refusal bookkeeping in `record`, `execute` and `refusalOf` (`edit-owner.ts:504-563`).
- **The folder-level names are confused.** `isUnsaved` means "has a failure", and `isSaving` means "unsaved and not failed" (`whispering.svelte.ts:1039-1049`).

## Definitions

- **Revision:** each accepted `replaceText` or `change` increments it.
- **Witness:** the exact stored content the input was based on. It is updated whenever a write lands or a clean editor refreshes.
- **Saved(r):** storage is confirmed to hold revision r, or a later revision, through a guarded write.
- **Dirty:** another write is needed before storage holds `text`. It is false when `text` equals the witness and nothing is in flight, or when `text` equals the in-flight text.
- **Save (attempt):** one guarded write of the current text against the witness.
- **Flush:** resolves when the revision that was current at the call is saved, including when a later saved revision supersedes it. It never reports on revisions accepted after the call. It fails with the failure or conflict that blocks that revision.
- **Durability:** separate from all of the above. Text held in memory is not crash recovery.

## Sequences

1. **Typing during a save.** r1 is in flight and r2 is accepted, so `saving` and `dirty` are both true. When r1 lands, the witness becomes r1 and `dirty` stays true, so autosave sends r2. `flush()` called at r1 resolves `{revision: 1}`.
2. **Reverting while a save runs.** The editor holds witness W and r1 is in flight. A revert is an ordinary edit back to W's text, so `dirty` is true: r1 will land, and W must then be written back. Nothing is refused, and no `discard` lock is needed. This is how the current code behaves (`edit-owner.ts:1139-1147`), but the new definition makes it visible to callers.
3. **Retrying a failure.** The retry keeps the failure visible: `failure` is set and `saving` is true, so the UI can show "Not saved: offline · retrying…". The failure clears only when a write lands. Typing does not clear it either; the next autosave is simply another retry. This is the main product choice: it removes the flicker and contradicts the premise that a failure and a running retry exclude each other. The current behaviour, where typing makes the failure disappear, is the alternative.
4. **Typing after a conflict.** The conflict stays, input is accepted, and autosave pauses because a guarded write against the same witness cannot succeed. Autosave starts again in two cases. One is `resolve(...)`. The other is a refresh showing that storage equals the witness again, which clears the conflict.
5. **A refresh fails while text is usable.** `storage.error` is set, while `text`, `dirty` and autosave are unchanged; writes stay guarded.
6. **A refresh finds the file deleted, with no input.** The editor keeps `text` as the last known content and sets `storage.state` to `'missing'`. Typing is accepted. The first save, or an eager refresh check, turns this into a `conflict` with `current: null`. Only `resolve('mine')` recreates the file. The `lastShown` workaround is no longer needed.
7. **A refresh finds the file deleted, with input.** This is an eager conflict with `current: null`, and autosave pauses.

## Greenfield API

```ts
type Editor<S> = {
  readonly path: string;
  readonly state: {
    text: string;                 // always present
    revision: number;
    dirty: boolean;
    saving: boolean;
    failure?: SaveFailure;        // latest finished attempt was refused
    conflict?: SaveConflict;      // carries the observed `current`
    storage: { state: 'present' | 'missing' | 'not-text'; error?: ReadError };
  };
  readonly locked?: string;       // an exclusive action holds the path
  markdown(schema?: S): MarkdownContent<S>;
  replaceText(text: string): Result<void, ChangeError>;
  change(c: DocumentChange<S>): Result<void, ChangeError>;
  revert(): void;                 // text := witness text, as an ordinary edit
  flush(): Promise<Result<{ revision: number }, SaveFailure | SaveConflict>>;
  resolve(choice: 'mine' | 'theirs' | { text: string }): Promise<Result<void, ...>>;
  subscribe(fn: () => void): () => void;
  release(): void;                // decrements the count of holders
};
folder.open<S>(path, schema?): Promise<Result<Editor<S>, OpenError /* missing | not-text | read */>>;
```

Vanilla use:

```ts
const opened = await folder.open('notes/a.md');
if (opened.error) return report(opened.error);
const editor = opened.data;
const stop = editor.subscribe(render);
editor.replaceText(editor.state.text + '\nMore.');
const done = await editor.flush();   // { revision } covering this edit, or the blocking problem
stop(); editor.release();            // held input stays with the folder until saved or closed
```

Svelte. The parent owns loading:

```svelte
{#await folder.open(path)}
  <Loading />
{:then opened}
  {#if opened.error}<OpenFailed error={opened.error} />
  {:else}<FileEditor editor={reactive(opened.data)} />{/if}
{/await}
```

```svelte
<script lang="ts">
  let { editor } = $props();
  const s = $derived(editor.state);
</script>
<span role="status">
  {#if s.conflict}Changed elsewhere
  {:else if s.failure}Not saved: {s.failure.message}{#if s.saving} · retrying…{/if}
  {:else if s.dirty || s.saving}Saving…
  {:else if s.storage.state === 'missing'}Deleted elsewhere
  {:else}Saved{/if}
</span>
{#if s.conflict}
  <Compare saved={s.conflict.current} yours={s.text} />
  <Button onclick={() => editor.resolve('theirs')}>Use saved file</Button>
  <Button onclick={() => editor.resolve('mine')}>Keep my text</Button>
{:else if s.failure}
  <Button onclick={() => editor.flush()}>Try again</Button>
{/if}
{#if s.storage.error}<p role="alert">{s.storage.error.message}</p>{/if}
<Textarea readonly={!!editor.locked}
  bind:value={() => s.text, (v) => editor.replaceText(v)} />
```

## What disappears, what moves, what stays

**Disappears:**
- The `unread`, `loading` and `unavailable` statuses inside the editor, and every `text === undefined` branch in callers.
- The `NoSource` and `NotText` change errors.
- The adapter starting a read from a getter, and the `isWriting`/`isUnsaved` gating callers use to avoid it.
- `lastShown`.
- The nested `Unsaved` entity.
- The mixed `buffer.error` and its refusal bookkeeping (`record`, `execute`, `refusalOf`). Callers toast the Results instead.
- `discard()` being refused while a save runs. `Recovery` is no longer needed per editor, though `close()` still returns unsaved input.
- Pointless writes after a conflict.

**Moves:**
- Loading UI moves to the parent or an `await` block.
- `open` must deduplicate per path and count holders. That counting replaces today's `subscribe`/`prune` reference counting.
- The folder keeps clean text for deleted files while editors hold them. Memory is bounded by the number of open editors.
- Eager conflict detection on refresh: refresh results are now compared against the witness.

**Stays, because a guarantee depends on it:**
- Read ordering against saves (`clock`, `docAt`), so stale reads never replace newer knowledge.
- Guarded witness writes, so outside changes are never silently overwritten.
- The drain loop, so newer typing survives a write landing or failing.
- Fences, so actions save input first.
- One shared source for the text and Markdown views.
- The folder-level aggregate for app status and `close()`.

## Open uncertainties and checks for the coordinator

1. **Retaining a failure across retries (sequence 3)** is a product decision for you. It conflicts with the earlier premise that a failure and a retry exclude each other.
2. **Remove the conflict from the snapshot, or keep it while autosave pauses?** Pausing depends on accepting that conflicts are detected eagerly on refresh. Check that a guarded write cannot succeed while the witness is stale. Reading `replaceSource` in `handle.ts` would settle this; I did not read it.
3. **Flash for cached editors.** I believe a Svelte 5 `{#await}` on an already resolved promise still renders the pending branch for a tick, but I haven't verified it. If it does, a synchronous `folder.peek(path)` for cached editors is needed. Please measure this.
4. **Execution evidence requested.** I ran nothing. Please write tests that reproduce:
   - (a) `save()` at r1 returning r2's failure;
   - (b) typing after a conflict producing repeated write attempts and the status going conflict → saving → conflict;
   - (c) a clean outside deletion turning `ready` into `unavailable`.


