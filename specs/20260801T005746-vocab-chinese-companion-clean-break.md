# Vocab becomes one Chinese companion with three session entries

- **Status:** Draft
- **Date:** 2026-08-01
- **Owner:** braden
- **Decision owners (proposed):** [ADR-0195](../docs/adr/0195-vocab-is-a-chinese-companion-and-one-app-serves-one-learning-goal.md), [ADR-0196](../docs/adr/0196-a-session-entry-composes-an-opening-turn-and-vocab-stores-no-session-state.md), [ADR-0197](../docs/adr/0197-saved-entries-are-located-in-transcripts-by-longest-match-and-provenance-is-derived.md)
- **Standing decisions:** [ADR-0102](../docs/adr/0102-vocab-stores-verbatim-entries-under-a-human-owned-note-and-refuses-glosses-srs-and-provenance.md) (the entry shape, unchanged by this break), [ADR-0046](../docs/adr/0046-a-capability-free-agent-persists-finished-messages-not-live-doc-streams.md) / [ADR-0047](../docs/adr/0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) (the client loop and the finished-message record), [ADR-0055](../docs/adr/0055-conversation-storage-is-one-canonical-table-every-surface-syncs.md) (the canonical conversations table this keeps unforked)
- **Amends:** [ADR-0105](../docs/adr/0105-vocab-is-a-multilingual-tutor-and-readings-are-a-client-side-derived-view.md) through ADR-0195: the language-blind tutor and the multi-script registry are withdrawn; readings as a deterministic client-side derived view stand

## One sentence

Vocab becomes one Chinese conversation companion whose chat is the whole
product, entered three ways (Conversation, Practice, Revisit), where the saved
entry pool is located inside transcripts by longest-match phrase matching rather
than tracked by any new stored state.

## Current state

Vocab today is a general multilingual tutor. Read against the destination, four
things are true and two of them are now wrong.

What holds up:

- **The chat is the product.** `+page.svelte` builds one `createAgentChatState`
  over the canonical `conversationsTable`, and `ConversationView.svelte` renders
  the active thread. Live turns stream in component state; finished messages are
  one JSON blob per id in the conversation's row document (ADR-0046/0047).
- **The entry pool is right.** `entriesTable` is `{ text, note, stage, createdAt }`,
  saved by selecting text in a settled message, deduped on exact text, with a
  human-owned note and one three-value acquisition dial (ADR-0102). Nothing here
  needs to change.
- **Readings are a derived view.** `ReadingMarkdown.svelte` resolves a romanizer
  and hands it to `@epicenter/ui/markdown`, which emits `<ruby>`. The tutor is
  told never to write readings, so the stored message stays clean for reuse as
  conversation memory and as verbatim entries.
- **Capture is already two-sided.** Drag-select saves a span; "Suggest entries"
  runs a one-shot completion over a settled message and offers transient
  candidates. Neither stores a gloss.

What the destination breaks:

- **The tutor is language-blind.** `VOCAB_SYSTEM_PROMPT` says "adapt to whichever
  language they are studying", `entry-candidates.ts` and `practice.ts` both go out
  of their way to hold no language-specific strings, and `readings/registry.ts`
  runs an ordered provider set (`pinyin-pro`, `wanakana`, `transliteration`) behind
  a script-detection dispatch. Every one of those is machinery for a container the
  product is not going to be.
- **There is one session entry, not three.** "Practice these" in `EntriesPanel`
  compiles up to 20 filtered entries into `buildPracticePrompt` and sends it into
  the *active* conversation. There is no Conversation entry (you just type) and no
  Revisit at all. The saved pool and the transcript never meet: an entry is a row
  in a sidebar, and nothing in the chat knows it exists.

The README is also stale: it documents `src/lib/conversation.svelte.ts` and
`src/lib/vocab.ts`, neither of which exists, and describes the app as a
multilingual tutor.

## Target shape

```txt
                       one Chinese companion
                              │
        ┌─────────────────────┼─────────────────────┐
   Conversation            Practice               Revisit
   (you type)          (produce your entries)  (re-meet a past topic)
        │                     │                     │
        └──────── one composer, one opening turn ────┘
                              │
                    one conversations table
                    one transcript per conversation
                    one entry pool
                              │
              ┌───────────────┴───────────────┐
     pinyin over Han runs            longest-match entry spans
     (deterministic, offline)        (deterministic, offline)
```

Three commitments define the break:

1. **Chinese by construction.** One Chinese-English tutor prompt, one romanizer,
   no registry, no script dispatch, no language field anywhere. One app serves one
   learning goal (ADR-0195).
2. **A session entry is a composition, not a mode.** Practice and Revisit each
   open a new conversation and write one composed first user turn. No intent
   column, no per-conversation system prompt, no stored session, focus, or roster
   (ADR-0196).
3. **The pool is found in the text.** Longest-match phrase matching over verbatim
   entry text is the one new primitive. It paints saved entries in the transcript,
   builds Revisit's roster, and answers "where did I meet this" without a stored
   provenance column (ADR-0197).

The durable shape does not change. No table gains a column, no table is added,
and the canonical conversations table stays unforked.

## Research findings

Findings that moved decisions, each with its evidence.

**Committing to Chinese is what makes phrase matching correct, not merely
cheaper.** Chinese writes no word boundaries, so locating a saved multi-character
entry in a passage is exact substring search with longest-match-first
tie-breaking, and it cannot produce a false positive of the "cat inside category"
kind. In a space-delimited language the same search needs boundary rules,
inflection handling, and a per-language answer to what a word is. The abandoned
`origin/spec/vocab-two-boats` branch built exactly this (`apps/zhongwen/src/lib/lens/match.ts`,
`findVocabMatches`, longest-match-first, 68 lines of tests) and its own note says
the reason is "Chinese has no spaces, so matching is dictionary-driven". This is
the concrete capability the language commitment buys, and it is why the break is
worth taking rather than merely tidy.

**Every transcript is already open in memory, so derived provenance costs
nothing.** `createAgentChatState` mirrors the conversations table into a handle
registry and opens a handle, and therefore the messages child document, for
*every* row (`reconcileHandles` loops `liveIds` and calls `ensureHandle` on each).
The code comments on the coupling itself: the picker preview reads the open doc,
"which is why the registry opens loops eagerly." So "which conversations contain
this entry" is a pure scan over data already resident. This is what lets ADR-0102's
provenance-column trigger be answered with derivation instead of a schema change.
It is also the one scaling limit worth naming (see Open questions).

**The system-prompt seam does not need to change.** `AgentKit.buildSystemPrompts`
is `() => string[]`, read per turn inside a per-conversation closure. Because the
target composes session intent into the first *user* turn rather than into system
prompts, `@epicenter/app-shell` is untouched by this work. Making intent durable
later is a known, small move: give `buildSystemPrompts` the conversation id and add
a stored column. Naming that as the deferred path is cheaper than building the seam
now.

**The shared markdown seam needs one additive field, not a rewrite.**
`Segment` in `@epicenter/ui/markdown` is `{ text: string; reading?: string }` and
`ruby.svelte` renders a `<ruby>` when `reading` is present. Highlighting a matched
entry needs a third channel. One optional `mark?: string` on `Segment`, rendered as
a wrapping span, is generic (it says "the host may style this run") and keeps the
package free of any vocabulary knowledge. Composition order is settled by the
two-boats branch's own build note: match whole entries first, then let pinyin
annotate inside each matched span.

**The two-boats branch already ran the scheduling experiment to its end, and it
failed in a specific way worth not repeating.** It shipped `mastery`, `dueAt`,
`newWordsPerDay`, and a review-queue selector, then wrote in its own spec that the
review screen, the intervals, and the `dueAt` advancement were all deleted because
"the conversation is the repetition." What survived was one self-reported comfort
value, which is exactly ADR-0102's `stage`. Its one honest open problem was
rotation (airtime), not scheduling: with no bump, every in-play word floods every
prompt. That problem transfers to Practice here and is carried forward as an open
question, not as machinery.

**The two-boats branch also settled segmentation, and the settlement holds.** It
refused CC-CEDICT and a segmenter after finding all three would-be consumers
covered without them: capture by human selection, highlight by longest-match over
the personal list, gloss by a boundary-agnostic model. Nothing in the Chinese
commitment reopens that. This spec ships no dictionary and no segmenter.

**`pinyin-pro` is sub-MB and needed on essentially every message here.** ADR-0105
lazily dynamic-imports each provider because most studied languages are Latin-script
and need no reading at all. In a Chinese-only app that premise is gone: the first
message needs it. A static import deletes the load cache, the promise map, and the
`{#await}` in the render path. The bundle delta is small but real, so verification
measures it rather than asserting it.

## Exact user loop

The loop is one sentence long: **you talk, you save what you did not know, and
later you come back to it on purpose.**

```txt
  ┌──────────────────────────────────────────────────────────┐
  │                                                          │
  │   1. Enter a session                                     │
  │        Conversation  you type the first turn             │
  │        Practice      composed from your derived focus    │
  │        Revisit       composed from a past conversation   │
  │                          │                               │
  │   2. Chat in Chinese and English                         │
  │        pinyin renders over Han in settled messages       │
  │        your saved entries are painted where they appear  │
  │                          │                               │
  │   3. Save what you did not know                          │
  │        drag-select a span, or                            │
  │        "Suggest entries" on one message                  │
  │                          │                               │
  │   4. Curate the pool                                     │
  │        cycle stage, write a note, delete                 │
  │                          │                               │
  └──────────────────────────┴───────────────────────────────┘
                             ▼
                    later, step 1 again
```

Step 3 writes the only durable thing a session produces. Steps 1 and 2 write
nothing except the transcript itself. Step 4 is the human dial, never machine
written.

What is deliberately absent from the loop: no daily queue, no due count, no
streak, no "session complete", and no grading moment. Coming back is an act the
user takes, not a debt the app tracks.

## Durable objects and non-objects

### Objects (all of them already exist)

| Object | Shape | Owner |
| --- | --- | --- |
| `conversations` row | canonical `{ title, model, createdAt, updatedAt }` | `@epicenter/chat`, unforked |
| conversation row document | one finished `AgentMessage` per key | ADR-0046/0047 |
| `entries` row | `{ text, note, stage, createdAt }` | ADR-0102, unchanged |
| `showReadings` value | boolean, app default true | Vocab |

Nothing is added. That is the point of the break: the whole target is reachable
by deleting the multilingual layer and adding two pure functions.

### Non-objects (refused, with the trigger that would reopen each)

| Refused | Why | Trigger |
| --- | --- | --- |
| A session, mode, or intent column | A session entry is how you open a conversation, not a state you are in. The composed first turn is already durable and already syncs | A Practice session measurably drifts back to generic tutoring within a few turns |
| A stored focus set, roster, or queue | Focus is a query over the pool; a roster is a match over a transcript. Storing either creates two truths that must be reconciled | Deriving a roster becomes too slow to do at render time |
| A `conversationId` provenance column on `entries` | ADR-0102 named this as a possible additive column; matching answers the question without it, and every transcript is already resident | The transcript scan stops being affordable, which is the same trigger as the row above |
| `dueAt`, intervals, SRS, `newWordsPerDay` | Built and deleted on the two-boats branch. The conversation is the repetition | Never as scheduling. Rotation, if needed, is sampling (see Open questions) |
| Exposure or production counters, streaks, due counts | ADR-0102 refusal, undisturbed | None |
| A stored gloss, dictionary, or CC-CEDICT | Meaning lives in the chat and in the human-owned note | None; the two-boats branch closed this |
| A segmenter (`Intl.Segmenter` or dictionary-backed) | Capture is human-drawn selection; highlight is longest-match over the personal pool | Single-tap-to-add ergonomics chafe, then `Intl.Segmenter` is polish, not a capability |
| A `language` column, per-script registry, provider dispatch | The app is Chinese by construction (ADR-0195) | A second learning goal, which is a second app, not a column |
| A second reading toggle for entry highlights | Readings are dense and worth hiding; entry highlights are sparse and are the point | Highlights read as noise in a real session |
| An extracted `@epicenter/chinese` or `@epicenter/vocab` package | One consumer is not a seam | A second app wants the same entry pool |
| Simplified/traditional normalization on match | ADR-0102 stores text verbatim, never normalized | A user reads both scripts and misses matches (see Open questions) |

## Session-entry contracts

One composer, three intents, one file (`src/lib/session.ts`). `practice.ts` folds
into it and is deleted.

```ts
export type SessionStart =
  | { kind: 'conversation' }
  | { kind: 'practice'; entryTexts: string[] }
  | { kind: 'revisit'; topic: string; entryTexts: string[] };

/** The opening user turn, or null when the learner writes the first turn. */
export function composeSessionOpening(start: SessionStart): string | null;
```

Contracts shared by all three:

- **Each entry opens a new conversation.** Never the active one. Today `practice()`
  sends into whatever chat is open, which mixes a compiled turn into an unrelated
  thread and makes the transcript a poor Revisit anchor.
- **Each writes nothing to `entries`.** No entry is marked practiced, revisited, or
  exposed. ADR-0102's `stage` stays the only dial and only the human turns it.
- **Each is visible.** The composed turn is an ordinary user message in the
  transcript, so the steering is legible, permanent, and syncs with no schema
  change. The cost is honest: a machine-written user turn appears in the thread.
  Mitigation is voice, not mechanism, so the composed text reads first-person and
  short.

Per intent:

| Intent | Focus source | Opening turn asks for |
| --- | --- | --- |
| Conversation | none; entries never enter the prompt | nothing; the learner types |
| Practice | derived: entries with `stage !== 'usable'`, newest first, capped, honoring the panel's active stage filter | a scene where the learner must produce the listed entries, without the tutor saying them first |
| Revisit | derived: entries that actually appear in the chosen past conversation's transcript, by longest match | those entries brought back in a fresh context, checking recognition |

The Conversation row is the one that keeps the product honest. The destination
says normal conversation follows the user's intent, so the entry pool never enters
a system prompt and never enters an unasked-for turn. Practice and Revisit steer
because the learner asked them to.

Revisit's anchor is a **past conversation**, not an entry. That is the sharp line
between it and Practice: Practice's unit is the entry and its direction is forward
(produce it); Revisit's unit is the topic and its direction is backward (meet it
again where you met it). It is also the direct answer to the requirement that
returning to specific topics matters, and it is only buildable because matching
derives which entries a past conversation actually contained.

## Prompt composition

```txt
per turn        systemPrompts = [ TUTOR_SYSTEM_PROMPT ]      one constant, app level
                                  ▲
                                  └── the entry pool NEVER appears here

per session     first user turn = composeSessionOpening(start)   Practice / Revisit only
entry

one shot        entry-candidate extraction (own system prompt, own completion,
                writes no turn, stores nothing)
```

`TUTOR_SYSTEM_PROMPT` replaces `VOCAB_SYSTEM_PROMPT` and commits to Chinese:
English for explanation and meta-commentary, Chinese for vocabulary, examples,
and conversational lines; plain text only, never pinyin or any romanization,
because the client renders readings and because the message is fed back as
memory. The multilingual "infer the language, follow if they switch" instruction
is deleted.

`buildSystemPrompts` keeps its `() => string[]` shape, so
`@epicenter/app-shell/agent-chat` is not touched. If Practice steering later
proves to drift, the deferred move is precise: widen `AgentKit.buildSystemPrompts`
to take the conversation id, add one intent column to Vocab's own conversations
table, and compose a second system prompt for intent-bearing conversations. That
forks the canonical table shape (ADR-0055), which is exactly why it waits for
evidence.

`buildEntryCandidatePrompt` keeps its structure and drops its language-neutrality:
it asks for Chinese spans and says so, which is strictly more accurate than
"spans in the language the learner is studying" resolved from context.

## Pinyin and phrase rendering

Two deterministic, offline, pure passes over one settled message. Both run only on
settled text; a streaming turn renders raw, as today.

**Pinyin.** `readings/` collapses to one file exporting one romanizer built on a
static `pinyin-pro` import. The registry, the provider type, the load cache, the
composer, `romaji.ts`, `cyrillic.ts`, `runs.ts`, and their tests are deleted, along
with the `wanakana` and `transliteration` dependencies. The kana/hangul abstention
guard is also deleted: it exists so shared Han is never stamped with a Mandarin
reading in a Japanese passage, and in an app that is Chinese by construction the
Mandarin reading of a Han run is the correct answer. This is a deliberate, small,
reversible call, not an oversight.

**Phrase matching.** One new pure module (`src/lib/matching.ts`):

```ts
export type EntrySegment = { text: string; entry?: string };

/** Split text into plain runs and saved-entry runs, longest match first. */
export function findEntrySegments(text: string, entryTexts: string[]): EntrySegment[];
```

Rules, each with a reason:

- **Longest match first at each position.** 中国人 wins over 中国 when both are
  saved, which is what the learner means by having saved the longer one.
- **Exact, verbatim, unnormalized.** ADR-0102 stores the selection verbatim, so
  matching does too. No case folding, no trimming beyond what save already did, no
  simplified/traditional conversion.
- **Only entries containing at least one Han character participate.** An entry that
  is pure Latin (an English gloss the learner saved) would otherwise match inside
  unrelated words, which is the false-positive class Chinese otherwise makes
  impossible.
- **Concatenating every segment's text reproduces the input.** The same invariant
  the romanizer already holds, so the two passes compose safely.

**Composition.** Match first over the whole passage, then romanize inside each run.
This requires one additive optional field on the shared segment type:

```ts
// packages/ui/src/markdown/romanizer.ts
export type Segment = { text: string; reading?: string; mark?: string };
```

`ruby.svelte` wraps a marked segment in a span carrying the mark, and the app
styles it. Because pinyin segments Han per character, a matched entry becomes
several adjacent segments sharing one mark; adjacent identical spans with no
whitespace between them read as one continuous highlight, which is a rendering
risk to check visually rather than assert.

**Both roles are painted.** A saved entry the learner typed is worth seeing as much
as one the tutor wrote, and it is the same function either way.

## Migration waves

Four waves, dependency ordered, each a standalone commit that leaves the app
green and runnable.

**Wave 1: commit to Chinese.** Rewrite the tutor prompt; delete `registry.ts`,
`romaji.ts`, `cyrillic.ts`, `runs.ts` and their tests; collapse `pinyin.ts` to one
statically imported romanizer and drop the abstention guard; simplify
`ReadingMarkdown.svelte` to a synchronous render; retune
`buildEntryCandidatePrompt`; drop `wanakana` and `transliteration` from
`package.json`; update the package description. Land ADR-0195 as Proposed.
*Deletes more than it adds; nothing depends on it.*

**Wave 2: phrase matching and the mark channel.** Add `src/lib/matching.ts` with
tests; add `mark?` to `Segment` and render it in `ruby.svelte`; compose match and
pinyin in `ReadingMarkdown.svelte`; paint assistant and user messages. Land
ADR-0197 as Proposed.
*Depends on Wave 1 only for the collapsed romanizer; the seam change is additive
and no other consumer of `@epicenter/ui/markdown` is affected.*

**Wave 3: three session entries.** Add `src/lib/session.ts` with
`composeSessionOpening` and tests; delete `practice.ts`; derive Practice focus from
the pool and Revisit's roster from a chosen conversation's transcript via Wave 2's
matcher; change every entry to open a new conversation; build the entry surface in
the sidebar or an empty-state screen. Land ADR-0196 as Proposed.
*Depends on Wave 2 for the Revisit roster.*

**Wave 4: docs and hygiene.** Rewrite `apps/vocab/README.md`, which is stale
independently of this work; add `Amended by` to ADR-0105; flip the three ADRs to
Accepted; delete this spec.

### Implemented now versus deferred

Implemented now, in the four waves above:

- The Chinese commitment and the whole multilingual deletion.
- Longest-match phrase matching and entry highlighting in the transcript.
- Three session entries, each opening a new conversation from a composed turn.
- Revisit anchored on a past conversation, with a derived roster.

Explicitly deferred, each with the trigger that would start it:

| Deferred | Trigger |
| --- | --- |
| Per-conversation stored intent and a widened `buildSystemPrompts` | Practice drifts back to generic tutoring within a session |
| Focus rotation or sampling for Practice | A real Practice opening feels flooded or repeats the same entries every time |
| Tap a highlighted entry for a transient contextual gloss | Re-reading a saved entry in context without leaving the chat is wanted; the two-boats branch proved it works and stores nothing |
| An entry-highlight visibility toggle | Highlights read as noise |
| Simplified/traditional matching | A learner reading both scripts misses matches |
| Pronunciation (TTS, STT round trip, tone scoring) | The core loop is proven; this was researched on the two-boats branch and never gated the loop |
| Any app rename (`apps/vocab`, `@epicenter/vocab`, namespace `so.epicenter.vocab`) | Never for the namespace without a deliberate replica break; see Open questions |

## Verification

Mechanical, from the repo root unless noted:

- `bun run typecheck` in `apps/vocab`, and in `packages/ui` for the `Segment`
  change.
- `bun test` for `matching.ts`, `session.ts`, and the retained
  `entry-candidates.test.ts`. The matcher is the one place unit tests clearly earn
  their keep: overlapping entries, longest-match precedence, an entry spanning
  punctuation, a Latin-only entry that must not match, and the concatenation
  invariant.
- `bun run build` in `apps/vocab` before and after Wave 1, recording the bundle
  delta from statically importing `pinyin-pro` against the two deleted
  dependencies. Report the number; do not assert it.
- `bun scripts/check-doc-hygiene.ts` from the repo root.
- The repo formatter over changed files.

By hand, in `bun dev:vocab`:

- A Chinese answer renders pinyin over Han and nothing over Latin, with the
  toggle hiding it.
- A saved multi-character entry is painted where it appears in a later message,
  in both the tutor's and the learner's lines, and a longer saved entry wins over
  a shorter one inside it.
- Practice opens a new conversation whose first turn lists the derived focus
  verbatim, and no entry row changes.
- Revisit lists past conversations, shows the entries derived from the chosen
  one, and opens a new conversation naming that topic.
- Reload with the network off: saved transcripts still render readings and
  highlights. This is the local-first payoff ADR-0105 established and ADR-0195
  keeps.

## Rejected alternatives

**Keep the multilingual tutor and add a Chinese "profile".** Rejected. It keeps
every piece of machinery the break exists to delete (the registry, the dispatch,
the language-neutral prompt gymnastics) and adds a profile concept on top. It also
forfeits the finding that makes this worth doing: phrase matching is only
unambiguously correct because the language has no word boundaries, so a
language-blind matcher would need per-language boundary rules immediately.

**Store session intent on the conversation row.** Rejected for now. It forks the
canonical conversations table shape (ADR-0055), widens the shared `AgentKit` seam,
and buys steering persistence that the composed first turn already provides for
the length of a normal session. Named as the deferred path with its trigger, so
reversing this is a known small move rather than a rediscovery.

**Make Practice and Revisit system prompts rather than user turns.** Rejected.
System prompts are per-app and stateless here; making them per-conversation is the
stored-intent change above. A user turn is durable, syncs, is visible to the
learner, and costs nothing.

**Send Practice into the active conversation, as today.** Rejected. It mixes a
compiled turn into an unrelated thread and leaves no clean Revisit anchor. A
session entry starts a session.

**Add a `conversationId` column to `entries` for provenance.** Rejected. ADR-0102
allowed it as a future additive column, but matching answers the same question over
data already in memory, and a stored column would go stale the moment an entry's
text is also spoken in a different conversation, which is the common case.

**Revive `dueAt`, mastery integers, and a review queue.** Rejected. The two-boats
branch built them and then deleted the intervals and the advancement itself, on the
grounds that the conversation is the repetition. Rebuilding a schedule would repeat
a completed experiment.

**Bundle CC-CEDICT or add a segmenter.** Rejected. Settled on the two-boats branch
and undisturbed here: capture is a human-drawn selection, highlight is longest match
over the personal pool, and any gloss is contextual and boundary-agnostic.

**Rename the app to something Chinese-specific now.** Rejected. The directory and
package names are cosmetic, but the Lens namespace `so.epicenter.vocab` is the
replica identity; changing it strands existing local data. Not part of this break.

**Extract a package for the Chinese layer.** Rejected. One consumer is not a seam,
which is the same call the two-boats branch reached about `@epicenter/vocab`.

## Open questions

Two are product forks and belong to the user or to Codex, not to this spec. Two
are local and are answered here with the answer marked.

**1. Product fork: is Revisit anchored on a past conversation or on the entries
themselves?** This spec commits to the conversation anchor, because the destination
says returning to specific topics matters and because it is the only reading that
makes Revisit structurally different from Practice rather than a second filter over
the same pool. The alternative reading, "Revisit = entries I have not met in a
while", is a Practice variant and would collapse the third surface back into the
second. If the intended meaning is the entry-anchored one, Wave 3 changes shape and
the third surface probably should not exist.

**2. Product fork: does a Practice session need to steer past its opening turn?**
This spec bets it does not, and defers stored intent behind a drift trigger. If the
answer is that Practice must hold its stance for the whole session regardless of
observed drift, then stored intent is Wave 3 work, not deferred work, and the
`AgentKit` seam change lands with it.

**3. Local, answered: what happens when the entry pool grows past a few dozen for
Practice?** Every in-play entry entering every Practice opening is the flooding
problem the two-boats branch named and did not solve. The answer here is the same
one it recommended: sample a capped handful rather than schedule, and keep sampling
stateless so nothing is written during a session. Not built until a real session
feels flooded.

**4. Local, answered: when does deriving provenance stop being affordable?** Every
transcript is resident because the handle registry opens all of them eagerly, so a
Revisit roster is a scan over memory today. That eagerness is already flagged in
`agent-chat.svelte.ts` as a coupling worth removing (a denormalized preview on the
conversation row would let handles open lazily). If handles ever open lazily, the
Revisit roster becomes the reason to open a transcript on demand, computed when the
user picks a conversation rather than for the whole list. That is a change of
timing, not of model, and it does not resurrect the provenance column.
