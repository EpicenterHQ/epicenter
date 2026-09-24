# 0444. Vocab stores finished session messages as local rows

- **Status:** Proposed
- **Date:** 2026-09-24
- **Relates:** [ADR-0046](0046-a-capability-free-agent-persists-finished-messages-not-live-doc-streams.md) (persist-on-finish), [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) (store rows)
- **Unbuilt:** Message rows still reference archived conversation ids through `@epicenter/chat` rather than the signed-in account's one current session.

## Context

The current `@epicenter/chat` adapter puts one completed `AgentMessage` JSON value in each local `messages` row. It keys those rows by a conversation id because Vocab currently has many conversations. The proposed Vocab session has no conversation list or title, but must restore finished questions and answers after a refresh. A single transcript blob would rewrite the whole history on each finish.

## Decision

**Vocab persists each finished message as one row in its Local `chatHistoryDefinition`.** Each row carries the signed-in account key, the agent message id, and one complete message value. The session adapter presents only rows for the active account, ordered by the message timestamp, to the agent loop. The Local store owns the rows; the agent loop owns the live attempt.

Sending writes the user message before generation. Clean completion writes the assistant message once. A failed or stopped answer writes no partial assistant message, leaving the user message for retry. Starting a new session or Practice deletes that account's current message rows in one local transaction after stopping the old loop. Rows for another account on the same device remain untouched.

## Consequences

A finished exchange survives a refresh on its device without syncing to another device. One message write is independent of transcript length. An interrupted question is recoverable, but a partial answer and unsent draft are not. Account filtering and reset are correctness boundaries because `openLocal()` owns an app-wide device document, not a document per signed-in account.

## Considered alternatives

- One JSON value for the whole transcript: rewrites the full exchange after each finished answer.
- Persist streamed tokens: adds repeated writes and partial-answer recovery that Vocab does not promise.
- Retain conversation ids: keeps a namespace for an archive Vocab no longer exposes.
