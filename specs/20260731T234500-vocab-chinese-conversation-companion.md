# Vocab becomes a Chinese conversation companion

**Date**: 2026-07-31
**Status**: In Progress
**Owner**: Braden (product direction), whoever executes the waves
**Branch**: `claude/vocab-chinese-implementation-integration`; all five waves are
implemented and committed locally. What is left is the manual verification this
environment cannot run and the open questions at the bottom, which need the
user. Once those settle the spec is spent and should be deleted, since ADR-0195
already holds the durable decision.
**Records**: [ADR-0195](../docs/adr/0195-vocab-is-a-chinese-conversation-companion-and-every-intentional-session-is-a-new-conversation.md), which amends [ADR-0105](../docs/adr/0105-vocab-is-a-multilingual-tutor-and-readings-are-a-client-side-derived-view.md)

## One Sentence

Vocab stops being a language-blind multilingual tutor with a vocabulary sidebar
bolted on, and becomes a chat-first Chinese conversation companion where every
intentional session is a new conversation opened with a composed first turn.

## How to read this spec

```txt
Read first:
  One Sentence
  State after the waves
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

The product destination is settled and recorded in ADR-0195. This spec was the
path from the code that existed to that destination. Every wave has now landed;
each wave below records what was built and, where it differs, why the built
shape is not the planned one.

## Recognition sentence

> I open Vocab to have a Chinese conversation, and anything I want to become
> comfortable using can naturally become material for a future conversation.

Everything below is judged against that sentence. A change that does not serve
it is out of scope.

## State after the waves

```txt
apps/vocab/
  vocab.ts                              # Lens, VOCAB_MODEL, VOCAB_SYSTEM_PROMPT (Chinese), entriesTable
  src/lib/
    application.ts                      # openVocabApplication: replica + bound Lens + entries state
    session.ts          (73)            # SessionOpening; practiceOpening(entryTexts)
    seeds.ts            (86)            # CONVERSATION_SEEDS: SessionOpening[]; sampleSeeds(count)
    entry-candidates.ts (95)            # extract savable Chinese spans from a settled message
    readings.ts         (98)            # createPinyinRomanizer + resolveRomanizer, one lazy import
    state/entries.svelte.ts             # the one entry pool: save / setStage / setNote / remove
  src/routes/
    +page.svelte                        # createAgentChatState, readings toggle, openSession()
    components/
      ConversationView.svelte           # thread, selection capture, candidates, seed chips
      EntriesPanel.svelte               # pool list, stage filter, stage ladder, "Practice in a new chat"
      VocabSidebar.svelte               # conversation list with rename + EntriesPanel
      ReadingMarkdown.svelte            # settled message + pinyin overlay
```

What was right before this work and is untouched: the entry pool and its shape
(ADR-0102), the reading overlay as a derived view over clean text (ADR-0105),
selection capture, candidate extraction, the canonical conversations shape, and
the client agent loop.

Four things were wrong, and they were the reason for this spec. All four are
now closed.

**1. The tutor could not name the language it teaches.** Closed by Wave 2.
`VOCAB_SYSTEM_PROMPT` is a Chinese-and-English conversation persona,
`practicePrompt` asks for a Chinese passage and an English explanation, and
`buildEntryCandidatePrompt` asks for the Chinese spans. The package
`description` and the README say Chinese.

**2. Practice had no session boundary.** Closed by Wave 1. Practice awaits
`chat.createConversation(practiceOpening(phrases))`, creating a separate titled
conversation and leaving the active topic untouched. The implementation landed
in `27920a0993` (shared chat seam) and `3d91ab7f41` (Vocab caller).

**3. An async creation defect on that same path.** Closed by Wave 1. The
opening is sent only after the new handle is selected, and the caller reports
failures rather than discarding the promise. Tests cover the awaited creation
path and the composed title/opening contract.

**4. Nothing offered the learner a way in.** Closed by Wave 3. An empty thread
offers three topic chips drawn from a hand-written seed list; accepting one
opens its own titled conversation.

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
| Conversation creation, titling, the loop | `packages/app-shell/src/agent-chat/agent-chat.svelte.ts` | Gained the optional opener (Wave 1) and the `title` setter (Wave 5); no other shape change |
| What each session entry's opening turn says | `apps/vocab/src/lib/session.ts` | Pure functions, no I/O, no state |
| The curated conversation seeds | `apps/vocab/src/lib/seeds.ts` | A list of Chinese conversation openers, app-owned |
| The Chinese tutor persona | `apps/vocab/vocab.ts` | App constant, alongside `VOCAB_MODEL` |
| The saved pool and its writes | `apps/vocab/src/lib/state/entries.svelte.ts` | Unchanged; ADR-0102 shape |
| The single pinyin overlay | `apps/vocab/src/lib/readings.ts` | Keeps its kana/hangul abstain guard |
| Wiring the three entries to the chat | `apps/vocab/src/routes/+page.svelte` | Calls the composers, awaits the create |

## Session-entry contracts

The shared seam gained exactly one optional argument. Both pre-existing call
sites (`apps/vocab/src/routes/+page.svelte`,
`apps/tab-manager/src/lib/components/chat/AiChat.svelte`) pass nothing and are
untouched.

```ts
// packages/app-shell/src/agent-chat/agent-chat.svelte.ts
export type ConversationOpener = {
  /** A real title written at creation, so the first-message auto-title
   *  (which only overwrites the untitled placeholder) stays out of the way. */
  title?: string;
  /** One composed first user turn, sent after the handle is ready. */
  opening?: string;
};
async function createConversation(opener?: ConversationOpener): Promise<ConversationId>;
```

Vocab's side is pure and testable:

```ts
// apps/vocab/src/lib/session.ts
/** What a composed session entry hands the chat registry. */
export type SessionOpening = { title: string; opening: string };

/** The learner picked phrases to work on. The only path that reads the pool. */
export function practiceOpening(phrases: string[]): SessionOpening;

// apps/vocab/src/lib/seeds.ts
/** The hand-written topic openers. A seed IS a SessionOpening. */
export const CONVERSATION_SEEDS: readonly SessionOpening[];

/** Draw distinct seeds to offer on a blank thread. */
export function sampleSeeds(count: number): SessionOpening[];
```

**Built differently from the plan:** there is no `seedOpening(seed)`. A seed is
written as a title and an opening line already, so a composer for it would have
been the identity function; accepting a seed is `createConversation(seed)`. That
leaves `session.ts` owning the shared type and the one entry that genuinely has
to compose, which is why the module took the general name rather than staying
`practice.ts`.

A blank session is `createConversation()` with no argument, exactly as before.

| Entry | Reads the pool | Title | Opening turn asks for |
| --- | --- | --- | --- |
| Type a turn | no | auto, from the learner's first message | nothing |
| Accept a seed | no | the seed's short topic name | a conversation about that topic, in the learner's voice |
| Practice a selection | yes, the chosen phrases only | `Practice: <first phrases>` | a passage or dialogue that puts the listed phrases in context at the learner's level, then a short English explanation of the tricky parts |

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
| conversation row document | one finished `AgentMessage` per key | the chat storage chain (ADR-0047) |
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
| Routes for the three entries | Vocab keeps the active conversation in internal state, not the URL | None |
| An extracted Chinese-specific package | One consumer is not a seam | A second app wants the same pool |

## Implementation waves

Each wave followed the same order: build the new path, stop the old imports,
verify, then delete. No wave left the app broken between commits.

### Wave 1: the session boundary (landed)

`27920a0993` (shared chat seam) and `3d91ab7f41` (Vocab caller).

`createConversation` took an optional `ConversationOpener` (`{ title?, opening? }`):
the title is written into `table.create` in place of the `'New Chat'` literal,
and the opening is sent through the new conversation's own handle after
`reconcileHandles()` and `selection.select(id)`. The auto-title guard needed no
change, since it only overwrites the placeholder. `practice()` awaits the create
and reports failures rather than discarding the promise, and never touches
`chat.active`. The `EntriesPanel` button says "Practice in a new chat".

**Built differently:** the composer stayed in `practice.ts` rather than moving
to a one-function `session.ts`, which was correct at the time; Wave 3 renamed it
once seeds gave the module a second reason to exist.

### Wave 2: declare Chinese (landed)

`8912aa5c97`.

`VOCAB_SYSTEM_PROMPT` is a Chinese-and-English conversation persona carrying the
light-steering rule, with the plain-text rule kept verbatim. The practice opening
asks for a Chinese passage and an English explanation; `buildEntryCandidatePrompt`
asks for the Chinese spans, not the English used to explain them. The package
`description` and the README say Chinese.

**Built differently:** the two tests asserting the prompts name no language were
deleted rather than inverted. They encoded the withdrawn decision, and the
replacement claim would have been prompt prose rather than a contract. The README
was rewritten rather than patched at the opening paragraph: it still described a
`vocabWorkspace`, a `conversation.svelte.ts`, and a `recorder.svelte.ts` that no
longer exist, and half-correcting it would have been worse than either extreme.

**Not verified here:** the manual read of three answers. See Verification.

### Wave 3: proactive seeds (landed)

`36d59c2eed`.

`seeds.ts` holds eight hand-written topic openers, each a short English title and
a first-person opening line that starts in Chinese and names the level in
English. `sampleSeeds(3)` draws distinct seeds, unrecorded, and
`ConversationView`'s empty state offers them as chips. Accepting one calls the
same `openSession()` that Practice calls.

**Built differently:** there is no `seedOpening()`; see Session-entry contracts
above. `practice.ts` became `session.ts` and `buildPracticeOpening` became
`practiceOpening`, since the module now owns the shared `SessionOpening` type
rather than practice alone.

### Wave 4: collapse the reading path (landed)

`0a2e060e25`.

`resolveRomanizer` is a direct function: a passage with Han and no kana or
hangul resolves the lazily imported pinyin romanizer, everything else resolves
`identityRomanizer`. One module-level promise is the load cache. The abstain
guard is preserved at both altitudes, and `ReadingMarkdown`'s call is unchanged
apart from its import path.

**Built differently:** the whole `readings/` folder collapsed into one
`readings.ts` rather than keeping a `registry.ts` that no longer holds a
registry. `registry.test.ts` and `pinyin.test.ts` merged into `readings.test.ts`,
which gained two cases the split files could not state: that a kana-bearing
passage resolves to identity end to end, and that the resolved romanizer is
shared rather than rebuilt per message.

### Wave 5: stragglers (landed)

`732e6298c0`, `3d5c2727f4`, `df8315ae9e`, then the sweeps `be80b20e67` and
`e35fc44070`.

1. The stage control is a `select` over the three rungs in order, replacing the
   button that cycled `usable -> new` and turned ADR-0102's ladder into a ring.
2. `agent-chat.svelte.ts` gained `set title`, mirroring `model`. It landed with
   a consumer rather than alone: double-click a conversation row in the Vocab
   sidebar to rename it, commit on Enter or blur, restore on Escape, empty
   refused at the call site.
3. `vocab.ts` cites ADR-0047 for finished-message storage and for answering in
   the client. The chain is ADR-0043 and ADR-0046, both Superseded by ADR-0047,
   which is Accepted and carries both decisions forward; no later ADR supersedes
   it. The older numbers are kept only where they say what changed.
4. The first sweep fixed two JSDoc links the rename broke, the stage list
   restated beside the stage filter, a seed draw whose bound was computed before
   the pool shrank, and a missing file-map entry.
5. The second sweep caught two comments the first missed: `+page.svelte` still
   described the injected persona as "one general multilingual system prompt"
   while the constant it injects is a Chinese tutor, and `EntriesPanel.svelte`
   still named the compiled set after the old "Practice these" button label.
   Both were listed as acceptance criteria here and neither had been done.

## Deletion prizes

Verified by repo-wide search to have no consumer outside the deleted set:

| Path | Lines | Why it went |
| --- | --- | --- |
| `apps/vocab/src/lib/readings/registry.ts` | 103 | The registry had one permanent entry |
| `apps/vocab/src/lib/readings/registry.test.ts` | 53 | |
| `apps/vocab/src/lib/readings/pinyin.ts` | 74 | Folded into `readings.ts` |
| `apps/vocab/src/lib/readings/romaji.ts` | 34 | Japanese has no audience in a Chinese app |
| `apps/vocab/src/lib/readings/romaji.test.ts` | 36 | |
| `apps/vocab/src/lib/readings/cyrillic.ts` | 34 | Cyrillic likewise |
| `apps/vocab/src/lib/readings/cyrillic.test.ts` | 35 | |
| `apps/vocab/src/lib/readings/runs.ts` | 39 | Its only two importers were the two providers above |

415 lines deleted against 121 added across the reading path, so the overlay is
294 lines lighter and lives in one file. Two npm dependencies are gone,
`wanakana` and `transliteration`, confirmed unused everywhere else in the
monorepo before removal. Every prompt in the app now says Chinese.

## Verification

Automated, all run green on this branch after the reconciliation:

```sh
bun test apps/vocab                         # 40 pass, 4 files
bun test packages/app-shell                 # 8 pass, 2 files
bun test apps/tab-manager                   # 13 pass, the other consumer of the shared seam
bun run --cwd apps/vocab typecheck          # 1851 files, 0 errors
bun run --cwd packages/app-shell typecheck  # 1664 files, 0 errors
bun run check:doc-hygiene                   # the two-state spec lifecycle
bun run check:doc-paths                     # file paths cited in docs/ must exist
```

Assertions written:

- `seeds.test.ts`: every seed opens a titled conversation with a first turn, no
  seed title is `'New Chat'`, titles are distinct, and every opening line is
  actually Chinese. `sampleSeeds` draws distinct seeds, only from the committed
  list, and returns the whole list rather than looping when asked for more.
- `readings.test.ts`: the abstain guard holds end to end (a kana- or
  hangul-bearing passage resolves to identity, Han and all), and the resolved
  romanizer is shared rather than rebuilt per message.
- `agent-chat.svelte.test.ts`: renaming a conversation writes the new title to
  its row.

The planned "a seed's opening line is identical for an empty pool and a full
one" assertion was not written, because the built shape makes it untypable: a
seed is static data and `sampleSeeds` takes only a count, so there is no pool
argument to vary. Independence is structural, not asserted.

The planned "the auto-title does not reclaim a renamed title" assertion was
attempted and dropped. The registry's tests shim `$derived` to a single
evaluation, so a handle cannot observe its own row changing mid-test; the same
guard is already covered by "a supplied title survives the opening turn".

Manual, and not run here. This environment has no credentialed model endpoint
and no browser session, so none of the following was exercised:

- Read three ordinary answers and confirm the tutor stays conversational rather
  than drilling saved phrases. If it drills, the light-steering sentence in
  Wave 2 is too strong. Closest evidence available: the prompt text itself.
- Accept a seed and confirm it opens a new titled conversation with that first
  turn while the current thread is untouched.
- Start a practice session while a topic conversation is open. The topic thread
  is untouched, a new titled conversation appears in the sidebar, and switching
  back to the topic thread resumes it.
- Run two practice sessions. They have distinct titles and do not collide in the
  list.
- Rename a conversation by double-clicking its row, and confirm Escape discards
  the edit while Enter and blur commit it.

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
| Collapsing the comfort mark to two rungs | ADR-0102 fixes three ordered stages and the filter has a real consumer. This is a data change; it must not happen as a side effect of this work |
| Renaming the app, package, or namespace | Never for `so.epicenter.vocab` without a deliberate replica break |

## Open questions

These need the user, not an implementer. None of them blocks review of this
branch.

1. **Where do seeds come from, and do they need to rotate?** Wave 3 shipped a
   hand-written list of eight, drawn from at random and never recorded, so the
   same seed can reappear. If that grates, the cheap fix is per-device transient
   state, not a table. Model-generated seeds are a larger step and would put a
   network call in front of a blank thread. The list itself is also a taste
   call: eight topics chosen by an implementer, not by the person who will use
   them.
2. **How should the composed opening turn render?** It is a real user turn, so
   the transcript stays a replayable memory, but the learner sees a line they
   did not type. Today it renders as an ordinary sent bubble. A chip reads
   better; that is a design call and nothing built here forecloses it.
3. **Does practice honor the panel's stage filter, or always exclude the
   comfortable ones?** Today the filter drives the compiled set. Under the
   destination, "practice the ones I am not comfortable with yet" may be the
   only selection worth having.
4. **Does a taken seed leave litter?** Boot auto-creates a conversation when the
   list is empty, and that is where the seed chips are shown, so accepting a
   seed leaves the blank conversation behind and opens a second one. This
   follows the decision that every intentional session opens a new conversation,
   and it is the same litter an unused "New Conversation" click already makes,
   so nothing special-cases it. If it grates in use, the honest fixes are
   reaping empty untitled conversations or sending a seed into an empty active
   thread and titling it; the second is a narrowing of the rule and belongs in
   ADR-0195, not in a component.

Delete this spec once the manual verification passes and the questions settle.
Its durable half already lives in ADR-0195.
