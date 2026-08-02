# 0195. Vocab is a Chinese conversation companion, and every intentional session is a new conversation

- **Status:** Accepted
- **Date:** 2026-08-02
- **Amends:** [ADR-0105](0105-vocab-is-a-multilingual-tutor-and-readings-are-a-client-side-derived-view.md), withdrawing the language-blind tutor, the multi-script provider registry, the three-category script taxonomy, and the "How to add a language" procedure. ADR-0105's decision that readings are a deterministic, offline, client-side derived view over clean text stands whole, which is why this amends rather than supersedes.
- **Relates:** [ADR-0102](0102-vocab-stores-verbatim-entries-under-a-human-owned-note-and-refuses-glosses-srs-and-provenance.md), whose entry shape and refusals this preserves unchanged; [ADR-0055](0055-conversation-storage-is-one-canonical-table-every-surface-syncs.md) (amended by [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md) to owner-scoped instances of one canonical shape), which this decision keeps unforked; [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md), whose client loop reaches its system prompt through an app-level, argument-free `buildSystemPrompts`, a seam this decision keeps argument-free.

## Context

Vocab shipped as a general multilingual tutor: a system prompt that tells the
model to infer whichever language the learner is studying, an ordered registry
of per-script romanizers (Chinese, Japanese kana, Cyrillic), and prompt builders
written under a rule that no prompt may name a language. Beside it sits a saved
entry pool that the tutor does not read.

Two forces made a decision necessary. The product destination is not a container
that serves many learning goals; it is one Chinese conversation companion, and
the language-blind rule makes every prompt vaguer than it could be while buying
nothing that a second app would not buy better. Separately, deliberate practice
over saved phrases originally compiled those phrases into a user turn and sent
it into whatever conversation happened to be open, which steered an unrelated
thread permanently (a user turn is conversation memory) and overwrote the
conversation title that is the app's only handle for returning to a topic. That
second force was answered first: the shared chat seam gained a composed opener
in `27920a0993` and Vocab's practice path moved onto it in `3d91ab7f41`. This
ADR records the rule that change was an instance of, and settles the language
question it left open.

## Decision

**Vocab is a chat-first Chinese conversation companion. One app serves one
learning goal. An intentional session is a newly created conversation opened
with one composed first turn, and the only thing distinguishing one session from
another is the turn it was composed with. Vocab stores no session, mode, intent,
or focus state.**

- **One learning goal, named.** The tutor teaches Chinese and answers in mixed
  Chinese and English: English carries explanation and meta-commentary, Chinese
  carries vocabulary, examples, and conversational lines. Every prompt Vocab
  composes may name Chinese directly. A second learning goal is a second app,
  never a language column, a learner profile, or a provider registry.
- **Chat is the default surface and the only surface.** There is one thread
  view. The ways into a session are actions, not routes and not modes.
- **A session entry composes a title and an opening turn; the mechanism is one
  call.** `createConversation({ title?, opening? })` on the shared chat seam is
  the whole of it. A blank session passes nothing. A composed session passes a
  real title, so the first-message auto-title stays out of the way, and one
  first-person user turn. No entry sends into the conversation already open.
- **The default tutor steers lightly through its persona, never through the
  pool.** The saved pool never enters a system prompt. Ordinary conversation
  follows the learner; the tutor may introduce useful language the way a good
  conversation partner does, and that is the whole of default steering.
  Deliberate steering exists only where the learner asked for it, and it is
  visible in the transcript as the turn that asked for it.
- **A proactive topic seed, if one is offered, is a topic and not a drill.** It
  does not read the saved pool. If it did, accepting a seed would be practice
  wearing a friendlier name and the two would collapse into one thing under the
  worse of the two names.
- **Saved phrases are human-curated end to end.** Capture is an explicit save
  from chat, and the comfort mark is the learner's. Nothing machine-writes a
  phrase, a note, or a mark. ADR-0102's entry shape and every one of its
  refusals hold unchanged.
- **Returning to a topic is the conversation list.** Conversations are durable
  and titled, sorted by recency, and switching to one is how you go back. There
  is no separate revisit surface: re-covering saved material is practice with a
  different selection, and returning to a subject is picking the conversation
  where you discussed it.
- **No stored session state.** No mode, kind, intent, focus set, or roster
  column. The canonical conversations shape stays unforked, and
  `buildSystemPrompts` keeps its app-level, argument-free shape.
- **Readings stay exactly what ADR-0105 made them:** a deterministic, offline,
  client-side derived view over clean text, rendered through the existing
  `Romanizer` and `<ruby>` seam, hideable by one toggle, and never emitted by
  the tutor. The invariant that a missing reading beats a wrong one is
  preserved, so the pinyin path keeps abstaining on runs where kana or hangul is
  present.

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
  providers lose their audience, along with the `wanakana` and `transliteration`
  dependencies, which nothing else in the monorepo imports. The reading overlay
  stays offline and free of any model call, which is ADR-0105's local-first
  payoff and the reason `pinyin-pro` stays load-bearing.
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
- The learner sees an opening line they did not type. It is a real user turn, so
  the transcript stays a replayable memory; the mitigation is voice, and the
  composed turn reads short and first-person.
- The app, package, and namespace keep the name `vocab`. The namespace
  `so.epicenter.vocab` is the replica identity, and renaming it would strand
  local data for a cosmetic gain.

**This decision is accepted ahead of most of its implementation.** The session
mechanism it names is implemented (the two commits above) and has one producer
(`apps/vocab/src/lib/practice.ts` through
`apps/vocab/src/routes/+page.svelte`). The Chinese declaration, the
proactive seed, and the collapse of the reading registry are not built. The
remaining waves are tracked in
[the execution spec](../../specs/20260731T234500-vocab-chinese-conversation-companion.md).

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
- **Routes for the session entries.** Rejected: Vocab keeps the active
  conversation in internal state rather than the URL, so three routes would add
  three mount points to render one thread three times.
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
