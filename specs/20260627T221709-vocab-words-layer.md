# Vocab WORDS Layer: a chat that remembers your vocabulary

**Date**: 2026-06-27
**Status**: Draft
**Owner**: Vocab (apps/vocab)
**Branch**: (not started)

## One Sentence

Add a user-curated WORDS store to `apps/vocab` so the existing chat can weave your target vocabulary into conversation, capture new words you tap mid-chat, and report back which ones you actually used, with no spaced-repetition scheduler.

## How to read this spec

```txt
Read first:
  One Sentence
  Motivation (Current State, Target Shape)
  The words schema (catalog)
  Architecture (the loop, ownership, a compiled prompt)
  Implementation Plan
  Success Criteria

Read if changing the design:
  Research Findings
  Design Decisions
  What this refuses (and must keep refusing)
  Open Questions

Edge Cases and Decisions Log are reference.
```

## Overview

`apps/vocab` today is a bilingual Chinese-English chat with client-side pinyin annotation. It has no concept of a word you are learning. This spec adds a local-first WORDS store you curate, a focus set the chat reads, and a harvest step that writes back what happened, turning the chat from a stateless tutor into one that remembers your vocabulary and accumulates an owned, exportable record of it.

## Motivation

### Current State

The shipped app is the TALK half only. The durable model (`apps/vocab/vocab.ts`) is:

```ts
// workspace: epicenter-vocab
tables: { conversations }          // from @epicenter/chat: id, title, model, createdAt, updatedAt
                                   //   + child doc `messages` (LWW AgentMessage store)
kv:     { showPinyin }             // boolean, default true
// plus constants: VOCAB_MODEL = 'gemini-3.5-flash', VOCAB_SYSTEM_PROMPT (Chinese-tuned)
```

Pinyin is render-time only: `pinyinRomanizer` (`apps/vocab/src/lib/romanize/pinyin.ts`) segments CJK runs and the `Markdown` component annotates them. There is no `words` table, no status, no review, no dictionary.

This creates problems:

1. **It cannot remember your vocabulary.** The product promise ("a chat that remembers your vocabulary") is literally undeliverable: nothing persists a word you are learning.
2. **It is a ChatGPT-with-pinyin wrapper.** Without an owned, growing word store and a read/write loop into the conversation, the app has no durable asset and nothing to make it sticky.
3. **No recognition or usage practice.** Conversation alone gives comprehensible input, but there is no surface that practices recognizing a specific word or that records whether you produced it.

### Target Shape

One small user-owned table plus three behaviors layered on the existing chat:

```ts
// the entire durable addition
wordsTable = defineTable({
  id:              field.string<WordId>(),
  term:            field.string(),                           // 学习
  gloss:           field.string(),                           // meaning (you curate; dict/AI prefills)
  status:          field.select(['new', 'learning', 'known']), // the ONE mastery signal, yours
  notes:           field.string(),                           // tutor's living one-line read (overwritten)
  lastPracticedAt: nullable(field.instant()),                // rotation only; null = never
  createdAt:       field.instant(),
});
```

```txt
capture  : tap a word in the chat -> saved as `new`, gloss auto-filled
select   : pure function -> `learning` words, least-recently-practiced first, take N
compile  : prompt = persona + focus words (term/gloss/status) + notes + your free-text intent
harvest  : the AI (already in the chat) reports what you actually used,
           stamps lastPracticedAt on words that came up, proposes status changes you approve,
           overwrites each word's notes
```

## Research Findings

Three subagent rounds (architecture, an adversarial dueAt/curation debate, and a user-perspective stress test) plus comparable-app research produced the direction. Compressed:

### How no-grade vocab tools surface words

| Tool | Mastery signal | Scheduler | Word source |
| --- | --- | --- | --- |
| Anki / SM-2 / FSRS | per-review **grade** (required input) | adaptive due-dates | manual entry (the death) |
| LingQ | status buckets (new/learning/known) | fixed intervals, mostly exposure | **tap a word in real content** |
| Glossika | none | fixed exposure schedule | curated sentences |
| Duolingo | half-life model | strength bar | fixed course |

**Key finding**: SM-2 and FSRS are *driven by a per-review grade*. A conversation produces no clean pass/fail grade. A `dueAt` with no grade feeding it is just Glossika's fixed timer wearing an SRS costume, not adaptive scheduling.

**Implication**: refuse the scheduler. The conversation offers a better signal than a self-graded flashcard: whether you actually *used* the word. That signal is behavioral and free to read at harvest.

### The dueAt / AI-as-curator debate

Two adversaries (champion-B: AI curates durable state; champion-A: deterministic, AI off the durable path) converged on a keystone:

> **Non-determinism at write time (gated, typed, approved, revertible). Determinism at read time (`select()` is a pure function of stored fields).**

The repo already ships the write machinery: `invokeAction` validates every AI mutation against a TypeBox schema at one choke point (`packages/workspace/src/shared/actions.ts`), `createDispatchToolCatalog` turns an action's schema into the AI tool's input schema (ADR-0047), and `apps/local-books` proved model-in-the-loop typed writes with per-mutation approval (ADR-0044). `local-books` even has *parked* `mark_reviewed` / `add_note` tools that are this words layer.

### User-perspective stress test

Two skeptical-learner adversaries converged: the data-model simplification holds, but the product had two real cracks, both fixable with **zero new durable fields**:

| Crack | Fix | New fields |
| --- | --- | --- |
| The store does not fill itself (manual entry = Anki death) | tap-a-word-in-chat capture + harvest proposes words | none |
| `lastPracticedAt` stamped on the whole focus set lies, and rotates the hard words (never-surfaced) to the back | harvest reports which words *actually came up*; stamp only those | none |
| `notes` append-only log rots and bloats the prompt | `notes` is an overwritten one-line snapshot | none |
| No visible progress | surface a derived `known: N` count | none (derived) |

**Key finding**: the one deletion that was load-bearing *for the learner* was "knowing what was actually practiced." It returns as **one sentence in the AI harvest pass that already runs**, not as the deterministic transcript scanner that was correctly deleted. The AI version is also better: it handles Chinese segmentation, synonyms, and whether the word was used *correctly*, which a string match cannot.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Mastery signal | 2 coherence | One human `status` dial (new/learning/known) | LingQ-proven; AI proposes changes, you approve. ADR candidate. |
| Scheduling | 2 coherence | Pure `select()` function; no stored `dueAt`/`reviewAfter` | In-repo SELECT is `scan().rows` + JS sort; a stored schedule is a derived value that drifts and forces migrations. ADR candidate. |
| Exposure counters | 2 coherence | Refused | No consumer once the scheduler and modes are gone; transcript counting is false-precise for Chinese. |
| Practice intent | 3 taste | Ephemeral; compiles into the session prompt, then evaporates | User chose this over a durable override; keeps the durable model purely factual. Loss: no multi-session "park for a month" (use the status dial). |
| Compile modes (introduce/expose/elicit) | 2 coherence | Refused as computed fields | The AI tutor escalates from showing to eliciting on its own, given status + notes. |
| Harvest mechanism | 2 coherence | AI pass only (notes + status proposals + "what was used"); no deterministic scanner | The AI is already in the conversation; one richer harvest prompt replaces a subsystem. |
| `lastPracticedAt` stamp | 1 evidence | Stamp only words the harvest confirms appeared | Stamping the whole focus set buries never-surfaced words. Verified failure mode in stress test. |
| `notes` semantics | 3 taste | Overwritten one-line snapshot, not append-only | Bounds token cost and kills stale advice. Revisit if one line proves too little. |
| Word capture | 2 coherence | Tap a CJK word in chat -> `new`, gloss prefilled | The store must fill itself; the chat already segments CJK. ADR candidate. |
| Gloss source | 1 evidence | CC-CEDICT (meaning) + pinyin-pro (reading); reading not stored | reading is deterministic from characters; do not store derived data. See Open Questions for the AI-gloss alternative. |
| `language` field | 2 coherence | Refused | Chinese is an app constant (like the model and system prompt). A loose BCP-47 string smears a constant onto the sync wire. Reintroduce as a strict union co-committed with romanizer #2. |
| `focusWordIds` on conversation | 2 coherence | Not durable; live session `$state` | Intent evaporates; only its effects persist. Avoids forking the shared `@epicenter/chat` conversations table. |
| Gating | 3 taste | Graduated (ADR-0044): notes auto, status/merge approved | You keep ownership of `status`; the AI earns the right to disagree, not to overwrite. |

## The words schema (catalog)

```ts
wordsTable = defineTable({
  id:              field.string<WordId>(),                     // branded, minted on create
  term:            field.string(),                             // the word/phrase, e.g. 学习
  gloss:           field.string(),                             // meaning; prefilled, user-editable
  status:          field.select(['new', 'learning', 'known']), // YOUR dial; AI proposes via gated tool
  notes:           field.string(),                             // tutor's living read; overwritten at harvest
  lastPracticedAt: nullable(field.instant()),                  // rotation key; null = never practiced
  createdAt:       field.instant(),
});
// conversations stays exactly as imported from @epicenter/chat (not forked).
```

### Fields considered and rejected

| Candidate | Why rejected |
| --- | --- |
| `seenCount`, `exposureCount` | No consumer once the scheduler/modes are gone; counting is false-precise for Chinese. |
| `productionCount` | Folds into `(status, lastPracticedAt)` + the AI's read; a counter cannot judge correct usage. |
| `dueAt` / `reviewAfter` | The schedule is a pure function; a stored override was refused with "intent evaporates". |
| `reading` | Deterministic from `term` via pinyin-pro; storing it is storing a derived value. |
| `language` | Chinese is a constant; reintroduce as a strict union with romanizer #2. |
| `mode` (introduce/expose/elicit) | The AI decides per word from status + notes. |
| `focusWordIds` on conversation | Live session state, not durable; avoids forking the shared table. |

## Architecture

### The loop

```txt
                tap a CJK word in chat
                        |  (gloss from CC-CEDICT, status = new)
                        v
   +------------------ WORDS store ------------------+
   |  term, gloss, status, notes, lastPracticedAt    |
   +-------------------------------------------------+
      |  (1) SELECT  pure fn: status==learning,
      |             least-recently-practiced, take N
      v
   FOCUS SET (n = slider; live $state, not durable)
      |  (2) COMPILE  persona + focus(term,gloss,status) + notes + your free-text
      v
   CONVERSATION  -- chips above input: no gloss, hover to reveal --
      |  (3) HARVEST  AI reports used/only-seen/never-came-up
      |              -> stamp lastPracticedAt on words that appeared
      |              -> propose status changes (you approve)
      |              -> overwrite notes; propose new words to save
      +----------------------------> back to WORDS
```

### Ownership (who may write what)

```txt
status           you        (AI proposes, you approve)        <- the mastery dial
notes            AI         (auto-applied, overwritten)        <- the living read
lastPracticedAt  harvest    (only words that actually appeared)
term, gloss      you        (capture prefills, you edit)
select()         code       (pure function; no model)          <- read-time determinism
```

### A compiled prompt (deterministic default)

```txt
You are a Mandarin conversation partner. Mix English explanation with 简体字;
never write pinyin (the client adds it).

The user is practicing these words. Introduce the `new` ones naturally and gloss
them inline once; for `learning` ones, create openings where the natural reply
uses the word rather than saying it for them. Weave them in where they fit; do
not force every one.

  学习 (to study)  [learning]  note: confuses with 学校 (school)
  复习 (to review) [learning]
  习惯 (habit)     [new]

The user asked: "casual chat about my weekend, keep it light."
```

At session end the harvest prompt asks the model to return, per focus word, `used | only-seen | never-came-up`, a one-line updated note, an optional status proposal, and any new words the user stumbled on.

## Implementation Plan

### Phase 1: WORDS store + capture (the funnel)

- [ ] **1.1** Add `wordsTable` to `vocab.ts` with `id, term, gloss, status, createdAt` (defer `notes`, `lastPracticedAt` to later phases; `defineTable` versioning makes them additive).
- [ ] **1.2** Add `generateWordId` branded factory beside `generateMessageId`.
- [ ] **1.3** Bundle/load CC-CEDICT and add a `glossFor(term): { gloss, reading }` lookup (Chinese-only seam).
- [ ] **1.4** Make CJK runs in rendered assistant messages tappable; tap -> create word `{ term, gloss: glossFor(term), status: 'new' }`.
- [ ] **1.5** A minimal words list view: term, gloss, status dial, manual add as the escape hatch. Surface a derived `known: N` count.

### Phase 2: select + compile + chips

- [ ] **2.1** Add `lastPracticedAt` column (migration).
- [ ] **2.2** `selectFocus(words, n)`: pure fn, `status==='learning'` sorted by `lastPracticedAt` ascending (nulls first), take `n`; allow pin/drop; optionally seed K `new` words.
- [ ] **2.3** Compile the focus set + optional free-text intent into the system prompt (deterministic builder).
- [ ] **2.4** Render focus words as chips above the input: no gloss, hover reveals gloss + reading; light up as they appear.

### Phase 3: harvest

- [ ] **3.1** Add `notes` column (migration).
- [ ] **3.2** Harvest prompt: per focus word return `used|only-seen|never-came-up`, updated one-line note, optional status proposal, proposed new words.
- [ ] **3.3** Apply: stamp `lastPracticedAt = now` only on `used|only-seen`; overwrite `notes` (auto); queue `status` changes and new words for one-tap approval (ADR-0044 gating).

### Phase 4: polish

- [ ] **4.1** Tags grouping (deferred; only if a single pool starts to feel crowded, see Open Questions).
- [ ] **4.2** AI-assisted and template compile modes as seams, only if wanted.

## Edge Cases

### A focus word never comes up in the chat

1. N words selected; the tutor naturally touches a few.
2. Harvest reports the rest as `never-came-up`.
3. They are **not** stamped, so they stay at the front of tomorrow's rotation instead of sinking. (This is the fix for the priority-inversion crack.)

### The user marks a word `known` they have actually forgotten

1. Illusion of competence; `known` drops it from rotation.
2. The next time it appears in any chat, harvest may propose `known -> learning` based on a fumble.
3. You approve or reject; the dial stays yours.

### Slider set high

1. The tutor cannot weave 12 words into a casual chat without a forced recital.
2. Default N small (about 5), cap modest (about 8); the compile prompt says "weave where they fit, do not force every one."
3. See Open Questions on whether to ship a fixed N first.

### A captured term is a substring of a longer word

1. CC-CEDICT lookup returns the wrong sense (e.g. tapping inside 学习者).
2. Gloss is user-editable; the user corrects it.
3. Phrase-level capture is deferred (Open Questions).

## Open Questions

1. **Decks / "apps".** ~~Resolved 2026-06-27: deferred.~~ Ship a single word pool for v1, no grouping field. If grouping is wanted later, add a single `tags: string[]` (a clean additive migration via `defineTable` versioning) and have `select()` filter by the active tag; refuse a `decks` entity until deck-level metadata is real.

2. **Gloss source on capture.** CC-CEDICT (instant, offline, deterministic) vs ask the in-context AI (handles phrases and contextual sense, costs latency).
   - **Recommendation**: CC-CEDICT for single words; AI fallback for multi-character phrase selections. Resolve when building 1.3/1.4.

3. **Slider now or later.** Fixed small N first vs ship the slider immediately.
   - **Recommendation**: fixed N (about 5) first; add the slider only when a user asks. Class 3.

4. **AI-assisted / template compile modes.** Deterministic builder is the default.
   - **Recommendation**: defer both as named seams; build only on demand.

## What this refuses (and must keep refusing)

The loudest future request will be "just add spaced repetition, it is table stakes." Do not. These refusals are the design, not an oversight:

```txt
no SRS scheduler / FSRS / SM-2          (no grade exists in a conversation)
no stored dueAt / review intervals      (the schedule is a pure function)
no exposure / production counters        (false-precise; no consumer)
no streaks, no due-count                 (coercion that breeds dodge-the-word laziness)
no introduce/expose/elicit mode fields   (the AI tutor decides per word)
no `language` column                     (Chinese is a constant until romanizer #2)
```

Promote the top three to an ADR when work lands, so this is durable past the spec.

## Decisions Log

- Keep `notes` as a single overwritten line: bounds prompt cost and staleness.
  Revisit when: a single line demonstrably loses signal the tutor needs across sessions.
- Keep intent ephemeral (no durable override): the user chose the purely-factual durable model.
  Revisit when: the user repeatedly wants multi-session "park this word" and the status dial proves insufficient.
- Keep the slider deferred behind a fixed N: avoids the forced-recital footgun.
  Revisit when: a user asks to practice more than the default per session.

## Success Criteria

- [ ] You can tap a word in a chat and it is saved with a prefilled gloss and `status: 'new'`.
- [ ] Starting a session auto-fills a focus set of `learning` words, least-recently-practiced first.
- [ ] The compiled prompt makes the tutor weave the focus words in; chips show them without gloss, hover reveals.
- [ ] At session end, only words that actually appeared get `lastPracticedAt` stamped; status changes and new words are proposed for one-tap approval; notes are refreshed.
- [ ] A derived `known: N` count is visible and climbs as you graduate words.
- [ ] No `dueAt`, no counters, no SRS scheduler exist anywhere in the code.
- [ ] `bun run check` / typecheck / tests pass; sync compatibility with the canonical schema preserved.

## References

- `apps/vocab/vocab.ts` - workspace contract; add `wordsTable` and `generateWordId` here (wire contract for sync).
- `apps/vocab/vocab.browser.ts` - browser composition (`openVocabBrowser`).
- `apps/vocab/src/lib/romanize/pinyin.ts` - `pinyinRomanizer`; the gloss/reading seam lives beside it.
- `packages/ui/src/markdown/romanizer.ts` - `Romanizer`/`Segment` types (already language-agnostic).
- `packages/chat/src/index.ts` - the shared `conversationsTable` Vocab composes beside (do not fork).
- `packages/workspace/src/shared/actions.ts` - `invokeAction` + `Value.Check` choke point for gated AI writes.
- `packages/workspace/src/agent/dispatch-catalog.ts` - `createDispatchToolCatalog`; action schema becomes the AI tool input schema (ADR-0047).
- `apps/local-books/src/agent/recategorize.ts` - model-in-the-loop typed mutation pattern to mirror for harvest.
- `apps/local-books/AGENTS.md` - capability/approval lattice (ADR-0044) and the parked `mark_reviewed`/`add_note` precedent.
