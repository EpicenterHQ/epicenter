# 0450. Vocab chats persist chosen expressions before the tutor speaks

- **Status:** Accepted
- **Date:** 2026-09-24
- **Amends:** [ADR-0444](0444-vocab-stores-finished-chat-messages-as-local-rows.md) (chat existence and title are no longer derived only from messages); [ADR-0445](0445-vocab-saves-local-chats-and-syncs-saved-entries.md) (new chats start from Words, and Words navigation keeps the selected chat alive)

## Context

Vocab currently selects an empty chat ID when the learner presses New chat. The first sent question creates its first Local message row and supplies its title. This lets a learner reopen a finished explanation, but leaves the new chat as a blank question box. The learner now starts from saved expressions and wants the tutor to open a conversation in which they can use them. The chosen expressions exist before either participant has sent a message.

## Decision

**A new Vocab chat starts from one to three saved expressions chosen in Words, and Local stores that choice before the tutor speaks.** Words is the initial view. The learner can choose entries directly or accept a visible suggestion before starting. The start action creates one account-scoped row in the new `chats` table of the existing Local `chatHistoryDefinition`; its row ID is the conversation ID. The row contains `accountKey`, `focus` items of `{ entryId, text }`, and `createdAt`. `text` is the chosen expression at start and does not change with the entry. Each finished message remains a separate row in that store's existing `messages` table, whose `conversationId` points to the chat row ID.

```text
openLocal(chatHistoryDefinition)       this device
  chats                              one row per conversation: focus and creation time
  messages                           many rows per conversation: finished turns

openPersonal(vocabDefinition)          learner's account
  entries                            current text, note, and stage
```

The chat title comes from its focus text. Its recency comes from the latest message, or `createdAt` until a message exists. Starting a chat explicitly requests the tutor's opening turn; mounting or reopening an unanswered chat does not start another request. A failed, stopped, or interrupted opening leaves the chat row available for retry. The tutor uses the fixed focus in natural conversation and can explain an expression when asked. Changing focus starts another chat from Words.

The chat's focus panel shows each original expression. It reads the current entry by `entryId` to offer the learner's stage control; if the entry is absent, it shows the text without that control. It never relinks by matching text, changes an entry automatically, or stores notes and stages in Local.

On desktop, Words is the full view for finding entries, editing learner notes, choosing stages, and starting a conversation. Chat shows the saved chat list on the left, the conversation in the center, and the small focus panel on the right. Its header returns to Words. On a narrow screen, Words and Chat each take the available width; Chat opens its history separately and keeps its focus words reachable without shrinking the conversation. Notes remain editable only in Words. The chat panel has no focus-changing control; another selection starts a new conversation from Words.

Only the selected chat has a live loop and draft. Moving between Chat and Words keeps that selected chat mounted, so its draft and answer continue. Selecting another chat disposes the old loop and loses its unsent draft and partial answer. The microphone runs only while Chat is visible; moving to Words closes it and may discard speech that has not reached the draft. Refresh still restores only saved messages and focus.

## Consequences

An unfinished tutor opening is recoverable without a hidden learner message or a second chat engine. One Local row per chat stores intent that cannot be derived from a transcript with no first message. Deleting a saved entry leaves its original expression in old device-local chats, just as completed messages remain there. Deleting and later re-adding the same text does not reconnect the old chat's stage control to the new entry. Chat focus has no entry-to-chat repair, stage history, or synchronized learning result.

The Words view replaces the current empty-chat home. A learner who wants to ask about an unfamiliar expression first adds it to Words, then starts a conversation. One selected answer may finish while Words is visible; no other chat runs in the background. Reopening a chat on another device remains unavailable because chats are Local.

## Considered alternatives

- Derive focus from the first tutor message: the model may omit or change a chosen expression, and an interrupted opening has no message to derive from.
- Insert a hidden learner prompt: makes the transcript carry UI metadata and requires hidden-message rendering and recovery rules.
- Store only entry IDs: deletion would erase the expression needed to reopen a chat with its original subject.
- Store focus only in page state: refresh or a failed first answer would lose the learner's choice.
