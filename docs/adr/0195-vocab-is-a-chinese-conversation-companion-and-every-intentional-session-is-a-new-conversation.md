# 0195. Vocab is a Chinese conversation companion, and every intentional session is a new conversation

- **Status:** Accepted
- **Date:** 2026-07-31
- **Amends:** [ADR-0105](0105-vocab-is-a-multilingual-tutor-and-readings-are-a-client-side-derived-view.md), withdrawing the language-blind tutor, the multi-script provider registry, the three-category script taxonomy, and the "How to add a language" procedure. ADR-0105's decision that readings are a deterministic, offline, client-side derived view over clean text stands whole, which is why this amends rather than supersedes.
- **Relates:** [ADR-0102](0102-vocab-stores-verbatim-entries-under-a-human-owned-note-and-refuses-glosses-srs-and-provenance.md) (the entry shape and its refusals, preserved unchanged), [ADR-0055](0055-conversation-storage-is-one-canonical-table-every-surface-syncs.md) (the canonical conversations table this keeps unforked), [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) (the client loop and its app-level system-prompt seam), [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md)

## Context

Vocab shipped as a general multilingual tutor: a language-blind system prompt
that infers the studied language, an ordered registry of per-script romanizers,
and prompt builders written to hold no language-specific string. Beside it sat a
saved entry pool that the chat did not know about, reachable only through a
"Practice these" button that compiled entry text into a user turn and sent it
into whatever conversation happened to be open.

Two things forced a decision. The product destination is not a container that
serves many learning goals; it is one Chinese conversation companion, and the
multilingual shape makes every prompt vaguer than it could be while buying
nothing. And the practice path had no session boundary, so its steering barged
into an unrelated topic, persisted for the life of that thread because a user
turn is permanent conversation memory, and overwrote the conversation title that
is the only topic-return handle the app has. There was nowhere durable to put
"this is a practice session" short of forking the canonical conversations table.

## Decision

**Vocab is a chat-first Chinese conversation companion. One app serves one
learning goal. Every intentional session opens a new conversation, and the only
thing that distinguishes one session from another is the opening turn it was
composed with. Vocab stores no session, mode, intent, or focus state.**

- **One learning goal, named.** The tutor teaches Chinese and answers in mixed
  Chinese and English: English carries explanation and meta-commentary, Chinese
  carries vocabulary, examples, and conversational lines. Every prompt Vocab
  composes may name Chinese directly. A second learning goal is a second app,
  never a language column, a learner profile, or a provider registry.
- **Chat is the default surface and the only surface.** There is one thread
  view. The ways into a session are actions, not routes and not modes.
- **Three ways in, one mechanism.** The learner writes the first turn; or the
  learner accepts a proactive conversational seed, which is a topic opener; or
  the learner starts deliberate practice over phrases they picked from the saved
  pool. Each opens a new conversation. The second and third write one composed
  first user turn and a real title. None of them sends into the active
  conversation.
- **The default tutor steers lightly through its persona, never through the
  pool.** The saved pool never enters a system prompt. Ordinary conversation
  follows the learner; the tutor may introduce useful language the way a good
  conversation partner does, and that is the whole of default steering.
  Deliberate steering exists only where the learner asked for it, and it is
  visible in the transcript as the turn that asked for it.
- **A seed is a topic, not a drill.** A proactive seed does not read the saved
  pool. If it did, accepting a seed would be practice wearing a friendlier name
  and the two would collapse into one thing with a worse name.
- **Saved phrases are human-curated end to end.** Capture is an explicit save
  from chat, and the comfort mark is the learner's. Nothing machine-writes a
  phrase, a note, or a mark. ADR-0102's entry shape and every one of its
  refusals hold unchanged.
- **Returning to a topic is the conversation list.** Conversations are durable
  and titled, sorted by recency, and switching to one is how you go back. There
  is no separate revisit feature: re-covering saved material is practice with a
  different selection, and returning to a subject is picking the conversation
  where you discussed it.
- **No stored session state.** No mode, kind, intent, focus set, or roster
  column. The canonical conversations table stays unforked, and the shared chat
  seam's `buildSystemPrompts` keeps its app-level, argument-free shape.
- **Readings stay exactly what ADR-0105 made them:** a deterministic, offline,
  client-side derived view over clean text, rendered through the existing
  `Romanizer` and `<ruby>` seam, hideable by one toggle, and never emitted by
  the tutor. The invariant that a missing reading beats a wrong one is preserved,
  so the pinyin path keeps abstaining on runs where kana or hangul is present.

Refused, and to stay refused: SRS, `dueAt`, review intervals, and any scheduler;
automatic or machine-computed mastery; a stored gloss, dictionary, or CC-CEDICT
database; machine-owned definitions or machine writes to a learner's note;
multilingual scope in any form (a language column, a per-script provider
registry, a target-language setting); persistent session-mode state; and a
generic materialization or session API built before a second consumer exists.

## Consequences

- The prompts get to say what they mean. The tutor prompt, the practice opener,
  and the phrase-candidate extractor stop working around a language they are not
  allowed to name.
- One romanizer remains. The provider type, the ordered registry, the script
  dispatch, the load cache, the composer, and the Japanese and Cyrillic
  providers lose their audience, along with two npm dependencies. The reading
  overlay stays offline and free of any model call, which is ADR-0105's
  local-first payoff and the reason `pinyin-pro` stays load-bearing.
- Serving a second language now costs a second app rather than a provider file
  and a registry line. That is the deliberate trade, and it is why ADR-0105's
  "How to add a language" procedure is withdrawn.
- Practice can no longer run inside the conversation you are already in. This is
  a real capability removal, taken on purpose: it is the same act that stops
  practice from contaminating an unrelated thread and from stealing its title.
- Steering strength decays with conversation length, because it lives in the
  opening turn rather than in a per-turn system prompt. This is the accepted
  risk and the one thing that would reopen the no-stored-intent half of this
  decision.
- Nothing a session does produces a durable record beyond its transcript. There
  is no completion, no grade, no streak, and no due count. Coming back is
  something the learner does, not a debt the app tracks.
- The learner sees an opening line they did not type. The mitigation is voice:
  the composed turn reads short and first-person, and the interface may render
  it as a chip rather than a bubble.
- The app, package, and namespace keep the name `vocab`. The namespace
  `so.epicenter.vocab` is the replica identity, and renaming it would strand
  local data for a cosmetic gain.

**Triggers to reopen.** If a practice session measurably drifts back to generic
tutoring within a few turns, the move is precise: widen the shared chat seam to
take the conversation id, add one intent column to Vocab's conversations table,
and compose a second system prompt for intent-bearing conversations. Nothing
built under this decision is wasted by that change. If a second learning goal
becomes real, it is a new app that reuses the packages, not a field added here.

## Considered alternatives

- **Keep the multilingual tutor and add a Chinese profile.** Rejected: it keeps
  every piece of machinery this deletes and stacks a profile concept on top,
  while still forbidding any prompt from naming the language it teaches.
- **Keep the registry with one provider in it.** Rejected: a registry with a
  single permanent entry is dispatch with nothing to dispatch on, and it
  advertises an extension point the product no longer wants used.
- **A stored session, mode, or intent column plus a per-mode system prompt.**
  Rejected for now: it forks a canonical Lens shape for one app and widens a
  shared seam, to buy steering persistence the composed opening turn already
  supplies at normal conversation length.
- **Routes for the session entries.** Rejected: Vocab has no URL seam, and three
  routes would add a router and three mount points to render one thread three
  times.
- **A distinct Revisit surface.** Rejected: the word fused two different things.
  Returning to a topic is the titled conversation list, already shipped;
  re-covering saved phrases is practice with a different selection. Neither
  earns a third surface, and building one is how a scheduler gets back in.
- **Feeding the saved pool into every system prompt.** Rejected: it makes
  ordinary conversation follow the app's agenda instead of the learner's, which
  is exactly what chat-first exists to protect.
- **A stored provenance column so a session can name the phrases it covered.**
  Rejected here, upholding ADR-0102: it records one origin when the useful
  answer is every occurrence, and no shipped surface needs the answer yet.
