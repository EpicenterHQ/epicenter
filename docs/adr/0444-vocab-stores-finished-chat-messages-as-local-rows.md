# 0444. Vocab stores finished chat messages as local rows

- **Status:** Accepted
- **Date:** 2026-09-24
- **Relates:** [ADR-0046](0046-a-capability-free-agent-persists-finished-messages-not-live-doc-streams.md) (persist on finish), [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) (store rows)

## Context

Vocab needs to reopen a learner's questions and completed answers on the same device. The chat history belongs to the device, while saved entries belong to the signed-in account. The Local store is shared across accounts on that device.

## Decision

**Vocab persists each tutor message as one row in Local `chatHistoryDefinition`.** Each row has an account key, conversation ID, agent message ID, and complete message value. The active agent loop reads only its account and conversation. The conversation list, title, and recency are derived from those rows; an empty new chat has no row.

Sending writes the user message before generation. The assistant streams in page state and is written once after a clean finish. A failed, stopped, or abandoned turn writes no partial assistant message, leaving its question available for retry. The agent loop assigns increasing timestamps so causal message order survives refresh even if several messages are created in the same millisecond.

## Consequences

Completed chats survive refresh on this device and can be reopened. Chats do not follow the account to another device. An unsent draft and partial answer can disappear. Account and conversation filtering keep local histories separate. A new empty chat can disappear on refresh; its title comes from its first question after send.

## Considered alternatives

- One JSON transcript per chat: rewrites the full transcript after every answer.
- Persist streamed tokens: adds repeated writes and partial-answer recovery Vocab does not promise.
- A conversations metadata table: duplicates title and recency that the message rows already provide.
