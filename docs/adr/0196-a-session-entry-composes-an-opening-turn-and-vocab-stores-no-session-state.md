# 0196. A session entry composes an opening turn, and Vocab stores no session state

- **Status:** Proposed
- **Date:** 2026-08-01
- **Relates:** [ADR-0055](0055-conversation-storage-is-one-canonical-table-every-surface-syncs.md) (the canonical conversations table this keeps unforked), [ADR-0046](0046-a-capability-free-agent-persists-finished-messages-not-live-doc-streams.md) / [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) (the client loop and per-turn system prompts), [ADR-0102](0102-vocab-stores-verbatim-entries-under-a-human-owned-note-and-refuses-glosses-srs-and-provenance.md) (entries stay the only thing a session writes)

## Context

Vocab gains three ways into a session: Conversation, where the learner writes the
first turn; Practice, where the app compiles saved entries into a request to use
them; and Revisit, where the app brings back a past topic. The obvious shape is a
mode: store which mode a conversation is in and compose a different system prompt
per mode. That would fork the canonical conversations table (ADR-0055) by adding a
column to Vocab's interpretation of it, and widen the shared `AgentKit` seam, whose
`buildSystemPrompts` is deliberately `() => string[]` and app-level.

The existing Practice path already demonstrates the cheaper shape: it compiles
entry text into an ordinary user turn and sends it. That turn is durable, syncs,
survives reload, and needs no schema at all.

## Decision

**A session entry is a composition, not a state. Each of Conversation, Practice,
and Revisit opens a new conversation and, for Practice and Revisit, writes one
composed first user turn. Vocab stores no session, mode, intent, focus set, or
roster.**

- **One composer, three intents.** A single pure function maps an intent to an
  opening user turn, or to nothing for Conversation. The intent value exists only
  during the call that creates the conversation.
- **A session entry always opens a new conversation.** It never sends into the
  active one, so a composed turn never lands in an unrelated thread and every
  session is a clean anchor for a later Revisit.
- **Focus is derived, never stored.** Practice's entry set is a query over the pool
  at the moment of composition. Revisit's set is derived from a past conversation's
  transcript. Neither is persisted, and neither writes back to any entry.
- **The entry pool never enters a system prompt.** Normal conversation follows the
  learner's intent, so the tutor is not steered toward saved entries unless the
  learner opened a session that asks for it.
- **`buildSystemPrompts` keeps its `() => string[]` shape.** The shared agent-chat
  seam is not widened by this decision.

## Consequences

- No table gains a column and no table is added. The canonical conversations table
  stays unforked, and the entry shape stays exactly ADR-0102's.
- The steering is visible in the transcript, which makes it legible and permanently
  recoverable, and it syncs across devices with no additional mechanism. The cost is
  a machine-written user turn appearing in the thread; the mitigation is voice, so
  the composed text reads short and first-person.
- Steering strength decays with conversation length, because it lives in context
  rather than in a per-turn system prompt. This is the accepted risk, and it is the
  one thing that would reopen this decision.
- Practice and Revisit are structurally different rather than two filters over one
  pool: Practice's unit is the entry and points forward at production, Revisit's
  unit is a past conversation and points back at recognition.
- No session produces a durable record beyond its transcript. There is no session
  completion, no grading moment, no streak, and no due count. Coming back is
  something the learner does, not a debt the app tracks.

**Trigger to reopen:** a Practice session measurably drifts back to generic
tutoring within a few turns. The move is then precise and small: widen
`AgentKit.buildSystemPrompts` to take the conversation id, add one intent column to
Vocab's conversations table, and compose a second system prompt for
intent-bearing conversations. Nothing built under this decision is wasted by that
change.

## Considered alternatives

- **A stored mode or intent column plus a per-mode system prompt.** Rejected for
  now: it forks the canonical table shape and widens a shared seam to buy steering
  persistence the composed turn already supplies for a normal session length.
- **Composing the intent as a system prompt without storing it.** Rejected: system
  prompts are read per turn from an app-level, argument-free builder, so a prompt
  that varies per conversation is the stored-intent change in disguise.
- **Sending Practice into the active conversation, as the current code does.**
  Rejected: it mixes a compiled turn into an unrelated thread and leaves no clean
  anchor for Revisit.
- **Feeding the entry pool into every system prompt so all conversation is
  steered.** Rejected: it makes normal conversation follow the app's agenda rather
  than the learner's, which is the one thing the Conversation entry exists to
  protect.
