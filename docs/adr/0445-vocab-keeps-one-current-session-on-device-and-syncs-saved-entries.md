# 0445. Vocab keeps one current session on device and syncs saved entries

- **Status:** Proposed
- **Date:** 2026-09-24
- **Relates:** [ADR-0046](0046-a-capability-free-agent-persists-finished-messages-not-live-doc-streams.md) (finished turns)
- **Unbuilt:** Vocab still exposes multiple local conversations, their metadata, and a per-conversation agent loop.

## Context

Vocab currently opens `vocabLocalDefinition` through `openLocal()` for conversation and message rows and `vocabDefinition` through `openPersonal()` for saved entries. `createAgentChatState()` keeps a handle and draft for every local conversation. The sidebar lists their titles, and Practice creates another titled conversation. The only application caller of `@epicenter/chat` and `@epicenter/app-shell/agent-chat` is Vocab. Moving those surfaces into Vocab would preserve the conversation archive and its coordination work.

The learner needs the current explanation and follow-up context to survive a refresh on the same device. Saved entries are the selected material they carry across devices. The current Practice action copies entry text into a new conversation, although practicing an entry does not require replacing the learner's tutor exchange.

## Decision

**Vocab retains one current learning session per account on each device and keeps saved entries in the account-backed Personal store.** `chatHistoryDefinition` opens through `openLocal()` and holds the finished messages for the current session. The local document is device-owned across account changes, so every retained message belongs to an account identity and the active session reads only that account's messages. `vocabDefinition` opens through `openPersonal(account)` and holds the learner's explicitly saved `entries`.

The user message is saved locally when a turn starts. The assistant message streams in live UI state and is saved locally once after a clean finish. A stopped or failed attempt saves no partial assistant message; its saved user message remains available for retry. Unsent drafts and partial streams have no persistence guarantee.

Starting a new tutor exchange retires the current exchange for that account on that device. A reset stops the old run before replacing its messages, so a late result cannot enter the new exchange. Practice is a separate temporary activity and leaves the tutor exchange intact. Its exercise format is a later product decision. Practice does not automatically change entries; only an explicit learner stage choice writes to Personal. Switching accounts retires the page's active run and shows only the destination account's local exchange and Personal entries. Switching back on the same device may restore that account's current exchange.

The conversation archive is retired: no conversation list, title, preview, per-conversation draft, per-conversation inference choice, or answer continuing in another conversation. The inference destination belongs to the current account's device workflow rather than a conversation. Connection loss does not silently drop a submitted tutor question.

## Consequences

A refresh restores finished questions and answers on the same device. A different device receives the saved entries but starts with its own local exchange. Practice leaves the tutor exchange available when the learner returns. An unfinished temporary Practice activity has no refresh-recovery guarantee. Entries currently save exact text and an initially empty note, not the answer that supplied context.

`@epicenter/chat` and `@epicenter/app-shell/agent-chat` no longer have an application consumer in their present forms. Vocab still needs message persistence, streaming, retry, account separation, and a visible New-exchange reset boundary. The execution spec decides how to replace the current storage rows and verify retirement of old callers.

## Considered alternatives

- Keep many local conversations: preserves parallel topics and recoverable explanations, but keeps the registry, metadata, sidebar, and concurrent loop lifetimes.
- Keep only a transient exchange: removes local message persistence but loses the current explanation on refresh; a saved entry does not currently carry its explanation.
- Move the shared packages into Vocab unchanged: corrects package ownership without changing the product or its machinery.
