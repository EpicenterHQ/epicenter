# Blind design-quality judgment: file-editing API comparison

## Pair 1 — **B**, medium confidence

**A's model.** A splits the five statuses into three states for how the text relates to storage. Whether a save is running, and the last failure, sit inside `unsaved`: `| { status: 'unsaved'; saving: boolean; lastFailure?: SaveFailure } | { status: 'conflict'; theirs: Theirs; edited: boolean }`. An unedited file that is deleted elsewhere becomes `conflict{ theirs: deleted, edited: false }`, so "saved" keeps meaning what it says.
- **Write contract:** `save()` "resolves `Ok({ revision })` once that revision or a later one is confirmed … never reports a later revision's failure". Flush "promises one attempt each, not durability".
- **Losses it accepts:** loading moves to whoever opens the editor.

**B's model.** B makes the same split, with more detail: `writing?: { revision }` "may be older than `revision`", and `lastFailure?: { error; revision }`. Deletion of an unedited file is `persistence: saved, storage.exists: false`. B names the cost: "That changes behaviour, and the bargain needs naming".
- **Write contract:** "`Ok` means 'revision r is stored', not 'the current text is stored'." B's flush "keeps going until no attempt is left that can run without new input". That is a slightly different bound from A's once per revision.

**What decides it**
1. **B found a real defect, and I confirmed it in the source.** Type B over stored A. An outside write stores C. Then type A again. `submitText` compares against the pinned `input.from` (A), clears the input (`edit-owner.ts:1139-1146`), and `shownText` then returns C (`:1093-1098`). So `replaceText('A')` returns Ok but the user's input is replaced. This breaks a requirement stated in REQUEST.md: accepted input must survive.
2. **B walks each requested sequence twice:** once for current behaviour and once for the proposal. A traces the sequences only against current code and leaves the proposed behaviour implied by its rules.
3. **A's Svelte example has errors.**
   - It fails to compile: `const_tag_invalid_placement`, because `{@const s = editor.state}` is not inside a block.
   - It calls `editor.refresh`, which is not in A's `TextEditor` interface.

**In A's favour**
- **A also found a real defect.** A joined save "returns the outcome of the loop's *last* round". This is confirmed: `drain` returns the last `outcome`, and joiners receive `state.running` (`:806-808`, `:888-889`).
- **A's conflict payload is cleaner:** a tagged `Theirs`, versus B's `storage.exists` boolean.
- **A removes more:** it deletes the stored-refusal machinery, which B never mentions.

**B's concerns**
- `snapshot()` is a method in the type but is used as a property (`ed.snapshot.persistence`) in the template. This is probably the adapter, but it isn't stated.
- A file that becomes non-text after opening has no representation beyond `conflict`.
- Calling `createEditor` inside `{@const}` leaves when the handle is released unclear.

## Pair 2 — **A**, low confidence

**A's model.** `saved | unsaved{saving, failure?} | diverged{current, edited}`, plus `stale?` and `locked?`. "Saving" and "a failure" are "facts that can be true at the same time".
- **Write contract:** `save()` "does **not** promise the editor is saved afterwards". Flush "attempts every held revision once … never retries in a loop".
- **Retry and typing:** both keep the failure, "because the text is still not persisted and the cause (for example, a full disk) still applies."

**B's model.** Four exclusive statuses, `saved | unsaved{saving} | failed | conflict`, plus independent `stored: 'text' | 'missing' | 'not-text'` and `readError`.
- **Failure:** "`failed` belongs to an attempt and should be dropped when the text changes". A retry goes `failed → unsaved, saving:true`, and B accepts that "No stale error is kept."
- **Flush:** internal only. It "locks input, then saves until nothing is held or one attempt fails."
- **Self-assessment:** B admits its union "expresses the same contract as mine" as the five-status candidate. It is a flatter public API over the same responsibilities, not a structural simplification.

**What decides it**
1. **A better answers the central question.** A re-partitions the state. B keeps the request's candidate almost unchanged and moves `saving` into a flag.
2. **B's choice to drop the failure contradicts a precedent in the source.** The folder aggregate keeps `storageFailure` "until a save lands" (`handle.ts:270-272`; `whispering.svelte.ts:1072`). B's editor would hide the failure on the next keystroke. B argues for this deliberately, but neither B nor any other response cites that precedent.
3. **B's central type is invalid.** It declares both `readonly save: SaveState` and `save(): Promise<…>` on `Editor`, and its examples use both `editor.save.status` and `editor.save()`. TypeScript does not allow one name to be both.

**In B's favour**
- B's sequence table is the most careful comparison with the source. It cites Whispering re-checking `getStatus().unsaved` after `save()` (`whispering.svelte.ts:528-530`, confirmed).
- B's Svelte example compiles.
- B's open check is decisive: "does anything need an editor without asking for its content?"

**A's concerns, all demonstrated**
- `current: string | null | 'binary'` is ambiguous: a file whose text is literally "binary" can't be told apart. And `typeof s.current === 'string'` would offer "Use saved file" for binary content.
- `editor.refresh` is used in the template but missing from the type.
- The Svelte example has the same `{@const}` compile failure.
- A says a `save()` called at r1 "resolves after r1 lands. (The current loop already behaves this way through `again`.)" That is wrong if autosave joins during the attempt: the caller then waits for the whole loop and gets its final outcome (`:806-808`, `:888`).

## Guarantees: stated vs chosen

| Source | Guarantees |
|---|---|
| **Stated in REQUEST.md** | One folder-owned buffer per path; raw text and Markdown views share one source; input survives unmounts, failed saves, conflicts and newer typing during a save; memory is not crash recovery. |
| **Chosen by the responses** | `open` is async so text always exists; autosave pauses on conflict; save is scoped to a revision; failure is kept or cleared; deleted is modelled as conflict or as "saved + missing"; explicit leases. |
| **Inherited from the source** | Fences, `settle`'s once-per-revision attempts (`:902-924`), read ticks, `Recovery` values, the autosave timer. |

## Total complexity

**The real structural change is the same in all four responses: async `open`.**
- **Gone:** the `unread | loading | unavailable` states, the adapters' trigger-a-read-on-first-access code, and `lastShown`.
- **Added:** a lease lifecycle, refcounting, and keeping text in memory after deletion. Pair 2 A and B, and Pair 1 B (via `release()`), say this openly. Pair 2 A puts it most plainly: "A forgotten `dispose` leaks the path state".
- **Moved:** callers must await before mounting.

**Removing stored refusals** (Pair 1 A, Pair 2 A, Pair 2 B) is real code deletion. The re-partitioned status union removes no work; it relabels it.

## Consistency across the two repetitions

The two A responses are near-twins: the same model, deletion-as-conflict, kept failures, and the same two template defects. The B responses differ from each other. Pair 1 B keeps failures with revision tags; Pair 2 B clears them and keeps four statuses.

The winning label flips (Pair 1 B, Pair 2 A). That reflects how strong each opponent was, not a consistent ranking of the A-type answer. So I can't establish that either source is systematically better.

Points of agreement across all four:
- Autosave should pause on conflict.
- `save()` should be scoped to a revision.
- Refusals don't belong in stored state.
- The joined-save and conflict-retry-loop behaviours are defects.

## Is there a convincing improvement?

**In forming the model, yes, moderately.** Pair 1 B and Pair 2 A show that the five statuses really encode a relationship plus an in-flight write, using concrete traces checked against the source.

**In simplicity, no clear win.** All four trade availability states for a lease lifecycle. Pair 2 B is mostly a flatter API over the same responsibilities.

## Still untested — evidence requests for the coordinator

1. **Pair 1 B's input-replacement trace:** stored A, type B, outside write C, type A; assert `getText()` returns `'A'`.
2. **The conflict-retry loop:** conflict, then type, then wait past `SAVE_AFTER_MS`; check for a `saving` flicker and a `BUSY` refusal from `resolveConflict`.
3. **The joined save:** check whether `save()` returns a later revision's failure.
4. **Callers that only list rows:** whether eager `open` adds reads (Whispering `RecordingDetail.svelte:74-77`).
5. **The race no design resolves:** what happens when a read detects a conflict while a write is in flight. No response settles this.

I read the source and ran nothing. Of the defects above, the following are confirmed from the source alone and not executed:
- Pair 1 B's input-replacement trace
- the joined-save outcome
- `drain` clearing the error
- `submitText` scheduling a save during conflict
