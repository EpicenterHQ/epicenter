# 0445. Vocab saves local chats and syncs saved entries

- **Status:** Accepted
- **Date:** 2026-09-24
- **Relates:** [ADR-0046](0046-a-capability-free-agent-persists-finished-messages-not-live-doc-streams.md) (finished turns), [ADR-0444](0444-vocab-stores-finished-chat-messages-as-local-rows.md) (message rows)

## Context

The learner can return to an earlier explanation on the same device. Saved entries are the material that follows their account to another device. Keeping every conversation's agent loop and draft alive would add lifetimes the learner does not need.

## Decision

**Vocab saves multiple chats on this device, mounts one active chat loop, and syncs saved entries through Personal.** Local `chatHistoryDefinition` owns message rows scoped by account and conversation. Personal `vocabDefinition` owns the learner's explicitly saved entries. The sidebar derives each chat's title from its first sent question and sorts chats by latest message. New selects a fresh ID; it does not delete older chats or write an empty row. Switching chats disposes the old loop, stops its stream and dictation, and opens the chosen saved messages. A submitted question remains available for retry if its answer did not finish.

The inference destination is one account and device workflow choice, captured for each turn. Unsent drafts and partial answers belong only to the active view. There are no per-chat drafts, inference choices, or background streams. Only an explicit learner stage choice changes an entry's stage. The old Practice as a new chat action remains removed; a separate activity can be designed later.

## Consequences

A refresh restores saved questions and completed answers on this device. Another device shows Personal entries and its own local chats. Switching accounts shows only the destination account's local chats and Personal entries. The learner can return to an old explanation but loses an unsent draft on chat switch. A saved entry still contains its text and human note, not its source answer.

The app owns the chat presentation and storage adapter. `@epicenter/agent` remains the UI-free loop. Vocab has no web-search tool calls; its current loop receives no tool catalog.

## Considered alternatives

- One resettable exchange per account: deletes earlier explanations when New is pressed.
- One active loop per saved chat: preserves background streams and drafts at the cost of a conversation registry and concurrent lifetimes.
- A conversations table: persists metadata already derivable from messages.
