# Vocab becomes a Chinese conversation companion

**Date**: 2026-07-31
**Status**: In Progress
**Owner**: Braden (product direction), whoever executes the waves
**Branch**: `claude/vocab-chinese-adr-decision` carries the decision docs only; each implementation wave gets its own branch
**Records**: [ADR-0195](../docs/adr/0195-vocab-is-a-chinese-conversation-companion-and-every-intentional-session-is-a-new-conversation.md), which amends [ADR-0105](../docs/adr/0105-vocab-is-a-multilingual-tutor-and-readings-are-a-client-side-derived-view.md)

## One Sentence

Vocab stops being a language-blind multilingual tutor with a vocabulary sidebar
bolted on, and becomes a chat-first Chinese conversation companion where every
intentional session is a new conversation opened with a composed first turn.

## Status in one paragraph

The product decision is **accepted** (ADR-0195). The implementation is **one
wave of five done**. Wave 1, the session boundary, is implemented in
`27920a0993` (shared chat seam) and `3d91ab7f41` (Vocab caller). Waves 2
through 5, the Chinese declaration, proactive seeds, the reading-path collapse,
and the stragglers, are **not built on any branch this spec governs**. Nothing
below claims otherwise, and no wave should be marked done here without the
commit that did it.

**Read this before writing a line of Wave 2.** An implementation of Waves 2
through 5 already exists on the local branch `claude/vocab-chinese-waves-2-5`
(`4cf70ca922..41c3db74d5`, unpushed): it declares Chinese in every composed
prompt, adds a seed list and blank-thread topics, collapses the reading folder
to one module, and sweeps the stragglers. That branch also carries **its own
ADR-0195 commit** (`4cf70ca922`), which duplicates the one this spec records, so
the two lanes cannot both land as written. The next step is almost certainly to
reconcile that branch onto this decision and drop its duplicate ADR commit, not
to rebuild the waves from these instructions. Read its diff first, and treat the
wave descriptions below as the acceptance criteria for that branch rather than
as a build order.

**Where Wave 1 actually lives, because it changes how the next PR is opened.**
Those two commits are not on `origin/main`. They sit on a local unpushed chain
that this branch and several sibling branches share. So a Wave 2 branch cut from
`origin/main` will not have the composed opener, and a Wave 2 PR opened against
`origin/main` from this ancestry will drag roughly forty unrelated commits into
its diff. Push Wave 1 first, or cut Wave 2 from whatever branch carries it and
say so in the PR.

## Recognition sentence

> I open Vocab to have a Chinese conversation, and anything I want to become
> comfortable using can naturally become material for a future conversation.

Everything below is judged against that sentence. A change that does not serve
it is out of scope.

## Current state

Verified against this branch, not inherited from an earlier draft.

```txt
apps/vocab/
  vocab.ts                              # Lens, VOCAB_MODEL, VOCAB_SYSTEM_PROMPT, entriesTable
  src/lib/
    application.ts                      # openVocabApplication: replica + bound Lens + entries state
    practice.ts                (64)     # buildPracticeOpening(entryTexts) -> { title, opening }
    entry-candidates.ts                 # extract savable spans from a settled message
    state/entries.svelte.ts             # the one entry pool: save / setStage / setNote / remove
    readings/
      registry.ts              (103)    # ReadingProvider, readingProviders[], loadOnce, composeRomanizers, resolveRomanizer
      pinyin.ts                (74)     # Chinese, abstains on kana/hangul
      romaji.ts                (34)     # Japanese kana
      cyrillic.ts              (34)     # Cyrillic
      runs.ts                  (39)     # shared run walker; importers are romaji + cyrillic only
  src/routes/
    +page.svelte                        # createAgentChatState, readings toggle, practice()
    components/
      ConversationView.svelte           # thread, selection capture, candidate extraction
      EntriesPanel.svelte               # pool list, stage filter, "Practice in a new chat"
      VocabSidebar.svelte               # conversation list + EntriesPanel
      ReadingMarkdown.svelte            # settled message + reading overlay
```

What is right today and stays: the entry pool and its shape (ADR-0102), the
reading overlay as a derived view over clean text (ADR-0105), selection capture,
candidate extraction, the canonical conversations shape, and the client agent
loop.

**Landed: the session boundary.** `createConversation` in
`packages/app-shell/src/agent-chat/agent-chat.svelte.ts` takes a
`ConversationOpener` (`{ title?, opening? }`), writes the real title at row
creation, and sends the opening turn through the new handle only after the
handle exists. `practice()` in `apps/vocab/src/routes/+page.svelte` awaits it and
reports failures rather than discarding the promise; it never touches
`chat.active`. Both existing call sites that pass nothing are unchanged.

**Not landed, and the reason this spec is still open:**

1. **The tutor cannot name the language it teaches.** `VOCAB_SYSTEM_PROMPT`
   (`apps/vocab/vocab.ts`) tells the model to infer the studied language and to
   follow language switches. `buildPracticePrompt` in
   `apps/vocab/src/lib/practice.ts` and `buildEntryCandidatePrompt` in
   `apps/vocab/src/lib/entry-candidates.ts` are each written to hold no
   language-specific string, and each is vaguer for it. The package
   `description` still reads "Multilingual chat tutor with a deterministic
   client-side reading overlay".
2. **Nothing offers the learner a way in.** There is no proactive seed. A blank
   thread is the whole invitation.
3. **The reading path still dispatches across three scripts.**
   `apps/vocab/src/lib/readings/registry.ts` carries a provider type, an ordered
   array, a load cache, and a composer for an app that will read one script.
   `wanakana` and `transliteration` are in `apps/vocab/package.json` and are
   imported nowhere else in the monorepo.

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
stored intent. The thread view is the same component in all three cases. Of the
three, "type a turn" and "practice a selection" exist today; "accept a seed" is
Wave 3.

## Ownership

| Concern | Owner | Note |
| --- | --- | --- |
| Conversation creation, titling, the loop | `packages/app-shell/src/agent-chat/agent-chat.svelte.ts` | Already gained the optional opener; no further shape change |
| What a composed opening turn says | `apps/vocab/src/lib/practice.ts` | Pure functions, no I/O, no state |
| The curated conversation seeds | Vocab app code, module named by whoever builds Wave 3 | A list of Chinese conversation openers, app-owned data |
| The Chinese tutor persona | `apps/vocab/vocab.ts` | App constant, alongside `VOCAB_MODEL` |
| The saved pool and its writes | `apps/vocab/src/lib/state/entries.svelte.ts` | Unchanged; ADR-0102 shape |
| The single pinyin overlay | `apps/vocab/src/lib/readings/pinyin.ts` | Keeps its kana/hangul abstain guard |
| Wiring the entries to the chat | `apps/vocab/src/routes/+page.svelte` | Calls the composers, awaits the create |

## Session-entry contracts

The shared seam is done and is not reopened by any remaining wave:

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

Vocab's side is pure and testable. `buildPracticeOpening(entryTexts)` already
returns the `{ title, opening }` pair. A seed is the same pair, so Wave 3 decides
whether it needs a composing function at all or whether a seed is literally a
`ConversationOpener` the accept handler passes through; that call belongs to the
wave, not to this spec.

A blank session is `createConversation()` with no argument, exactly as today.

| Entry | Reads the pool | Title | Opening turn asks for |
| --- | --- | --- | --- |
| Type a turn | no | auto, from the learner's first message | nothing |
| Accept a seed | no | the seed's short topic name | a conversation about that topic, in the learner's voice |
| Practice a selection | yes, the chosen phrases only | `Practice: <first phrases>` | a passage that puts the listed phrases in context |

Two properties hold across all three and are worth asserting in tests:

- **A seed's opening turn is independent of the pool.** The weaker true claim,
  worth putting in the test's name: a natural Chinese opener may happen to
  contain a phrase that is also saved. The claim is that the pool did not choose
  the line.
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

Each wave follows the same order: build the new path, stop the old imports,
verify, then delete. No wave leaves the app broken between commits.

### Wave 1: the session boundary (landed)

Commits `27920a0993` (shared chat seam) and `3d91ab7f41` (Vocab caller), both on
`main`. The implementation kept `apps/vocab/src/lib/practice.ts` and its
`buildPracticeOpening` rather than introducing a new one-function module, and
the `EntriesPanel` button now reads "Practice in a new chat".

Two decisions this wave settled, so a later wave does not relitigate them: the
opening turn is sent through the new handle after selection, never before, and a
failure to acquire the conversation surfaces through `reportBackgroundError`
like every other background chat failure.

### Wave 2: declare Chinese (next)

The smallest next PR, and the one every later wave depends on.

1. **Build.** Rewrite `VOCAB_SYSTEM_PROMPT` (`apps/vocab/vocab.ts`) as an
   explicitly Chinese-and-English tutor persona. Keep the plain-text rule (no
   pinyin, romaji, or transliteration in the answer) verbatim: that rule is what
   keeps the message clean enough to be conversation memory and to yield
   verbatim entries. Add the light-steering sentence: the tutor follows the
   learner and may introduce useful language the way a conversation partner
   does, without turning the thread into a lesson.
2. **Build.** Let `apps/vocab/src/lib/practice.ts` and
   `apps/vocab/src/lib/entry-candidates.ts` name Chinese directly, and delete
   the "deliberately language-neutral" paragraphs in both file headers, which
   document a rule this wave withdraws. In `buildEntryCandidatePrompt`, "extract
   only spans in the language the learner is studying" becomes "extract only the
   Chinese spans, not the English used to explain them".
3. **Switch.** Update the `description` in `apps/vocab/package.json` and the
   opening paragraph of `apps/vocab/README.md`.
4. **Verify.** Typecheck. `apps/vocab/src/lib/practice.test.ts` and
   `apps/vocab/src/lib/entry-candidates.test.ts` must stay green; a prompt
   rewrite that breaks the candidate parser tests means the parser was reading
   the prompt's shape, which it should not.
5. **Verify, manual.** Run `bun dev:vocab` and read three answers. This is a
   prompt change and no test asserts its content, which is correct.

### Wave 3: proactive seeds

1. **Build.** Add a small hand-written list of Chinese conversation openers,
   each a short topic name plus a first-person opening line. App-owned data, not
   a table, not a model call.
2. **Build.** Wire accept-to-start chips where an empty or new thread is
   visible.
3. **Verify.** Accepting a seed opens a new conversation with that title and
   that first turn, and the saved pool is not consulted.

Known rough edge to resolve inside this wave, not after it: the app creates a
blank conversation at boot, so accepting a seed leaves that empty conversation
behind in the list. Decide whether the seed reuses the blank one or the blank
one is not created until the learner types.

### Wave 4: collapse the reading path

Licensed by Wave 2's declaration. Do not start it before Wave 2 lands, or the
deletion has no recorded justification in the tree.

1. **Build.** Replace the registry in `apps/vocab/src/lib/readings/registry.ts`
   with a direct `resolveRomanizer`: if the passage has Han and no kana or
   hangul, load `pinyin-pro` and return the pinyin romanizer; otherwise return
   the identity romanizer. Keep the lazy dynamic import and the one-load cache.
   Keep the abstain guard: ADR-0105's "a missing reading beats a wrong one"
   invariant is preserved by ADR-0195, and dropping the guard would contradict
   it. Whether the folder collapses to a single module is the implementer's
   call; `resolveRomanizer` is the only name that must survive.
2. **Switch.** `apps/vocab/src/routes/components/ReadingMarkdown.svelte` is the
   only importer of `resolveRomanizer` outside the folder, and its call is
   unchanged.
3. **Verify.** `apps/vocab/src/lib/readings/registry.test.ts` keeps its
   `resolveRomanizer` cases and drops its `composeRomanizers` block;
   `apps/vocab/src/lib/readings/pinyin.test.ts` is untouched.
4. **Delete.** The files and dependencies listed below.

### Wave 5: stragglers

Cheap, independent, do whenever after Wave 1.

1. The stage control in `apps/vocab/src/routes/components/EntriesPanel.svelte`
   cycles `usable -> new`, turning ADR-0102's ordered ladder into a ring:
   demoting `understood` means stepping forward through `usable`. Make the
   affordance match the data model.
2. `packages/app-shell/src/agent-chat/agent-chat.svelte.ts` exposes `get title()`
   with no setter while `model` has both. Title is the topic-return handle and
   the one a learner most wants to correct. Add the mirroring setter **with its
   consumer** (a rename affordance in the sidebar); a setter alone is a surface
   with no producer. Note the test-harness limit before writing assertions:
   `agent-chat.svelte.test.ts` shims `$derived` to a single evaluation, so a
   handle cannot observe its own row changing mid-test, which makes a
   rename-versus-auto-title interaction untestable there.
3. `apps/vocab/vocab.ts` cites ADR-0046 as live authority for message storage in
   two places. ADR-0046 and ADR-0043 are both Superseded by ADR-0047, and
   nothing supersedes ADR-0047, so **ADR-0047 is the citation to use**.
4. The `STAGE_FILTERS` comment in `EntriesPanel.svelte` still calls the button
   "Practice these"; the button now reads "Practice in a new chat".

## Deletion prizes

Verified on this branch to have no consumer outside the deleted set:

| Path | Lines | Why it goes |
| --- | --- | --- |
| `apps/vocab/src/lib/readings/romaji.ts` | 34 | Japanese has no audience in a Chinese app |
| `apps/vocab/src/lib/readings/romaji.test.ts` | 36 | |
| `apps/vocab/src/lib/readings/cyrillic.ts` | 34 | Cyrillic likewise |
| `apps/vocab/src/lib/readings/cyrillic.test.ts` | 35 | |
| `apps/vocab/src/lib/readings/runs.ts` | 39 | Its only two importers are the two files above |

That is 178 lines deleted outright. Inside `registry.ts`, the `ReadingProvider`
type, the `readingProviders` array, `loadOnce`, and `composeRomanizers` collapse
roughly 60 of its 103 lines, and `registry.test.ts` loses its
`composeRomanizers` block. Two npm dependencies go with them, `wanakana` and
`transliteration` in `apps/vocab/package.json`, neither imported anywhere else
in the monorepo.

## Verification

Automated, per wave:

```sh
bun run typecheck                 # from apps/vocab and packages/app-shell
bun test apps/vocab               # 6 test files today
bun test apps/tab-manager         # the other consumer of the shared chat seam
bun run check:doc-hygiene         # the two-state spec lifecycle
bun run check:doc-paths           # file paths cited in docs/ must exist
```

Manual, and not automatable. Each needs a credentialed model endpoint and a
browser, which is why none of it is claimed here:

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
| A simulation or scenario catalog (stored role-play definitions) | A seed list a learner actually curates and reorders. Until then a seed is a line of text, not a record |
| Aggressive steering controls (intensity sliders, drill modes, per-turn targets) | Practice measurably drifts back to generic tutoring, ADR-0195's named reopen trigger; the fix then is one intent column, not a control panel |
| Any generic materialization or session API | A second consumer. One app is not a seam |
| Transcript phrase highlighting (locating saved phrases in messages) | A surface that needs it. It is cheap in Chinese because the text is unspaced, but nothing in the destination asks for it |
| Simplified and traditional matching or normalization | A learner who reads both and misses matches. ADR-0102 stores text verbatim |
| Pronunciation: TTS, an STT round trip, tone scoring | The core loop is proven and a learner asks to speak |
| Collapsing the comfort mark to two rungs | ADR-0102 fixes three ordered stages and the filter has a real consumer. This is a data change; it must not happen as a side effect of this work |
| Renaming the app, package, or namespace | Never for `so.epicenter.vocab` without a deliberate replica break |

## Open questions

These need the user, not an implementer. None of them blocks Wave 2.

1. **Where do seeds come from, and do they need to rotate?** Wave 3 assumes a
   hand-written list picked without storing what was shown, so the same seed can
   reappear. If that grates, the cheap fix is per-device transient state, not a
   table. Model-generated seeds are a larger step and would put a network call
   in front of a blank thread.
2. **How should the composed opening turn render?** It is a real user turn, so
   the transcript stays a replayable memory, but the learner sees a line they
   did not type. A chip may read better than a bubble; that is a design call, and
   ADR-0195 deliberately does not make it.
3. **Does practice honor the panel's stage filter, or always exclude the
   comfortable ones?** Today the filter drives the compiled set. Under the
   destination, "practice the ones I am not comfortable with yet" may be the only
   selection worth having.
4. **Does accepting a seed reuse the boot-created blank conversation?** Wave 3
   must answer this to avoid littering the list; the answer is a product call
   about whether a blank conversation exists before the learner acts.

Delete this spec once the waves land and the questions settle. Its durable half
already lives in ADR-0195.
