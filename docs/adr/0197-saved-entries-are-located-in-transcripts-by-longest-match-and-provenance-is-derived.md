# 0197. Saved entries are located in transcripts by longest match, and provenance is derived

- **Status:** Proposed
- **Date:** 2026-08-01
- **Relates:** [ADR-0102](0102-vocab-stores-verbatim-entries-under-a-human-owned-note-and-refuses-glosses-srs-and-provenance.md) (this answers its provenance-column reopening condition in the negative), [ADR-0195](0195-vocab-is-a-chinese-companion-and-one-app-serves-one-learning-goal.md) (the language commitment that makes the match correct), [ADR-0105](0105-vocab-is-a-multilingual-tutor-and-readings-are-a-client-side-derived-view.md) (the derived-view rule this second pass follows)

## Context

Vocab's saved entries and its transcripts have never met: an entry is a row in a
sidebar, and nothing in the chat knows it exists. Two wanted capabilities need
them to meet. Painting saved entries where they appear in a message turns the chat
itself into the review surface, and a Revisit session needs to know which entries a
past conversation actually contained.

ADR-0102 refused a provenance column and named one condition that would reopen it:
if "where did I save this from" became a real ask, one additive `conversationId`
column would be added. Revisit makes that ask real. Two facts decide it the other
way. Chinese writes no word boundaries, so locating a saved phrase in a passage is
exact longest-match substring search with no false-positive class of the kind
space-delimited languages produce. And the agent-chat handle registry already opens
every conversation's message document eagerly, so a scan across transcripts reads
data that is already resident.

## Decision

**Saved entries are located inside message text by exact, verbatim, longest-match
substring search, and every question of the form "which entries appear here" or
"where did I meet this entry" is answered by that search at read time. No
provenance, occurrence, or exposure state is stored.**

- **The matcher is one pure function** that splits a settled message into plain
  runs and saved-entry runs, longest match first at each position, so a longer
  saved entry wins over a shorter one nested inside it.
- **Matching is verbatim and unnormalized**, consistent with ADR-0102's verbatim
  `text`: no case folding, no simplified/traditional conversion, no lemmatization.
- **Only entries containing at least one Han character participate.** A pure-Latin
  entry would otherwise match inside unrelated words, which is the one
  false-positive class the language commitment does not rule out.
- **Concatenating every produced segment reproduces the input**, the same invariant
  the romanizer holds, so matching and pinyin compose: match whole entries first,
  then romanize inside each run.
- **The match runs only on settled messages**, off the streaming path, like every
  other derived view (ADR-0105).
- **ADR-0102's provenance column stays refused.** Which conversations contain an
  entry is derived, not recorded.

## Consequences

- Entry highlighting in the transcript and Revisit's roster are the same mechanism
  used twice, and both are deterministic, offline, and free of any model call.
- Derived provenance cannot go stale and cannot disagree with the text. A stored
  `conversationId` would record only the first place an entry was saved, while the
  common case is that the same phrase recurs across conversations; the match finds
  all of them.
- Rendering a marked run needs one additive optional field on the shared markdown
  segment type, so `@epicenter/ui/markdown` gains a generic "the host may style this
  run" channel and no vocabulary knowledge.
- Cost is a scan proportional to transcript volume times pool size, paid at read
  time. It is affordable today because every transcript is already open. If handles
  ever open lazily, the roster is computed when the learner picks a conversation
  rather than for the whole list. That is a change of timing, not of model.
- Two limits are accepted. A learner who reads both simplified and traditional
  misses matches across scripts, and an entry saved with surrounding punctuation
  matches only where that punctuation recurs. Both are consequences of storing text
  verbatim and are cheap to revisit without changing this decision.

## Considered alternatives

- **Add the `conversationId` column ADR-0102 allowed.** Rejected: it records one
  origin when the useful answer is every occurrence, and it adds durable state to
  answer a question the text already answers.
- **A segmenter or a bundled dictionary (CC-CEDICT, `Intl.Segmenter`).** Rejected:
  capture is a human-drawn selection and highlighting is longest match over the
  personal pool, so neither consumer needs word boundaries. This upholds the
  conclusion an earlier exploration reached and shipped.
- **Ask the model which entries appeared.** Rejected: it is non-deterministic,
  needs a network call per message, and would make the transcript overlay depend on
  an inference endpoint, forfeiting the offline guarantee ADR-0105 established.
- **Store an occurrence or exposure counter as messages arrive.** Rejected: it is a
  write on every turn to cache something derivable, and it recreates the counters
  ADR-0102 refused.
