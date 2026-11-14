## Verdicts

| Pair | Verdict | Confidence |
|---|---|---|
| 1 | **B** | low to medium |
| 2 | **Tie** (slight lean to A) | low |

I checked the main code claims against the snapshot, and they hold:
- `edit-owner.ts:1162` schedules autosave without any condition.
- `:847` clears the error and sets `saving` before resending with the stale `input.from` (`:827`).
- `:1013-1016` refuses discard with BUSY.
- `:806-808` makes a caller that joins a running save get the result of the drain's *last* attempt.
- `:1139-1147` keeps input while a save runs, even after a revert.
- `svelte/edits.ts:24-27` starts a file read when a getter is first read.

All four responses report these facts correctly. None of them describes the code wrongly in a way that matters.

---

## Pair 1: B (low to medium)

**The deciding difference is how each models a revert while a save is running.**

Response A puts `saving` inside `unsaved` (`{ kind: 'unsaved'; saving: boolean; failure }`) and defines dirty as "`text !== witness text`". Its own walkthrough of a revert during a save says "the editor is clean while R5 is still in flight." In A's model that means `kind: 'saved'`, and A's template shows "Saved" while a write is in flight that will change storage. A has no way to represent "clean, but writing". This is the very case the user asked about: a save carrying older text alongside the current text.

Response B keeps `writing` as its own axis ("`writing` exists because a save of older text is real and can overlap any persistence state"). In the same case its UI shows "Saving…". B's definition of saved is still a little too strong: "storage is known to hold exactly `text`" isn't strictly true during the `saved, writing` moment B describes. But it stays visible to callers, while A's version is hidden.

**Other differences:**
- **Clean file deleted elsewhere.**
  - A closes the editor (`closed: { reason: 'deleted', lastText }`).
  - B keeps a "ghost" (`conflict{stored: null}`) and names its costs: "a clean 'ghost' can outlive its file."
  - Both are coherent, and both are labelled as product choices.
- **What `save()` returns.** A's `{landed: Revision}` tells the caller more than B's `Result<void>`. A also explains plainly why a coalesced newer write satisfies `save()`.
- **Failure lifetime.** Both keep a failure through the retry. B also keeps it through typing: "Typing does not clear it, because typing doesn't fix storage."

**Concrete-use concerns:**
- **B, Svelte:**
  - `FileRoute.svelte` gets the compiler warning `state_referenced_locally` on `path`. `openText(folder.files, path)` captures the path once, so the route wouldn't reopen when the path changes.
  - `close`, `lf` and `withFileNewlines` are never defined.
- **A, Svelte:**
  - The template has no compiler warnings.
  - It assumes `editor.state` is reactive but never shows a subscription or adapter.
  - `{#await folder.open(path)}` could leave a handle unreleased if the promise resolves after the component is destroyed. This is an uncertain implementation detail, not a demonstrated flaw.

---

## Pair 2: Tie, slight lean to A (low)

**Response A has the better model of which facts exclude each other.** It finds the one real either/or: "the reason autosave has stopped: a failure, fixed by retrying, or a conflict, fixed by choosing a version." It encodes that as `problem: SaveFailure | SaveConflict | undefined` and states invariants: "a failure implies `pending`, and so does `writing`… Failure and conflict never coexist." Its definition of pending handles a revert during a save correctly: "Text that equals the witness is still pending if a write of a different revision is in flight." This directly answers the user's question about relationships between the facts.

**Response B leaves those relationships implicit.** It exposes `dirty`, `saving`, `failure?`, `conflict?` and `storage{state, error}` as independent fields and states no invariants. Its prose implies some, such as autosave pausing during a conflict, but the type allows conflict+saving and failure+conflict. That is the risk the user raised: "independent flags leave relationships implicit." B does define dirty precisely: "false when `text` equals the witness and nothing is in flight, or when `text` equals the in-flight text."

**Against A, two demonstrated problems:**
- **Missing lifecycle.** The `Editor` type has no `release()`, and the Svelte example never releases anything. Yet A says "Clean deleted editors linger. They stay held until the view releases them" and lists "`close`/`settle`/`release`" under what stays. A admits "Released handles are an open question," but as written its lifecycle is incomplete. B includes `release(): void // decrements the count of holders`.
- **Lost or displaced information.**
  - A clears a failure when the user types ("because it described r1"). That is defensible and explained, but "Saving…" can then replace "Not saved" while storage is still failing.
  - A moves refresh errors to "the polling query", so the editor no longer shows them.
  - B keeps both: it labels failure retention as "the main product choice" and keeps `storage.error`.

**Concrete use:**
- A's `editorView(raw)` gets the compiler warning `state_referenced_locally`.
- A's `folder.peek(path) ?? folder.open(path)` is a reasonable way to avoid a loading flash for editors that are already held.
- B uses an undefined `reactive()` helper and never calls `release()` in its template.
- B honestly flags the `{#await}` flash as unverified.

Each response has one strength the other lacks: A's tighter exclusive union and stated invariants, and B's complete handle lifecycle and kept information. I can't call the difference decisive.

---

## Consistency across repetitions

All four responses agree on the substance:
- Reject the single five-way status.
- Open the editor with an async `open`, so `text` always exists.
- Make revert something that is never refused.
- Pause autosave during a conflict.
- Return refusals as Results instead of storing them.
- Report the same snapshot bugs.

The real differences come down to three choices:

| Choice | Pair 1 A | Pair 1 B | Pair 2 A | Pair 2 B |
|---|---|---|---|---|
| Where saving/writing lives | nested inside `unsaved` | orthogonal | orthogonal | orthogonal |
| Clean file deleted elsewhere | editor closes | ghost kept | ghost kept | ghost kept |
| Failure when the user types | not stated | kept | cleared | kept |

The responses don't line up into one consistent "winner" style across the pairs. The flaw that decided Pair 1 (a write in flight that can't be represented) doesn't appear in either Pair 2 response. The weaknesses in Pair 2 point in opposite directions: lifecycle for A, invariants for B. So the two pairs don't show one version consistently ahead.

## Does either pair show a convincing improvement?

Only Pair 1, and only modestly. Pair 2 doesn't separate the two responses.

## What remains untested

These are execution requests for the coordinator, all repeated across the responses:
1. Type after a conflict, wait past `SAVE_AFTER_MS`, and count `replaceSource` calls. This should confirm the conflict → saving → conflict loop.
2. Call `save()` at r1 while r2 later fails, and check whether the r1 caller gets r2's error.
3. Delete a clean file elsewhere and check that `ready` turns into `unavailable`.
4. Check whether a Svelte 5 `{#await}` on an already-resolved promise shows the pending branch for a tick. This decides whether `peek` is needed.

Not checked by me: whether `replaceSource` treats an outside write of identical text as success or as a conflict (both Pair 2 responses raise this), and whether each caller can open the editor before rendering it. None of the proposed APIs has been prototyped, type-checked or tested. The compiler checks only cover syntax.
