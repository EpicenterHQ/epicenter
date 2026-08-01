# Chinese tutor: session-intent prototype

A throwaway prototype of one interaction model. Not a product, not wired to
Epicenter, and not a place to grow features. It exists to answer one question:

> If chat is the default surface and Conversation, Practice, and Revisit are
> alternate ways into the same chat, does that survive contact with code, or do
> the three surfaces quietly become three engines?

The answer here is that it survives, and the seam that makes it survive is
narrow enough to state in one sentence: **an entry surface produces a seed, and
the engine consumes seeds.** Everything else follows.

Run it:

```sh
bun test          # 48 tests
bun run typecheck
```

## The shape

```ts
// A surface decides what a session is given.
openSession(request: SessionRequest, sources: SessionSources): SessionSeed

type SessionRequest =
  | { intent: 'chat' }                                  // the default surface
  | { intent: 'conversation' }
  | { intent: 'practice'; cap?: number }
  | { intent: 'revisit'; topic?: string; cap?: number }

type SessionSources = { phrases: SavedPhrase[]; sessions: PastSession[] }

type SessionSeed = {
  intent: SessionIntentName
  systemPrompt: string      // tutor persona + at most one session block
  opening: string | null    // a seeded first user turn, or null for chat-first
  focus: SavedPhrase[]      // the capped target set, empty for chat and conversation
  revisited: PastSession[]  // what the excerpt was drawn from
}

// The engine consumes seeds and knows nothing else about surfaces.
createTutorSession({ seed, model, store, generateId, now }): TutorSession

// The overlays are pure functions over clean text. Nothing is stored.
renderMessage(text: string, options?: RenderOptions): RenderedToken[]
```

`src/tutor.ts` imports `SessionSeed` and nothing else from the session layer.
There is no `intent` branch in it, and no hook where one could be added
inconspicuously. That is the whole structural argument, and
`test/intent-isolation.test.ts` holds it in place: feed two different seeds the
same user turn and every recorded model request is identical except the system
prompt.

## Files

| File | What it owns |
| --- | --- |
| `src/saved.ts` | The two shared pools: `SavedPhrase` (ADR-0102's shape, verbatim) and `PastSession`. |
| `src/focus.ts` | Which phrases go in play, and the per-intent caps. A selector, never a scheduler. |
| `src/revisit.ts` | Compiling prior sessions into a capped excerpt. |
| `src/prompt.ts` | The tutor persona plus one block per intent. |
| `src/session.ts` | The four openings. The only place surfaces differ. |
| `src/tutor.ts` | The one conversation engine. |
| `src/render.ts` | Derived pinyin and optional phrase highlighting. |

## What the tests actually claim

- **Prompt composition** (`test/prompt.test.ts`): every opening composes onto the
  same persona; an empty pool degrades Practice and Revisit to plain chat rather
  than shipping an empty target list.
- **Intent isolation** (`test/intent-isolation.test.ts`): a prompt carries at
  most one `## This session:` block and never another opening's; a phrase only
  Practice can reach never appears in another surface's prompt; the engine
  produces identical requests across intents modulo the system prompt.
- **Focus caps** (`test/focus.test.ts`): caps are enforced in code, selection is
  pure and leaves the pool unchanged, and a zero or negative cap yields nothing
  rather than throwing.
- **Deterministic rendering** (`test/render.test.ts`): same message, same tokens;
  tokens concatenate back to the message under every combination of overlays;
  after a driven session the store still holds exactly the clean text the tutor
  wrote.

## Design tradeoffs, taken deliberately

**Chat and Conversation are separate surfaces, and the prototype makes the
difference small enough to judge.** Chat is base persona, no focus, no opening
turn. Conversation is the same plus one paragraph telling the tutor to follow the
user and not steer toward vocabulary, plus one opening line. If that paragraph is
the entire justification for a second button, Conversation should collapse into
Chat and the paragraph should become a mode toggle. The prototype is built so
that decision is a two-line deletion, not a refactor.

**The opening is a real user turn, not a tutor-first greeting and not a hidden
system line.** One entry path into the engine, and the transcript stays a
replayable model memory (ADR-0047). The cost is that the user sees a line they
did not type. A UI would want to render it as a chip rather than a bubble.

**Target phrases live only in the system prompt.** The system prompt is re-sent
from the seed each turn and never persisted, so the target set never becomes
conversation memory the tutor can parrot back as a vocabulary list.

Building that turned up a limit worth recording: the property is *independence*,
not word-avoidance. The Practice opening says 我想练习一下, and 练习 is itself a
saveable phrase, so a natural-language opening will sometimes contain a word that
happens to be in the pool. The testable claim is therefore that the opening is
the same line whatever is in play, and that the target set is not recoverable
from the transcript. Chasing a stronger claim would force openings into pure
English, which is worse for a Chinese tutor.

**Focus caps are enforced in code, not requested in a prompt.** A tutor handed
forty targets writes a list; handed five, it writes a conversation. Practice caps
at 5, Revisit at 8, Chat and Conversation at 0.

**Selection is a pure function of the pool, so nothing is a scheduler.** No
`dueAt`, no intervals, no counters, no per-day throttle, and no writes after a
session. Ordering is `new` before `understood`, then oldest first, then by id so
it is stable across devices. Retirement happens exactly once, when the human
marks a phrase `usable`. The cost is real: there is no decay and no automatic
reintroduction, so a phrase marked `usable` too early is gone until the human
moves it back.

**Pinyin is imported statically.** ADR-0105 has the shipped app lazy-load
`pinyin-pro` behind a script test so the dictionary is a code-split chunk. The
prototype bundles it, because a lazily loaded provider registry is the shipped
app's concern and would add an async seam to every test for no design insight.

**Readings are per character; highlights are per phrase.** Pinyin sits over the
glyph it reads, and the two overlays compose: a Han character inside a matched
phrase carries both. Phrase matching is greedy longest-first, the standard
heuristic for unspaced text, so 学习 wins over 学.

**The store is an array.** No CRDT type crosses the engine's seam. In the real
app the store is the conversation's per-id last-write-wins document.

## Not built, on purpose

SRS or any scheduler, gloss cards, a stored dictionary, a generic
materialization API, a UI, tools or an agent loop with a non-empty catalog,
streaming transport, and sync. Each of those is either explicitly refused by
ADR-0102, out of the mission's scope, or a shipped-app concern that would not
change the answer to the question this prototype asks.

## Forks with existing repo truth

These are recorded, not resolved. The prototype follows the destination it was
given; the ADRs are untouched.

**1. Chinese-focused persona vs ADR-0105's language-blind tutor.** ADR-0105 is
Accepted and says the tutor is language-blind, runs one general multilingual
prompt, has no target-language setting, and that this reinforces ADR-0102's
refusal of a language column. The destination this prototype implements is a
Chinese tutor answering in mixed Chinese and English, which contradicts that
directly at the persona layer.

The fork is narrower than it looks. Everything mechanical in ADR-0105 survives
unchanged here: readings are a client-side derived view over clean text, the
tutor never emits romanization, and pinyin is deterministic and offline. What is
contradicted is only the persona and the positioning. The repo already holds both
answers: `apps/vocab` ships `VOCAB_SYSTEM_PROMPT` ("You are a multilingual
language tutor"), while `apps/zhongwen` on `origin/spec/vocab-two-boats` ships
`ZHONGWEN_SYSTEM_PROMPT` ("You are a bilingual Chinese-English language
assistant"). Whoever lands this needs to say which app is the destination and
either amend ADR-0105 or scope it explicitly to the multilingual app.

**2. "Do not assume one room per day" vs the two-boats review queue.** The
`vocab-two-boats` branch keys its queue to a day: `reviewQueue(words, { today,
newWordsPerDay })` filters on `dueAt <= today` and throttles new words per day.
The destination says the user may return to specific topics, which makes a dated
room the wrong unit. This prototype drops the date entirely: Revisit is a search
over conversation history by topic, and Practice takes no date. If the per-day
new-word throttle was doing real work (keeping a bulk import from flooding every
session), the cap here does that job without a calendar.

**3. Revisit wants provenance that ADR-0102 refuses.** "Which phrases came from
this thread" is naturally answered by a stored conversation id on each phrase,
which ADR-0102 refuses and names as an earned-later additive column. The
prototype recovers relevance at read time instead, by matching phrase text
against transcript text, which works because phrases are stored verbatim and
Chinese is unspaced. The cost: a phrase that was discussed but never literally
written in the transcript will not be found, and a very common phrase matches
everywhere. That cost is acceptable at this size and is exactly the evidence
ADR-0102 asked for before reopening the column.

**4. Practice roles sit close to a refused field.** ADR-0102 refuses
"introduce/expose/elicit mode fields". The prototype derives those two roles from
`stage` at prompt-composition time and stores nothing, so the refusal holds. It
is worth naming because the pressure to persist the role is exactly how that
refusal would erode.

**5. Vocabulary drift.** The two-boats branch calls the dial `mastery` with
values 0/1/2; ADR-0102 calls it `stage` with `new`/`understood`/`usable`. This
prototype uses ADR-0102's names.
