# Vocab becomes a Chinese conversation companion

**Date**: 2026-07-31
**Status**: Draft
**Owner**: Braden (product direction), whoever executes the waves
**Branch**: `worktree-vocab-companion-lock` (planning only; no production code changed)
**Records**: [ADR-0195](../docs/adr/0195-vocab-is-a-chinese-conversation-companion-and-every-intentional-session-is-a-new-conversation.md), which amends [ADR-0105](../docs/adr/0105-vocab-is-a-multilingual-tutor-and-readings-are-a-client-side-derived-view.md)

## One Sentence

Vocab stops being a language-blind multilingual tutor with a vocabulary sidebar
bolted on, and becomes a chat-first Chinese conversation companion where every
intentional session is a new conversation opened with a composed first turn.

## How to read this spec

```txt
Read first:
  One Sentence
  Current state
  Target shape
  Session-entry contracts
  Implementation waves
  Verification

Read if changing the architecture:
  Ownership
  Durable objects and refusals
  Explicitly deferred
  Open questions
```

The product destination is settled and recorded in ADR-0195. This spec is the
path from the code that exists to that destination. It changes no production
code itself.

## Recognition sentence

> I open Vocab to have a Chinese conversation, and anything I want to become
> comfortable using can naturally become material for a future conversation.

Everything below is judged against that sentence. A change that does not serve
it is out of scope.

## Current state

```txt
apps/vocab/
  vocab.ts                              # Lens, VOCAB_MODEL, VOCAB_SYSTEM_PROMPT, entriesTable
  src/lib/
    application.ts                      # openVocabApplication: replica + bound Lens + entries state
    practice.ts                         # buildPracticePrompt(entryTexts) -> one user turn
    entry-candidates.ts                 # extract savable spans from a settled message
    state/entries.svelte.ts             # the one entry pool: save / setStage / setNote / remove
    readings/
      registry.ts   (103)               # ReadingProvider, readingProviders[], loadOnce, composeRomanizers, resolveRomanizer
      pinyin.ts     (74)                # Chinese, abstains on kana/hangul
      romaji.ts     (34)                # Japanese kana
      cyrillic.ts   (34)                # Cyrillic
      runs.ts       (39)                # shared run walker; callers are romaji + cyrillic only
  src/routes/
    +page.svelte                        # createAgentChatState, readings toggle, practice()
    components/
      ConversationView.svelte           # thread, selection capture, candidate extraction
      EntriesPanel.svelte               # pool list, stage filter, "Practice these"
      VocabSidebar.svelte               # conversation list + EntriesPanel
      ReadingMarkdown.svelte            # settled message + reading overlay
```

What is right today and stays: the entry pool and its shape (ADR-0102), the
reading overlay as a derived view over clean text (ADR-0105), selection capture,
candidate extraction, the canonical conversations table, and the client agent
loop.

Four things are wrong, and they are the reason for this spec.

**1. The tutor cannot name the language it teaches.** `VOCAB_SYSTEM_PROMPT`
(`apps/vocab/vocab.ts:47-56`) tells the model to infer the studied language and
follow language switches. `buildPracticePrompt` and
`buildEntryCandidatePrompt` are both written to hold no language-specific
string, which makes each of them vaguer than it needs to be. The package
`description` still reads "Multilingual chat tutor".

**2. Practice has no session boundary.** `practice()`
(`apps/vocab/src/routes/+page.svelte:51-55`) sends the compiled turn into
`chat.active`, whatever conversation that is. Three consequences, each a direct
contradiction of the destination:

- a compiled twenty-phrase list lands in a thread about something else;
- a user turn is permanent conversation memory, so once steered the thread stays
  steered with no exit short of starting a new conversation;
- the auto-title writes the first fifty characters of the first user message
  (`packages/app-shell/src/agent-chat/agent-chat.svelte.ts:394-396`), so a
  practice-started conversation is titled `Using the entries I'm learning below,
  write a short,` and every practice session collides on that identical string.
  The conversation list is the only topic-return surface the app has.

**3. An attached defect on that same path.** `createConversation` is `async`
(`agent-chat.svelte.ts:484`). Line 53 calls it unawaited and line 54 reads
`chat.active?`, which is still `undefined`, so Practice silently does nothing on
exactly the path where it must open a conversation. The discarded promise also
drops its rejection with no `reportBackgroundError`. It is masked in normal use
because boot auto-creates a conversation when the list is empty
(`agent-chat.svelte.ts:474`).

**4. Nothing offers the learner a way in.** There is no proactive seed. A blank
thread is the whole invitation.

## Target shape

```txt
                 ┌──────────────────────────────────────────┐
   type          │                                          │
   a turn  ─────▶│                                          │
                 │        one chat surface                  │
   accept        │   (ConversationView, unchanged)          │
   a seed  ─────▶│                                          │
                 │                                          │
   practice      │                                          │
   selection ───▶│                                          │
                 └──────────────────────────────────────────┘
        │                          ▲
        │  each opens a NEW        │  the tutor persona is Chinese-and-English
        │  conversation            │  and steers lightly by default
        ▼                          │
   createConversation({ title?, opening? })
        │
        ▼
   canonical conversations row  { title, model, createdAt, updatedAt }   ← unforked
   conversation row document    one finished AgentMessage per key         ← unchanged
```

Three ways in, one mechanism. A session entry produces a title and, for the two
composed entries, one opening user turn. There is no mode, no route, and no
stored intent. The thread view is the same component in all three cases.

## Ownership

| Concern | Owner | Note |
| --- | --- | --- |
| Conversation creation, titling, the loop | `packages/app-shell/src/agent-chat/agent-chat.svelte.ts` | Gains one optional argument; no other shape change |
| What each session entry's opening turn says | `apps/vocab/src/lib/session.ts` (new) | Pure functions, no I/O, no state |
| The curated conversation seeds | `apps/vocab/src/lib/seeds.ts` (new) | A list of Chinese conversation openers, app-owned |
| The Chinese tutor persona | `apps/vocab/vocab.ts` | App constant, alongside `VOCAB_MODEL` |
| The saved pool and its writes | `apps/vocab/src/lib/state/entries.svelte.ts` | Unchanged; ADR-0102 shape |
| The single pinyin overlay | `apps/vocab/src/lib/readings/pinyin.ts` | Keeps its kana/hangul abstain guard |
| Wiring the three entries to the chat | `apps/vocab/src/routes/+page.svelte` | Calls the composers, awaits the create |

## Session-entry contracts

The shared seam gains exactly one optional argument. Both existing call sites
(`apps/vocab/src/routes/+page.svelte:62`,
`apps/tab-manager/src/lib/components/chat/AiChat.svelte:36`) pass nothing and are
untouched.

```ts
// packages/app-shell/src/agent-chat/agent-chat.svelte.ts
async function createConversation(options?: {
  /** A real title written at creation, so the first-message auto-title
   *  (which only overwrites 'New Chat') stays out of the way. */
  title?: string;
  /** One composed first user turn, sent after the handle is ready. */
  opening?: string;
}): Promise<ConversationId>;
```

Vocab's side is pure and testable:

```ts
// apps/vocab/src/lib/session.ts
/** What a composed session entry hands the chat registry. */
export type SessionOpening = { title: string; opening: string };

/** The learner accepted a proactive topic. Reads nothing from the saved pool. */
export function seedOpening(seed: ConversationSeed): SessionOpening;

/** The learner picked phrases to work on. The only path that reads the pool. */
export function practiceOpening(phrases: string[]): SessionOpening;
```

A blank session is `createConversation()` with no argument, exactly as today.

| Entry | Reads the pool | Title | Opening turn asks for |
| --- | --- | --- | --- |
| Type a turn | no | auto, from the learner's first message | nothing |
| Accept a seed | no | the seed's short topic name | a conversation about that topic, in the learner's voice |
| Practice a selection | yes, the chosen phrases only | `Practice: <first phrases>` | a scene that makes the learner produce the listed phrases, without the tutor saying them first |

Two properties hold across all three, and are worth writing tests for:

- **The opening turn is independent of the pool for seeds.** A seed's text is
  the same line whatever is saved. (The weaker true claim, worth stating in the
  test's name: a natural Chinese opener may happen to contain a phrase that is
  also in the pool. The claim is that the pool did not choose the line.)
- **No session writes anything back.** Nothing is marked practiced, nothing is
  auto-saved, no counter moves.

## Durable objects and refusals

Objects, all of which already exist:

| Object | Shape | Owner |
| --- | --- | --- |
| `conversations` row | canonical `{ title, model, createdAt, updatedAt }` | `@epicenter/chat`, unforked |
| conversation row document | one finished `AgentMessage` per key | the chat storage chain |
| `entries` row | `{ text, note, stage, createdAt }` | ADR-0102, unchanged |
| `showReadings` value | boolean, app default `true` | Vocab |

Refused, with the trigger that would reopen each:

| Refused | Why | Trigger |
| --- | --- | --- |
| A session, mode, kind, or intent column | A session entry is how you open a conversation, not a state you are in | A practice session measurably drifts back to generic tutoring within a few turns |
| A stored focus set, roster, or queue | Focus is a selection made at the moment of composition | None; storing it creates a second truth to reconcile |
| A `conversationId` provenance column on entries | ADR-0102 named this as a possible additive column; no shipped surface needs the answer yet | A surface genuinely needs "where did I meet this", and derived matching is not enough |
| `dueAt`, intervals, SRS, per-day new-phrase throttles | The conversation is the repetition | Never as scheduling |
| Exposure or production counters, streaks, due counts | ADR-0102 refusal, undisturbed | None |
| A stored gloss, dictionary, or CC-CEDICT | Meaning lives in the chat and in the human-owned note | None |
| Machine writes to `note` or a machine-set comfort mark | The pool is human-curated end to end | None |
| A `language` column, provider registry, script dispatch | The app is Chinese by construction (ADR-0195) | A second learning goal, which is a second app |
| A segmenter (`Intl.Segmenter` or dictionary-backed) | Capture is a human-drawn selection | Single-tap capture ergonomics chafe; then it is polish, not a capability |
| Routes for the three entries | Vocab has no URL seam | None |
| An extracted `@epicenter/chinese` package | One consumer is not a seam | A second app wants the same pool |

## Implementation waves

Each wave follows the same order: build the new path, stop the old imports,
verify, then delete. No wave leaves the app broken between commits.

### Wave 1: the session boundary

The only wave that is independently valuable on its own. It closes all three
consequences in Current State item 2 plus the defect in item 3.

1. **Build.** Add the optional `{ title?, opening? }` to `createConversation`
   in `packages/app-shell/src/agent-chat/agent-chat.svelte.ts:484`. Write the
   title into the `table.create` call instead of the literal `'New Chat'` when
   supplied; after `reconcileHandles()` and `selection.select(id)`, send
   `opening` through the new handle's `sendMessage` when supplied. The existing
   auto-title guard at `:394-396` needs no change: it only overwrites
   `'New Chat'`.
2. **Build.** Add `apps/vocab/src/lib/session.ts` with `practiceOpening`, moving
   the body of `buildPracticePrompt` into it and giving it a Chinese-aware
   title. Keep it pure.
3. **Switch.** Rewrite `practice()` in `apps/vocab/src/routes/+page.svelte:51-55`
   to `await chat.createConversation(practiceOpening(phrases))`, catching into
   `reportBackgroundError`. It never touches `chat.active`.
4. **Switch.** Retitle the `EntriesPanel` button so it says a session starts
   ("Practice in a new chat").
5. **Verify.** Typecheck both packages; run `apps/tab-manager` tests, since the
   shared seam moved.
6. **Delete.** Remove `apps/vocab/src/lib/practice.ts` and fold
   `practice.test.ts` into a `session.test.ts`.

### Wave 2: declare Chinese

Depends on Wave 1 landing first, so a behavior fix and a product repositioning
are not fused into one reviewable diff.

1. **Build.** Rewrite `VOCAB_SYSTEM_PROMPT` (`apps/vocab/vocab.ts:47-56`) as an
   explicitly Chinese-and-English tutor persona. It must keep the plain-text
   rule (no pinyin, romaji, or transliteration in the answer) verbatim: that
   rule is what keeps the message clean enough to be conversation memory and to
   yield verbatim entries. Add the light-steering sentence: the tutor follows
   the learner and may introduce useful language the way a conversation partner
   does, without turning the thread into a lesson.
2. **Build.** Let `session.ts` and `entry-candidates.ts` name Chinese directly.
   In `buildEntryCandidatePrompt`, "extract only spans in the language the
   learner is studying" becomes "extract only the Chinese spans, not the English
   used to explain them".
3. **Switch.** Update the `description` field in `apps/vocab/package.json` and
   the opening paragraph of `apps/vocab/README.md`.
4. **Verify.** Run `bun dev:vocab` and read three answers. This is a prompt
   change; no test asserts its content, and that is correct.

### Wave 3: proactive seeds

1. **Build.** Add `apps/vocab/src/lib/seeds.ts`: a small hand-written list of
   Chinese conversation openers, each a short topic name plus a first-person
   opening line. App-owned data, not a table, not a model call.
2. **Build.** Add `seedOpening` to `session.ts`.
3. **Build.** Surface two or three seeds where an empty or new thread is
   visible, as accept-to-start chips.
4. **Verify.** Accepting a seed opens a new conversation with that title and
   that first turn, and the saved pool is not consulted.

### Wave 4: collapse the reading path

Licensed by Wave 2's declaration.

1. **Build.** Rewrite `resolveRomanizer` in
   `apps/vocab/src/lib/readings/registry.ts` as a direct function: if the
   passage has Han and no kana or hangul, load `pinyin-pro` and return the
   pinyin romanizer; otherwise return the identity romanizer. Keep the lazy
   dynamic import and the one-load cache for the single provider. Keep the
   abstain guard: ADR-0105's "a missing reading beats a wrong one" invariant is
   preserved by ADR-0195, and dropping the guard would contradict it.
2. **Switch.** `ReadingMarkdown.svelte:19` is the only consumer of
   `resolveRomanizer` outside the folder and its call is unchanged.
3. **Verify.** `registry.test.ts` keeps its `resolveRomanizer` cases and drops
   its `composeRomanizers` block; `pinyin.test.ts` is untouched.
4. **Delete.** The files and dependencies listed below.

### Wave 5: stragglers

Cheap, independent, do whenever after Wave 1.

1. The stage control in `EntriesPanel.svelte:23-27` cycles `usable -> new`,
   turning ADR-0102's ordered ladder into a ring: demoting `understood` requires
   stepping forward through `usable`. Make the affordance match the data model.
2. `agent-chat.svelte.ts` exposes `get title()` with no setter while `model` has
   both (`:255`, `:281`). Title is the topic-return handle and the one a learner
   most wants to correct. Add the mirroring setter.
3. `apps/vocab/vocab.ts:76` and `:124` cite ADR-0046 as live authority for
   message storage. ADR-0046 is Superseded by ADR-0047. Walk the chain, confirm
   the current authority for finished-message storage, and re-cite it. Do not
   guess a number.

## Deletion prizes

Verified to have no consumer outside the deleted set:

| Path | Lines | Why it goes |
| --- | --- | --- |
| `apps/vocab/src/lib/readings/romaji.ts` | 34 | Japanese has no audience in a Chinese app |
| `apps/vocab/src/lib/readings/romaji.test.ts` | 36 | |
| `apps/vocab/src/lib/readings/cyrillic.ts` | 34 | Cyrillic likewise |
| `apps/vocab/src/lib/readings/cyrillic.test.ts` | 35 | |
| `apps/vocab/src/lib/readings/runs.ts` | 39 | Its only two importers are the two files above |
| `apps/vocab/src/lib/practice.ts` | 18 | Folded into `session.ts` |

Plus, inside `registry.ts`, the `ReadingProvider` type, the `readingProviders`
array, `loadOnce`, and `composeRomanizers`: roughly 60 of its 103 lines. Plus two
npm dependencies, `wanakana` and `transliteration`
(`apps/vocab/package.json`), neither used anywhere else in the monorepo.

Roughly 196 lines deleted outright, about 60 more collapsed, two dependencies
gone, and every prompt in the app gets to say Chinese.

## Verification

Automated, per wave:

```sh
bun run typecheck                 # from apps/vocab and packages/app-shell
bun test apps/vocab               # 6 test files today
bun test apps/tab-manager         # the other consumer of the shared chat seam
bun scripts/check-doc-hygiene.ts  # this spec must reference ADR-0195 while that ADR is Proposed
```

New assertions worth writing:

- `session.test.ts`: a seed's opening line is identical for an empty pool and a
  full one; a practice opening contains exactly the phrases passed in and
  nothing else from the pool; both produce a title that is not `'New Chat'`.
- `agent-chat` (or a Vocab-level test): `createConversation({ title })` produces
  a row whose title survives the first `sendMessage`, and
  `createConversation()` with no argument is byte-identical in behavior to
  today.

Manual, and not automatable:

- Start a practice session while a topic conversation is open. The topic thread
  is untouched, a new titled conversation appears in the sidebar, and switching
  back to the topic thread resumes it.
- Run two practice sessions. They have distinct titles and do not collide in the
  list.
- Read three ordinary answers and confirm the tutor stays conversational rather
  than drilling saved phrases. If it drills, the light-steering sentence in
  Wave 2 is too strong.

## Explicitly deferred

Named so nobody builds them by accident. Each needs a real trigger, not an
opportunity.

| Deferred | Trigger to reconsider |
| --- | --- |
| Adaptive SRS, spacing, `dueAt`, intervals, per-day throttles | None. Refused by ADR-0102 and ADR-0195; the conversation is the repetition |
| Gloss or dictionary storage (CC-CEDICT and friends) | None. Meaning lives in the chat and the human-owned note |
| A source-text corpus (imported articles, graded readers, a passage library) | A learner routinely pastes outside text in and wants it kept; that is a different app before it is a table here |
| A simulation or scenario catalog (stored role-play definitions) | A seed list that a learner actually curates and reorders. Until then a seed is a line of text, not a record |
| Aggressive steering controls (intensity sliders, drill modes, per-turn targets) | Practice measurably drifts back to generic tutoring, which is ADR-0195's named reopen trigger; the fix then is one intent column, not a control panel |
| Any generic materialization or session API | A second consumer. One app is not a seam |
| Transcript phrase highlighting (locating saved phrases in messages) | A surface that needs it. It is cheap in Chinese because the text is unspaced, but nothing in the destination asks for it yet |
| Simplified and traditional matching or normalization | A learner who reads both and misses matches. ADR-0102 stores text verbatim |
| Pronunciation: TTS, an STT round trip, tone scoring | The core loop is proven and a learner asks to speak |
| Renaming the app, package, or namespace | Never for `so.epicenter.vocab` without a deliberate replica break |

## Open questions

These need the user, not an implementer.

1. **Is the comfort mark still three rungs?** ADR-0102 fixes
   `stage: new | understood | usable`, an ordered ladder, and it drives which
   phrases the practice selection offers. The destination says phrases are
   "marked comfortable by the learner", which reads binary. Three rungs are
   preserved by default because ADR-0102 is Accepted and the filter has a real
   consumer. Collapsing to two is a data change and should not happen as a side
   effect of this work.
2. **Where do seeds come from, and do they need to rotate?** Wave 3 assumes a
   hand-written list picked without storing what was shown, so the same seed can
   reappear. If that grates, the cheap fix is per-device transient state, not a
   table. Model-generated seeds are a larger step and would put a network call
   in front of a blank thread.
3. **How should the composed opening turn render?** It is a real user turn, so
   the transcript stays a replayable memory, but the learner sees a line they
   did not type. A chip reads better than a bubble; that is a design call.
4. **Does practice honor the panel's stage filter, or always exclude the
   comfortable ones?** Today the filter drives the compiled set. Under the
   destination, "practice the ones I am not comfortable with yet" may be the
   only selection worth having.
