# 0055. Conversation storage is one canonical table in @epicenter/chat, and every chat surface syncs

- **Status:** Accepted
- **Date:** 2026-06-22
- **Amended by:** [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md) (one canonical schema gained owner-scoped instances; not every surface shared one physical synced table) and [ADR-0166](0166-data-document-sync-and-agent-replace-workspace.md) (record Lenses and the explicit Agent data interface replace Workspace tables, child-doc openers, and `.connect()`)
- **Supersedes:** [ADR-0051](0051-one-agent-loop-its-store-seam-chooses-persistence.md) (a chat surface no longer picks a store implementation by transcript reach; conversation storage is one synced table, and tab-manager's device-local store is removed). The one-loop decision carries forward unchanged.
- **Relates:** [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) (the one client loop and its by-id record store), [ADR-0046](0046-a-capability-free-agent-persists-finished-messages-not-live-doc-streams.md) (the finished-message record the messages child doc holds), [ADR-0049](0049-inference-is-its-own-box-the-daemon-never-infers.md) / [ADR-0050](0050-the-inference-contract-is-openai-compatible.md) (the OpenAI-compatible engine every surface drives)

## Context

ADR-0051 kept one agent loop but let its store seam choose persistence: a synced surface passed the Yjs child-doc store (`attachKvStore`), and a device-local surface passed an IndexedDB-backed store satisfying the same interface. tab-manager was the one device-local surface, justified by "a per-browser scratch transcript needs no CRDT."

That justification did not hold against the product goal. Chat should follow a person across their devices, the same as everything else tab-manager already syncs (tabs, bookmarks). The device-local store made tab-manager the one chat surface whose history was stranded on a single browser, and the one surface that hand-rolled its conversation storage: a flat IndexedDB `KvStoreHandle`, a separate per-conversation model-settings store, and a conversation list derived by scanning IndexedDB key prefixes, instead of the table + child-doc model every other surface uses.

Separately, four surfaces (opensidian, vocab, local-books, tab-manager) each hand-declared the same `conversations` table plus `messages` child doc. That table has no natural home: it needs both the storage primitives (`defineTable`, `attachKvStore`) and the agent domain (`AgentMessage`), so neither the domain-agnostic workspace package nor the storage-agnostic agent package can own it, and it puddled into every app.

## Decision

**Conversation storage is one canonical table, `conversationsTable` in the new `@epicenter/chat` package: a synced row per conversation (`id`, `title`, `model`, `createdAt`, `updatedAt`) whose `messages` child doc holds finished `AgentMessage` records (ADR-0046/0047). Every chat surface syncs onto it. tab-manager's device-local store is deleted; tab-manager uses the standard `.connect()` browser preset like every other surface.**

- **One home for conversation storage.** `@epicenter/chat` is the layer that knows both the storage primitives and the agent domain. opensidian, vocab, local-books, and tab-manager all spread `conversationsTable` into their workspace and open a conversation's turns via `tables.conversations.docs.messages.open(id)`. The per-app `ConversationId` brands and table definitions collapse to one.
- **Every surface syncs; there is no device-local branch.** The loop still takes a by-id record store (ADR-0047), but exactly one implementation is now in use: the synced Yjs child doc. tab-manager's IndexedDB store, its settings store, and its key-prefix-derived list are gone.
- **tab-manager uses `.connect()`.** It dropped the hand-rolled `.create()` + `attachLocalStorage` + a separate `openCollaboration` in the session bootstrap for the standard browser preset, which bundles persistence, the relay sync transport, and the per-row child-doc openers chat needs.
- **`model` is a required column.** Every conversation resolves to one model id (the OpenAI-compatible request field, ADR-0050); a surface with a single fixed model writes that constant on create. There is no nullable branch at the one place the engine reads it.

## Consequences

- **The conversations table and the `ConversationId` vocabulary live once** in `@epicenter/chat`. opensidian deleted three dead branching columns (`parentId`/`sourceMessageId`/`systemPrompt`, always written null, never read) in the move; vocab and local-books gained the `model` column.
- **tab-manager chat history that was device-local is not migrated.** ADR-0051 already declared device-local history droppable across a store change; the move to a synced table drops it. New conversations sync from creation.
- **Pre-migration synced rows that lack `model` (vocab/local-books) become nonconforming** and drop from the list. Accepted as a greenfield migration cost: chat history is the most disposable data in these apps. A surface with real deployed conversation data would instead bump the table version and backfill `model`.
- **The loop is unchanged.** It still takes a by-id record store and persists finished messages; only the implementation passed to it converged on the synced table.

## Considered alternatives

- **Keep tab-manager device-local (status quo, ADR-0051).** Rejected: it strands chat on one browser, against the goal that chat follows a person across devices, and keeps tab-manager hand-rolling the storage every other surface gets from the table model.
- **Extract a shared reactive chat-state (`createChatState`) too.** Rejected for now: the reactive layers vary on real product axes (tools, system prompts, approval policy, active-conversation source). A shared primitive would be a multi-knob config object that couples independently-evolving apps; honest duplication of the glue is clearer than a parameterized shared owner. Storage converges; the reactive glue stays inline per app. **Trigger to revisit:** a fourth UI surface that is genuinely identical, or the same behavior fix applied in two chat-states.
- **Replace the loop's store seam with an append-log to make the substrate swappable.** Partly done, partly deferred. The unused half is removed: `ConversationOptions.store` is now `AgentMessageStore`, the `set`/`entries`/`observe` subset the loop actually uses, so it no longer advertises the `get`/`delete` it never calls (the richer `KvStoreHandle` still satisfies it structurally, so no consumer changed). The full append-log (`append`/`list`/`observe`) plus an adapter, which would make a sequence-CRDT swap a one-line change, is deferred: that swap was considered and declined (a single-user, multi-device log wants chronological order and idempotent by-id writes, which the LWW-keyed store gives; a sequence CRDT's insertion order is not time order), so the adapter would be indirection for a swap we chose not to make. **Trigger to revisit:** a decision to move messages onto a sequence CRDT.
