# Adversarial review: the Chinese conversation companion destination

- **Date:** 2026-07-31
- **Scope:** `apps/vocab`, its prompt seams, and the ADR-0102/0105 pair
- **Status:** Review artifact. No production code changed. Not an ADR.
- **Destination treated as fixed:** one Chinese conversation companion, chat-first, mixed Chinese-English, with Conversation / Practice / Revisit as session entry surfaces over a shared entry pool, pinyin overlay, and history.

## Recommendation in one paragraph

Build the session boundary and nothing else first. The destination's load-bearing promise is that saved vocabulary is not forced into ordinary conversation but may steer an explicit practice session, and today Vocab has no place to put that distinction, so it smuggled the steering into a user message injected into whichever conversation happens to be open. Make one conversation equal one session, seeded and titled at creation. That change needs no new column, no new page, no new mode, and it fixes forced steering, unbounded steering, and the ruined conversation titles at once. Then amend ADR-0105 (do not supersede it) to narrow the tutor to Chinese, which collapses the three-provider reading registry to a single pinyin path and deletes two npm dependencies. Refuse Revisit as a third surface until the user says it means something Practice does not.

## 1. The strongest hidden contradiction

**A session has nowhere durable to live, so it lives in a message; and a message is permanent, contaminating, and steals the title.**

The chain is mechanical, not speculative:

- `AgentKit.buildSystemPrompts` is `() => string[]` (`packages/app-shell/src/agent-chat/agent-chat.svelte.ts:89`). It takes no conversation argument. The prompt seam is app-global, re-read per turn (`:218`).
- The canonical conversation row is exactly `{ title, model, createdAt, updatedAt }` (`packages/chat/src/index.ts:34-41`). There is no column that could carry a session kind, and adding one would fork a shared Lens shape that `apps/vocab/vocab.ts:5-9` explicitly names as the sync wire contract.
- So the only available carrier for "this is a practice session" is the body of a user turn. That is exactly what `buildPracticePrompt` is (`apps/vocab/src/lib/practice.ts:15-18`).

Three consequences, each a direct violation of the accepted destination:

**(a) Practice barges into the open topic conversation.** `practice()` (`apps/vocab/src/routes/+page.svelte:51-55`) sends into `chat.active`, whatever it is. Mid-conversation about ordering food, "Practice these (20)" drops a twenty-item vocabulary list into that thread. This is precisely "forcing saved vocabulary in ordinary conversation."

**(b) The steering never ends.** Because the instruction is a transcript message, it is fed back as conversation memory on every later turn (ADR-0105 makes this explicit, and it is why readings are kept out of message text). A practice request does not expire when the passage arrives; the conversation is permanently a drilling conversation with no exit short of starting a new one. The inverse failure of (a): once you steer, you cannot stop.

**(c) The same mechanism destroys topic return.** `sendMessage` titles a conversation from the first fifty characters of the first user message (`agent-chat.svelte.ts:393-397`). A practice-started conversation is therefore titled `Using the entries I'm learning below, write a short,` and every practice session collides on that identical string. The sidebar conversation list (`VocabSidebar.svelte:66-91`) is the only topic-return surface that exists, and practice-as-a-message poisons it.

**Attached defect, verified.** `createConversation` is `async` (`agent-chat.svelte.ts:484`). `practice()` calls it unawaited on line 53 and reads `chat.active?.` on line 54, which is still `undefined`, so the practice button silently does nothing on exactly the path where it must open a conversation. The discarded promise also drops its rejection with no `reportBackgroundError`. This is masked in normal use because boot auto-creates a conversation when the list is empty (`:474`), which is why it has not been noticed.

## 2. The minimal durable model

Unchanged from today. That is the finding.

```ts
entries      { id, text, note, stage, createdAt }   // ADR-0102, keep verbatim
conversations{ title, model, createdAt, updatedAt } // canonical @epicenter/chat, do not fork
showReadings boolean
```

No `kind` column, no `sessionType`, no `language`, no `topic` table. The session is expressed as **a conversation opened with a seeded first turn and an explicit title**. Durability comes free: the title is already durable, already sorted by recency (`agent-chat.svelte.ts:167-169`), and already listed.

This also disposes of consequence (b) correctly rather than by suppression. Steering permanence is only pathological when it leaks into an ordinary thread. Once a session *is* a conversation, a practice conversation staying a practice conversation is the right behavior, not a bug.

## 3. Pages, modes, or actions

**Actions.** Not close.

- **Not pages.** Vocab deliberately has no URL seam (`+page.svelte:31`). Three routes would introduce a router, three mount points, and three copies of the thread, to render one thread three times.
- **Not modes.** A mode requires durable per-conversation state (refused above, it forks the shared Lens) and an exit affordance (which is the thing that does not exist and cannot be built without the column).
- **Actions.** Each surface is one function: open a conversation, title it, seed its first turn. One mechanism, N prompt builders. `buildPracticePrompt` is already the first of them.

The one-sentence test passes: *Conversation, Practice, and Revisit are three buttons that each open a titled conversation with a different opening turn.*

Note the existing title guard composes for free: `sendMessage` overwrites the title only when it is still exactly `'New Chat'` (`agent-chat.svelte.ts:394-396`). Seed a real title at creation and the auto-title stays out of the way with no further change.

## 4. Preserving topic return without chat clutter

Topic return is a **list** problem, not a transcript problem. Keep every affordance outside the thread.

What is needed, in order of value:

1. **Explicit titles for seeded sessions** ("Practice: 12 entries", "Revisit: 你好, 学习, ..."). Fixes the collision in (c). Zero schema change.
2. **Rename.** The handle exposes `get title()` with no setter, while `model` has both (`agent-chat.svelte.ts:255-283`). That asymmetry is unmotivated: title is the topic-return handle and is the one the user most wants to correct. A setter mirroring `model`'s is a few lines in the shared package.
3. Nothing else.

**Refuse:** a topics table, pinning, tags, folders, or a per-conversation subject field. These are the decks-and-tags machinery ADR-0102 already refused at the entry layer, reappearing one level up. The conversation list sorted by `updatedAt` with honest titles is the whole feature; returning to a topic is `switchTo`, already shipped (`VocabSidebar.svelte:74`).

## 5. Are `stage` and `note` still right?

**`stage`: keep, and fix the control.** It has a real consumer beyond decoration: the stage filter selects which entries Practice compiles (`EntriesPanel.svelte:32-45`). Under a destination whose whole point is deliberate steering in explicit sessions, stage *is* the steering selector. It earns its keep.

The control is wrong, though. `NEXT_STAGE` cycles `usable -> new` (`EntriesPanel.svelte:23-27`), turning ADR-0102's *ordered ladder* into a ring: demoting `understood` to `new` requires stepping forward through `usable`. The data model and the affordance disagree. Small fix, honest asymmetry.

**`note`: keep, and give it its first reader.** Today `note` is write-only. Nothing consumes it but the input that renders it (`EntriesPanel.svelte:133-138`); `buildPracticePrompt` sends only `entryTexts` (`practice.ts:15-18`). That is a field with no machine consumer, which normally makes it a deletion candidate. It survives because the destination hands it one: Revisit is exactly "the user's own words about the words," and a revisit prompt that carries the note is materially better than one that does not.

Worth stating precisely, because it is easy to get wrong: **ADR-0102 refused machine *writes* to `note`. It never refused machine *reads*.** A revisit prompt that reads notes needs no amendment to ADR-0102.

## 6. ADR-0105: amend, do not supersede

Superseding would be a mistake. ADR-0105 makes three separable claims and only one of them conflicts with the destination.

| Claim | Verdict |
| --- | --- |
| The tutor is language-blind; one general multilingual prompt | **Contradicted.** `VOCAB_SYSTEM_PROMPT` (`vocab.ts:47-56`) tells the model to infer the language and follow language switches. A Chinese companion should say Chinese. |
| No `language` column on entries | **Survives, strengthened.** In a Chinese app the column is a constant. This is the two-boats spec's original argument ("the app boundary is the discriminator"), reached independently of ADR-0105's reasoning. |
| Readings are a deterministic client-side derived view over clean text | **Survives whole.** This is the strongest part of the ADR and the reason the message stays clean enough to be memory and to yield verbatim entries. |

So: one new ADR that **amends** ADR-0105 at the tutor-language claim, sets `Amended by` on ADR-0105, and leaves the derived-view decision and the no-language-column refusal explicitly intact. Pick the number at write time, not from this memo: `origin/main` currently tops out at **0190**, but 0191 through 0194 are claimed by unpushed in-flight work on other branches, so allocating naively from `main` would collide.

The amendment's second half is the collapse it licenses. With Chinese declared, the ordered multi-provider registry has one live provider and two with no audience.

Keep the kana/hangul abstain guard (`pinyin.ts:22, 34, 69`). It is three lines and it preserves the invariant that a missing reading beats a wrong one when the tutor quotes Japanese.

**Also fix while there:** `apps/vocab/vocab.ts:76` and `:122` cite ADR-0046 as the authority for message storage. ADR-0046 is Superseded by ADR-0047, and the actual current storage is the row-owned document per ADR-0152 and `createAgentMessageDocumentStore` (`packages/chat/src/index.ts:60`). Citing a retired ADR as live authority is the exact failure `AGENTS.md` warns about.

## 7. Deletion prizes

Deleted outright by the Chinese declaration (all verified to have no consumer outside the set):

| Path | Lines |
| --- | --- |
| `apps/vocab/src/lib/readings/romaji.ts` | 34 |
| `apps/vocab/src/lib/readings/romaji.test.ts` | 36 |
| `apps/vocab/src/lib/readings/cyrillic.ts` | 34 |
| `apps/vocab/src/lib/readings/cyrillic.test.ts` | 35 |
| `apps/vocab/src/lib/readings/runs.ts` | 39 (only callers are romaji and cyrillic) |

Plus, inside `registry.ts`, the `ReadingProvider` type, the `readingProviders` array, `loadOnce`, and `composeRomanizers` (roughly 60 of its 103 lines). `resolveRomanizer` is the registry's only export reaching outside the folder, with exactly one consumer (`ReadingMarkdown.svelte:19`), so it survives as a direct "has Han and no kana: load pinyin-pro, else identity" function. `registry.test.ts` loses its `composeRomanizers` block.

Plus two npm dependencies: `wanakana` and `transliteration` (`apps/vocab/package.json:40,38`), neither used anywhere else in the monorepo.

Total: about 178 lines deleted outright, about 60 more collapsed, two dependencies gone, and the app's `description` field stops claiming to be multilingual.

## 8. Smallest implementation wave

**Wave 1 is the only one I would authorize now, and it is genuinely small.**

1. Add an optional `{ title?, seed? }` to `createConversation` in `packages/app-shell/src/agent-chat/agent-chat.svelte.ts:484`. Both call sites are safe: `apps/vocab` and `apps/tab-manager/src/lib/application.ts:188` are the only consumers of `createAgentChatState`, and tab-manager calls it with no arguments.
2. Rewrite `practice()` (`+page.svelte:51-55`) to `await` a new titled conversation and send into *it*, never into `chat.active`. Catch the promise into `reportBackgroundError`.
3. Retitle the button from "Practice these" to something that says a session starts ("Practice in a new chat").

That is one shared-package signature change and one app function. It closes (a), (b), (c), and the unawaited-promise defect together, and it is independently shippable and revertible.

**Wave 2** (separable, larger blast radius): the ADR-0195 amendment, the Chinese system prompt, the registry collapse, the dependency removal.

**Wave 3** (gated on the judgment in section 10): a Revisit action, if it survives.

**Wave 4** (cheap, do whenever): the `stage` ladder control, the title setter, the stale ADR-0046 citations.

Order matters: Wave 1 before Wave 2, because Wave 2 touches the prompt that Wave 1's seeded turns are generated under, and reviewing them together would fuse a behavior fix with a product repositioning in one diff.

## 9. What to refuse

Refused because the destination does not need them and each drags a family of machinery:

- **A `kind` / `mode` column on conversations.** Forks a canonical Lens shape for one app. The session is the conversation.
- **Routes for the three surfaces.** Introduces a router seam to render one thread three times.
- **A topics or tags table.** ADR-0102's refused grouping machinery, relocated.
- **SRS, `dueAt`, review scheduling.** ADR-0102 refused these, the two-boats history shows the interval machinery was already built and deleted once when conversation became the repetition, and nothing in the destination reopens it. Do not let "Revisit" smuggle it back.
- **A stored gloss, or machine writes to `note`.** ADR-0102 holds unchanged.
- **AI-annotated readings.** ADR-0105's deferred provider. A Chinese-only app makes it strictly less relevant, since Han is category 1.

## 10. The one user judgment that could change execution

**Does "Revisit" mean a distinct tutor behavior, or is it the conversation list?**

The destination fuses two different objects under one word: "revisit saved words" and "revisit prior material." They resolve differently.

- If Revisit means *return to a past topic*, it is `switchTo` over a well-titled conversation list. Already shipped. Wave 1's titling completes it, and there is no third surface to build.
- If Revisit means *re-cover saved words*, it is Practice with a different entry selection, and the two collapse into one action with a filter.
- If Revisit means *check whether I still know these* (retrieval, not exposure), that is a genuinely different learning operation from Practice's "show me these in context," and it earns a second prompt builder beside `buildPracticePrompt`. It still does not earn a third *surface*: same mechanism, different seed.

**My recommendation is to build two actions and treat Revisit as the titled conversation list until the user asks to be quizzed.** Everything downstream of that answer is one prompt-builder file either way, which is why this is safe to defer and why Wave 1 does not depend on it.

## 11. Risks and assumptions

- **Load-bearing interpretation.** I read "surfaces sharing transcript" as *one chat surface renders every session*, not *all three write into a single eternal thread*. The latter reading is self-contradictory with "session entry surfaces" and with "do not force vocabulary into ordinary conversation," but it is an interpretation, and it is the assumption Wave 1 rests on. If the user means one eternal thread, Wave 1 is wrong and the design needs an in-thread mode marker instead.
- **Shared-package edit.** Wave 1 touches `packages/app-shell`, used by tab-manager. The optional-argument shape keeps that call site untouched, but it is a shared surface and deserves the corresponding review gate.
- **Practice-in-place may be wanted sometimes.** Wave 1 removes the ability to practice inside the current conversation. I judge that correct (it is the contradiction), but it is a real capability removal, not a pure fix.
- **Verified state.** `bun test apps/vocab` passes in the primary checkout: 37 tests across 6 files, 0 failures. The same command in this review's fresh worktree reports 23 pass / 4 fail / 3 errors, entirely from `Cannot find package` on `pinyin-pro`, `wanakana`, and `transliteration`: the worktree has no installed `node_modules`. Those are environment failures, not regressions, and the pure-logic suites (practice, entry candidates, romanizer composition) pass in both. Every path, symbol, and line number above was read from the repository, not inferred.
